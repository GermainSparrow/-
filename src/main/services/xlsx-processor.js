const fs = require("node:fs/promises");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { AppError } = require("./app-error");
const { applyRestoration, applySanitization, detectStructuredValues, findOriginalLeaks } = require("./entity-service");
const { decodeXml } = require("./xml-utils");

const HEADER_FOOTER_FIELDS = [
  "oddHeader",
  "oddFooter",
  "evenHeader",
  "evenFooter",
  "firstHeader",
  "firstFooter"
];

function extractTextFromValue(value, texts) {
  if (value == null) return;
  if (typeof value === "string") {
    texts.push(value);
    return;
  }
  if (typeof value === "number") {
    texts.push(String(value));
    return;
  }
  if (typeof value === "boolean") {
    return;
  }
  if (value instanceof Date) {
    return;
  }
  if (Array.isArray(value.richText)) {
    for (const item of value.richText) {
      if (item.text) texts.push(item.text);
    }
  }
  if (typeof value.text === "string") texts.push(value.text);
  if (typeof value.hyperlink === "string") texts.push(value.hyperlink);
  if (typeof value.formula === "string") texts.push(value.formula);
  if (typeof value.result === "string" || typeof value.result === "number") texts.push(String(value.result));
}

function transformValue(value, transform) {
  if (value == null) return value;
  if (typeof value === "string") return transform(value);
  if (typeof value === "number") {
    const transformed = transform(String(value));
    return transformed === String(value) ? value : transformed;
  }
  if (typeof value === "boolean" || value instanceof Date) return value;
  if (Array.isArray(value.richText)) {
    return {
      ...value,
      richText: value.richText.map((item) => ({
        ...item,
        text: item.text ? transform(item.text) : item.text
      }))
    };
  }

  const next = { ...value };
  if (typeof next.text === "string") next.text = transform(next.text);
  if (typeof next.hyperlink === "string") next.hyperlink = transform(next.hyperlink);
  if (typeof next.formula === "string") next.formula = transform(next.formula);
  if (typeof next.result === "string" || typeof next.result === "number") {
    const current = String(next.result);
    const transformed = transform(current);
    next.result = transformed === current ? next.result : transformed;
  }
  return next;
}

function extractTextFromNote(note, texts) {
  if (!note) return;
  if (typeof note === "string") {
    texts.push(note);
    return;
  }
  if (Array.isArray(note.texts)) {
    for (const item of note.texts) {
      if (item.text) texts.push(item.text);
    }
  }
}

function transformNote(note, transform) {
  if (!note) return note;
  if (typeof note === "string") return transform(note);
  if (Array.isArray(note.texts)) {
    return {
      ...note,
      texts: note.texts.map((item) => ({
        ...item,
        text: item.text ? transform(item.text) : item.text
      }))
    };
  }
  return note;
}

async function loadWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
    return workbook;
  } catch (error) {
    throw new AppError("XLSX_READ_FAILED", "无法读取 XLSX 文件，可能是损坏、加密或格式不受支持", null);
  }
}

function assertNoImages(workbook) {
  workbook.eachSheet((worksheet) => {
    if (worksheet.getImages().length > 0) {
      throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Excel 文件包含图片，第一版无法确认图片内是否包含敏感信息");
    }
  });
}

function clearWorkbookMetadata(workbook) {
  workbook.creator = "";
  workbook.lastModifiedBy = "";
  workbook.created = undefined;
  workbook.modified = undefined;
  workbook.lastPrinted = undefined;
  workbook.company = "";
  workbook.manager = "";
  workbook.subject = "";
  workbook.title = "";
  workbook.keywords = "";
  workbook.category = "";
  workbook.description = "";
}

function transformWorksheetName(worksheet, transform) {
  const currentName = worksheet.name;
  const transformedName = transform(currentName);
  if (transformedName === currentName) return;

  try {
    worksheet.name = transformedName;
  } catch (error) {
    throw new AppError("XLSX_SHEET_NAME_INVALID", "脱敏后的工作表名称不符合 XLSX 约束，请调整脱敏值", {
      reason: "invalid_or_duplicate_sheet_name"
    });
  }
}

function extractHeaderFooter(worksheet, texts) {
  for (const field of HEADER_FOOTER_FIELDS) {
    const value = worksheet.headerFooter?.[field];
    if (typeof value === "string" && value) {
      texts.push(value);
    }
  }
}

