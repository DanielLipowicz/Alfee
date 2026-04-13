const { db } = require("../../database");
const { createAuditLog } = require("./shared");

const DEFAULT_HACCP_PROCESSES = [
  {
    name: "Gospodarka odpadami",
    description: "Zapobieganie skazeniu i szkodnikom.",
    frequencyType: "DAILY",
    frequencyValue: 1,
    isCcp: false,
    fields: [
      {
        name: "Kosze oproznione",
        type: "BOOLEAN",
        required: true,
        order: 1,
      },
      {
        name: "Strefa czysta",
        type: "BOOLEAN",
        required: true,
        order: 2,
      },
      {
        name: "Oznaki szkodnikow",
        type: "BOOLEAN",
        required: true,
        minValue: 0,
        maxValue: 0,
        order: 3,
      },
      {
        name: "Uwagi",
        type: "TEXT",
        required: false,
        order: 4,
      },
    ],
  },
  {
    name: "Kontrola temperatury urzadzen chlodniczych",
    description: "Zapewnienie prawidlowego przechowywania zywnosci.",
    frequencyType: "TWICE_DAILY",
    frequencyValue: 2,
    isCcp: false,
    fields: [
      {
        name: "Urzadzenie",
        type: "SELECT",
        required: true,
        allowedValues: ["Lodowka glowna", "Chlodnia", "Zamrazarka"],
        order: 1,
      },
      {
        name: "Temperatura C",
        type: "NUMBER",
        required: true,
        minValue: 0,
        maxValue: 5,
        order: 2,
      },
      {
        name: "Stan urzadzenia",
        type: "SELECT",
        required: true,
        allowedValues: ["OK", "Awaria"],
        order: 3,
      },
      {
        name: "Uwagi",
        type: "TEXT",
        required: false,
        order: 4,
      },
    ],
  },
  {
    name: "Mycie i dezynfekcja kuchni",
    description: "Utrzymanie higieny powierzchni roboczych.",
    frequencyType: "SHIFT_END",
    frequencyValue: 1,
    isCcp: false,
    fields: [
      {
        name: "Obszar",
        type: "SELECT",
        required: true,
        allowedValues: ["Blaty", "Podloga", "Umywalki", "Strefa przygotowania"],
        order: 1,
      },
      {
        name: "Wykonano",
        type: "BOOLEAN",
        required: true,
        minValue: 1,
        maxValue: 1,
        order: 2,
      },
      {
        name: "Srodek uzyty",
        type: "TEXT",
        required: true,
        order: 3,
      },
      {
        name: "Uwagi",
        type: "TEXT",
        required: false,
        order: 4,
      },
    ],
  },
  {
    name: "Obrobka termiczna miesa (CCP)",
    description: "Eliminacja zagrozen biologicznych.",
    frequencyType: "PER_BATCH",
    frequencyValue: null,
    isCcp: true,
    fields: [
      {
        name: "Produkt",
        type: "SELECT",
        required: true,
        allowedValues: ["Kurczak", "Wolowina", "Wieprzowina", "Inne"],
        order: 1,
      },
      {
        name: "Temperatura rdzenia C",
        type: "NUMBER",
        required: true,
        minValue: 75,
        order: 2,
      },
      {
        name: "Partia",
        type: "TEXT",
        required: true,
        order: 3,
      },
      {
        name: "Uwagi",
        type: "TEXT",
        required: false,
        order: 4,
      },
    ],
  },
];

async function createOnboardingProcess({
  organizationId,
  createdBy,
  processTemplate,
}) {
  const existing = await db.get(
    `
    SELECT id
    FROM haccp_processes
    WHERE organization_id = ? AND lower(name) = lower(?)
    `,
    [organizationId, processTemplate.name]
  );
  if (existing) {
    return {
      processId: Number(existing.id),
      created: false,
    };
  }

  const createdProcess = await db.run(
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
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `,
    [
      organizationId,
      processTemplate.name,
      processTemplate.description,
      processTemplate.frequencyType,
      processTemplate.frequencyValue,
      processTemplate.isCcp ? 1 : 0,
      createdBy,
      createdBy,
    ]
  );

  for (let index = 0; index < processTemplate.fields.length; index += 1) {
    const field = processTemplate.fields[index];
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
        createdProcess.lastID,
        field.name,
        field.type,
        field.required ? 1 : 0,
        field.minValue == null ? null : field.minValue,
        field.maxValue == null ? null : field.maxValue,
        Array.isArray(field.allowedValues) && field.allowedValues.length > 0
          ? field.allowedValues.join(",")
          : null,
        field.order || index + 1,
      ]
    );
  }

  await createAuditLog({
    organizationId,
    entityType: "Process",
    entityId: createdProcess.lastID,
    action: "CREATE",
    oldValue: null,
    newValue: processTemplate,
    createdBy,
  });

  return {
    processId: createdProcess.lastID,
    created: true,
  };
}

async function seedDefaultHaccpProcessesForOrganization({
  organizationId,
  createdBy,
}) {
  if (!Number.isInteger(Number(organizationId)) || Number(organizationId) <= 0) {
    throw new Error("seedDefaultHaccpProcessesForOrganization: invalid organizationId");
  }
  if (!Number.isInteger(Number(createdBy)) || Number(createdBy) <= 0) {
    throw new Error("seedDefaultHaccpProcessesForOrganization: invalid createdBy");
  }

  const summary = {
    createdCount: 0,
    existingCount: 0,
    processIds: [],
  };

  for (let index = 0; index < DEFAULT_HACCP_PROCESSES.length; index += 1) {
    const result = await createOnboardingProcess({
      organizationId: Number(organizationId),
      createdBy: Number(createdBy),
      processTemplate: DEFAULT_HACCP_PROCESSES[index],
    });
    summary.processIds.push(result.processId);
    if (result.created) {
      summary.createdCount += 1;
    } else {
      summary.existingCount += 1;
    }
  }

  return summary;
}

module.exports = {
  DEFAULT_HACCP_PROCESSES,
  seedDefaultHaccpProcessesForOrganization,
};
