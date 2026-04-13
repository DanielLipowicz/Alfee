const fs = require("fs");
const path = require("path");

const { db } = require("../../database");
const logger = require("../logger");
const { parseBoolean, normalizeText, escapeCsv } = require("./shared");
const { listEntriesForManager } = require("./process");

let cachedPdfFontPath = null;

function getPdfDocumentConstructor() {
  try {
    return require("pdfkit");
  } catch (error) {
    error.message = `Nie mozna zaladowac biblioteki PDF (pdfkit): ${error.message}`;
    throw error;
  }
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
    return "entry_id,status,created_at,recorded_for_at,created_by,is_reviewed,reviewed_at,corrective_actions";
  }

  const lines = [];
  for (let groupIndex = 0; groupIndex < reportGroups.length; groupIndex += 1) {
    const group = reportGroups[groupIndex];
    lines.push(escapeCsv(`Proces: ${group.processName || "-"}`));

    const headers = [
      "entry_id",
      "status",
      "created_at",
      "recorded_for_at",
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
        row.recorded_for_at || "",
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

function findFontInDirectories(directories, fileNames) {
  for (let dirIndex = 0; dirIndex < directories.length; dirIndex += 1) {
    const directory = directories[dirIndex];
    if (!directory || !fs.existsSync(directory)) {
      continue;
    }

    for (let fileIndex = 0; fileIndex < fileNames.length; fileIndex += 1) {
      const candidate = path.join(directory, fileNames[fileIndex]);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolvePdfFontPath() {
  if (cachedPdfFontPath) {
    return cachedPdfFontPath;
  }

  const configuredPath = normalizeText(process.env.HACCP_PDF_FONT_PATH);
  const candidates = [
    configuredPath,
    path.join(process.cwd(), "assets", "fonts", "NotoSans-Regular.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"),
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      cachedPdfFontPath = candidate;
      return candidate;
    }
  }

  const discovered = findFontInDirectories(
    [
      "/usr/share/fonts",
      "/usr/local/share/fonts",
      "/usr/share/fonts/truetype",
      "/usr/share/fonts/dejavu",
      "/usr/share/fonts/noto",
      "/usr/share/fonts/TTF",
    ],
    [
      "NotoSans-Regular.ttf",
      "DejaVuSans.ttf",
      "LiberationSans-Regular.ttf",
      "Arial.ttf",
      "arial.ttf",
    ]
  );
  if (discovered) {
    cachedPdfFontPath = discovered;
    return discovered;
  }

  return null;
}

function getPdfColumnDefinitions(group) {
  return [
    { key: "id", label: "ID", weight: 0.8, align: "left" },
    { key: "status", label: "Status", weight: 1.1, align: "left" },
    { key: "created_by_name", label: "Autor", weight: 1.8, align: "left" },
    { key: "created_at", label: "Data", weight: 1.4, align: "left" },
    { key: "recorded_for_at", label: "Dotyczy godz.", weight: 1.4, align: "left" },
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
  const regularFontPath = resolvePdfFontPath();
  if (!regularFontPath) {
    throw new Error(
      "HACCP PDF: nie znaleziono fontu Unicode. Ustaw HACCP_PDF_FONT_PATH lub zainstaluj NotoSans/DejaVuSans."
    );
  }

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

    logger.info("HACCP PDF font selected", {
      fontPath: regularFontPath,
    });
    doc.font(regularFontPath);

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
      doc.font(regularFontPath);
    };

    const addPage = () => {
      doc.addPage();
      doc.font(regularFontPath);
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

module.exports = {
  listReportRows,
  buildCsvReport,
  buildPdfReport,
};

