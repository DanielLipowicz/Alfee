const { db } = require("../../database");

const FIELD_TYPES = ["BOOLEAN", "NUMBER", "TEXT", "SELECT"];
const FREQUENCY_TYPES = ["NONE", "DAILY", "MULTIPLE_PER_DAY"];
const ENTRY_STATUSES = ["OK", "ALERT", "CRITICAL"];

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  return [value];
}

function parseInteger(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  const parsed = Number.parseInt(String(candidate || "").trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseDecimal(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  if (candidate == null || String(candidate).trim() === "") {
    return null;
  }
  const parsed = Number.parseFloat(String(candidate).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  const normalized = String(candidate || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "tak"].includes(normalized);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeDate(value) {
  const trimmed = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeRecordedForAt(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  const trimmed = normalizeText(candidate);
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  return `${match[1]} ${match[2]}:${match[3]}:00`;
}

function escapeCsv(value) {
  const text = String(value == null ? "" : value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function normalizePdfText(value) {
  return String(value == null ? "" : value)
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfText(value) {
  return normalizePdfText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function getSeverityForStatus(status) {
  if (status === "CRITICAL") {
    return "HIGH";
  }
  if (status === "ALERT") {
    return "MEDIUM";
  }
  return "LOW";
}

function serializeJson(value) {
  return JSON.stringify(value == null ? null : value);
}

async function createAuditLog({
  organizationId = null,
  entityType,
  entityId,
  action,
  oldValue = null,
  newValue = null,
  createdBy = null,
}) {
  await db.run(
    `
    INSERT INTO haccp_audit_logs (
      organization_id,
      entity_type,
      entity_id,
      action,
      old_value,
      new_value,
      created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      organizationId,
      entityType,
      entityId,
      action,
      serializeJson(oldValue),
      serializeJson(newValue),
      createdBy,
    ]
  );
}

async function notifyManagers(organizationId, title, message, url = null) {
  const managers = await db.all(
    `
    SELECT DISTINCT
      u.id
    FROM users u
    JOIN user_organizations uo ON uo.user_id = u.id
    WHERE
      uo.organization_id = ?
      AND u.role = 'manager'
      AND u.is_active = 1
    `,
    [organizationId]
  );

  for (let index = 0; index < managers.length; index += 1) {
    await db.run(
      `
      INSERT INTO notifications (user_id, type, title, message, url)
      VALUES (?, 'haccp', ?, ?, ?)
      `,
      [managers[index].id, title, message, url]
    );
  }
}

function normalizeFrequencyType(value) {
  const normalized = String(value || "NONE")
    .trim()
    .toUpperCase();
  return FREQUENCY_TYPES.includes(normalized) ? normalized : "NONE";
}

function normalizeFieldType(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return FIELD_TYPES.includes(normalized) ? normalized : null;
}

function normalizeAllowedValues(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  FIELD_TYPES,
  FREQUENCY_TYPES,
  ENTRY_STATUSES,
  toArray,
  parseInteger,
  parseDecimal,
  parseBoolean,
  normalizeText,
  normalizeDate,
  normalizeRecordedForAt,
  escapeCsv,
  normalizePdfText,
  escapePdfText,
  getSeverityForStatus,
  createAuditLog,
  notifyManagers,
  normalizeFrequencyType,
  normalizeFieldType,
  normalizeAllowedValues,
};
