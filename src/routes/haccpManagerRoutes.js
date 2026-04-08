const express = require("express");

const { db } = require("../database");
const { ensureAuthenticated, ensureManager } = require("../middleware/auth");
const { ensureManagerOrganization } = require("../middleware/tenant");
const { setFlash } = require("../utils/flash");
const {
  FIELD_TYPES,
  FREQUENCY_TYPES,
  ENTRY_STATUSES,
  parseEntryFilters,
  parseAlertFilters,
  listProcesses,
  getProcessWithFields,
  createProcess,
  updateProcess,
  ensureMissingEntryAlerts,
  listEntriesForManager,
  getEntryWithDetails,
  reviewEntry,
  listAlertsForManager,
  resolveAlert,
  listReportRows,
  buildCsvReport,
  buildPdfReport,
  getManagerDashboardStats,
} = require("../utils/haccp");

const router = express.Router();

function blankProcessFormData() {
  return {
    name: "",
    description: "",
    frequencyType: "NONE",
    frequencyValue: "",
    isActive: true,
    isCcp: false,
    fields: [
      {
        name: "",
        type: "NUMBER",
        required: true,
        minValue: "",
        maxValue: "",
        allowedValues: [],
        order: 1,
      },
    ],
  };
}

function mapProcessToFormData(process) {
  if (!process) {
    return blankProcessFormData();
  }
  return {
    name: process.name || "",
    description: process.description || "",
    frequencyType: process.frequency_type || "NONE",
    frequencyValue:
      process.frequency_value == null ? "" : String(process.frequency_value),
    isActive: Number(process.is_active) === 1,
    isCcp: Number(process.is_ccp) === 1,
    fields:
      process.fields?.map((field) => ({
        name: field.name || "",
        type: field.type || "TEXT",
        required: Number(field.required) === 1,
        minValue: field.min_value == null ? "" : String(field.min_value),
        maxValue: field.max_value == null ? "" : String(field.max_value),
        allowedValues: Array.isArray(field.allowed_values)
          ? field.allowed_values
          : [],
        order: field.field_order || 1,
      })) || [],
  };
}

router.use(ensureAuthenticated, ensureManager, ensureManagerOrganization);

