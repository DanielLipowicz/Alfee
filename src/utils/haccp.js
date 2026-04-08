const fs = require("fs");
const path = require("path");

const { db } = require("../database");

const FIELD_TYPES = ["BOOLEAN", "NUMBER", "TEXT", "SELECT"];
const FREQUENCY_TYPES = ["NONE", "DAILY", "MULTIPLE_PER_DAY"];
const ENTRY_STATUSES = ["OK", "ALERT", "CRITICAL"];

function getPdfDocumentConstructor() {
  try {
    return require("pdfkit");
  } catch (error) {
    error.message = `Nie mozna zaladowac biblioteki PDF (pdfkit): ${error.message}`;
    throw error;
  }
}

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

function parseFieldsFromForm(body) {
  const names = toArray(body.fieldName);
  const types = toArray(body.fieldType);
  const requiredFlags = toArray(body.fieldRequired);
  const minValues = toArray(body.fieldMinValue);
  const maxValues = toArray(body.fieldMaxValue);
  const allowedValues = toArray(body.fieldAllowedValues);
  const orders = toArray(body.fieldOrder);
  const maxLength = Math.max(
    names.length,
    types.length,
    requiredFlags.length,
    minValues.length,
    maxValues.length,
    allowedValues.length,
    orders.length
  );

  const fields = [];
  const errors = [];

  for (let index = 0; index < maxLength; index += 1) {
    const rawName = normalizeText(names[index]);
    const rawType = normalizeFieldType(types[index]);
    const rawRequired = parseBoolean(requiredFlags[index]);
    const rawMin = parseDecimal(minValues[index]);
    const rawMax = parseDecimal(maxValues[index]);
    const rawAllowed = normalizeAllowedValues(allowedValues[index]);
    const rawOrder = parseInteger(orders[index]) || index + 1;

    const isEmptyRow =
      !rawName &&
      !rawType &&
      requiredFlags[index] == null &&
      minValues[index] == null &&
      maxValues[index] == null &&
      allowedValues[index] == null;
    if (isEmptyRow) {
      continue;
    }

    if (!rawName) {
      errors.push(`Pole #${index + 1}: nazwa jest wymagana.`);
      continue;
    }
    if (!rawType) {
      errors.push(`Pole #${index + 1}: niepoprawny typ pola.`);
      continue;
    }
    if (
      rawType === "NUMBER" &&
      rawMin != null &&
      rawMax != null &&
      rawMin > rawMax
    ) {
      errors.push(
        `Pole "${rawName}": min_value nie moze byc wieksze od max_value.`
      );
      continue;
    }
    if (rawType === "SELECT" && rawAllowed.length === 0) {
      errors.push(
        `Pole "${rawName}": dla typu SELECT podaj dozwolone wartosci (oddzielone przecinkami).`
      );
      continue;
    }

    fields.push({
      name: rawName,
      type: rawType,
      required: rawRequired,
      minValue: rawType === "NUMBER" ? rawMin : null,
      maxValue: rawType === "NUMBER" ? rawMax : null,
      allowedValues: rawType === "SELECT" ? rawAllowed : [],
      order: rawOrder,
    });
  }

  return { fields, errors };
}

function validateProcessPayload(payload) {
  const errors = [];

  if (!payload.name) {
    errors.push("Nazwa procesu jest wymagana.");
  }
  if (!FREQUENCY_TYPES.includes(payload.frequencyType)) {
    errors.push("Niepoprawny typ czestotliwosci.");
  }
  if (payload.frequencyType === "MULTIPLE_PER_DAY") {
    if (!payload.frequencyValue || payload.frequencyValue < 1) {
      errors.push("Dla MULTIPLE_PER_DAY podaj liczbe >= 1.");
    }
  }
  if (payload.frequencyType === "DAILY") {
    if (payload.frequencyValue != null && payload.frequencyValue < 1) {
      errors.push("Dla DAILY liczba wykonania musi byc >= 1.");
    }
  }
  if (!Array.isArray(payload.fields) || payload.fields.length === 0) {
    errors.push("Proces musi miec przynajmniej jedno pole.");
  }

  return errors;
}

function parseProcessPayload(body) {
  const name = normalizeText(body.name);
  const description = normalizeText(body.description);
  const frequencyType = normalizeFrequencyType(body.frequencyType);
  const frequencyValueRaw = parseInteger(body.frequencyValue);
  const isActive = body.isActive == null ? true : parseBoolean(body.isActive);
  const isCcp = parseBoolean(body.isCcp);
  const parsedFields = parseFieldsFromForm(body);
  const frequencyValue =
    frequencyType === "NONE"
      ? null
      : frequencyValueRaw == null
        ? frequencyType === "MULTIPLE_PER_DAY"
          ? 1
          : null
        : frequencyValueRaw;

  return {
    payload: {
      name,
      description,
      frequencyType,
      frequencyValue,
      isActive,
      isCcp,
      fields: parsedFields.fields,
    },
    errors: parsedFields.errors,
  };
}

