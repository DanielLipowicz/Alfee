const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated } = require("../middleware/auth");
const { hashPassword, verifyPassword } = require("../security/password");
const { setFlash } = require("../utils/flash");

const router = express.Router();

router.use(ensureAuthenticated);

function normalizeDisplayName(rawName) {
  return String(rawName || "").trim();
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

async function loadProfileUser(userId) {
  return db.get(
    `
    SELECT
      id,
      email,
      name,
      role,
      auth_provider,
      password_hash,
      created_at
    FROM users
    WHERE id = ?
    `,
    [userId]
  );
}

function renderProfile(res, profileUser, statusCode = 200, flash = null) {
  if (flash) {
    res.locals.flash = flash;
  }
  return res.status(statusCode).render("profile", {
    title: "Profil",
    profileUser,
  });
}

router.get("/", async (req, res, next) => {
  try {
    const profileUser = await loadProfileUser(req.user.id);
    if (!profileUser) {
      return res.status(404).render("error", {
        title: "Brak uzytkownika",
        message: "Nie znaleziono danych profilu.",
      });
    }

    return renderProfile(res, profileUser);
  } catch (error) {
    return next(error);
  }
});

router.post("/name", async (req, res, next) => {
  try {
    const name = normalizeDisplayName(req.body.name);
    const profileUser = await loadProfileUser(req.user.id);

    if (!profileUser) {
      return res.status(404).render("error", {
        title: "Brak uzytkownika",
        message: "Nie znaleziono danych profilu.",
      });
    }

    if (!name) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Podaj imie i nazwisko.",
      });
    }

    if (name.length > 120) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Imie i nazwisko moze miec maksymalnie 120 znakow.",
      });
    }

    if (profileUser.name === name) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Podane imie i nazwisko jest juz ustawione na koncie.",
      });
    }

    await db.run("UPDATE users SET name = ? WHERE id = ?", [name, profileUser.id]);

    setFlash(req, "success", "Imie i nazwisko zostalo zaktualizowane.");
    return res.redirect("/profile");
  } catch (error) {
    return next(error);
  }
});

router.post("/password", async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    const confirmPassword = String(req.body.confirmPassword || "");

    const profileUser = await loadProfileUser(req.user.id);
    if (!profileUser) {
      return res.status(404).render("error", {
        title: "Brak uzytkownika",
        message: "Nie znaleziono danych profilu.",
      });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Wypelnij wszystkie pola hasla.",
      });
    }

    if (!profileUser.password_hash) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "To konto nie ma ustawionego hasla lokalnego.",
      });
    }

    const validCurrentPassword = verifyPassword(
      currentPassword,
      profileUser.password_hash
    );
    if (!validCurrentPassword) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Aktualne haslo jest niepoprawne.",
      });
    }

    if (currentPassword === newPassword) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Nowe haslo musi byc inne niz aktualne.",
      });
    }

    const passwordError = validatePasswordStrength(newPassword);
    if (passwordError) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: passwordError,
      });
    }

    if (newPassword !== confirmPassword) {
      return renderProfile(res, profileUser, 400, {
        type: "error",
        text: "Nowe hasla musza byc identyczne.",
      });
    }

    const passwordHash = hashPassword(newPassword);
    await db.run(
      `
      UPDATE users
      SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL
      WHERE id = ?
      `,
      [passwordHash, profileUser.id]
    );

    setFlash(req, "success", "Haslo zostalo zmienione.");
    return res.redirect("/profile");
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
