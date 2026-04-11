const { db } = require("../../database");

const FIELD_TYPES = ["BOOLEAN", "NUMBER", "TEXT", "SELECT"];
const FREQUENCY_TYPES = [
  "ON_DEMAND",
  "PER_BATCH",
  "SHIFT_START",
  "SHIFT_END",
  "DAILY",
  "TWICE_DAILY",
  "EVERY_X_HOURS",
  "WEEKLY",
  "MONTHLY",
  "FIXED_TIMES_DAILY",
];
const ENTRY_STATUSES = ["OK", "ALERT", "CRITICAL"];

const LEGACY_FREQUENCY_MAP = {
  NONE: "ON_DEMAND",
  MULTIPLE_PER_DAY: "TWICE_DAILY",
};

const FREQUENCY_LABELS_PL = {
  ON_DEMAND: "Na zadanie",
  PER_BATCH: "Na partie",
  SHIFT_START: "Poczatek zmiany",
  SHIFT_END: "Koniec zmiany",
  DAILY: "Codziennie",
  TWICE_DAILY: "Dwa razy dziennie",
  EVERY_X_HOURS: "Co X godzin",
  WEEKLY: "Co tydzien",
  MONTHLY: "Co miesiac",
  FIXED_TIMES_DAILY: "Stale godziny dziennie",
};

const FREQUENCY_LABELS_EN = {
  ON_DEMAND: "On demand",
  PER_BATCH: "Per batch",
  SHIFT_START: "Shift start",
  SHIFT_END: "Shift end",
  DAILY: "Daily",
  TWICE_DAILY: "Twice daily",
  EVERY_X_HOURS: "Every X hours",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  FIXED_TIMES_DAILY: "Fixed times per day",
};

const FREQUENCY_LABELS_UK = {
  ON_DEMAND: "За потреби",
  PER_BATCH: "На партію",
  SHIFT_START: "Початок зміни",
  SHIFT_END: "Кінець зміни",
  DAILY: "Щодня",
  TWICE_DAILY: "Двічі на день",
  EVERY_X_HOURS: "Кожні X годин",
  WEEKLY: "Щотижня",
  MONTHLY: "Щомісяця",
  FIXED_TIMES_DAILY: "Фіксований час щодня",
};

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

  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6] || "0", 10);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const rounded = Math.round(timestamp / 60000) * 60000;
  const roundedDate = new Date(rounded);

  const y = String(roundedDate.getUTCFullYear()).padStart(4, "0");
  const m = String(roundedDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(roundedDate.getUTCDate()).padStart(2, "0");
  const hh = String(roundedDate.getUTCHours()).padStart(2, "0");
  const mm = String(roundedDate.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:00`;
}

function isLikelyTimeFieldName(fieldName) {
  const normalized = normalizeText(fieldName).toLowerCase();
  if (!normalized) {
    return false;
  }
  return /czas|godzin|godz|time|hour|minut/.test(normalized);
}

function normalizeTimeRelatedFieldValue(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  const trimmed = normalizeText(candidate);
  if (!trimmed) {
    return null;
  }

  const dateTime = normalizeRecordedForAt(trimmed);
  if (dateTime) {
    return dateTime.slice(0, 16);
  }

  const timeMatch = trimmed.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeMatch) {
    return null;
  }

  const hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2], 10);
  const second = Number.parseInt(timeMatch[3] || "0", 10);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const totalSeconds = hour * 3600 + minute * 60 + second;
  const roundedMinutes = Math.round(totalSeconds / 60);
  const normalizedMinutes = ((roundedMinutes % 1440) + 1440) % 1440;
  const roundedHour = Math.floor(normalizedMinutes / 60);
  const roundedMinute = normalizedMinutes % 60;

  return `${String(roundedHour).padStart(2, "0")}:${String(
    roundedMinute
  ).padStart(2, "0")}`;
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
  const normalized = String(value || "ON_DEMAND")
    .trim()
    .toUpperCase();
  const mapped = LEGACY_FREQUENCY_MAP[normalized] || normalized;
  return FREQUENCY_TYPES.includes(mapped) ? mapped : "ON_DEMAND";
}

function buildFrequencyOptions(locale = "pl") {
  return FREQUENCY_TYPES.map((type) => ({
    value: type,
    label: getFrequencyLabel(type, null, locale),
  }));
}

function getFrequencyLabel(type, frequencyValue = null, locale = "pl") {
  const normalizedType = normalizeFrequencyType(type);
  const normalizedLocale = String(locale || "pl").toLowerCase();
  const labelMap =
    normalizedLocale === "en"
      ? FREQUENCY_LABELS_EN
      : normalizedLocale === "uk"
        ? FREQUENCY_LABELS_UK
        : FREQUENCY_LABELS_PL;
  const baseLabel = labelMap[normalizedType] || normalizedType;

  if (
    normalizedType === "EVERY_X_HOURS" &&
    Number.isInteger(Number(frequencyValue)) &&
    Number(frequencyValue) > 0
  ) {
    if (normalizedLocale === "en") {
      return `Every ${Number(frequencyValue)} h`;
    }
    if (normalizedLocale === "uk") {
      return `Кожні ${Number(frequencyValue)} год.`;
    }
    return `Co ${Number(frequencyValue)} godz.`;
  }

  if (
    normalizedType === "FIXED_TIMES_DAILY" &&
    Number.isInteger(Number(frequencyValue)) &&
    Number(frequencyValue) > 0
  ) {
    if (normalizedLocale === "en") {
      return `${baseLabel} (${Number(frequencyValue)}x)`;
    }
    if (normalizedLocale === "uk") {
      return `${baseLabel} (${Number(frequencyValue)}x)`;
    }
    return `${baseLabel} (${Number(frequencyValue)}x)`;
  }

  return baseLabel;
}

function getExpectedEntriesPerDay(frequencyType, frequencyValue) {
  const normalizedType = normalizeFrequencyType(frequencyType);
  const normalizedValue = parseInteger(frequencyValue);

  if (normalizedType === "ON_DEMAND" || normalizedType === "PER_BATCH") {
    return null;
  }
  if (normalizedType === "WEEKLY" || normalizedType === "MONTHLY") {
    return null;
  }
  if (normalizedType === "TWICE_DAILY") {
    return 2;
  }
  if (
    normalizedType === "DAILY" ||
    normalizedType === "SHIFT_START" ||
    normalizedType === "SHIFT_END"
  ) {
    return Math.max(normalizedValue || 1, 1);
  }
  if (normalizedType === "EVERY_X_HOURS") {
    const hours = Math.max(normalizedValue || 0, 1);
    return Math.max(Math.ceil(24 / hours), 1);
  }
  if (normalizedType === "FIXED_TIMES_DAILY") {
    return Math.max(normalizedValue || 1, 1);
  }

  return null;
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
  isLikelyTimeFieldName,
  normalizeTimeRelatedFieldValue,
  escapeCsv,
  normalizePdfText,
  escapePdfText,
  getSeverityForStatus,
  createAuditLog,
  notifyManagers,
  normalizeFrequencyType,
  buildFrequencyOptions,
  getFrequencyLabel,
  getExpectedEntriesPerDay,
  normalizeFieldType,
  normalizeAllowedValues,
};
