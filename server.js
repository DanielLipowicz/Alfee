const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const methodOverride = require("method-override");
const SQLiteStoreFactory = require("connect-sqlite3");
require("dotenv").config({ quiet: true });

const { db, initDatabase } = require("./src/database");
const adminRoutes = require("./src/routes/adminRoutes");
const managerRoutes = require("./src/routes/managerRoutes");
const employeeRoutes = require("./src/routes/employeeRoutes");
const observerRoutes = require("./src/routes/observerRoutes");
const haccpManagerRoutes = require("./src/routes/haccp/managerRoutes");
const haccpEmployeeRoutes = require("./src/routes/haccp/employeeRoutes");
const notificationRoutes = require("./src/routes/notificationRoutes");
const profileRoutes = require("./src/routes/profileRoutes");
const { ensureAuthenticated } = require("./src/middleware/auth");
const { loadUserOrganizations } = require("./src/middleware/tenant");
const { hashPassword, verifyPassword } = require("./src/security/password");
const { setFlash } = require("./src/utils/flash");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const PORT = Number(process.env.PORT) || 3000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function parseBooleanEnv(value) {
  if (value == null || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseTrustProxyValue(value) {
  if (value == null || value === "") {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return 1;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  const asNumber = Number(normalized);
  if (Number.isInteger(asNumber) && asNumber >= 0) {
    return asNumber;
  }
  return value;
}

const trustProxy = parseTrustProxyValue(process.env.TRUST_PROXY);
const sessionCookieSecureEnv = String(
  process.env.SESSION_COOKIE_SECURE || "auto"
).trim().toLowerCase();
const sessionCookieSecure =
  sessionCookieSecureEnv === "auto"
    ? "auto"
    : parseBooleanEnv(sessionCookieSecureEnv) ?? false;
const forceHttps = parseBooleanEnv(process.env.FORCE_HTTPS) === true;

app.set("trust proxy", trustProxy);

if (forceHttps) {
  app.use((req, res, next) => {
    if (req.secure) {
      return next();
    }
    const host = req.headers.host;
    if (!host) {
      return next();
    }
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  });
}

const uploadsDir = path.join(process.cwd(), "uploads");
const dataDir = path.join(process.cwd(), "data");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const managerEmails = (process.env.MANAGER_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const adminEmails = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

const googleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
);

function normalizeEmail(rawEmail) {
  return String(rawEmail || "").trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 10) {
    return "Haslo musi miec co najmniej 10 znakow.";
  }
  if (!/[a-z]/.test(value)) {
    return "Haslo musi zawierac mala litere.";
  }
  if (!/[A-Z]/.test(value)) {
    return "Haslo musi zawierac wielka litere.";
  }
  if (!/[0-9]/.test(value)) {
    return "Haslo musi zawierac cyfre.";
  }
  if (!/[^a-zA-Z0-9]/.test(value)) {
    return "Haslo musi zawierac znak specjalny.";
  }
  return null;
}

function buildLocalIdentity(email) {
  return `local:${email}:${Date.now()}:${Math.round(Math.random() * 1e9)}`;
}

function renderAuthError(res, statusCode, viewName, formData, message) {
  res.locals.flash = { type: "error", text: message };
  return res.status(statusCode).render(viewName, {
    title: viewName === "register" ? "Rejestracja" : "Logowanie",
    formData,
  });
}

async function determineRoleForNewUser(email) {
  const managerCount = await db.get(
    "SELECT COUNT(*) AS total FROM users WHERE role = 'manager'"
  );

  if (adminEmails.includes(email)) {
    return "admin";
  }
  if (managerEmails.includes(email)) {
    return "manager";
  }
  if (
    Number(managerCount.total || 0) === 0 &&
    managerEmails.length === 0 &&
    adminEmails.length === 0
  ) {
    return "manager";
  }
  return "employee";
}

async function registerFailedLoginAttempt(userId) {
  await db.run(
    `
    UPDATE users
    SET
      failed_login_attempts = failed_login_attempts + 1,
      locked_until = CASE
        WHEN failed_login_attempts + 1 >= ? THEN datetime('now', ?)
        ELSE locked_until
      END
    WHERE id = ?
    `,
    [MAX_LOGIN_ATTEMPTS, `+${LOCKOUT_MINUTES} minutes`, userId]
  );

  return db.get(
    "SELECT failed_login_attempts, locked_until FROM users WHERE id = ?",
    [userId]
  );
}

async function clearFailedLoginAttempts(userId) {
  await db.run(
    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
    [userId]
  );
}

function isLocked(lockedUntil) {
  if (!lockedUntil) {
    return false;
  }
  const normalized = String(lockedUntil).replace(" ", "T");
  const lockTimestamp = Date.parse(`${normalized}Z`);
  if (Number.isNaN(lockTimestamp)) {
    return false;
  }
  return lockTimestamp > Date.now();
}

async function ensureDefaultMembership(userId, role) {
  if (role !== "manager" && role !== "employee" && role !== "observer") {
    return;
  }

  const organizations = await db.all("SELECT id FROM organizations ORDER BY id ASC");
  if (organizations.length !== 1) {
    return;
  }

  await db.run(
    `
    INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
    VALUES (?, ?)
    `,
    [userId, organizations[0].id]
  );
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.db",
      dir: dataDir,
    }),
    secret: process.env.SESSION_SECRET || "dev-session-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          "http://localhost:3000/auth/google/callback",
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const googleId = profile.id;
          const email = normalizeEmail(profile.emails?.[0]?.value || "");
          const name = profile.displayName || email;

          let user = await db.get("SELECT * FROM users WHERE google_id = ?", [
            googleId,
          ]);

          if (!user) {
            user = await db.get(
              "SELECT * FROM users WHERE lower(email) = lower(?)",
              [email]
            );
          }

          if (!user) {
            const role = await determineRoleForNewUser(email);

            const inserted = await db.run(
              `
              INSERT INTO users (google_id, email, name, role, auth_provider, is_active)
              VALUES (?, ?, ?, ?, 'google', 1)
              `,
              [googleId, email, name, role]
            );
            user = await db.get("SELECT * FROM users WHERE id = ?", [
              inserted.lastID,
            ]);
          } else {
            const shouldBeAdmin = adminEmails.includes(email);
            const shouldBeManager = managerEmails.includes(email);
            let targetRole = user.role;

            if (shouldBeAdmin) {
              targetRole = "admin";
            } else if (shouldBeManager) {
              targetRole = "manager";
            } else if (
              !["admin", "manager", "employee", "observer"].includes(user.role)
            ) {
              targetRole = "employee";
            }

            await db.run(
              `
              UPDATE users
              SET google_id = ?, email = ?, name = ?, role = ?
              WHERE id = ?
              `,
              [googleId, email, name, targetRole, user.id]
            );
            user = await db.get("SELECT * FROM users WHERE id = ?", [user.id]);
          }

          if (Number(user.is_active || 1) !== 1) {
            return done(null, false, {
              message: "To konto jest nieaktywne.",
            });
          }

          await ensureDefaultMembership(user.id, user.role);

          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );
}

