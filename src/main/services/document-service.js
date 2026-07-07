const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("./app-error");
const { createDocId } = require("./entity-service");
const { extractDocxDocument, restoreDocxDocument, sanitizeDocxDocument } = require("./docx-processor");
const { extractPdfDocument, restorePdfDocument, sanitizePdfDocument } = require("./pdf-processor");
const { extractTextDocument, restoreTextDocument, sanitizeTextDocument } = require("./text-processor");
const { extractXlsxDocument, restoreXlsxDocument, sanitizeXlsxDocument } = require("./xlsx-processor");

const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const BLOCKED_LEGACY = new Set([".doc", ".xls"]);

function getExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function assertSupported(filePath) {
  const extension = getExtension(filePath);
  if (BLOCKED_LEGACY.has(extension)) {
    throw new AppError("UNSUPPORTED_LEGACY_FORMAT", "第一版不支持旧版 Office 格式，请转换为 DOCX 或 XLSX 后重试", {
      extension
    });
  }

  if (!TEXT_EXTENSIONS.has(extension) && ![".docx", ".xlsx", ".pdf"].includes(extension)) {
    throw new AppError("UNSUPPORTED_FILE_TYPE", "不支持的文件类型", { extension });
  }
}

async function summarizeFile(filePath) {
  const stat = await fs.stat(filePath);
  const extension = getExtension(filePath);
  const contentHash = await hashFile(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    extension: extension.replace(".", "").toUpperCase() || "FILE",
    size: stat.size,
    docId: createDocId(filePath, stat, contentHash)
  };
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function extractDocument(filePath) {
  assertSupported(filePath);
  const summary = await summarizeFile(filePath);
  const extension = getExtension(filePath);

  if (TEXT_EXTENSIONS.has(extension)) {
    return extractTextDocument(filePath, summary.docId);
  }
  if (extension === ".docx") {
    return extractDocxDocument(filePath, summary.docId);
  }
  if (extension === ".xlsx") {
    return extractXlsxDocument(filePath, summary.docId);
  }
  if (extension === ".pdf") {
    return extractPdfDocument(filePath, summary.docId);
  }

  throw new AppError("UNSUPPORTED_FILE_TYPE", "不支持的文件类型", { extension });
}

async function ensureOutputDir(outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createUniqueOutputPath(inputPath, outputDir, suffix, extensionOverride = null, outputStem = null) {
  await ensureOutputDir(outputDir);
  const parsed = path.parse(inputPath);
  const extension = extensionOverride || parsed.ext;
  const baseName = outputStem || parsed.name;
  let candidate = path.join(outputDir, `${baseName}${suffix}${extension}`);
  let index = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(outputDir, `${baseName}${suffix}-${index}${extension}`);
    index += 1;
  }
  return candidate;
}

async function sanitizeDocument({ filePath, outputDir, entities, outputStem = null }) {
  assertSupported(filePath);
  const extension = getExtension(filePath);
  const outputPath = await createUniqueOutputPath(
    filePath,
    outputDir,
    ".sanitized",
    extension === ".pdf" ? ".pdf" : null,
    outputStem
  );

  let result;
  if (TEXT_EXTENSIONS.has(extension)) {
    result = await sanitizeTextDocument({ filePath, outputPath, entities });
  } else if (extension === ".docx") {
    result = await sanitizeDocxDocument({ filePath, outputPath, entities });
  } else if (extension === ".xlsx") {
    result = await sanitizeXlsxDocument({ filePath, outputPath, entities });
  } else if (extension === ".pdf") {
    result = await sanitizePdfDocument({ filePath, outputPath, entities });
  }

  return {
    outputPath,
    warnings: result?.warnings || []
  };
}

async function restoreDocument({ filePath, outputDir, entities, outputStem = null }) {
  assertSupported(filePath);
  const extension = getExtension(filePath);
  const outputPath = await createUniqueOutputPath(
    filePath,
    outputDir,
    ".restored",
    extension === ".pdf" ? ".pdf" : null,
    outputStem
  );

  let result;
  if (TEXT_EXTENSIONS.has(extension)) {
    result = await restoreTextDocument({ filePath, outputPath, entities });
  } else if (extension === ".docx") {
    result = await restoreDocxDocument({ filePath, outputPath, entities });
  } else if (extension === ".xlsx") {
    result = await restoreXlsxDocument({ filePath, outputPath, entities });
  } else if (extension === ".pdf") {
    result = await restorePdfDocument({ filePath, outputPath, entities });
  }

  return {
    outputPath,
    warnings: result?.warnings || []
  };
}

module.exports = {
  createUniqueOutputPath,
  extractDocument,
  restoreDocument,
  sanitizeDocument,
  summarizeFile
};
