const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AppError, toPublicError } = require("./app-error");
const { createEncryptedMapping, decryptMappingPackage } = require("./crypto-service");
const { detectEntities, summarizeEntities } = require("./entity-service");
const { createReport, writeReport } = require("./report-service");
const {
  createUniqueOutputPath,
  extractDocument,
  restoreDocument,
  sanitizeDocument,
  summarizeFile
} = require("./document-service");

function publicDocumentSummary(document) {
  return {
    path: document.path,
    docId: document.docId,
    kind: document.kind,
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

async function previewSanitization(files) {
  const documents = [];
  const blocked = [];

  for (const file of files) {
    try {
      documents.push(await extractDocument(file.path));
    } catch (error) {
      blocked.push({
        path: file.path,
        error: toPublicError(error)
      });
    }
  }

  return {
    files: documents.map(publicDocumentSummary),
    blocked,
    entities: detectEntities(documents)
  };
}

async function runSanitization({ files, mode, entities, outputDir, credential }) {
  const results = [];

  for (const file of files) {
    const writtenPaths = [];

    try {
      const summary = await summarizeFile(file.path);
      if (!file.docId) {
        throw new AppError("PREVIEW_REQUIRED", "请先预览识别实体，再执行脱敏", {
          path: file.path
        });
      }
      if (file.docId !== summary.docId) {
        throw new AppError("DOCUMENT_CHANGED", "文件内容已变化，请重新导入并预览后再执行脱敏", {
          path: file.path
        });
      }
      const docEntities = filterEntitiesForDoc(entities, summary.docId);
      if (!docEntities.length) {
        throw new AppError("NO_ENABLED_ENTITIES", "未选择任何启用实体，已阻断导出以避免原文被误作为脱敏文件", {
          path: file.path
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
      const outputStem = safeDocumentLabel(summary.docId);

      const sanitizeResult = await sanitizeDocument({
        filePath: file.path,
        outputDir,
        entities: docEntities,
        outputStem
      });
      writtenPaths.push(sanitizeResult.outputPath);

      const outputs = {
        sanitizedFile: sanitizeResult.outputPath,
        mappingFile: null,
        reportFile: null
      };

      if (mappingPackage) {
        outputs.mappingFile = await createUniqueOutputPath(file.path, outputDir, ".mapping.enc", ".json", outputStem);
        writtenPaths.push(outputs.mappingFile);
        await fs.writeFile(outputs.mappingFile, JSON.stringify(mappingPackage, null, 2), "utf8");
      }

      outputs.reportFile = await createUniqueOutputPath(file.path, outputDir, ".sanitization-report", ".json", outputStem);
      writtenPaths.push(outputs.reportFile);
      const report = createReport({
        sourceLabel: outputStem,
        mode,
        entities: docEntities,
        warnings: sanitizeResult.warnings,
        outputs
      });
      await writeReport(outputs.reportFile, report);

      results.push({
        sourcePath: file.path,
        docId: summary.docId,
        entitySummary: summarizeEntities(docEntities),
        warnings: sanitizeResult.warnings,
        outputs
      });
    } catch (error) {
      await cleanupFiles(writtenPaths);
      throw error;
    }
  }

  return { results };
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

async function runRestoration({ filePath, mappingPath, outputDir, credential }) {
  const writtenPaths = [];

  try {
    const mappingPackage = JSON.parse(await fs.readFile(mappingPath, "utf8"));
    const mapping = decryptMappingPackage(mappingPackage, credential);
    const outputStem = safeDocumentLabel(mapping.docId);
    const restoreResult = await restoreDocument({
      filePath,
      outputDir,
      entities: mapping.entities,
      outputStem
    });
    writtenPaths.push(restoreResult.outputPath);

    const reportPath = await createUniqueOutputPath(filePath, outputDir, ".restore-report", ".json", outputStem);
    writtenPaths.push(reportPath);
    await writeReport(reportPath, createReport({
      sourceLabel: outputStem,
      mode: "restore",
      entities: mapping.entities,
      warnings: restoreResult.warnings,
      outputs: {
        restoredFile: restoreResult.outputPath,
        mappingFile: path.basename(mappingPath),
        reportFile: reportPath
      }
    }));

    return {
      outputPath: restoreResult.outputPath,
      reportPath,
      warnings: restoreResult.warnings,
      entitySummary: summarizeEntities(mapping.entities)
    };
  } catch (error) {
    await cleanupFiles(writtenPaths);
    throw error;
  }
}

module.exports = {
  previewSanitization,
  runRestoration,
  runSanitization,
  unlockMapping
};
