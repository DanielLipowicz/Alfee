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
const { requestLogger } = require("./src/middleware/requestLogger");
const { hashPassword, verifyPassword } = require("./src/security/password");
const { setFlash } = require("./src/utils/flash");
const logger = require("./src/utils/logger");
const {
  seedDefaultHaccpProcessesForOrganization,
} = require("./src/utils/haccp");
const {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  normalizeLocale,
  detectLocaleFromHeader,
  translate,
  translateHtml,
  withLocale,
} = require("./src/i18n");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const PORT = Number(process.env.PORT) || 3000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const ORGANIZATION_ONBOARDING_ROLES = new Set([
  "manager",
  "employee",
  "observer",
]);
const stylesPath = path.join(__dirname, "public", "css", "styles.css");
const ASSET_VERSION =
  process.env.ASSET_VERSION ||
  (fs.existsSync(stylesPath) ? String(fs.statSync(stylesPath).mtimeMs) : "1");

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? logger.serializeError(reason) : reason,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: logger.serializeError(error),
  });
  process.exit(1);
});

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
  if (adminEmails.includes(email)) {
    return "admin";
  }
  if (managerEmails.includes(email)) {
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

function requiresOrganizationOnboarding(role) {
  return ORGANIZATION_ONBOARDING_ROLES.has(role);
}

async function hasOrganizationMembership(userId) {
  const membership = await db.get(
    `
    SELECT 1 AS present
    FROM user_organizations
    WHERE user_id = ?
    LIMIT 1
    `,
    [userId]
  );
  return Boolean(membership);
}

function shouldShowOrganizationOnboarding(req) {
  if (!req.user || !requiresOrganizationOnboarding(req.user.role)) {
    return false;
  }
  if (!Array.isArray(req.userOrganizations)) {
    return false;
  }
  return req.userOrganizations.length === 0;
}

async function redirectAfterSuccessfulAuthentication(req, res, next) {
  try {
    if (await hasOrganizationMembership(req.user.id)) {
      return redirectByRole(req, res);
    }
    if (requiresOrganizationOnboarding(req.user.role)) {
      return res.redirect("/onboarding/organization");
    }
    return redirectByRole(req, res);
  } catch (error) {
    return next(error);
  }
}

function renderOrganizationOnboarding(
  res,
  statusCode,
  { formData, showEmployeeInfo = false, message = null } = {}
) {
  if (message) {
    res.locals.flash = { type: "error", text: message };
  }

  return res.status(statusCode).render("organization-onboarding", {
    title: "Organization setup",
    formData: {
      organizationChoice: String(formData?.organizationChoice || ""),
      organizationName: String(formData?.organizationName || ""),
    },
    showEmployeeInfo,
  });
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

app.use((req, res, next) => {
  const queryLocale = normalizeLocale(req.query?.lang);
  if (queryLocale && req.session) {
    req.session.locale = queryLocale;
  }

  const sessionLocale = normalizeLocale(req.session?.locale);
  const headerLocale = detectLocaleFromHeader(req.get("accept-language"));
  const locale = queryLocale || sessionLocale || headerLocale || DEFAULT_LOCALE;

  req.locale = locale;
  req.t = (sourceText) => translate(locale, sourceText);
  res.locals.locale = locale;
  res.locals.t = req.t;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.localeOptions = SUPPORTED_LOCALES.map((code) => ({
    code,
    label: LOCALE_LABELS[code] || code.toUpperCase(),
  }));
  res.locals.withLocale = (code) => withLocale(req.originalUrl, code);

  next();
});

app.use((req, res, next) => {
  const originalRender = res.render.bind(res);

  res.render = (view, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const locals = typeof options === "function" ? undefined : options;

    return originalRender(view, locals, (error, html) => {
      if (error) {
        if (typeof done === "function") {
          return done(error);
        }
        return next(error);
      }

      const translatedHtml = translateHtml(req.locale, html);
      if (typeof done === "function") {
        return done(null, translatedHtml);
      }
      return res.send(translatedHtml);
    });
  };

  next();
});

app.use(passport.initialize());
app.use(passport.session());
app.use(requestLogger);

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

app.use((req, res, next) => {
  if (!shouldShowOrganizationOnboarding(req)) {
    return next();
  }

  if (req.path === "/onboarding/organization" || req.path === "/logout") {
    return next();
  }

  return res.redirect("/onboarding/organization");
});

function redirectByRole(req, res) {
  if (shouldShowOrganizationOnboarding(req)) {
    return res.redirect("/onboarding/organization");
  }

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

app.get("/onboarding/organization", ensureAuthenticated, (req, res) => {
  if (!requiresOrganizationOnboarding(req.user.role)) {
    return redirectByRole(req, res);
  }

  if (!shouldShowOrganizationOnboarding(req)) {
    return redirectByRole(req, res);
  }

  const mode = String(req.query.mode || "").trim().toLowerCase();
  const showEmployeeInfo = mode === "join";

  return renderOrganizationOnboarding(res, 200, {
    formData: {
      organizationChoice: showEmployeeInfo ? "join" : "",
      organizationName: "",
    },
    showEmployeeInfo,
  });
});

app.post("/onboarding/organization", ensureAuthenticated, async (req, res, next) => {
  try {
    if (!requiresOrganizationOnboarding(req.user.role)) {
      return redirectByRole(req, res);
    }

    if (!shouldShowOrganizationOnboarding(req)) {
      return redirectByRole(req, res);
    }

    const organizationChoice = String(req.body.organizationChoice || "")
      .trim()
      .toLowerCase();
    const organizationName = String(req.body.organizationName || "").trim();
    const formData = { organizationChoice, organizationName };

    if (organizationChoice !== "create" && organizationChoice !== "join") {
      return renderOrganizationOnboarding(res, 400, {
        formData,
        message: "Select how you want to continue.",
      });
    }

    if (organizationChoice === "join") {
      await db.run(
        "UPDATE users SET role = 'employee' WHERE id = ? AND role IN ('manager', 'employee', 'observer')",
        [req.user.id]
      );

      const refreshedUser = await db.get("SELECT * FROM users WHERE id = ?", [
        req.user.id,
      ]);

      return req.login(refreshedUser, (error) => {
        if (error) {
          return next(error);
        }

        setFlash(req, "success", "Please contact your manager and provide your email address.");
        return res.redirect("/onboarding/organization?mode=join");
      });
    }

    if (!organizationName) {
      return renderOrganizationOnboarding(res, 400, {
        formData,
        message: "Enter organization name.",
      });
    }

    if (organizationName.length > 120) {
      return renderOrganizationOnboarding(res, 400, {
        formData,
        message: "Organization name can have up to 120 characters.",
      });
    }

    const existingOrganization = await db.get(
      "SELECT id FROM organizations WHERE lower(name) = lower(?)",
      [organizationName]
    );

    if (existingOrganization) {
      return renderOrganizationOnboarding(res, 409, {
        formData,
        message: "This organization name is already in use.",
      });
    }

    let createdOrganizationId = null;
    await db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const createdOrganization = await db.run(
        "INSERT INTO organizations (name) VALUES (?)",
        [organizationName]
      );
      createdOrganizationId = Number(createdOrganization.lastID);

      await db.run(
        `
        INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
        VALUES (?, ?)
        `,
        [req.user.id, createdOrganizationId]
      );

      await db.run(
        "UPDATE users SET role = 'manager' WHERE id = ? AND role IN ('manager', 'employee', 'observer')",
        [req.user.id]
      );

      await seedDefaultHaccpProcessesForOrganization({
        organizationId: createdOrganizationId,
        createdBy: Number(req.user.id),
      });

      await db.run("COMMIT");
    } catch (transactionError) {
      await db.run("ROLLBACK");
      throw transactionError;
    }

    const refreshedUser = await db.get("SELECT * FROM users WHERE id = ?", [
      req.user.id,
    ]);

    if (req.session) {
      req.session.activeOrganizationId = createdOrganizationId;
    }

    return req.login(refreshedUser, (error) => {
      if (error) {
        return next(error);
      }

      setFlash(req, "success", "Organization created. You are now a manager.");
      return res.redirect("/manager/dashboard");
    });
  } catch (error) {
    if (error?.code === "SQLITE_CONSTRAINT") {
      return renderOrganizationOnboarding(res, 409, {
        formData: {
          organizationChoice: "create",
          organizationName: String(req.body.organizationName || "").trim(),
        },
        message: "This organization name is already in use.",
      });
    }
    return next(error);
  }
});

app.get("/", (req, res) => {
  if (req.isAuthenticated()) {
    return redirectByRole(req, res);
  }
  return res.render("home", {
    title: "Lista zadan zespolu",
  });
});

app.get("/o-produkcie", (_req, res) => {
  return res.render("about-product", {
    title: "O produkcie",
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
      return redirectAfterSuccessfulAuthentication(req, res, next);
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

    return req.login(user, (error) => {
      if (error) {
        return next(error);
      }
      setFlash(req, "success", "Konto utworzone i aktywne. Zalogowano.");
      return redirectAfterSuccessfulAuthentication(req, res, next);
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
  (req, res, next) => {
    setFlash(req, "success", "Zalogowano pomyslnie.");
    return redirectAfterSuccessfulAuthentication(req, res, next);
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
  logger.error("Unhandled application error", {
    requestId: req.requestId || null,
    method: req.method,
    path: req.path,
    error: logger.serializeError(error),
  });
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
    logger.info("Application started", {
      port: PORT,
      url: `http://localhost:${PORT}`,
      logDirectory: logger.constants.LOG_DIRECTORY,
      allLogsFile: logger.constants.ALL_LOG_FILE,
      errorLogsFile: logger.constants.ERROR_LOG_FILE,
      maxLogSizeBytes: logger.constants.MAX_LOG_SIZE_BYTES,
    });
  });
}

start().catch((error) => {
  logger.error("Failed to start application", {
    error: logger.serializeError(error),
  });
  process.exit(1);
});
