const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("./app-error");
const { createDocId } = require("./entity-service");
const { extractDocxDocument, restoreDocxDocument, sanitizeDocxDocument } = require("./docx-processor");

const WORD_EXTENSION = ".docx";

function getExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function assertSupported(filePath) {
  const extension = getExtension(filePath);
  if (extension === ".doc") {
    throw new AppError("UNSUPPORTED_LEGACY_FORMAT", "第一版不支持旧版 DOC，请另存为 DOCX 后重试", {
      extension
    });
  }

  if (extension !== WORD_EXTENSION) {
    throw new AppError("UNSUPPORTED_FILE_TYPE", "当前版本仅支持 Word DOCX 文件，其他文件类型请使用粘贴文本输入", { extension });
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
  return extractDocxDocument(filePath, summary.docId);
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

async function sanitizeDocument({ filePath, outputDir, entities, outputStem = null, acknowledgements = {} }) {
  assertSupported(filePath);
  const outputPath = await createUniqueOutputPath(
    filePath,
    outputDir,
    ".sanitized",
    WORD_EXTENSION,
    outputStem
  );

  const result = await sanitizeDocxDocument({ filePath, outputPath, entities, acknowledgements });

  return {
    outputPath,
    warnings: result?.warnings || []
  };
}

async function restoreDocument({ filePath, outputDir, entities, outputStem = null }) {
  assertSupported(filePath);
  const outputPath = await createUniqueOutputPath(
    filePath,
    outputDir,
    ".restored",
    WORD_EXTENSION,
    outputStem
  );

  const result = await restoreDocxDocument({ filePath, outputPath, entities });

  return {
    outputPath,
    warnings: result?.warnings || []
  };
}

module.exports = {
  assertSupported,
  createUniqueOutputPath,
  extractDocument,
  restoreDocument,
  sanitizeDocument,
  summarizeFile
};
