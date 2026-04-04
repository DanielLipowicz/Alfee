const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureAdmin } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");

const router = express.Router();

router.use(ensureAuthenticated, ensureAdmin);

async function rollbackSafely() {
  try {
    await db.run("ROLLBACK");
  } catch (_error) {
    // Brak aktywnej transakcji.
  }
}

router.get("/organizations", async (_req, res, next) => {
  try {
    const [organizations, users, members] = await Promise.all([
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
        WHERE role IN ('manager', 'employee')
        ORDER BY role ASC, name ASC
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
        JOIN users u ON u.id = uo.user_id
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
      membersByOrganization,
    });
  } catch (error) {
    return next(error);
  }
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

router.post("/organizations", async (req, res, next) => {
  const name = String(req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Podaj nazwe organizacji.");
    return res.redirect("/admin/organizations");
  }

  try {
    await db.run("INSERT INTO organizations (name) VALUES (?)", [name]);
    setFlash(req, "success", "Utworzono organizacje.");
    return res.redirect("/admin/organizations");
  } catch (error) {
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
        "SELECT id, role FROM users WHERE id = ? AND role IN ('manager', 'employee')",
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
