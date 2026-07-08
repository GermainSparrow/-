const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { AppError, toPublicError } = require("./app-error");
const { createEncryptedMapping, decryptMappingPackage } = require("./crypto-service");
const {
  applyRestoration,
  applySanitization,
  detectEntities,
  findOriginalLeaks,
  summarizeEntities
} = require("./entity-service");
const { listEntitySets } = require("./entity-set-service");
const {
  createUniqueOutputPath,
  extractDocument,
  restoreDocument,
  sanitizeDocument,
  summarizeFile
} = require("./document-service");

const TEXT_SOURCE_PATH = "pasted-text";
const TEXT_SOURCE_LABEL = "粘贴文本";
const previewedSourceKeys = new Set();

function publicDocumentSummary(document) {
  return {
    path: document.path,
    docId: document.docId,
    kind: document.kind,
    sourceKind: document.sourceKind,
    sourceLabel: document.sourceLabel,
    warnings: document.warnings,
    textLength: document.textSegments.reduce((total, segment) => total + segment.text.length, 0)
  };
}

function filterEntitiesForDoc(entities, docId) {
  return entities.filter((entity) => entity.docId === docId && entity.enabled !== false);
}

function safeDocumentLabel(docId) {
  return `document-${docId}`;
}

function outputStemForSource(summary) {
  return summary.sourceKind === "word"
    ? path.parse(summary.name).name
    : safeDocumentLabel(summary.docId);
}

function stripGeneratedWordSuffix(stem) {
  return String(stem || "")
    .replace(/_已脱敏(?:-\d+)?$/u, "")
    .replace(/\.sanitized(?:-\d+)?$/u, "");
}

function restoreOutputStemForSource(source, mapping) {
  if (source.kind !== "word") return safeDocumentLabel(mapping.docId);
  const sourceFileName = String(mapping.sourceFileName || "").trim();
  const stem = sourceFileName
    ? path.parse(sourceFileName).name
    : stripGeneratedWordSuffix(path.parse(source.path).name);
  return stem || safeDocumentLabel(mapping.docId);
}

function createTextDocId(text) {
  return crypto.createHash("sha256").update(`pasted-text:${text}`).digest("hex").slice(0, 16);
}

function sourceLabel(source) {
  return source.kind === "word" ? source.path : TEXT_SOURCE_LABEL;
}

function normalizeSourcePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function previewKeyForSource(source, docId) {
  return source.kind === "word"
    ? `word:${normalizeSourcePath(source.path)}:${docId}`
    : `text:${docId}`;
}

function createTextDocument(text) {
  const docId = createTextDocId(text);
  return {
    kind: "text",
    sourceKind: "text",
    sourceLabel: TEXT_SOURCE_LABEL,
    path: TEXT_SOURCE_PATH,
    docId,
    textSegments: [
      {
        id: `${docId}:text`,
        label: TEXT_SOURCE_LABEL,
        text
      }
    ],
    warnings: []
  };
}

async function extractSourceDocument(source) {
  if (source.kind === "word") {
    const document = await extractDocument(source.path);
    return {
      ...document,
      sourceKind: "word",
      sourceLabel: source.path
    };
  }

  return createTextDocument(source.text);
}

async function summarizeSource(source) {
  if (source.kind === "word") {
    const summary = await summarizeFile(source.path);
    return {
      ...summary,
      kind: "word",
      sourceKind: "word",
      sourceLabel: summary.path
    };
  }

  const docId = createTextDocId(source.text);
  return {
    path: TEXT_SOURCE_PATH,
    name: TEXT_SOURCE_LABEL,
    extension: "TEXT",
    size: Buffer.byteLength(source.text, "utf8"),
    docId,
    kind: "text",
    sourceKind: "text",
    sourceLabel: TEXT_SOURCE_LABEL
  };
}

async function previewSanitization(source) {
  const documents = [];
  const blocked = [];

  try {
    const document = await extractSourceDocument(source);
    documents.push(document);
    previewedSourceKeys.add(previewKeyForSource(source, document.docId));
  } catch (error) {
    blocked.push({
      path: sourceLabel(source),
      error: toPublicError(error)
    });
  }

  return {
    sourceKind: source.kind,
    sourceLabel: sourceLabel(source),
    files: documents.map(publicDocumentSummary),
    blocked,
    entities: detectEntities(documents, await listEntitySets())
  };
}

async function sanitizeTextSource({ text, outputDir, entities, outputStem }) {
  const sanitizedText = applySanitization(text, entities);
  const leaks = findOriginalLeaks(sanitizedText, entities);
  if (leaks.length) {
    throw new AppError("SANITIZE_LEAK_DETECTED", "文本脱敏后仍检测到原始敏感信息", leaks);
  }

  const outputPath = await createUniqueOutputPath(
    "pasted-text.txt",
    outputDir,
    ".sanitized",
    ".txt",
    outputStem
  );
  await fs.writeFile(outputPath, sanitizedText, "utf8");
  return {
    outputPath,
    warnings: [],
    sanitizedText
  };
}