async function listProcesses(organizationId, includeInactive = true) {
  const activeFilter = includeInactive ? "" : "AND p.is_active = 1";
  return db.all(
    `
    SELECT
      p.id,
      p.name,
      p.description,
      p.is_active,
      p.frequency_type,
      p.frequency_value,
      p.is_ccp,
      p.created_at,
      p.updated_at,
      COUNT(DISTINCT f.id) AS field_count,
      COUNT(DISTINCT e.id) AS entry_count
    FROM haccp_processes p
    LEFT JOIN haccp_process_fields f ON f.process_id = p.id
    LEFT JOIN haccp_process_entries e ON e.process_id = p.id
    WHERE p.organization_id = ?
    ${activeFilter}
    GROUP BY p.id
    ORDER BY p.name ASC
    `,
    [organizationId]
  );
}

async function getProcessWithFields(processId, organizationId, onlyActive = false) {
  const activeFilter = onlyActive ? "AND p.is_active = 1" : "";
  const process = await db.get(
    `
    SELECT *
    FROM haccp_processes p
    WHERE p.id = ? AND p.organization_id = ?
    ${activeFilter}
    `,
    [processId, organizationId]
  );

  if (!process) {
    return null;
  }

  const fields = await db.all(
    `
    SELECT
      id,
      process_id,
      name,
      type,
      required,
      min_value,
      max_value,
      allowed_values,
      field_order
    FROM haccp_process_fields
    WHERE process_id = ?
    ORDER BY field_order ASC, id ASC
    `,
    [process.id]
  );

  return {
    ...process,
    fields: fields.map((field) => ({
      ...field,
      allowed_values: normalizeAllowedValues(field.allowed_values),
    })),
  };
}

async function createProcess({ organizationId, userId, body }) {
  const parsed = parseProcessPayload(body);
  const payloadErrors = validateProcessPayload(parsed.payload);
  const errors = [...parsed.errors, ...payloadErrors];

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      data: parsed.payload,
    };
  }

  const existing = await db.get(
    `
    SELECT id
    FROM haccp_processes
    WHERE organization_id = ? AND lower(name) = lower(?)
    `,
    [organizationId, parsed.payload.name]
  );

  if (existing) {
    return {
      ok: false,
      errors: ["Proces o tej nazwie juz istnieje w tej organizacji."],
      data: parsed.payload,
    };
  }

  await db.run("BEGIN TRANSACTION");
  try {
    const created = await db.run(
      `
      INSERT INTO haccp_processes (
        organization_id,
        name,
        description,
        is_active,
        frequency_type,
        frequency_value,
        is_ccp,
        created_by,
        updated_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        organizationId,
        parsed.payload.name,
        parsed.payload.description || null,
        parsed.payload.isActive ? 1 : 0,
        parsed.payload.frequencyType,
        parsed.payload.frequencyValue,
        parsed.payload.isCcp ? 1 : 0,
        userId,
        userId,
      ]
    );

    for (let index = 0; index < parsed.payload.fields.length; index += 1) {
      const field = parsed.payload.fields[index];
      await db.run(
        `
        INSERT INTO haccp_process_fields (
          process_id,
          name,
          type,
          required,
          min_value,
          max_value,
          allowed_values,
          field_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          created.lastID,
          field.name,
          field.type,
          field.required ? 1 : 0,
          field.minValue,
          field.maxValue,
          field.allowedValues.length > 0 ? field.allowedValues.join(",") : null,
          field.order,
        ]
      );
    }

    await createAuditLog({
      organizationId,
      entityType: "Process",
      entityId: created.lastID,
      action: "CREATE",
      oldValue: null,
      newValue: parsed.payload,
      createdBy: userId,
    });

    await db.run("COMMIT");
    return {
      ok: true,
      processId: created.lastID,
    };
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}

