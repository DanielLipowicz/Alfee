const { db } = require("../../database");
const {
  normalizeDate,
  getExpectedEntriesPerDay,
  createAuditLog,
  notifyManagers,
} = require("./shared");

async function ensureMissingEntryAlerts(organizationId, createdBy = null) {
  const targetDateRow = await db.get("SELECT date('now', '-1 day') AS target_date");
  const targetDate = targetDateRow?.target_date;
  if (!targetDate) {
    return;
  }

  const processes = await db.all(
    `
    SELECT
      id,
      name,
      frequency_type,
      frequency_value,
      created_at
    FROM haccp_processes
    WHERE
      organization_id = ?
      AND is_active = 1
      AND date(created_at) <= ?
    ORDER BY id ASC
    `,
    [organizationId, targetDate]
  );

  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index];
    const requiredCount = getExpectedEntriesPerDay(
      process.frequency_type,
      process.frequency_value
    );

    if (requiredCount == null) {
      continue;
    }

    const entryCountRow = await db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_process_entries
      WHERE process_id = ? AND date(COALESCE(recorded_for_at, created_at)) = ?
      `,
      [process.id, targetDate]
    );
    const executedCount = Number(entryCountRow?.total || 0);
    if (executedCount >= requiredCount) {
      continue;
    }

    const dedupeKey = `missing:${process.id}:${targetDate}`;
    const existing = await db.get(
      `
      SELECT id
      FROM haccp_alerts
      WHERE dedupe_key = ?
      `,
      [dedupeKey]
    );
    if (existing) {
      continue;
    }

    const severity = requiredCount - executedCount > 1 ? "HIGH" : "MEDIUM";
    const message = `Brak wpisu HACCP: proces "${process.name}" dnia ${targetDate} (wymagane ${requiredCount}, wykonane ${executedCount}).`;
    const created = await db.run(
      `
      INSERT INTO haccp_alerts (
        organization_id,
        process_id,
        severity,
        message,
        alert_type,
        dedupe_key
      )
      VALUES (?, ?, ?, ?, 'MISSING_ENTRY', ?)
      `,
      [organizationId, process.id, severity, message, dedupeKey]
    );

    await createAuditLog({
      organizationId,
      entityType: "Alert",
      entityId: created.lastID,
      action: "CREATE",
      oldValue: null,
      newValue: {
        severity,
        message,
        alertType: "MISSING_ENTRY",
      },
      createdBy,
    });

    await notifyManagers(
      organizationId,
      "HACCP: brak wpisu",
      message,
      "/manager/haccp/alerts"
    );
  }
}

function parseAlertFilters(query) {
  const resolvedRaw = String(query.resolved || "").trim().toLowerCase();
  if (resolvedRaw === "1" || resolvedRaw === "true") {
    return { resolved: 1 };
  }
  if (resolvedRaw === "0" || resolvedRaw === "false") {
    return { resolved: 0 };
  }
  return { resolved: null };
}

function parseMissingEntryDedupeKey(dedupeKey) {
  const match = /^missing:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(
    String(dedupeKey || "").trim()
  );
  if (!match) {
    return null;
  }

  const processId = Number.parseInt(match[1], 10);
  const targetDate = match[2];
  if (!Number.isInteger(processId) || !normalizeDate(targetDate)) {
    return null;
  }

  return { processId, targetDate };
}

async function listAlertsForManager(organizationId, filters = { resolved: null }) {
  const where = ["a.organization_id = ?"];
  const params = [organizationId];

  if (filters.resolved === 0 || filters.resolved === 1) {
    where.push("a.resolved = ?");
    params.push(filters.resolved);
  }

  const rows = await db.all(
    `
    SELECT
      a.id,
      a.entry_id,
      a.process_id,
      a.severity,
      a.message,
      a.alert_type,
      a.dedupe_key,
      a.created_at,
      a.resolved,
      a.resolved_at,
      p.name AS process_name,
      e.status AS entry_status,
      u.name AS entry_author_name
    FROM haccp_alerts a
    LEFT JOIN haccp_processes p ON p.id = a.process_id
    LEFT JOIN haccp_process_entries e ON e.id = a.entry_id
    LEFT JOIN users u ON u.id = e.created_by
    WHERE ${where.join(" AND ")}
    ORDER BY a.resolved ASC, a.created_at DESC
    LIMIT 500
    `,
    params
  );

  return rows.map((alert) => {
    if (alert.alert_type !== "MISSING_ENTRY") {
      return {
        ...alert,
        referenceUrl: null,
        referenceLabel: null,
      };
    }

    const missingInfo = parseMissingEntryDedupeKey(alert.dedupe_key);
    if (!missingInfo) {
      return {
        ...alert,
        referenceUrl: null,
        referenceLabel: null,
      };
    }

    return {
      ...alert,
      referenceUrl:
        `/manager/haccp/reports?processId=${missingInfo.processId}` +
        `&dateFrom=${missingInfo.targetDate}&dateTo=${missingInfo.targetDate}`,
      referenceLabel: `Brak z dnia ${missingInfo.targetDate}`,
    };
  });
}

async function listAlertsForEmployee(userId) {
  return db.all(
    `
    SELECT
      a.id,
      a.severity,
      a.message,
      a.created_at,
      a.resolved,
      a.resolved_at,
      p.name AS process_name,
      e.id AS entry_id
    FROM haccp_alerts a
    JOIN haccp_process_entries e ON e.id = a.entry_id
    JOIN haccp_processes p ON p.id = e.process_id
    WHERE e.created_by = ?
    ORDER BY a.created_at DESC
    LIMIT 200
    `,
    [userId]
  );
}

async function resolveAlert({ organizationId, alertId, userId }) {
  const alert = await db.get(
    `
    SELECT
      id,
      resolved,
      resolved_at,
      resolved_by
    FROM haccp_alerts
    WHERE id = ? AND organization_id = ?
    `,
    [alertId, organizationId]
  );

  if (!alert) {
    return {
      ok: false,
      notFound: true,
      error: "Nie znaleziono alertu.",
    };
  }
  if (Number(alert.resolved) === 1) {
    return {
      ok: false,
      error: "Alert jest juz rozwiazany.",
    };
  }

  await db.run(
    `
    UPDATE haccp_alerts
    SET
      resolved = 1,
      resolved_at = CURRENT_TIMESTAMP,
      resolved_by = ?
    WHERE id = ? AND organization_id = ?
    `,
    [userId, alertId, organizationId]
  );

  await createAuditLog({
    organizationId,
    entityType: "Alert",
    entityId: alertId,
    action: "UPDATE",
    oldValue: alert,
    newValue: {
      ...alert,
      resolved: 1,
      resolved_by: userId,
    },
    createdBy: userId,
  });

  return { ok: true };
}

module.exports = {
  ensureMissingEntryAlerts,
  parseAlertFilters,
  listAlertsForManager,
  listAlertsForEmployee,
  resolveAlert,
};