async function sanitizeSource({ source, outputDir, entities, outputStem, acknowledgements = {} }) {
  if (source.kind === "word") {
    return sanitizeDocument({
      filePath: source.path,
      outputDir,
      entities,
      outputStem,
      acknowledgements
    });
  }

  return sanitizeTextSource({
    text: source.text,
    outputDir,
    entities,
    outputStem
  });
}

async function runSanitization({ source, mode, entities, outputDir, credential, acknowledgements = {} }) {
  const writtenPaths = [];

  try {
    const summary = await summarizeSource(source);
    if (!source.docId) {
      throw new AppError("PREVIEW_REQUIRED", "请先预览识别实体，再执行脱敏", {
        source: summary.sourceLabel
      });
    }
    if (source.docId !== summary.docId) {
      throw new AppError("DOCUMENT_CHANGED", "文件内容已变化，请重新导入并预览后再执行脱敏", {
        source: summary.sourceLabel
      });
    }
    if (!previewedSourceKeys.has(previewKeyForSource(source, summary.docId))) {
      throw new AppError("PREVIEW_REQUIRED", "请先预览识别实体，再执行脱敏", {
        source: summary.sourceLabel
      });
    }

    const docEntities = filterEntitiesForDoc(entities, summary.docId);
    if (!docEntities.length) {
      throw new AppError("NO_ENABLED_ENTITIES", "未选择任何启用实体，已阻断导出以避免原文被误作为脱敏文件", {
        source: summary.sourceLabel
      });
    }

    const mappingPackage = mode === "reversible"
      ? createEncryptedMapping({
        docId: summary.docId,
        sourceFileName: summary.name,
        entities: docEntities,
        credential
      })
      : null;
    const outputStem = outputStemForSource(summary);

    const sanitizeResult = await sanitizeSource({
      source,
      outputDir,
      entities: docEntities,
      outputStem,
      acknowledgements
    });
    writtenPaths.push(sanitizeResult.outputPath);

    const outputs = {
      sanitizedFile: sanitizeResult.outputPath,
      mappingFile: null,
      reportFile: null
    };

    if (mappingPackage) {
      outputs.mappingFile = await createUniqueOutputPath(summary.name, outputDir, ".mapping.enc", ".json", outputStem);
      writtenPaths.push(outputs.mappingFile);
      await fs.writeFile(outputs.mappingFile, JSON.stringify(mappingPackage, null, 2), "utf8");
    }

    return {
      results: [
        {
          sourcePath: summary.path,
          sourceKind: summary.sourceKind,
          sourceLabel: summary.sourceLabel,
          docId: summary.docId,
          entitySummary: summarizeEntities(docEntities),
          warnings: sanitizeResult.warnings,
          outputs,
          sanitizedText: sanitizeResult.sanitizedText || null
        }
      ]
    };
  } catch (error) {
    await cleanupFiles(writtenPaths);
    throw error;
  }
}

async function cleanupFiles(filePaths) {
  await Promise.all(filePaths.map((filePath) => fs.unlink(filePath).catch(() => {})));
}

async function unlockMapping({ mappingPath, credential }) {
  const mappingPackage = JSON.parse(await fs.readFile(mappingPath, "utf8"));
  const mapping = decryptMappingPackage(mappingPackage, credential);
  return {
    sessionId: randomUUID(),
    docId: mapping.docId,
    sourceLabel: safeDocumentLabel(mapping.docId),
    createdAt: mapping.createdAt,
    entitySummary: summarizeEntities(mapping.entities)
  };
}

async function restoreTextSource({ text, outputDir, entities, outputStem }) {
  const restoredText = applyRestoration(text, entities);
  const outputPath = await createUniqueOutputPath(
    "pasted-text.txt",
    outputDir,
    ".restored",
    ".txt",
    outputStem
  );
  await fs.writeFile(outputPath, restoredText, "utf8");
  return {
    outputPath,
    warnings: [],
    restoredText
  };
}

async function restoreSource({ source, outputDir, entities, outputStem }) {
  if (source.kind === "word") {
    return restoreDocument({
      filePath: source.path,
      outputDir,
      entities,
      outputStem
    });
  }

  return restoreTextSource({
    text: source.text,
    outputDir,
    entities,
    outputStem
  });
}

async function runRestoration({ source, mappingPath, outputDir, credential }) {
  const writtenPaths = [];

  try {
    const mappingPackage = JSON.parse(await fs.readFile(mappingPath, "utf8"));
    const mapping = decryptMappingPackage(mappingPackage, credential);
    const outputStem = restoreOutputStemForSource(source, mapping);
    const restoreResult = await restoreSource({
      source,
      outputDir,
      entities: mapping.entities,
      outputStem
    });
    writtenPaths.push(restoreResult.outputPath);

    return {
      sourceKind: source.kind,
      sourceLabel: sourceLabel(source),
      outputPath: restoreResult.outputPath,
      reportPath: null,
      warnings: restoreResult.warnings,
      entitySummary: summarizeEntities(mapping.entities),
      restoredText: restoreResult.restoredText || null
    };
  } catch (error) {
    await cleanupFiles(writtenPaths);
    throw error;
  }
}

module.exports = {
  clearPreviewedSourcesForTest: () => previewedSourceKeys.clear(),
  createTextDocId,
  previewSanitization,
  runRestoration,
  runSanitization,
  unlockMapping
};
