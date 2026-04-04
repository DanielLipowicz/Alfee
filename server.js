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
const notificationRoutes = require("./src/routes/notificationRoutes");
const { ensureAuthenticated } = require("./src/middleware/auth");
const { loadUserOrganizations } = require("./src/middleware/tenant");
const { setFlash } = require("./src/utils/flash");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const PORT = Number(process.env.PORT) || 3000;

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

function normalizeUsername(rawUsername) {
  return String(rawUsername || "").trim();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
  return /^[a-zA-Z0-9._-]{3,40}$/.test(username);
}

function buildLocalIdentity(username) {
  return `local:${username}:${Date.now()}:${Math.round(Math.random() * 1e9)}`;
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

async function ensureDefaultMembership(userId, role) {
  if (role !== "manager" && role !== "employee") {
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
      secure: false,
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
            } else if (user.role === "admin") {
              targetRole = shouldBeManager ? "manager" : "employee";
            } else if (shouldBeManager || user.role === "manager") {
              targetRole = "manager";
            } else {
              targetRole = "employee";
            }

            await db.run(
              `
              UPDATE users
              SET google_id = ?, email = ?, name = ?, role = ?, auth_provider = 'google'
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
    return res.redirect("/admin/organizations");
  }
  if (req.user.role === "manager") {
    return res.redirect("/manager/dashboard");
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
      username: "",
      email: "",
    },
  });
});

app.post("/login/local", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);

    if (!username || !email) {
      return renderAuthError(
        res,
        400,
        "login",
        { username, email },
        "Podaj nazwe uzytkownika i email."
      );
    }

    const user = await db.get(
      `
      SELECT *
      FROM users
      WHERE lower(username) = lower(?) AND lower(email) = lower(?)
      LIMIT 1
      `,
      [username, email]
    );

    if (!user) {
      return renderAuthError(
        res,
        401,
        "login",
        { username, email },
        "Nie znaleziono konta z podanymi danymi."
      );
    }

    if (Number(user.is_active || 0) !== 1) {
      return renderAuthError(
        res,
        403,
        "login",
        { username, email },
        "To konto jest nieaktywne."
      );
    }

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
      username: "",
      email: "",
      name: "",
    },
  });
});

app.post("/register", async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name || "").trim() || username;

    if (!username || !email) {
      return renderAuthError(
        res,
        400,
        "register",
        { username, email, name },
        "Podaj nazwe uzytkownika i email."
      );
    }

    if (!validateUsername(username)) {
      return renderAuthError(
        res,
        400,
        "register",
        { username, email, name },
        "Nazwa uzytkownika musi miec 3-40 znakow: litery, cyfry, kropka, myslnik lub podkreslenie."
      );
    }

    if (!validateEmail(email)) {
      return renderAuthError(
        res,
        400,
        "register",
        { username, email, name },
        "Podaj poprawny adres email."
      );
    }

    const [existingByUsername, existingByEmail] = await Promise.all([
      db.get("SELECT id FROM users WHERE lower(username) = lower(?)", [username]),
      db.get("SELECT id FROM users WHERE lower(email) = lower(?)", [email]),
    ]);

    if (existingByUsername) {
      return renderAuthError(
        res,
        409,
        "register",
        { username, email, name },
        "Ta nazwa uzytkownika jest juz zajeta."
      );
    }

    if (existingByEmail) {
      return renderAuthError(
        res,
        409,
        "register",
        { username, email, name },
        "Ten email jest juz zarejestrowany."
      );
    }

    const role = await determineRoleForNewUser(email);
    const localIdentity = buildLocalIdentity(username);

    const created = await db.run(
      `
      INSERT INTO users (google_id, username, email, name, auth_provider, is_active, role)
      VALUES (?, ?, ?, ?, 'local', 1, ?)
      `,
      [localIdentity, username, email, name, role]
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
app.use("/manager", managerRoutes);
app.use("/employee", employeeRoutes);
app.use("/notifications", notificationRoutes);

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
