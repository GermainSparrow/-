const fs = require("node:fs/promises");
const path = require("node:path");
const { AppError } = require("./app-error");
const { applyRestoration, applySanitization, findOriginalLeaks } = require("./entity-service");

async function extractTextDocument(filePath, docId) {
  const text = await fs.readFile(filePath, "utf8");
  return {
    kind: "text",
    path: filePath,
    docId,
    textSegments: [
      {
        id: `${docId}:text`,
        label: path.basename(filePath),
        text
      }
    ],
    warnings: []
  };
}

async function sanitizeTextDocument({ filePath, outputPath, entities }) {
  const originalText = await fs.readFile(filePath, "utf8");
  const sanitizedText = applySanitization(originalText, entities);
  const leaks = findOriginalLeaks(sanitizedText, entities);
  if (leaks.length) {
    throw new AppError("SANITIZE_LEAK_DETECTED", "文本脱敏后仍检测到原始敏感信息", leaks);
  }
  await fs.writeFile(outputPath, sanitizedText, "utf8");
  return { warnings: [] };
}

async function restoreTextDocument({ filePath, outputPath, entities }) {
  const sanitizedText = await fs.readFile(filePath, "utf8");
  await fs.writeFile(outputPath, applyRestoration(sanitizedText, entities), "utf8");
  return { warnings: [] };
}

module.exports = {
  extractTextDocument,
  restoreTextDocument,
  sanitizeTextDocument
};