app.use(async (req, res, next) => {
  try {
    res.locals.currentUser = req.user || null;
    res.locals.flash = req.session?.flash || null;
    res.locals.googleConfigured = googleConfigured;
    res.locals.unreadNotifications = 0;
    res.locals.isAdminManagerMode = false;

    if (req.session?.flash) {
      delete req.session.flash;
    }

    if (req.user?.id) {
      const unread = await db.get(
        "SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0",
        [req.user.id]
      );
      res.locals.unreadNotifications = Number(unread?.total || 0);
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.use(loadUserOrganizations);

function redirectByRole(req, res) {
  if (req.user.role === "admin") {
    if (req.isAdminManagerMode === true) {
      return res.redirect("/manager/dashboard");
    }
    return res.redirect("/admin/organizations");
  }
  if (req.user.role === "manager") {
    return res.redirect("/manager/dashboard");
  }
  if (req.user.role === "observer") {
    return res.redirect("/observer/tasks");
  }
  return res.redirect("/employee/tasks");
}

app.get("/", (req, res) => {
  if (req.isAuthenticated()) {
    return redirectByRole(req, res);
  }
  return res.render("home", {
    title: "Lista zadan zespolu",
  });
});

app.get("/login", (req, res) => {
  if (req.isAuthenticated()) {
    return redirectByRole(req, res);
  }
  return res.render("login", {
    title: "Logowanie",
    formData: {
      email: "",
    },
  });
});

app.post("/login/local", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return renderAuthError(
        res,
        400,
        "login",
        { email },
        "Podaj email oraz haslo."
      );
    }

    let user = await db.get(
      `
      SELECT *
      FROM users
      WHERE auth_provider = 'local' AND lower(email) = lower(?)
      LIMIT 1
      `,
      [email]
    );

    if (!user) {
      return renderAuthError(
        res,
        401,
        "login",
        { email },
        "Niepoprawne dane logowania."
      );
    }

    if (Number(user.is_active || 0) !== 1) {
      return renderAuthError(
        res,
        403,
        "login",
        { email },
        "To konto jest nieaktywne."
      );
    }

    if (isLocked(user.locked_until)) {
      return renderAuthError(
        res,
        423,
        "login",
        { email },
        `Konto jest czasowo zablokowane po wielu nieudanych probach. Sprobuj ponownie za ${LOCKOUT_MINUTES} minut.`
      );
    }

    if (user.locked_until) {
      await clearFailedLoginAttempts(user.id);
      user = {
        ...user,
        failed_login_attempts: 0,
        locked_until: null,
      };
    }

    if (!user.password_hash) {
      return renderAuthError(
        res,
        403,
        "login",
        { email },
        "To konto nie ma ustawionego hasla. Zarejestruj nowe konto lokalne lub zaloguj sie przez Google."
      );
    }

    const validPassword = verifyPassword(password, user.password_hash);
    if (!validPassword) {
      const updatedLoginState = await registerFailedLoginAttempt(user.id);
      const baseMessage = "Niepoprawne dane logowania.";
      if (
        Number(updatedLoginState.failed_login_attempts || 0) >= MAX_LOGIN_ATTEMPTS &&
        isLocked(updatedLoginState.locked_until)
      ) {
        return renderAuthError(
          res,
          423,
          "login",
          { email },
          `Konto zostalo zablokowane na ${LOCKOUT_MINUTES} minut po wielu nieudanych probach.`
        );
      }
      return renderAuthError(res, 401, "login", { email }, baseMessage);
    }

    await clearFailedLoginAttempts(user.id);

    return req.login(user, (error) => {
      if (error) {
        return next(error);
      }
      setFlash(req, "success", "Zalogowano pomyslnie.");
      return redirectByRole(req, res);
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/register", (req, res) => {
  if (req.isAuthenticated()) {
    return redirectByRole(req, res);
  }
  return res.render("register", {
    title: "Rejestracja",
    formData: {
      email: "",
      name: "",
      password: "",
      passwordConfirm: "",
    },
  });
});

app.post("/register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || "");

    if (!email || !name) {
      return renderAuthError(
        res,
        400,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        "Podaj email oraz imie i nazwisko."
      );
    }

    if (!validateEmail(email)) {
      return renderAuthError(
        res,
        400,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        "Podaj poprawny adres email."
      );
    }

    if (name.length > 120) {
      return renderAuthError(
        res,
        400,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        "Imie i nazwisko moze miec maksymalnie 120 znakow."
      );
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return renderAuthError(
        res,
        400,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        passwordError
      );
    }

    if (password !== passwordConfirm) {
      return renderAuthError(
        res,
        400,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        "Hasla musza byc identyczne."
      );
    }

    const existingByEmail = await db.get(
      "SELECT id FROM users WHERE lower(email) = lower(?)",
      [email]
    );

    if (existingByEmail) {
      return renderAuthError(
        res,
        409,
        "register",
        { email, name, password: "", passwordConfirm: "" },
        "Ten email jest juz zarejestrowany."
      );
    }

    const role = await determineRoleForNewUser(email);
    const localIdentity = buildLocalIdentity(email);
    const passwordHash = hashPassword(password);

    const created = await db.run(
      `
      INSERT INTO users (google_id, email, name, auth_provider, password_hash, is_active, role)
      VALUES (?, ?, ?, 'local', ?, 1, ?)
      `,
      [localIdentity, email, name, passwordHash, role]
    );

    const user = await db.get("SELECT * FROM users WHERE id = ?", [created.lastID]);
    await ensureDefaultMembership(user.id, user.role);

    return req.login(user, (error) => {
      if (error) {
        return next(error);
      }
      setFlash(req, "success", "Konto utworzone i aktywne. Zalogowano.");
      return redirectByRole(req, res);
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/auth/google", (req, res, next) => {
  if (!googleConfigured) {
    setFlash(
      req,
      "error",
      "Logowanie Google nie jest skonfigurowane. Uzupelnij zmienne srodowiskowe."
    );
    return res.redirect("/login");
  }
  return passport.authenticate("google", { scope: ["profile", "email"] })(
    req,
    res,
    next
  );
});

app.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!googleConfigured) {
      return res.redirect("/login");
    }
    return next();
  },
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    setFlash(req, "success", "Zalogowano pomyslnie.");
    return redirectByRole(req, res);
  }
);

app.get("/logout", ensureAuthenticated, (req, res, next) => {
  req.logout((error) => {
    if (error) {
      return next(error);
    }
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      return res.redirect("/login");
    });
  });
});

app.use("/admin", adminRoutes);
app.use("/manager/haccp", haccpManagerRoutes);
app.use("/manager", managerRoutes);
app.use("/employee/haccp", haccpEmployeeRoutes);
app.use("/employee", employeeRoutes);
app.use("/observer", observerRoutes);
app.use("/notifications", notificationRoutes);
app.use("/profile", profileRoutes);

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Nie znaleziono",
    message: "Nie udalo sie znalezc wskazanej strony.",
  });
});

app.use((error, req, res, _next) => {
  console.error(error);
  if (!res.headersSent) {
    res.status(500).render("error", {
      title: "Blad serwera",
      message:
        "Wystapil nieoczekiwany blad. Sprobuj ponownie lub sprawdz logi aplikacji.",
    });
  }
});

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Aplikacja dziala na http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Nie udalo sie uruchomic aplikacji:", error);
  process.exit(1);
});
