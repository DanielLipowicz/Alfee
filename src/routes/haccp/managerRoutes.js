const express = require("express");

const { db } = require("../../database");
const { ensureAuthenticated, ensureManager } = require("../../middleware/auth");
const { ensureManagerOrganization } = require("../../middleware/tenant");
const { setFlash } = require("../../utils/flash");
const {
  FIELD_TYPES,
  buildFrequencyOptions,
  getFrequencyLabel,
  getExpectedEntriesPerDay,
  normalizeFrequencyType,
  ENTRY_STATUSES,
  parseEntryFilters,
  parseAlertFilters,
  listProcesses,
  getProcessWithFields,
  createEntry,
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
} = require("../../utils/haccp");

const router = express.Router();

function blankProcessFormData() {
  return {
    name: "",
    description: "",
    frequencyType: "ON_DEMAND",
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
    frequencyType: normalizeFrequencyType(process.frequency_type),
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

function mapProcessFrequencyLabel(process, locale = "pl") {
  return {
    ...process,
    frequency_label: getFrequencyLabel(
      process.frequency_type,
      process.frequency_value,
      locale
    ),
  };
}

function extractDateFromDedupeKey(dedupeKey) {
  const raw = String(dedupeKey || "");
  const match = raw.match(/^missing:\d+:(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
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
    const [stats, latestAlerts, latestEntries, processesRaw] = await Promise.all([
      getManagerDashboardStats(req.activeOrganizationId),
      listAlertsForManager(req.activeOrganizationId, { resolved: 0 }),
      listEntriesForManager(req.activeOrganizationId, {}),
      listProcesses(req.activeOrganizationId, true),
    ]);
    const processes = processesRaw.map((process) =>
      mapProcessFrequencyLabel(process, req.locale)
    );

    return res.render("manager/haccp-dashboard", {
      title: "HACCP",
      stats,
      latestAlerts: latestAlerts.slice(0, 8),
      latestEntries: latestEntries.slice(0, 8),
      processes,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/processes", async (req, res, next) => {
  try {
    const processesRaw = await listProcesses(req.activeOrganizationId, true);
    const processes = processesRaw.map((process) =>
      mapProcessFrequencyLabel(process, req.locale)
    );
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
    frequencyOptions: buildFrequencyOptions(_req.locale),
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
        frequencyOptions: buildFrequencyOptions(req.locale),
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
      frequencyOptions: buildFrequencyOptions(req.locale),
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
        frequencyOptions: buildFrequencyOptions(req.locale),
        errors: result.errors || ["Nie udalo sie zapisac zmian."],
      });
    }

    if (result.modelArchived) {
      setFlash(
        req,
        "success",
        `Model procesu zostal zmieniony. Stara wersja zostala zarchiwizowana jako "${result.archivedProcessName}".`
      );
    } else {
      setFlash(req, "success", "Zaktualizowano proces HACCP.");
    }
    return res.redirect("/manager/haccp/processes");
  } catch (error) {
    return next(error);
  }
});

router.get("/processes/:processId/new-entry", async (req, res, next) => {
  try {
    const process = await getProcessWithFields(
      Number(req.params.processId),
      req.activeOrganizationId,
      true
    );
    if (!process) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Nie znaleziono aktywnego procesu HACCP dla tej organizacji.",
      });
    }

    return res.render("manager/haccp-entry-form", {
      title: `HACCP - wpis kierownika (${process.name})`,
      process,
      errors: [],
      previousValues: {},
      correctiveAction: "",
      recordedForAt: "",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/processes/:processId/entries", async (req, res, next) => {
  try {
    const process = await getProcessWithFields(
      Number(req.params.processId),
      req.activeOrganizationId,
      true
    );
    if (!process) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Nie znaleziono aktywnego procesu HACCP dla tej organizacji.",
      });
    }

    const result = await createEntry({
      organizationId: req.activeOrganizationId,
      processId: process.id,
      userId: req.user.id,
      body: req.body,
    });

    if (!result.ok) {
      return res.status(400).render("manager/haccp-entry-form", {
        title: `HACCP - wpis kierownika (${process.name})`,
        process: result.process || process,
        errors: result.errors || ["Nie udalo sie zapisac wpisu."],
        previousValues: req.body,
        correctiveAction: String(req.body.correctiveAction || ""),
        recordedForAt: String(req.body.recordedForAt || ""),
      });
    }

    setFlash(req, "success", `Dodano wpis procesu (status: ${result.status}).`);
    return res.redirect("/manager/haccp/reports");
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

router.get("/alerts/:alertId/fill-missing", async (req, res, next) => {
  try {
    const alert = await db.get(
      `
      SELECT
        a.*,
        p.name AS process_name
      FROM haccp_alerts a
      LEFT JOIN haccp_processes p ON p.id = a.process_id
      WHERE a.id = ? AND a.organization_id = ?
      `,
      [Number(req.params.alertId), req.activeOrganizationId]
    );

    if (!alert) {
      return res.status(404).render("error", {
        title: "Brak alertu",
        message: "Nie znaleziono wskazanego alertu HACCP.",
      });
    }

    if (alert.alert_type !== "MISSING_ENTRY" || !alert.process_id) {
      setFlash(req, "error", "Ten alert nie dotyczy brakujacego wpisu.");
      return res.redirect("/manager/haccp/alerts");
    }

    const process = await getProcessWithFields(
      Number(alert.process_id),
      req.activeOrganizationId,
      false
    );
    if (!process) {
      return res.status(404).render("error", {
        title: "Brak procesu",
        message: "Proces powiazany z alertem nie jest juz dostepny.",
      });
    }

    const alertDate = extractDateFromDedupeKey(alert.dedupe_key);
    const defaultRecordedForAt = alertDate ? `${alertDate}T08:00` : "";
    return res.render("manager/haccp-missing-entry-form", {
      title: "HACCP - uzupelnij brakujacy wpis",
      alert,
      process,
      errors: [],
      previousValues: {},
      correctiveAction: "",
      recordedForAt: defaultRecordedForAt,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/alerts/:alertId/fill-missing", async (req, res, next) => {
  try {
    const alert = await db.get(
      `
      SELECT
        a.*,
        p.name AS process_name,
        p.frequency_type,
        p.frequency_value
      FROM haccp_alerts a
      LEFT JOIN haccp_processes p ON p.id = a.process_id
      WHERE a.id = ? AND a.organization_id = ?
      `,
      [Number(req.params.alertId), req.activeOrganizationId]
    );

    if (!alert) {
      return res.status(404).render("error", {
        title: "Brak alertu",
        message: "Nie znaleziono wskazanego alertu HACCP.",
      });
    }
    if (alert.alert_type !== "MISSING_ENTRY" || !alert.process_id) {
      setFlash(req, "error", "Ten alert nie dotyczy brakujacego wpisu.");
      return res.redirect("/manager/haccp/alerts");
    }

    const result = await createEntry({
      organizationId: req.activeOrganizationId,
      processId: Number(alert.process_id),
      userId: req.user.id,
      body: req.body,
      allowInactiveProcess: true,
    });

    if (!result.ok) {
      const process = result.process
        ? result.process
        : await getProcessWithFields(
            Number(alert.process_id),
            req.activeOrganizationId,
            false
          );
      return res.status(400).render("manager/haccp-missing-entry-form", {
        title: "HACCP - uzupelnij brakujacy wpis",
        alert,
        process,
        errors: result.errors || ["Nie udalo sie zapisac wpisu."],
        previousValues: req.body,
        correctiveAction: String(req.body.correctiveAction || ""),
        recordedForAt: String(req.body.recordedForAt || ""),
      });
    }

    const alertDate = extractDateFromDedupeKey(alert.dedupe_key);
    let missingResolved = false;

    if (alertDate) {
      const requiredCount = getExpectedEntriesPerDay(
        alert.frequency_type,
        alert.frequency_value
      );
      if (requiredCount == null) {
        setFlash(
          req,
          "success",
          `Uzupelniono wpis (dotyczy: ${result.recordedForAt || "teraz"}).`
        );
        return res.redirect("/manager/haccp/alerts");
      }

      const countRow = await db.get(
        `
        SELECT COUNT(*) AS total
        FROM haccp_process_entries
        WHERE
          process_id = ?
          AND organization_id = ?
          AND date(COALESCE(recorded_for_at, created_at)) = ?
        `,
        [Number(alert.process_id), req.activeOrganizationId, alertDate]
      );
      const currentCount = Number(countRow?.total || 0);
      if (currentCount >= requiredCount) {
        const resolveResult = await resolveAlert({
          organizationId: req.activeOrganizationId,
          alertId: Number(alert.id),
          userId: req.user.id,
        });
        missingResolved = resolveResult.ok;
      }
    }

    if (missingResolved) {
      setFlash(
        req,
        "success",
        `Uzupelniono brakujacy wpis (dotyczy: ${result.recordedForAt || "teraz"}) i zamknieto alert.`
      );
    } else {
      setFlash(
        req,
        "success",
        `Uzupelniono wpis (dotyczy: ${result.recordedForAt || "teraz"}). Alert pozostaje otwarty, jesli czestotliwosc nadal nie jest domknieta.`
      );
    }
    return res.redirect("/manager/haccp/alerts");
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
