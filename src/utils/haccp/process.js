const { db } = require("../../database");
const {
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
  getSeverityForStatus,
  createAuditLog,
  notifyManagers,
  normalizeFrequencyType,
  normalizeFieldType,
  normalizeAllowedValues,
} = require("./shared");

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

async function createEntry({
  organizationId,
  processId,
  userId,
  body,
  allowInactiveProcess = false,
}) {
  const processDefinition = await getProcessWithFields(
    processId,
    organizationId,
    !allowInactiveProcess
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
  const recordedForAt = normalizeRecordedForAt(body.recordedForAt);
  if (body.recordedForAt && !recordedForAt) {
    return {
      ok: false,
      errors: ["Podaj poprawna date i godzine, dla ktorej wpis ma zastosowanie."],
      process: processDefinition,
      entryValidation,
    };
  }

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
        status,
        recorded_for_at
      )
      VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      `,
      [
        processId,
        organizationId,
        userId,
        entryValidation.status,
        recordedForAt,
      ]
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
        recorded_for_at: recordedForAt,
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
      recordedForAt,
    };
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
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
    where.push("date(COALESCE(e.recorded_for_at, e.created_at)) >= ?");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("date(COALESCE(e.recorded_for_at, e.created_at)) <= ?");
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
      e.recorded_for_at,
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
      e.recorded_for_at,
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
      WHERE organization_id = ? AND date(COALESCE(recorded_for_at, created_at)) = date('now')
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
  parseProcessPayload,
  parseEntryFilters,
  listProcesses,
  getProcessWithFields,
  createProcess,
  updateProcess,
  createEntry,
  listEntriesForManager,
  listEntriesForEmployee,
  getEntryWithDetails,
  reviewEntry,
  getManagerDashboardStats,
};
