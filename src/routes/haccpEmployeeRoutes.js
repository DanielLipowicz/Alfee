const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureEmployee } = require("../middleware/auth");
const { setFlash } = require("../utils/flash");
const {
  listEntriesForEmployee,
  listAlertsForEmployee,
  getProcessWithFields,
  createEntry,
  getEntryWithDetails,
  ensureMissingEntryAlerts,
} = require("../utils/haccp");

const router = express.Router();

async function listEmployeeProcesses(userId) {
  return db.all(
    `
    SELECT
      p.id,
      p.name,
      p.description,
      p.organization_id,
      o.name AS organization_name,
      p.frequency_type,
      p.frequency_value,
      p.is_ccp
    FROM haccp_processes p
    JOIN user_organizations uo ON uo.organization_id = p.organization_id
    JOIN organizations o ON o.id = p.organization_id
    WHERE
      uo.user_id = ?
      AND p.is_active = 1
    ORDER BY o.name ASC, p.name ASC
    `,
    [userId]
  );
}

router.use(ensureAuthenticated, ensureEmployee);

router.use(async (req, _res, next) => {
  try {
    const organizations = await db.all(
      "SELECT organization_id FROM user_organizations WHERE user_id = ?",
      [req.user.id]
    );

    for (let index = 0; index < organizations.length; index += 1) {
      await ensureMissingEntryAlerts(
        Number(organizations[index].organization_id),
        req.user.id
      );
    }
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const [processes, entries, alerts] = await Promise.all([
      listEmployeeProcesses(req.user.id),
      listEntriesForEmployee(req.user.id),
      listAlertsForEmployee(req.user.id),
    ]);

    return res.render("employee/haccp", {
      title: "HACCP",
      processes,
      entries,
      alerts,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/processes/:processId/new-entry", async (req, res, next) => {
  try {
    const processMeta = await db.get(
      `
      SELECT
        p.id,
        p.organization_id
      FROM haccp_processes p
      JOIN user_organizations uo ON uo.organization_id = p.organization_id
      WHERE p.id = ? AND p.is_active = 1 AND uo.user_id = ?
      `,
      [Number(req.params.processId), req.user.id]
    );

    if (!processMeta) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Nie znaleziono procesu HACCP lub nie masz do niego dostepu.",
      });
    }

    const process = await getProcessWithFields(
      processMeta.id,
      processMeta.organization_id,
      true
    );

    return res.render("employee/haccp-entry-form", {
      title: `HACCP - ${process.name}`,
      process,
      errors: [],
      previousValues: {},
      correctiveAction: "",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/processes/:processId/entries", async (req, res, next) => {
  try {
    const processMeta = await db.get(
      `
      SELECT
        p.id,
        p.organization_id
      FROM haccp_processes p
      JOIN user_organizations uo ON uo.organization_id = p.organization_id
      WHERE p.id = ? AND p.is_active = 1 AND uo.user_id = ?
      `,
      [Number(req.params.processId), req.user.id]
    );

    if (!processMeta) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Nie znaleziono procesu HACCP lub nie masz do niego dostepu.",
      });
    }

    const result = await createEntry({
      organizationId: processMeta.organization_id,
      processId: processMeta.id,
      userId: req.user.id,
      body: req.body,
    });

    if (!result.ok) {
      const process = result.process
        ? result.process
        : await getProcessWithFields(
            processMeta.id,
            processMeta.organization_id,
            true
          );

      return res.status(400).render("employee/haccp-entry-form", {
        title: `HACCP - ${process?.name || "wpis"}`,
        process,
        errors: result.errors || ["Nie udalo sie zapisac wpisu."],
        previousValues: req.body,
        correctiveAction: String(req.body.correctiveAction || ""),
      });
    }

    setFlash(req, "success", `Zapisano wpis HACCP (status: ${result.status}).`);
    return res.redirect("/employee/haccp");
  } catch (error) {
    return next(error);
  }
});

router.get("/entries/:entryId", async (req, res, next) => {
  try {
    const entryMeta = await db.get(
      `
      SELECT
        e.id,
        e.organization_id
      FROM haccp_process_entries e
      WHERE e.id = ? AND e.created_by = ?
      `,
      [Number(req.params.entryId), req.user.id]
    );
    if (!entryMeta) {
      return res.status(404).render("error", {
        title: "Brak wpisu",
        message: "Nie znaleziono wskazanego wpisu HACCP.",
      });
    }

    const details = await getEntryWithDetails(
      entryMeta.id,
      entryMeta.organization_id,
      req.user.id
    );
    if (!details) {
      return res.status(404).render("error", {
        title: "Brak wpisu",
        message: "Nie znaleziono wskazanego wpisu HACCP.",
      });
    }

    return res.render("employee/haccp-entry-detail", {
      title: "HACCP - szczegoly wpisu",
      details,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