router.use(async (req, _res, next) => {
  try {
    await ensureMissingEntryAlerts(req.activeOrganizationId, req.user.id);
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const [stats, latestAlerts, latestEntries] = await Promise.all([
      getManagerDashboardStats(req.activeOrganizationId),
      listAlertsForManager(req.activeOrganizationId, { resolved: 0 }),
      listEntriesForManager(req.activeOrganizationId, {}),
    ]);

    return res.render("manager/haccp-dashboard", {
      title: "HACCP",
      stats,
      latestAlerts: latestAlerts.slice(0, 8),
      latestEntries: latestEntries.slice(0, 8),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/processes", async (req, res, next) => {
  try {
    const processes = await listProcesses(req.activeOrganizationId, true);
    return res.render("manager/haccp-processes", {
      title: "HACCP - procesy",
      processes,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/processes/new", (_req, res) => {
  return res.render("manager/haccp-process-form", {
    title: "HACCP - nowy proces",
    formMode: "create",
    processId: null,
    formData: blankProcessFormData(),
    fieldTypes: FIELD_TYPES,
    frequencyTypes: FREQUENCY_TYPES,
    errors: [],
  });
});

router.post("/processes", async (req, res, next) => {
  try {
    const result = await createProcess({
      organizationId: req.activeOrganizationId,
      userId: req.user.id,
      body: req.body,
    });

    if (!result.ok) {
      return res.status(400).render("manager/haccp-process-form", {
        title: "HACCP - nowy proces",
        formMode: "create",
        processId: null,
        formData: result.data || blankProcessFormData(),
        fieldTypes: FIELD_TYPES,
        frequencyTypes: FREQUENCY_TYPES,
        errors: result.errors || ["Nie udalo sie zapisac procesu."],
      });
    }

    setFlash(req, "success", "Utworzono proces HACCP.");
    return res.redirect("/manager/haccp/processes");
  } catch (error) {
    return next(error);
  }
});

router.get("/processes/:processId/edit", async (req, res, next) => {
  try {
    const process = await getProcessWithFields(
      Number(req.params.processId),
      req.activeOrganizationId
    );
    if (!process) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Nie znaleziono wskazanego procesu HACCP.",
      });
    }

    return res.render("manager/haccp-process-form", {
      title: "HACCP - edycja procesu",
      formMode: "edit",
      processId: process.id,
      formData: mapProcessToFormData(process),
      fieldTypes: FIELD_TYPES,
      frequencyTypes: FREQUENCY_TYPES,
      errors: [],
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/processes/:processId", async (req, res, next) => {
  const processId = Number(req.params.processId);
  try {
    const result = await updateProcess({
      organizationId: req.activeOrganizationId,
      processId,
      userId: req.user.id,
      body: req.body,
    });

    if (!result.ok) {
      if (result.notFound) {
        return res.status(404).render("error", {
          title: "Brak procesu",
          message: "Nie znaleziono wskazanego procesu HACCP.",
        });
      }

      return res.status(400).render("manager/haccp-process-form", {
        title: "HACCP - edycja procesu",
        formMode: "edit",
        processId,
        formData: result.data || blankProcessFormData(),
        fieldTypes: FIELD_TYPES,
        frequencyTypes: FREQUENCY_TYPES,
        errors: result.errors || ["Nie udalo sie zapisac zmian."],
      });
    }

    setFlash(req, "success", "Zaktualizowano proces HACCP.");
    return res.redirect("/manager/haccp/processes");
  } catch (error) {
    return next(error);
  }
});

router.get("/entries", async (req, res, next) => {
  try {
    const filters = parseEntryFilters(req.query);
    const query = new URLSearchParams();
    if (filters.dateFrom) {
      query.set("dateFrom", filters.dateFrom);
    }
    if (filters.dateTo) {
      query.set("dateTo", filters.dateTo);
    }
    if (filters.status) {
      query.set("status", filters.status);
    }
    if (filters.processId) {
      query.set("processId", String(filters.processId));
    }
    if (filters.createdBy) {
      query.set("createdBy", String(filters.createdBy));
    }

    const queryText = query.toString();
    return res.redirect(
      queryText
        ? `/manager/haccp/reports?${queryText}`
        : "/manager/haccp/reports"
    );
  } catch (error) {
    return next(error);
  }
});

router.get("/entries/:entryId", async (req, res, next) => {
  try {
    const details = await getEntryWithDetails(
      Number(req.params.entryId),
      req.activeOrganizationId
    );
    if (!details) {
      return res.status(404).render("error", {
        title: "Brak wpisu",
        message: "Nie znaleziono wskazanego wpisu HACCP.",
      });
    }

    return res.render("manager/haccp-entry-detail", {
      title: "HACCP - szczegoly wpisu",
      details,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/entries/:entryId/review", async (req, res, next) => {
  try {
    const result = await reviewEntry({
      organizationId: req.activeOrganizationId,
      entryId: Number(req.params.entryId),
      userId: req.user.id,
    });

    if (!result.ok) {
      setFlash(req, "error", result.error || "Nie udalo sie zatwierdzic wpisu.");
      return res.redirect(req.get("referer") || "/manager/haccp/reports");
    }

    setFlash(req, "success", "Wpis zostal zatwierdzony.");
    return res.redirect(req.get("referer") || "/manager/haccp/reports");
  } catch (error) {
    return next(error);
  }
});

router.get("/alerts", async (req, res, next) => {
  try {
    const filters = parseAlertFilters(req.query);
    const alerts = await listAlertsForManager(req.activeOrganizationId, filters);
    return res.render("manager/haccp-alerts", {
      title: "HACCP - alerty",
      alerts,
      filters,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/alerts/:alertId/resolve", async (req, res, next) => {
  try {
    const result = await resolveAlert({
      organizationId: req.activeOrganizationId,
      alertId: Number(req.params.alertId),
      userId: req.user.id,
    });
    if (!result.ok) {
      setFlash(req, "error", result.error || "Nie udalo sie zamknac alertu.");
      return res.redirect(req.get("referer") || "/manager/haccp/alerts");
    }

    setFlash(req, "success", "Alert oznaczony jako rozwiazany.");
    return res.redirect(req.get("referer") || "/manager/haccp/alerts");
  } catch (error) {
    return next(error);
  }
});

router.get("/reports", async (req, res, next) => {
  try {
    const filters = parseEntryFilters(req.query);
    const [reportGroups, processes, employees] = await Promise.all([
      listReportRows(req.activeOrganizationId, filters),
      listProcesses(req.activeOrganizationId, true),
      db.all(
        `
        SELECT
          u.id,
          u.name,
          u.email
        FROM users u
        JOIN user_organizations uo ON uo.user_id = u.id
        WHERE uo.organization_id = ? AND u.role = 'employee'
        ORDER BY u.name ASC
        `,
        [req.activeOrganizationId]
      ),
    ]);
    return res.render("manager/haccp-reports", {
      title: "HACCP - wpisy i raporty",
      reportGroups,
      filters,
      statuses: ENTRY_STATUSES,
      processes,
      employees,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/reports/export.csv", async (req, res, next) => {
  try {
    const filters = parseEntryFilters(req.query);
    const reportGroups = await listReportRows(req.activeOrganizationId, filters);
    const csv = buildCsvReport(reportGroups);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"haccp-report.csv\""
    );
    return res.send(csv);
  } catch (error) {
    return next(error);
  }
});

router.get("/reports/export.pdf", async (req, res, next) => {
  try {
    const filters = parseEntryFilters(req.query);
    const reportGroups = await listReportRows(req.activeOrganizationId, filters);
    const pdfBuffer = await buildPdfReport(reportGroups, filters);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"haccp-report.pdf\""
    );
    return res.send(pdfBuffer);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
