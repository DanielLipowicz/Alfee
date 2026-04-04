const { db } = require("../database");

async function loadUserOrganizations(req, res, next) {
  if (!req.user) {
    res.locals.userOrganizations = [];
    res.locals.activeOrganization = null;
    return next();
  }

  try {
    const organizations = await db.all(
      `
      SELECT
        o.id,
        o.name
      FROM user_organizations uo
      JOIN organizations o ON o.id = uo.organization_id
      WHERE uo.user_id = ?
      ORDER BY o.name ASC
      `,
      [req.user.id]
    );

    req.userOrganizations = organizations;
    res.locals.userOrganizations = organizations;
    req.activeOrganization = null;
    req.activeOrganizationId = null;
    res.locals.activeOrganization = null;

    if (req.user.role === "manager") {
      if (organizations.length === 0) {
        return next();
      }

      const organizationIds = organizations.map((organization) =>
        Number(organization.id)
      );
      let activeOrganizationId = Number(req.session?.activeOrganizationId);

      if (!organizationIds.includes(activeOrganizationId)) {
        activeOrganizationId = organizationIds[0];
        if (req.session) {
          req.session.activeOrganizationId = activeOrganizationId;
        }
      }

      const activeOrganization = organizations.find(
        (organization) => Number(organization.id) === activeOrganizationId
      );

      req.activeOrganizationId = activeOrganizationId;
      req.activeOrganization = activeOrganization || null;
      res.locals.activeOrganization = activeOrganization || null;
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

function ensureManagerOrganization(req, res, next) {
  if (req.user?.role !== "manager") {
    return next();
  }

  if (req.activeOrganizationId) {
    return next();
  }

  return res.status(403).render("error", {
    title: "Brak organizacji",
    message:
      "Nie masz przypisanej organizacji. Skontaktuj sie z administratorem, aby nadac dostep.",
  });
}

module.exports = {
  loadUserOrganizations,
  ensureManagerOrganization,
};