function transformHeaderFooter(worksheet, transform) {
  for (const field of HEADER_FOOTER_FIELDS) {
    const value = worksheet.headerFooter?.[field];
    if (typeof value === "string" && value) {
      worksheet.headerFooter[field] = transform(value);
    }
  }
}

async function findXmlLeaksInXlsx(filePath, entities) {
  let zip;
  try {
    zip = await JSZip.loadAsync(await fs.readFile(filePath));
  } catch (error) {
    throw new AppError("XLSX_VERIFY_FAILED", "无法复检 XLSX 输出文件", null);
  }

  const leaks = [];
  const knownOriginalValues = new Set(
    entities
      .filter((entity) => entity.enabled !== false && entity.originalValue)
      .map((entity) => entity.originalValue)
  );
  const seenStructuredLeaks = new Set();

  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir || (!fileName.endsWith(".xml") && !fileName.endsWith(".rels"))) continue;
    const xml = await zip.file(fileName).async("text");
    const scanText = `${xml}\n${decodeXml(xml)}`;

    for (const leak of findOriginalLeaks(scanText, entities)) {
      leaks.push({
        ...leak,
        fileName
      });
    }

    for (const structuredValue of detectStructuredValues(scanText)) {
      if (knownOriginalValues.has(structuredValue.originalValue)) continue;
      const leakKey = `${fileName}:${structuredValue.type}:${structuredValue.originalValue}`;
      if (seenStructuredLeaks.has(leakKey)) continue;
      seenStructuredLeaks.add(leakKey);
      leaks.push({
        type: structuredValue.type,
        fileName,
        reason: "unconfirmed_structured_value"
      });
    }
  }

  return leaks;
}

async function extractXlsxDocument(filePath, docId) {
  const workbook = await loadWorkbook(filePath);
  assertNoImages(workbook);
  const textSegments = [];

  workbook.eachSheet((worksheet) => {
    const texts = [worksheet.name];
    extractHeaderFooter(worksheet, texts);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        extractTextFromValue(cell.value, texts);
        extractTextFromNote(cell.note, texts);
      });
    });

    if (texts.length) {
      textSegments.push({
        id: `${docId}:${worksheet.id}`,
        label: worksheet.name,
        text: texts.join("\n")
      });
    }
  });

  return {
    kind: "xlsx",
    path: filePath,
    docId,
    textSegments,
    warnings: []
  };
}

async function transformXlsxFile({ filePath, outputPath, entities, mode }) {
  const workbook = await loadWorkbook(filePath);
  assertNoImages(workbook);
  clearWorkbookMetadata(workbook);
  const transform = mode === "restore"
    ? (text) => applyRestoration(text, entities)
    : (text) => applySanitization(text, entities);

  workbook.eachSheet((worksheet) => {
    transformWorksheetName(worksheet, transform);
    transformHeaderFooter(worksheet, transform);
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.value = transformValue(cell.value, transform);
        cell.note = transformNote(cell.note, transform);
      });
    });
  });

  await workbook.xlsx.writeFile(outputPath);

  if (mode !== "restore") {
    const xmlLeaks = await findXmlLeaksInXlsx(outputPath, entities);
    if (xmlLeaks.length) {
      await fs.unlink(outputPath).catch(() => {});
      throw new AppError("SANITIZE_LEAK_DETECTED", "XLSX 脱敏后仍检测到原始敏感信息，可能存在未覆盖的 XML 属性或部件", xmlLeaks);
    }

    const extracted = await extractXlsxDocument(outputPath, "verify");
    const leaks = findOriginalLeaks(extracted.textSegments.map((segment) => segment.text).join("\n"), entities);
    if (leaks.length) {
      await fs.unlink(outputPath).catch(() => {});
      throw new AppError("SANITIZE_LEAK_DETECTED", "XLSX 脱敏后仍检测到原始敏感信息", leaks);
    }
  }

  return { warnings: [] };
}

async function sanitizeXlsxDocument(options) {
  return transformXlsxFile({ ...options, mode: "sanitize" });
}

async function restoreXlsxDocument(options) {
  return transformXlsxFile({ ...options, mode: "restore" });
}

module.exports = {
  extractXlsxDocument,
  restoreXlsxDocument,
  sanitizeXlsxDocument
};