async function updateProcess({ organizationId, processId, userId, body }) {
  const current = await getProcessWithFields(processId, organizationId, false);
  if (!current) {
    return {
      ok: false,
      errors: ["Nie znaleziono procesu HACCP."],
      data: null,
      notFound: true,
    };
  }

  const parsed = parseProcessPayload(body);
  const payloadErrors = validateProcessPayload(parsed.payload);
  const errors = [...parsed.errors, ...payloadErrors];

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      data: parsed.payload,
    };
  }

  const duplicate = await db.get(
    `
    SELECT id
    FROM haccp_processes
    WHERE
      organization_id = ?
      AND lower(name) = lower(?)
      AND id <> ?
    `,
    [organizationId, parsed.payload.name, processId]
  );

  if (duplicate) {
    return {
      ok: false,
      errors: ["Proces o tej nazwie juz istnieje w tej organizacji."],
      data: parsed.payload,
    };
  }

  await db.run("BEGIN TRANSACTION");
  try {
    await db.run(
      `
      UPDATE haccp_processes
      SET
        name = ?,
        description = ?,
        is_active = ?,
        frequency_type = ?,
        frequency_value = ?,
        is_ccp = ?,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
      WHERE id = ? AND organization_id = ?
      `,
      [
        parsed.payload.name,
        parsed.payload.description || null,
        parsed.payload.isActive ? 1 : 0,
        parsed.payload.frequencyType,
        parsed.payload.frequencyValue,
        parsed.payload.isCcp ? 1 : 0,
        userId,
        processId,
        organizationId,
      ]
    );

    await db.run("DELETE FROM haccp_process_fields WHERE process_id = ?", [
      processId,
    ]);

    for (let index = 0; index < parsed.payload.fields.length; index += 1) {
      const field = parsed.payload.fields[index];
      await db.run(
        `
        INSERT INTO haccp_process_fields (
          process_id,
          name,
          type,
          required,
          min_value,
          max_value,
          allowed_values,
          field_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          processId,
          field.name,
          field.type,
          field.required ? 1 : 0,
          field.minValue,
          field.maxValue,
          field.allowedValues.length > 0 ? field.allowedValues.join(",") : null,
          field.order,
        ]
      );
    }

    await createAuditLog({
      organizationId,
      entityType: "Process",
      entityId: processId,
      action: "UPDATE",
      oldValue: {
        ...current,
        is_active: Number(current.is_active) === 1,
        is_ccp: Number(current.is_ccp) === 1,
      },
      newValue: parsed.payload,
      createdBy: userId,
    });

    await db.run("COMMIT");
    return {
      ok: true,
      processId,
    };
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}

function classifyDeviation({ value, minValue, maxValue, isCcp }) {
  if (value == null) {
    return null;
  }
  const hasMin = minValue != null;
  const hasMax = maxValue != null;
  if (!hasMin && !hasMax) {
    return null;
  }

  let outBy = 0;
  let expectedBoundary = null;
  if (hasMin && value < minValue) {
    outBy = minValue - value;
    expectedBoundary = minValue;
  }
  if (hasMax && value > maxValue) {
    outBy = value - maxValue;
    expectedBoundary = maxValue;
  }
  if (outBy <= 0) {
    return null;
  }

  if (isCcp) {
    return "CRITICAL";
  }

  const span =
    hasMin && hasMax ? Math.max(Math.abs(maxValue - minValue), 1) : null;
  const denominator =
    span != null ? span : Math.max(Math.abs(expectedBoundary || 0), 1);
  const ratio = outBy / denominator;
  return ratio <= 0.1 ? "ALERT" : "CRITICAL";
}

function resolveEntryStatus(deviations) {
  if (deviations.some((item) => item.level === "CRITICAL")) {
    return "CRITICAL";
  }
  if (deviations.some((item) => item.level === "ALERT")) {
    return "ALERT";
  }
  return "OK";
}

function normalizeEntryPayload(processDefinition, body) {
  const values = [];
  const errors = [];
  const deviations = [];

  for (let index = 0; index < processDefinition.fields.length; index += 1) {
    const field = processDefinition.fields[index];
    const rawValue = body[`field_${field.id}`];
    const textValue = normalizeText(rawValue);
    const isRequired = Number(field.required) === 1;

    if (isRequired && textValue === "") {
      errors.push(`Pole "${field.name}" jest wymagane.`);
      continue;
    }
    if (textValue === "") {
      values.push({ fieldId: field.id, value: null });
      continue;
    }

    if (field.type === "NUMBER") {
      const numberValue = parseDecimal(textValue);
      if (numberValue == null) {
        errors.push(`Pole "${field.name}" musi byc liczba.`);
        continue;
      }

      const minValue = parseDecimal(field.min_value);
      const maxValue = parseDecimal(field.max_value);
      const level = classifyDeviation({
        value: numberValue,
        minValue,
        maxValue,
        isCcp: Number(processDefinition.is_ccp) === 1,
      });
      if (level) {
        const bounds = [];
        if (minValue != null) {
          bounds.push(`min ${minValue}`);
        }
        if (maxValue != null) {
          bounds.push(`max ${maxValue}`);
        }
        deviations.push({
          fieldName: field.name,
          level,
          message: `Pole "${field.name}" (${numberValue}) poza zakresem ${bounds.join(", ")}.`,
        });
      }

      values.push({ fieldId: field.id, value: String(numberValue) });
      continue;
    }

    if (field.type === "BOOLEAN") {
      values.push({
        fieldId: field.id,
        value: parseBoolean(textValue) ? "1" : "0",
      });
      continue;
    }

    if (field.type === "SELECT") {
      const allowed = normalizeAllowedValues(field.allowed_values);
      if (!allowed.includes(textValue)) {
        errors.push(
          `Pole "${field.name}" ma niedozwolona wartosc. Dostepne: ${allowed.join(", ")}.`
        );
        continue;
      }
      values.push({ fieldId: field.id, value: textValue });
      continue;
    }

    values.push({ fieldId: field.id, value: textValue });
  }

  const status = resolveEntryStatus(deviations);
  return { values, status, errors, deviations };
}

async function createEntry({ organizationId, processId, userId, body }) {
  const processDefinition = await getProcessWithFields(
    processId,
    organizationId,
    true
  );
  if (!processDefinition) {
    return {
      ok: false,
      errors: ["Proces HACCP jest nieaktywny lub niedostepny."],
      process: null,
      entryValidation: null,
    };
  }

  const entryValidation = normalizeEntryPayload(processDefinition, body);
  if (entryValidation.errors.length > 0) {
    return {
      ok: false,
      errors: entryValidation.errors,
      process: processDefinition,
      entryValidation,
    };
  }

  const correctiveAction = normalizeText(body.correctiveAction);
  if (entryValidation.status !== "OK" && !correctiveAction) {
    return {
      ok: false,
      errors: [
        "Dla wpisu z ALERT/CRITICAL dodaj dzialanie korygujace przed zapisem.",
      ],
      process: processDefinition,
      entryValidation,
    };
  }

  await db.run("BEGIN TRANSACTION");
  try {
    const createdEntry = await db.run(
      `
      INSERT INTO haccp_process_entries (
        process_id,
        organization_id,
        created_by,
        status
      )
      VALUES (?, ?, ?, ?)
      `,
      [processId, organizationId, userId, entryValidation.status]
    );

    for (let index = 0; index < entryValidation.values.length; index += 1) {
      const item = entryValidation.values[index];
      await db.run(
        `
        INSERT INTO haccp_process_entry_values (entry_id, field_id, value)
        VALUES (?, ?, ?)
        `,
        [createdEntry.lastID, item.fieldId, item.value]
      );
    }

    let correctiveActionId = null;
    if (entryValidation.status !== "OK") {
      const corrective = await db.run(
        `
        INSERT INTO haccp_corrective_actions (entry_id, description, created_by)
        VALUES (?, ?, ?)
        `,
        [createdEntry.lastID, correctiveAction, userId]
      );
      correctiveActionId = corrective.lastID;
    }

    let alertId = null;
    if (entryValidation.status !== "OK") {
      const alertMessage = entryValidation.deviations
        .map((item) => item.message)
        .join(" ");
      const createdAlert = await db.run(
        `
        INSERT INTO haccp_alerts (
          organization_id,
          process_id,
          entry_id,
          severity,
          message,
          alert_type
        )
        VALUES (?, ?, ?, ?, ?, 'ENTRY_DEVIATION')
        `,
        [
          organizationId,
          processId,
          createdEntry.lastID,
          getSeverityForStatus(entryValidation.status),
          alertMessage || "Wpis oznaczony jako niezgodny.",
        ]
      );
      alertId = createdAlert.lastID;
    }

    await createAuditLog({
      organizationId,
      entityType: "ProcessEntry",
      entityId: createdEntry.lastID,
      action: "CREATE",
      oldValue: null,
      newValue: {
        status: entryValidation.status,
        values: entryValidation.values,
      },
      createdBy: userId,
    });

    if (correctiveActionId) {
      await createAuditLog({
        organizationId,
        entityType: "CorrectiveAction",
        entityId: correctiveActionId,
        action: "CREATE",
        oldValue: null,
        newValue: { description: correctiveAction },
        createdBy: userId,
      });
    }

    if (alertId) {
      await createAuditLog({
        organizationId,
        entityType: "Alert",
        entityId: alertId,
        action: "CREATE",
        oldValue: null,
        newValue: {
          severity: getSeverityForStatus(entryValidation.status),
          status: entryValidation.status,
        },
        createdBy: userId,
      });
    }

    await db.run("COMMIT");

    if (entryValidation.status !== "OK") {
      await notifyManagers(
        organizationId,
        `HACCP: nowe ${entryValidation.status}`,
        `Proces "${processDefinition.name}" otrzymal wpis o statusie ${entryValidation.status}.`,
        "/manager/haccp/alerts"
      );
      await notifyManagers(
        organizationId,
        "HACCP: nowe dzialanie korygujace",
        `Dodano dzialanie korygujace do procesu "${processDefinition.name}".`,
        "/manager/haccp/reports"
      );
    }

    return {
      ok: true,
      entryId: createdEntry.lastID,
      status: entryValidation.status,
      process: processDefinition,
    };
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}

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
      AND frequency_type IN ('DAILY', 'MULTIPLE_PER_DAY')
      AND date(created_at) <= ?
    ORDER BY id ASC
    `,
    [organizationId, targetDate]
  );

  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index];
    const requiredCount =
      process.frequency_type === "MULTIPLE_PER_DAY"
        ? Math.max(parseInteger(process.frequency_value) || 1, 1)
        : Math.max(parseInteger(process.frequency_value) || 1, 1);

    const entryCountRow = await db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_process_entries
      WHERE process_id = ? AND date(created_at) = ?
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

function parseEntryFilters(query) {
  const dateFrom = normalizeDate(query.dateFrom);
  const dateTo = normalizeDate(query.dateTo);
  const status = ENTRY_STATUSES.includes(String(query.status || "").toUpperCase())
    ? String(query.status).toUpperCase()
    : null;
  const processId = parseInteger(query.processId);
  const createdBy = parseInteger(query.createdBy);

  return {
    dateFrom,
    dateTo,
    status,
    processId,
    createdBy,
  };
}

async function listEntriesForManager(organizationId, filters = {}) {
  const where = ["e.organization_id = ?"];
  const params = [organizationId];

  if (filters.dateFrom) {
    where.push("date(e.created_at) >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("date(e.created_at) <= ?");
    params.push(filters.dateTo);
  }
  if (filters.status) {
    where.push("e.status = ?");
    params.push(filters.status);
  }
  if (filters.processId) {
    where.push("e.process_id = ?");
    params.push(filters.processId);
  }
  if (filters.createdBy) {
    where.push("e.created_by = ?");
    params.push(filters.createdBy);
  }

  return db.all(
    `
    SELECT
      e.id,
      e.process_id,
      e.created_at,
      e.created_by,
      e.status,
      e.is_reviewed,
      e.reviewed_by,
      e.reviewed_at,
      p.name AS process_name,
      p.is_ccp,
      u.name AS created_by_name,
      reviewer.name AS reviewed_by_name,
      COUNT(DISTINCT ca.id) AS corrective_action_count,
      GROUP_CONCAT(ca.description, ' | ') AS corrective_action_text
    FROM haccp_process_entries e
    JOIN haccp_processes p ON p.id = e.process_id
    JOIN users u ON u.id = e.created_by
    LEFT JOIN users reviewer ON reviewer.id = e.reviewed_by
    LEFT JOIN haccp_corrective_actions ca ON ca.entry_id = e.id
    WHERE ${where.join(" AND ")}
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT 500
    `,
    params
  );
}

async function listEntriesForEmployee(userId) {
  return db.all(
    `
    SELECT
      e.id,
      e.created_at,
      e.status,
      e.is_reviewed,
      e.reviewed_at,
      p.name AS process_name,
      p.organization_id,
      o.name AS organization_name,
      COUNT(DISTINCT ca.id) AS corrective_action_count
    FROM haccp_process_entries e
    JOIN haccp_processes p ON p.id = e.process_id
    JOIN organizations o ON o.id = p.organization_id
    JOIN user_organizations uo ON uo.organization_id = p.organization_id
    LEFT JOIN haccp_corrective_actions ca ON ca.entry_id = e.id
    WHERE e.created_by = ? AND uo.user_id = ?
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT 200
    `,
    [userId, userId]
  );
}

async function getEntryWithDetails(entryId, organizationId, createdByUserId = null) {
  const where = ["e.id = ?", "e.organization_id = ?"];
  const params = [entryId, organizationId];
  if (createdByUserId != null) {
    where.push("e.created_by = ?");
    params.push(createdByUserId);
  }

  const entry = await db.get(
    `
    SELECT
      e.*,
      p.name AS process_name,
      p.is_ccp,
      creator.name AS created_by_name,
      reviewer.name AS reviewed_by_name
    FROM haccp_process_entries e
    JOIN haccp_processes p ON p.id = e.process_id
    JOIN users creator ON creator.id = e.created_by
    LEFT JOIN users reviewer ON reviewer.id = e.reviewed_by
    WHERE ${where.join(" AND ")}
    `,
    params
  );

  if (!entry) {
    return null;
  }

  const [values, correctiveActions, alerts] = await Promise.all([
    db.all(
      `
      SELECT
        v.field_id,
        v.value,
        f.name AS field_name,
        f.type AS field_type
      FROM haccp_process_entry_values v
      JOIN haccp_process_fields f ON f.id = v.field_id
      WHERE v.entry_id = ?
      ORDER BY f.field_order ASC, f.id ASC
      `,
      [entry.id]
    ),
    db.all(
      `
      SELECT
        id,
        description,
        created_at,
        created_by
      FROM haccp_corrective_actions
      WHERE entry_id = ?
      ORDER BY created_at ASC
      `,
      [entry.id]
    ),
    db.all(
      `
      SELECT
        id,
        severity,
        message,
        created_at,
        resolved,
        resolved_at
      FROM haccp_alerts
      WHERE entry_id = ?
      ORDER BY created_at DESC
      `,
      [entry.id]
    ),
  ]);

  return {
    entry,
    values,
    correctiveActions,
    alerts,
  };
}

async function reviewEntry({ organizationId, entryId, userId }) {
  const entry = await db.get(
    `
    SELECT
      e.id,
      e.status,
      e.is_reviewed,
      e.reviewed_by,
      e.reviewed_at
    FROM haccp_process_entries e
    WHERE e.id = ? AND e.organization_id = ?
    `,
    [entryId, organizationId]
  );

  if (!entry) {
    return {
      ok: false,
      notFound: true,
      error: "Nie znaleziono wpisu HACCP.",
    };
  }
  if (Number(entry.is_reviewed) === 1) {
    return {
      ok: false,
      error: "Wpis jest juz zatwierdzony.",
    };
  }

  if (entry.status !== "OK") {
    const corrective = await db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_corrective_actions
      WHERE entry_id = ?
      `,
      [entryId]
    );
    if (Number(corrective?.total || 0) === 0) {
      return {
        ok: false,
        error:
          "Wpis z ALERT/CRITICAL nie moze byc zamkniety bez dzialania korygujacego.",
      };
    }
  }

  await db.run(
    `
    UPDATE haccp_process_entries
    SET
      is_reviewed = 1,
      reviewed_by = ?,
      reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND organization_id = ?
    `,
    [userId, entryId, organizationId]
  );

  await createAuditLog({
    organizationId,
    entityType: "ProcessEntry",
    entityId: entryId,
    action: "UPDATE",
    oldValue: entry,
    newValue: {
      ...entry,
      is_reviewed: 1,
      reviewed_by: userId,
    },
    createdBy: userId,
  });

  return { ok: true };
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

async function listAlertsForManager(organizationId, filters = { resolved: null }) {
  const where = ["a.organization_id = ?"];
  const params = [organizationId];

  if (filters.resolved === 0 || filters.resolved === 1) {
    where.push("a.resolved = ?");
    params.push(filters.resolved);
  }

  return db.all(
    `
    SELECT
      a.id,
      a.entry_id,
      a.process_id,
      a.severity,
      a.message,
      a.alert_type,
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

async function listReportRows(organizationId, filters = {}) {
  const rows = await listEntriesForManager(organizationId, filters);
  if (rows.length === 0) {
    return [];
  }

  const processIds = Array.from(
    new Set(
      rows
        .map((row) => Number(row.process_id))
        .filter((processId) => Number.isInteger(processId))
    )
  );
  const entryIds = rows
    .map((row) => Number(row.id))
    .filter((entryId) => Number.isInteger(entryId));

  const fieldsByProcess = new Map();
  if (processIds.length > 0) {
    const processPlaceholders = processIds.map(() => "?").join(",");
    const processFields = await db.all(
      `
      SELECT
        id,
        process_id,
        name,
        type,
        required,
        min_value,
        max_value,
        field_order
      FROM haccp_process_fields
      WHERE process_id IN (${processPlaceholders})
      ORDER BY process_id ASC, field_order ASC, id ASC
      `,
      processIds
    );

    for (let index = 0; index < processFields.length; index += 1) {
      const field = processFields[index];
      const processId = Number(field.process_id);
      if (!fieldsByProcess.has(processId)) {
        fieldsByProcess.set(processId, []);
      }
      fieldsByProcess.get(processId).push(field);
    }
  }

  const valuesByEntry = new Map();
  if (entryIds.length > 0) {
    const entryPlaceholders = entryIds.map(() => "?").join(",");
    const entryValues = await db.all(
      `
      SELECT
        entry_id,
        field_id,
        value
      FROM haccp_process_entry_values
      WHERE entry_id IN (${entryPlaceholders})
      ORDER BY entry_id ASC, field_id ASC
      `,
      entryIds
    );

    for (let index = 0; index < entryValues.length; index += 1) {
      const valueRow = entryValues[index];
      const entryId = Number(valueRow.entry_id);
      const fieldId = Number(valueRow.field_id);
      if (!valuesByEntry.has(entryId)) {
        valuesByEntry.set(entryId, new Map());
      }
      valuesByEntry.get(entryId).set(fieldId, valueRow.value);
    }
  }

  const grouped = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const processId = Number(row.process_id);
    if (!grouped.has(processId)) {
      grouped.set(processId, {
        processId,
        processName: row.process_name,
        isCcp: Number(row.is_ccp) === 1,
        fields: fieldsByProcess.get(processId) || [],
        rows: [],
      });
    }

    const group = grouped.get(processId);
    const fieldValuesMap = valuesByEntry.get(Number(row.id)) || new Map();
    const fieldValues = {};
    for (let fieldIndex = 0; fieldIndex < group.fields.length; fieldIndex += 1) {
      const field = group.fields[fieldIndex];
      fieldValues[field.id] = fieldValuesMap.has(field.id)
        ? fieldValuesMap.get(field.id)
        : null;
    }

    group.rows.push({
      ...row,
      detailsUrl: `/manager/haccp/entries/${row.id}`,
      fieldValues,
    });
  }

  return Array.from(grouped.values()).sort((left, right) =>
    String(left.processName || "").localeCompare(String(right.processName || ""), "pl", {
      sensitivity: "base",
    })
  );
}

function formatFieldValueForReport(value, fieldType, emptyPlaceholder = "") {
  if (value == null || String(value) === "") {
    return emptyPlaceholder;
  }
  if (String(fieldType || "").toUpperCase() === "BOOLEAN") {
    return parseBoolean(value) ? "TAK" : "NIE";
  }
  return String(value);
}

function buildCsvReport(reportGroups = []) {
  if (!Array.isArray(reportGroups) || reportGroups.length === 0) {
    return "entry_id,status,created_at,created_by,is_reviewed,reviewed_at,corrective_actions";
  }

  const lines = [];
  for (let groupIndex = 0; groupIndex < reportGroups.length; groupIndex += 1) {
    const group = reportGroups[groupIndex];
    lines.push(escapeCsv(`Proces: ${group.processName || "-"}`));

    const headers = [
      "entry_id",
      "status",
      "created_at",
      "created_by",
      "is_reviewed",
      "reviewed_at",
      "corrective_actions",
      ...group.fields.map((field) => field.name),
    ];
    lines.push(headers.map((header) => escapeCsv(header)).join(","));

    for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex += 1) {
      const row = group.rows[rowIndex];
      const baseColumns = [
        row.id,
        row.status || "",
        row.created_at || "",
        row.created_by_name || "",
        Number(row.is_reviewed) === 1 ? "1" : "0",
        row.reviewed_at || "",
        row.corrective_action_text || "",
      ];
      const fieldColumns = group.fields.map((field) =>
        formatFieldValueForReport(
          row.fieldValues ? row.fieldValues[field.id] : null,
          field.type,
          ""
        )
      );
      lines.push([...baseColumns, ...fieldColumns].map((value) => escapeCsv(value)).join(","));
    }

    if (groupIndex < reportGroups.length - 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

function resolvePdfFontPath() {
  const configuredPath = normalizeText(process.env.HACCP_PDF_FONT_PATH);
  const candidates = [
    configuredPath,
    path.join(process.cwd(), "assets", "fonts", "NotoSans-Regular.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"),
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPdfColumnDefinitions(group) {
  return [
    { key: "id", label: "ID", weight: 0.8, align: "left" },
    { key: "status", label: "Status", weight: 1.1, align: "left" },
    { key: "created_by_name", label: "Autor", weight: 1.8, align: "left" },
    { key: "created_at", label: "Data", weight: 1.4, align: "left" },
    { key: "review", label: "Review", weight: 1.1, align: "left" },
    { key: "corrective_action_text", label: "Działania korygujące", weight: 2.6, align: "left" },
    ...group.fields.map((field) => ({
      key: `field_${field.id}`,
      label: field.name,
      weight: 1.5,
      align: "left",
      field,
    })),
  ];
}

function getPdfCellValue(row, column) {
  if (column.key === "id") {
    return String(row.id || "");
  }
  if (column.key === "review") {
    return Number(row.is_reviewed) === 1 ? "TAK" : "NIE";
  }
  if (column.field) {
    return formatFieldValueForReport(
      row.fieldValues ? row.fieldValues[column.field.id] : null,
      column.field.type,
      "-"
    );
  }
  return formatFieldValueForReport(row[column.key], "TEXT", "-");
}

async function buildPdfReport(reportGroups = [], filters = {}) {
  const PDFDocument = getPdfDocumentConstructor();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 36,
      info: {
        Title: "Raport HACCP",
        Subject: "Raport HACCP",
      },
    });
    const chunks = [];

    doc.on("data", (chunk) => {
      chunks.push(chunk);
    });
    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on("error", (error) => {
      reject(error);
    });

    const regularFontPath = resolvePdfFontPath();
    if (regularFontPath) {
      doc.font(regularFontPath);
    } else {
      doc.font("Helvetica");
    }

    const left = doc.page.margins.left;
    const right = doc.page.margins.right;
    const top = doc.page.margins.top;
    const bottom = doc.page.margins.bottom;
    const rowCellPadding = 4;
    const pageBottom = () => doc.page.height - bottom;
    const contentWidth = () => doc.page.width - left - right;
    let cursorY = top;

    const setFontSize = (size) => {
      doc.fontSize(size);
      if (regularFontPath) {
        doc.font(regularFontPath);
      }
    };

    const addPage = () => {
      doc.addPage();
      if (regularFontPath) {
        doc.font(regularFontPath);
      }
      cursorY = top;
    };

    const ensureSpace = (requiredHeight) => {
      if (cursorY + requiredHeight > pageBottom()) {
        addPage();
      }
    };

    const writeLine = (text, options = {}) => {
      const size = options.fontSize || 10;
      const spacingAfter = options.spacingAfter == null ? 4 : options.spacingAfter;
      setFontSize(size);
      const height = doc.heightOfString(String(text || ""), {
        width: contentWidth(),
      });
      ensureSpace(height + spacingAfter);
      doc.text(String(text || ""), left, cursorY, {
        width: contentWidth(),
        align: options.align || "left",
      });
      cursorY += height + spacingAfter;
    };

    const calculateColumnWidths = (columns) => {
      const weightsSum = columns.reduce((sum, column) => sum + column.weight, 0);
      const widths = columns.map((column) =>
        (contentWidth() * column.weight) / Math.max(weightsSum, 1)
      );
      return widths;
    };

    const getRowHeight = (columns, widths, values, fontSize) => {
      setFontSize(fontSize);
      let maxHeight = 0;
      for (let index = 0; index < columns.length; index += 1) {
        const value = String(values[index] == null ? "" : values[index]);
        const textHeight = doc.heightOfString(value, {
          width: Math.max(widths[index] - rowCellPadding * 2, 12),
          align: columns[index].align || "left",
        });
        if (textHeight > maxHeight) {
          maxHeight = textHeight;
        }
      }
      return maxHeight + rowCellPadding * 2;
    };

    const drawRow = (columns, widths, values, options = {}) => {
      const isHeader = Boolean(options.isHeader);
      const fontSize = isHeader ? 9 : 8.5;
      const rowHeight = getRowHeight(columns, widths, values, fontSize);
      ensureSpace(rowHeight);

      let cursorX = left;
      for (let index = 0; index < columns.length; index += 1) {
        const width = widths[index];
        const text = String(values[index] == null ? "" : values[index]);
        doc
          .lineWidth(0.7)
          .fillColor(isHeader ? "#eef4ff" : "#ffffff")
          .strokeColor("#d6deea")
          .rect(cursorX, cursorY, width, rowHeight)
          .fillAndStroke();

        setFontSize(fontSize);
        doc.fillColor("#18202a").text(text, cursorX + rowCellPadding, cursorY + rowCellPadding, {
          width: Math.max(width - rowCellPadding * 2, 12),
          align: columns[index].align || "left",
        });
        cursorX += width;
      }

      cursorY += rowHeight;
    };

    const totalRows = Array.isArray(reportGroups)
      ? reportGroups.reduce((sum, group) => sum + (group.rows?.length || 0), 0)
      : 0;

    writeLine("Raport HACCP", { fontSize: 15, spacingAfter: 8 });
    writeLine(
      `Zakres dat: ${filters.dateFrom || "brak"} - ${filters.dateTo || "brak"}`,
      { fontSize: 10, spacingAfter: 2 }
    );
    if (filters.status) {
      writeLine(`Status: ${filters.status}`, { fontSize: 10, spacingAfter: 2 });
    }
    if (filters.processId) {
      writeLine(`Proces (ID): ${filters.processId}`, { fontSize: 10, spacingAfter: 2 });
    }
    writeLine(`Liczba wpisów: ${totalRows}`, { fontSize: 10, spacingAfter: 8 });

    if (!Array.isArray(reportGroups) || reportGroups.length === 0) {
      writeLine("Brak danych dla podanych filtrów.", { fontSize: 11, spacingAfter: 0 });
      doc.end();
      return;
    }

    for (let groupIndex = 0; groupIndex < reportGroups.length; groupIndex += 1) {
      const group = reportGroups[groupIndex];
      const groupTitle = `Proces: ${group.processName || "-"}${group.isCcp ? " (CCP)" : ""}`;
      writeLine(groupTitle, { fontSize: 11, spacingAfter: 4 });

      const columns = getPdfColumnDefinitions(group);
      const widths = calculateColumnWidths(columns);
      const headerValues = columns.map((column) => column.label);
      drawRow(columns, widths, headerValues, { isHeader: true });

      for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex += 1) {
        const row = group.rows[rowIndex];
        const values = columns.map((column) => getPdfCellValue(row, column));
        const expectedHeight = getRowHeight(columns, widths, values, 8.5);
        if (cursorY + expectedHeight > pageBottom()) {
          addPage();
          writeLine(`${groupTitle} (cd.)`, { fontSize: 11, spacingAfter: 4 });
          drawRow(columns, widths, headerValues, { isHeader: true });
        }
        drawRow(columns, widths, values, { isHeader: false });
      }

      if (groupIndex < reportGroups.length - 1) {
        cursorY += 8;
      }
    }

    doc.end();
  });
}

async function getManagerDashboardStats(organizationId) {
  const [processes, entriesToday, openAlerts, criticalAlerts] = await Promise.all([
    db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_processes
      WHERE organization_id = ? AND is_active = 1
      `,
      [organizationId]
    ),
    db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_process_entries
      WHERE organization_id = ? AND date(created_at) = date('now')
      `,
      [organizationId]
    ),
    db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_alerts
      WHERE organization_id = ? AND resolved = 0
      `,
      [organizationId]
    ),
    db.get(
      `
      SELECT COUNT(*) AS total
      FROM haccp_alerts
      WHERE organization_id = ? AND resolved = 0 AND severity = 'HIGH'
      `,
      [organizationId]
    ),
  ]);

  return {
    activeProcesses: Number(processes?.total || 0),
    entriesToday: Number(entriesToday?.total || 0),
    openAlerts: Number(openAlerts?.total || 0),
    criticalAlerts: Number(criticalAlerts?.total || 0),
  };
}

module.exports = {
  FIELD_TYPES,
  FREQUENCY_TYPES,
  ENTRY_STATUSES,
  parseProcessPayload,
  parseEntryFilters,
  parseAlertFilters,
  listProcesses,
  getProcessWithFields,
  createProcess,
  updateProcess,
  createEntry,
  ensureMissingEntryAlerts,
  listEntriesForManager,
  listEntriesForEmployee,
  getEntryWithDetails,
  reviewEntry,
  listAlertsForManager,
  listAlertsForEmployee,
  resolveAlert,
  listReportRows,
  buildCsvReport,
  buildPdfReport,
  getManagerDashboardStats,
};
