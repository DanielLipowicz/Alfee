const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureAdmin } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");
const {
  seedDefaultHaccpProcessesForOrganization,
} = require("../utils/haccp");

const router = express.Router();

router.use(ensureAuthenticated, ensureAdmin);

async function rollbackSafely() {
  try {
    await db.run("ROLLBACK");
  } catch (_error) {
    // Brak aktywnej transakcji.
  }
}

function buildDeletedEmail(userId) {
  return `deleted-user-${userId}-${Date.now()}@alfee.invalid`;
}

function buildDeletedName(userId) {
  return `Usuniete konto #${userId}`;
}

router.get("/organizations", async (_req, res, next) => {
  try {
    const [organizations, users, allUsers, members] = await Promise.all([
      db.all(
        `
        SELECT
          o.id,
          o.name,
          o.created_at,
          COUNT(DISTINCT uo.user_id) AS member_count,
          COUNT(DISTINCT t.id) AS task_count
        FROM organizations o
        LEFT JOIN user_organizations uo ON uo.organization_id = o.id
        LEFT JOIN tasks t ON t.organization_id = o.id
        GROUP BY o.id
        ORDER BY o.name ASC
        `
      ),
      db.all(
        `
        SELECT id, name, email, role
        FROM users
        WHERE role IN ('manager', 'employee', 'observer') AND deleted_at IS NULL
        ORDER BY role ASC, name ASC
        `
      ),
      db.all(
        `
        SELECT id, name, email, role
        FROM users
        WHERE deleted_at IS NULL
        ORDER BY
          CASE role
            WHEN 'admin' THEN 1
            WHEN 'manager' THEN 2
            WHEN 'observer' THEN 3
            ELSE 4
          END,
          name ASC
        `
      ),
      db.all(
        `
        SELECT
          o.id AS organization_id,
          u.id AS user_id,
          u.name AS user_name,
          u.email AS user_email,
          u.role AS user_role
        FROM user_organizations uo
        JOIN organizations o ON o.id = uo.organization_id
        JOIN users u ON u.id = uo.user_id AND u.deleted_at IS NULL
        ORDER BY o.name ASC, u.role ASC, u.name ASC
        `
      ),
    ]);

    const membersByOrganization = members.reduce((acc, member) => {
      if (!acc[member.organization_id]) {
        acc[member.organization_id] = [];
      }
      acc[member.organization_id].push(member);
      return acc;
    }, {});

    return res.render("admin/organizations", {
      title: "Organizacje",
      organizations,
      users,
      allUsers,
      managerModeOrganizationId: Number(
        _req.session?.adminManagerOrganizationId || 0
      ),
      membersByOrganization,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/manager-mode/:organizationId", async (req, res, next) => {
  const organizationId = Number(req.params.organizationId);
  if (!organizationId) {
    setFlash(req, "error", "Niepoprawna organizacja dla trybu kierownika.");
    return res.redirect("/admin/organizations");
  }

  try {
    const organization = await db.get(
      "SELECT id, name FROM organizations WHERE id = ?",
      [organizationId]
    );
    if (!organization) {
      setFlash(req, "error", "Nie znaleziono wskazanej organizacji.");
      return res.redirect("/admin/organizations");
    }

    req.session.adminManagerOrganizationId = Number(organization.id);
    setFlash(
      req,
      "success",
      `Wlaczono tryb kierownika dla organizacji "${organization.name}".`
    );
    return res.redirect("/manager/dashboard");
  } catch (error) {
    return next(error);
  }
});

router.post("/manager-mode/exit", (req, res) => {
  if (req.session) {
    delete req.session.adminManagerOrganizationId;
  }
  setFlash(req, "success", "Wylaczono tryb kierownika.");
  return res.redirect("/admin/organizations");
});

router.put("/organizations/:organizationId", async (req, res, next) => {
  const organizationId = Number(req.params.organizationId);
  const name = String(req.body.name || "").trim();

  if (!organizationId || !name) {
    setFlash(req, "error", "Podaj poprawna nazwe organizacji.");
    return res.redirect("/admin/organizations");
  }

  try {
    const organization = await db.get(
      "SELECT id FROM organizations WHERE id = ?",
      [organizationId]
    );
    if (!organization) {
      setFlash(req, "error", "Nie znaleziono organizacji do edycji.");
      return res.redirect("/admin/organizations");
    }

    await db.run("UPDATE organizations SET name = ? WHERE id = ?", [
      name,
      organizationId,
    ]);
    setFlash(req, "success", "Zaktualizowano nazwe organizacji.");
    return res.redirect("/admin/organizations");
  } catch (error) {
    if (error.message?.includes("UNIQUE")) {
      setFlash(req, "error", "Organizacja o tej nazwie juz istnieje.");
      return res.redirect("/admin/organizations");
    }
    return next(error);
  }
});

router.delete("/organizations/:organizationId", async (req, res, next) => {
  const organizationId = Number(req.params.organizationId);
  if (!organizationId) {
    setFlash(req, "error", "Niepoprawne ID organizacji.");
    return res.redirect("/admin/organizations");
  }

  try {
    const organization = await db.get(
      "SELECT id, name FROM organizations WHERE id = ?",
      [organizationId]
    );
    if (!organization) {
      setFlash(req, "error", "Nie znaleziono organizacji do usuniecia.");
      return res.redirect("/admin/organizations");
    }

    await db.run("BEGIN TRANSACTION");
    await db.run("DELETE FROM tasks WHERE organization_id = ?", [organizationId]);
    await db.run("DELETE FROM user_organizations WHERE organization_id = ?", [
      organizationId,
    ]);
    await db.run("DELETE FROM organizations WHERE id = ?", [organizationId]);
    await db.run("COMMIT");

    setFlash(
      req,
      "success",
      `Usunieto organizacje "${organization.name}" wraz z jej zadaniami.`
    );
    return res.redirect("/admin/organizations");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.put("/users/:userId/role", async (req, res, next) => {
  const userId = Number(req.params.userId);
  const targetRole = String(req.body.role || "").trim();
  const allowedRoles = ["admin", "manager", "employee", "observer"];

  if (!userId || !allowedRoles.includes(targetRole)) {
    setFlash(req, "error", "Niepoprawna rola lub uzytkownik.");
    return res.redirect("/admin/organizations");
  }

  try {
    const user = await db.get(
      "SELECT id, name, role FROM users WHERE id = ? AND deleted_at IS NULL",
      [userId]
    );
    if (!user) {
      setFlash(req, "error", "Nie znaleziono uzytkownika.");
      return res.redirect("/admin/organizations");
    }

    if (Number(req.user.id) === Number(user.id) && targetRole !== "admin") {
      setFlash(
        req,
        "error",
        "Nie mozesz odebrac sobie roli administratora z tego panelu."
      );
      return res.redirect("/admin/organizations");
    }

    if (user.role === "admin" && targetRole !== "admin") {
      const adminCount = await db.get(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND deleted_at IS NULL"
      );
      if (Number(adminCount.total || 0) <= 1) {
        setFlash(req, "error", "Nie mozna zdegradowac ostatniego administratora.");
        return res.redirect("/admin/organizations");
      }
    }

    await db.run("UPDATE users SET role = ? WHERE id = ?", [targetRole, user.id]);
    setFlash(req, "success", `Zmieniono role dla ${user.name}.`);
    return res.redirect("/admin/organizations");
  } catch (error) {
    return next(error);
  }
});

router.delete("/users/:userId", async (req, res, next) => {
  const userId = Number(req.params.userId);
  if (!userId) {
    setFlash(req, "error", "Niepoprawne ID uzytkownika.");
    return res.redirect("/admin/organizations");
  }

  try {
    const user = await db.get(
      "SELECT id, name, role, deleted_at FROM users WHERE id = ?",
      [userId]
    );
    if (!user || user.deleted_at) {
      setFlash(req, "error", "Nie znaleziono aktywnego uzytkownika.");
      return res.redirect("/admin/organizations");
    }

    if (Number(req.user.id) === Number(user.id)) {
      setFlash(req, "error", "Nie mozesz usunac swojego konta z tego panelu.");
      return res.redirect("/admin/organizations");
    }

    if (user.role === "admin") {
      const adminCount = await db.get(
        "SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND deleted_at IS NULL"
      );
      if (Number(adminCount.total || 0) <= 1) {
        setFlash(req, "error", "Nie mozna usunac ostatniego administratora.");
        return res.redirect("/admin/organizations");
      }
    }

    await db.run("BEGIN TRANSACTION");
    await db.run("DELETE FROM user_organizations WHERE user_id = ?", [user.id]);
    await db.run(
      `
      UPDATE users
      SET
        google_id = NULL,
        email = ?,
        name = ?,
        auth_provider = 'deleted',
        password_hash = NULL,
        failed_login_attempts = 0,
        locked_until = NULL,
        is_active = 0,
        role = 'employee',
        deleted_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [buildDeletedEmail(user.id), buildDeletedName(user.id), user.id]
    );
    await db.run("COMMIT");

    setFlash(
      req,
      "success",
      `Usunieto konto ${user.name}. Historia akcji pozostala powiazana z ID uzytkownika.`
    );
    return res.redirect("/admin/organizations");
  } catch (error) {
    await rollbackSafely();
    return next(error);
  }
});

router.post("/organizations", async (req, res, next) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Podaj nazwe organizacji.");
    return res.redirect("/admin/organizations");
  }

  try {
    await db.run("BEGIN TRANSACTION");
    const createdOrganization = await db.run(
      "INSERT INTO organizations (name) VALUES (?)",
      [name]
    );
    await seedDefaultHaccpProcessesForOrganization({
      organizationId: createdOrganization.lastID,
      createdBy: Number(req.user.id),
    });
    await db.run("COMMIT");
    setFlash(req, "success", "Utworzono organizacje.");
    return res.redirect("/admin/organizations");
  } catch (error) {
    await rollbackSafely();
    if (error.message?.includes("UNIQUE")) {
      setFlash(req, "error", "Organizacja o tej nazwie juz istnieje.");
      return res.redirect("/admin/organizations");
    }
    return next(error);
  }
});

router.post("/memberships", async (req, res, next) => {
  const organizationId = Number(req.body.organizationId);
  const userId = Number(req.body.userId);

  if (!organizationId || !userId) {
    setFlash(req, "error", "Wybierz organizacje i uzytkownika.");
    return res.redirect("/admin/organizations");
  }

  try {
    const [organization, user] = await Promise.all([
      db.get("SELECT id FROM organizations WHERE id = ?", [organizationId]),
      db.get(
        "SELECT id, role FROM users WHERE id = ? AND role IN ('manager', 'employee', 'observer') AND deleted_at IS NULL",
        [userId]
      ),
    ]);

    if (!organization || !user) {
      setFlash(req, "error", "Niepoprawna organizacja lub uzytkownik.");
      return res.redirect("/admin/organizations");
    }

    await db.run(
      `
      INSERT OR IGNORE INTO user_organizations (user_id, organization_id)
      VALUES (?, ?)
      `,
      [user.id, organization.id]
    );

    setFlash(req, "success", "Dodano czlonkostwo w organizacji.");
    return res.redirect("/admin/organizations");
  } catch (error) {
    return next(error);
  }
});

router.delete(
  "/memberships/:organizationId/:userId",
  async (req, res, next) => {
    const organizationId = Number(req.params.organizationId);
    const userId = Number(req.params.userId);

    if (!organizationId || !userId) {
      setFlash(req, "error", "Niepoprawne dane czlonkostwa.");
      return res.redirect("/admin/organizations");
    }

    try {
      await db.run(
        `
        DELETE FROM user_organizations
        WHERE organization_id = ? AND user_id = ?
        `,
        [organizationId, userId]
      );
      setFlash(req, "success", "Usunieto czlonkostwo.");
      return res.redirect("/admin/organizations");
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;
