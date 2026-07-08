const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");
const { PDFDocument, StandardFonts } = require("pdf-lib");

const {
  applyRestoration,
  applySanitization,
  detectEntities
} = require("../src/main/services/entity-service");
const {
  clearEntitySetStoreForTest,
  exportEntitySet,
  importEntitySet,
  listEntitySets,
  saveEntitySet
} = require("../src/main/services/entity-set-service");
const {
  createEncryptedMapping,
  decryptMappingPackage
} = require("../src/main/services/crypto-service");
const {
  extractDocxDocument,
  restoreDocxDocument,
  sanitizeDocxDocument
} = require("../src/main/services/docx-processor");
const {
  extractPdfDocument,
  sanitizePdfDocument
} = require("../src/main/services/pdf-processor");
const {
  extractXlsxDocument,
  sanitizeXlsxDocument
} = require("../src/main/services/xlsx-processor");
const {
  restoreTextDocument,
  sanitizeTextDocument
} = require("../src/main/services/text-processor");
const {
  clearPreviewedSourcesForTest,
  createTextDocId,
  previewSanitization,
  runRestoration,
  runSanitization
} = require("../src/main/services/sanitizer-service");
const {
  assertSupported,
  summarizeFile
} = require("../src/main/services/document-service");
const {
  assertPreviewPayloadAuthorized,
  assertRestorePayloadAuthorized,
  assertSanitizePayloadAuthorized,
  authorizeFilePaths,
  authorizeOutputDirectory,
  clearAuthorizationsForTest
} = require("../src/main/services/path-authorization-service");
const {
  droppedDocumentImportSchema,
  entitySetSaveSchema,
  parseWithSchema
} = require("../src/main/services/schemas");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "sanitizer-test-"));
}

function manualEntity(overrides = {}) {
  return {
    id: "manual-1",
    docId: "doc1",
    filePath: "fixture.txt",
    type: "person",
    originalValue: "李明",
    maskedValue: "<PERSON_001>",
    stableId: "PERSON_001",
    contextHash: "",
    locations: [],
    enabled: true,
    source: "manual",
    ...overrides
  };
}

async function writeDocxWithText(filePath, text) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("detects structured entities and replaces longer strings first", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "李明的手机号是13800138000，邮箱是liming@example.com，账号是6222021234567890123。"
    }]
  }];
  const detected = detectEntities(documents);
  assert.ok(detected.some((entity) => entity.originalValue === "13800138000"));
  assert.ok(detected.some((entity) => entity.originalValue === "liming@example.com"));
  assert.ok(detected.some((entity) => entity.originalValue === "6222021234567890123"));
  assert.ok(detected.every((entity) => entity.type === "entity"));
  assert.deepEqual(detected.map((entity) => entity.stableId), ["ENTITY_001", "ENTITY_002", "ENTITY_003"]);

  const text = "李明和明";
  const result = applySanitization(text, [
    manualEntity({ originalValue: "明", maskedValue: "<CHAR_001>", stableId: "CHAR_001" }),
    manualEntity({ originalValue: "李明", maskedValue: "<PERSON_001>", stableId: "PERSON_001" })
  ]);
  assert.equal(result, "<PERSON_001>和<CHAR_001>");
});

test("detects custom entity set entries with longest match and deduplication", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "四川路桥建设集团股份有限公司简称四川路桥，四川路桥再次出现。四川路航参与。"
    }]
  }];
  const entitySets = [{
    id: "set1",
    name: "测试词库",
    enabled: true,
    items: [
      {
        id: "item1",
        type: "company",
        canonicalName: "四川路桥建设集团股份有限公司",
        aliases: ["四川路桥"],
        enabled: true
      },
      {
        id: "item2",
        type: "company",
        canonicalName: "四川路航",
        aliases: [],
        enabled: true
      }
    ]
  }];

  const detected = detectEntities(documents, entitySets).filter((entity) => entity.source === "custom");
  const byValue = new Map(detected.map((entity) => [entity.originalValue, entity]));
  assert.equal(byValue.get("四川路桥建设集团股份有限公司").locations.length, 1);
  assert.equal(byValue.get("四川路桥").locations.length, 2);
  assert.equal(byValue.get("四川路航").locations.length, 1);
  assert.ok(detected.every((entity) => entity.type === "entity"));
  assert.equal(byValue.get("四川路桥").source, "custom");
});

test("custom entity set detection respects disabled sets items and duplicate aliases", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "四川路桥与四川路航"
    }]
  }];

  assert.equal(detectEntities(documents, [{
    id: "disabled-set",
    name: "停用词库",
    enabled: false,
    items: [{ id: "item1", type: "company", canonicalName: "四川路桥", aliases: [], enabled: true }]
  }]).filter((entity) => entity.source === "custom").length, 0);

  const detected = detectEntities(documents, [{
    id: "set1",
    name: "测试词库",
    enabled: true,
    items: [
      { id: "disabled-item", type: "company", canonicalName: "四川路航", aliases: [], enabled: false },
      { id: "item1", type: "company", canonicalName: "四川路桥", aliases: ["四川路桥"], enabled: true },
      { id: "item2", type: "company", canonicalName: "重复项", aliases: ["四川路桥"], enabled: true }
    ]
  }]).filter((entity) => entity.source === "custom");

  assert.deepEqual(detected.map((entity) => entity.originalValue), ["四川路桥"]);
});

test("restores only existing placeholders and stable tags", () => {
  const entities = [manualEntity({ originalValue: "李明", maskedValue: "李四<PERSON_001>" })];
  assert.equal(applyRestoration("李四<PERSON_001>涨薪", entities), "李明涨薪");
  assert.equal(applyRestoration("董事长涨薪", entities), "董事长涨薪");
  assert.equal(applyRestoration("<PERSON_001>涨薪", entities), "李明涨薪");
});

test("encrypts reversible mapping with password and rejects wrong password", () => {
  const mappingPackage = createEncryptedMapping({
    docId: "doc1",
    sourceFileName: "fixture.txt",
    entities: [manualEntity()],
    credential: { method: "password", password: "correct-password" }
  });

  const decrypted = decryptMappingPackage(mappingPackage, {
    method: "password",
    password: "correct-password"
  });
  assert.equal(decrypted.entities[0].originalValue, "李明");
  assert.throws(() => decryptMappingPackage(mappingPackage, {
    method: "password",
    password: "wrong-password"
  }), /解密失败/);
});

test("encrypts reversible mapping with key file", async () => {
  const tempDir = await makeTempDir();
  const keyFilePath = path.join(tempDir, "restore.key");
  await fs.writeFile(keyFilePath, "local key material");

  const mappingPackage = createEncryptedMapping({
    docId: "doc1",
    sourceFileName: "fixture.txt",
    entities: [manualEntity()],
    credential: { method: "keyFile", keyFilePath }
  });
  const keyFileHash = crypto.createHash("sha256")
    .update(await fs.readFile(keyFilePath))
    .digest("hex");
  assert.equal("keyFileHash" in mappingPackage.wrap.kdf, false);
  assert.doesNotMatch(JSON.stringify(mappingPackage), new RegExp(keyFileHash));

  const decrypted = decryptMappingPackage(mappingPackage, {
    method: "keyFile",
    keyFilePath
  });
  assert.equal(decrypted.entities[0].maskedValue, "<PERSON_001>");
});

test("sanitizes and restores txt without leaking original values", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.txt");
  const sanitizedPath = path.join(tempDir, "fixture.sanitized.txt");
  const restoredPath = path.join(tempDir, "fixture.restored.txt");
  const entities = [manualEntity({ filePath: inputPath })];
  await fs.writeFile(inputPath, "负责人李明，电话13800138000。", "utf8");

  await sanitizeTextDocument({ filePath: inputPath, outputPath: sanitizedPath, entities });
  const sanitized = await fs.readFile(sanitizedPath, "utf8");
  assert.doesNotMatch(sanitized, /李明/);
  assert.match(sanitized, /<PERSON_001>/);

  await restoreTextDocument({ filePath: sanitizedPath, outputPath: restoredPath, entities });
  assert.match(await fs.readFile(restoredPath, "utf8"), /李明/);
});

test("blocks sanitization when pasted text changed after preview", async () => {
  const tempDir = await makeTempDir();
  const originalText = "负责人李明，电话13800138000。";
  const changedText = "负责人王五，电话13800138000。";
  const docId = createTextDocId(originalText);

  await assert.rejects(() => runSanitization({
    source: { kind: "text", text: changedText, docId },
    mode: "irreversible",
    entities: [manualEntity({ docId, filePath: "pasted-text" })],
    outputDir: tempDir
  }), /文件内容已变化/);
});

test("blocks direct text export without preview or enabled entities", async () => {
  const tempDir = await makeTempDir();
  const text = "负责人李明";
  const docId = createTextDocId(text);
  clearPreviewedSourcesForTest();

  await assert.rejects(() => runSanitization({
    source: { kind: "text", text },
    mode: "irreversible",
    entities: [manualEntity({ docId, filePath: "pasted-text" })],
    outputDir: tempDir
  }), /请先预览识别实体/);

  await assert.rejects(() => runSanitization({
    source: { kind: "text", text, docId },
    mode: "irreversible",
    entities: [manualEntity({ docId, filePath: "pasted-text" })],
    outputDir: tempDir
  }), /请先预览识别实体/);

  await previewSanitization({ kind: "text", text });
  await assert.rejects(() => runSanitization({
    source: { kind: "text", text, docId },
    mode: "irreversible",
    entities: [],
    outputDir: tempDir
  }), /未选择任何启用实体/);
});

test("blocks docx export when file was imported but not previewed", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.docx");
  await writeDocxWithText(inputPath, "负责人李明");
  const summary = await summarizeFile(inputPath);
  clearPreviewedSourcesForTest();

  await assert.rejects(() => runSanitization({
    source: { kind: "word", path: inputPath, docId: summary.docId },
    mode: "irreversible",
    entities: [manualEntity({ docId: summary.docId, filePath: inputPath })],
    outputDir: tempDir
  }), /请先预览识别实体/);
});

test("rejects unapproved ipc paths before service execution and skips text file authorization", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.docx");
  const keyFilePath = path.join(tempDir, "restore.key");
  await fs.writeFile(inputPath, "not a real docx", "utf8");
  await fs.writeFile(keyFilePath, "key material", "utf8");
  const docId = "preview-doc-id";
  const payload = {
    source: { kind: "word", path: inputPath, docId },
    mode: "reversible",
    entities: [manualEntity({ docId, filePath: inputPath })],
    outputDir: tempDir,
    credential: { method: "keyFile", keyFilePath }
  };

  clearAuthorizationsForTest();
  assert.throws(() => assertPreviewPayloadAuthorized({ source: { kind: "word", path: inputPath } }), (error) => {
    return error.code === "UNAUTHORIZED_FILE_PATH" && error.details?.purpose === "sanitize";
  });
  assert.doesNotThrow(() => assertPreviewPayloadAuthorized({ source: { kind: "text", text: "负责人李明" } }));
  assert.throws(() => assertSanitizePayloadAuthorized(payload), (error) => {
    return error.code === "UNAUTHORIZED_FILE_PATH" && error.details?.purpose === "sanitize";
  });

  authorizeFilePaths([inputPath], "sanitize");
  assert.throws(() => assertSanitizePayloadAuthorized(payload), /输出目录未通过目录选择器授权/);

  authorizeOutputDirectory(tempDir);
  assert.throws(() => assertSanitizePayloadAuthorized(payload), (error) => {
    return error.code === "UNAUTHORIZED_FILE_PATH" && error.details?.purpose === "keyFile";
  });

  authorizeFilePaths([keyFilePath], "keyFile");
  assert.doesNotThrow(() => assertSanitizePayloadAuthorized(payload));

  clearAuthorizationsForTest();
  authorizeFilePaths([keyFilePath], "keyFile");
  authorizeOutputDirectory(tempDir);
  assert.doesNotThrow(() => assertSanitizePayloadAuthorized({
    ...payload,
    source: { kind: "text", text: "负责人李明", docId: createTextDocId("负责人李明") },
    mode: "irreversible",
    credential: undefined
  }));
  assert.throws(() => assertRestorePayloadAuthorized({
    source: { kind: "word", path: inputPath },
    mappingPath: keyFilePath,
    outputDir: tempDir,
    credential: { method: "password", password: "restore" }
  }), (error) => error.code === "UNAUTHORIZED_FILE_PATH" && error.details?.purpose === "restore");
  clearAuthorizationsForTest();
});

test("cleans reversible output when mapping credential fails", async () => {
  const tempDir = await makeTempDir();
  const text = "负责人李明";
  const docId = createTextDocId(text);

  await assert.rejects(() => runSanitization({
    source: { kind: "text", text, docId },
    mode: "reversible",
    entities: [manualEntity({ docId, filePath: "pasted-text" })],
    outputDir: tempDir,
    credential: { method: "keyFile", keyFilePath: path.join(tempDir, "missing.key") }
  }));

  const outputNames = await fs.readdir(tempDir);
  assert.deepEqual(outputNames.filter((name) => name.includes(".sanitized") || name.includes(".mapping.enc")), []);
});

test("cleans restored output when restore report write fails", async () => {
  const tempDir = await makeTempDir();
  const mappingPath = path.join(tempDir, "fixture.mapping.enc.json");
  const credential = { method: "password", password: "restore-password" };
  const entity = manualEntity({ docId: "doc1", filePath: "pasted-text" });
  await fs.writeFile(mappingPath, JSON.stringify(createEncryptedMapping({
    docId: "doc1",
    sourceFileName: "fixture.txt",
    entities: [entity],
    credential
  }), null, 2), "utf8");

  const originalWriteFile = fs.writeFile;
  fs.writeFile = async (filePath, ...args) => {
    if (String(filePath).includes(".restore-report")) {
      throw new Error("report write failed");
    }
    return originalWriteFile(filePath, ...args);
  };

  try {
    await assert.rejects(() => runRestoration({
      source: { kind: "text", text: "负责人<PERSON_001>" },
      mappingPath,
      outputDir: tempDir,
      credential
    }), /report write failed/);
  } finally {
    fs.writeFile = originalWriteFile;
  }

  const outputNames = await fs.readdir(tempDir);
  assert.deepEqual(outputNames.filter((name) => name.includes(".restored")), []);
});

test("uses safe output names and reports without source file name", async () => {
  const tempDir = await makeTempDir();
  const text = "负责人李明身份证";
  const preview = await previewSanitization({ kind: "text", text });
  const docId = preview.files[0].docId;

  const result = await runSanitization({
    source: { kind: "text", text, docId },
    mode: "irreversible",
    entities: [manualEntity({ docId, filePath: "pasted-text" })],
    outputDir: tempDir
  });

  const outputs = result.results[0].outputs;
  assert.doesNotMatch(path.basename(outputs.sanitizedFile), /李明|身份证/);
  assert.doesNotMatch(path.basename(outputs.reportFile), /李明|身份证/);
  const reportText = await fs.readFile(outputs.reportFile, "utf8");
  assert.doesNotMatch(reportText, /李明|身份证/);
  assert.match(reportText, new RegExp(`document-${docId}`));
});

test("sanitizes and restores docx through source model", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.docx");
  await writeDocxWithText(inputPath, "负责人李明");

  const preview = await previewSanitization({ kind: "word", path: inputPath });
  assert.equal(preview.sourceKind, "word");
  assert.equal(preview.blocked.length, 0);
  const docId = preview.files[0].docId;
  const credential = { method: "password", password: "restore-password" };
  const entity = manualEntity({ docId, filePath: inputPath });

  const sanitizeResult = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "reversible",
    entities: [entity],
    outputDir: tempDir,
    credential
  });
  const outputs = sanitizeResult.results[0].outputs;
  const sanitized = await extractDocxDocument(outputs.sanitizedFile, "verify");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  const restoreResult = await runRestoration({
    source: { kind: "word", path: outputs.sanitizedFile },
    mappingPath: outputs.mappingFile,
    outputDir: tempDir,
    credential
  });
  const restored = await extractDocxDocument(restoreResult.outputPath, "verify");
  assert.match(restored.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("blocks unsupported file types through source preview", async () => {
  const tempDir = await makeTempDir();
  const extensions = [".doc", ".pdf", ".xlsx", ".txt", ".md"];

  for (const extension of extensions) {
    const inputPath = path.join(tempDir, `fixture${extension}`);
    await fs.writeFile(inputPath, "placeholder", "utf8");
    const preview = await previewSanitization({ kind: "word", path: inputPath });
    assert.equal(preview.files.length, 0);
    assert.equal(preview.blocked.length, 1);
    if (extension === ".doc") {
      assert.equal(preview.blocked[0].error.code, "UNSUPPORTED_LEGACY_FORMAT");
    } else {
      assert.equal(preview.blocked[0].error.code, "UNSUPPORTED_FILE_TYPE");
    }
  }
});

test("validates dropped docx import payloads", () => {
  const parsed = parseWithSchema(droppedDocumentImportSchema, {
    purpose: "sanitize",
    filePaths: ["D:/work/fixture.docx"]
  });
  assert.deepEqual(parsed, {
    purpose: "sanitize",
    filePaths: ["D:/work/fixture.docx"]
  });

  assert.throws(() => parseWithSchema(droppedDocumentImportSchema, {
    purpose: "sanitize",
    filePaths: ["D:/work/one.docx", "D:/work/two.docx"]
  }), /参数校验失败/);
  assert.throws(() => parseWithSchema(droppedDocumentImportSchema, {
    purpose: "mapping",
    filePaths: ["D:/work/fixture.docx"]
  }), /参数校验失败/);
  assert.doesNotThrow(() => assertSupported("D:/work/fixture.docx"));
  assert.throws(() => assertSupported("D:/work/fixture.pdf"), /仅支持 Word DOCX 文件/);
});

test("preview includes built in shudao entity set entries", async () => {
  clearEntitySetStoreForTest();
  try {
    const preview = await previewSanitization({ kind: "text", text: "四川路桥与四川路航联合施工。" });
    const customValues = preview.entities
      .filter((entity) => entity.source === "custom")
      .map((entity) => entity.originalValue);
    assert.ok(customValues.includes("四川路桥"));
    assert.ok(customValues.includes("四川路航"));
    assert.ok(preview.entities.every((entity) => entity.source !== "custom" || entity.type === "entity"));
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("imports and exports entity sets as csv and json", async () => {
  clearEntitySetStoreForTest();
  try {
    const imported = await importEntitySet({
      format: "csv",
      content: "type,canonicalName,aliases,maskedValue,enabled,sourceName,sourceUrl,notes\ncompany,测试公司,测试简称|测试集团,,true,单元测试,https://example.com,备注"
    });
    assert.equal(imported.length, 1);
    assert.equal(imported[0].items[0].canonicalName, "测试公司");
    assert.equal(imported[0].items[0].type, "entity");
    assert.deepEqual(imported[0].items[0].aliases, ["测试简称", "测试集团"]);

    const exportedJson = await exportEntitySet({ id: imported[0].id, format: "json" });
    const exported = JSON.parse(exportedJson.content);
    assert.equal(exported.items[0].canonicalName, "测试公司");

    const exportedCsv = await exportEntitySet({ id: imported[0].id, format: "csv" });
    assert.match(exportedCsv.content, /canonicalName/);
    assert.doesNotMatch(exportedCsv.content.split("\n")[0], /type/);
    assert.match(exportedCsv.content, /测试公司/);

    const sets = await listEntitySets();
    assert.ok(sets.some((entitySet) => entitySet.id === imported[0].id));
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("saves entity sets while dropping blank draft items", async () => {
  clearEntitySetStoreForTest();
  try {
    assert.doesNotThrow(() => parseWithSchema(entitySetSaveSchema, {
      entitySet: {
        id: "draft-set",
        name: "新建实体集",
        enabled: true,
        version: "1.0.0",
        items: [{ id: "blank-item", canonicalName: "", aliases: [], enabled: true }]
      }
    }));

    const savedBlank = await saveEntitySet({
      id: "draft-set",
      name: "新建实体集",
      enabled: true,
      version: "1.0.0",
      items: [{
        id: "blank-item",
        canonicalName: "",
        aliases: [],
        maskedValue: "",
        enabled: true,
        sourceName: "",
        sourceUrl: "",
        notes: ""
      }]
    });
    assert.equal(savedBlank.items.length, 0);

    const savedMixed = await saveEntitySet({
      id: "mixed-set",
      name: "混合实体集",
      enabled: true,
      version: "1.0.0",
      items: [
        {
          id: "valid-item",
          canonicalName: "四川路桥",
          aliases: [],
          enabled: true
        },
        {
          id: "blank-item",
          canonicalName: "",
          aliases: [],
          maskedValue: "",
          enabled: true,
          sourceName: "",
          sourceUrl: "",
          notes: ""
        }
      ]
    });
    assert.equal(savedMixed.items.length, 1);
    assert.equal(savedMixed.items[0].canonicalName, "四川路桥");
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("previews sanitizes and restores pasted text", async () => {
  const tempDir = await makeTempDir();
  const text = "负责人李明，电话13800138000，邮箱liming@example.com，账号6222021234567890123。";
  const credential = { method: "password", password: "restore-password" };

  const preview = await previewSanitization({ kind: "text", text });
  assert.equal(preview.sourceKind, "text");
  assert.equal(preview.blocked.length, 0);
  assert.ok(preview.entities.some((entity) => entity.originalValue === "13800138000"));
  assert.ok(preview.entities.some((entity) => entity.originalValue === "liming@example.com"));
  assert.ok(preview.entities.some((entity) => entity.originalValue === "6222021234567890123"));
  assert.ok(preview.entities.every((entity) => entity.type === "entity"));

  const docId = preview.files[0].docId;
  const entities = [
    ...preview.entities,
    manualEntity({ docId, filePath: "pasted-text" })
  ];
  const sanitizeResult = await runSanitization({
    source: { kind: "text", text, docId },
    mode: "reversible",
    entities,
    outputDir: tempDir,
    credential
  });
  const item = sanitizeResult.results[0];
  assert.equal(item.sourceKind, "text");
  assert.ok(item.sanitizedText);
  assert.doesNotMatch(item.sanitizedText, /李明|13800138000|liming@example\.com|6222021234567890123/);
  assert.equal(await fs.readFile(item.outputs.sanitizedFile, "utf8"), item.sanitizedText);
  assert.ok(item.outputs.mappingFile);

  const restoreResult = await runRestoration({
    source: { kind: "text", text: item.sanitizedText },
    mappingPath: item.outputs.mappingFile,
    outputDir: tempDir,
    credential
  });
  assert.equal(restoreResult.sourceKind, "text");
  assert.match(restoreResult.restoredText, /李明/);
  assert.match(restoreResult.restoredText, /13800138000/);
});

test("sanitizes docx text nodes", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.docx");
  const outputPath = path.join(tempDir, "fixture.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>负责人李明</w:t></w:r></w:p></w:body></w:document>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments[0].text, /李明/);

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitized = await extractDocxDocument(outputPath, "doc1");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("previews docx images but requires acknowledgement before sanitization", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "image.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>负责人李明</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const preview = await previewSanitization({ kind: "word", path: inputPath });
  assert.equal(preview.blocked.length, 0);
  assert.ok(preview.files[0].warnings.some((warning) => warning.includes("图片内内容无法修改")));

  const docId = preview.files[0].docId;
  const entity = manualEntity({ docId, filePath: inputPath });
  await assert.rejects(() => runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: [entity],
    outputDir: tempDir
  }), (error) => error.code === "DOCX_IMAGE_ACK_REQUIRED");
  assert.deepEqual((await fs.readdir(tempDir)).filter((name) => name.includes(".sanitized")), []);

  const result = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: [entity],
    outputDir: tempDir,
    acknowledgements: { imageContentUnmodified: true }
  });
  const item = result.results[0];
  assert.ok(item.warnings.some((warning) => warning.includes("图片内内容无法修改")));

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(item.outputs.sanitizedFile));
  assert.ok(sanitizedZip.file("word/media/image1.png"));
  const sanitized = await extractDocxDocument(item.outputs.sanitizedFile, "verify");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("sanitizes docx field code text", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "field.docx");
  const outputPath = path.join(tempDir, "field.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:instrText>HYPERLINK &quot;mailto:liming@example.com&quot;</w:instrText></w:r><w:r><w:t>邮箱链接</w:t></w:r></w:p></w:body></w:document>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  const entities = detectEntities([extracted]);
  assert.ok(entities.some((entity) => entity.originalValue === "liming@example.com"));

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.doesNotMatch(documentXml, /liming@example\.com/);
  assert.match(documentXml, /ENTITY_001/);
});

test("blocks docx unhandled xml attributes without writing output", async () => {
  const tempDir = await makeTempDir();
  const bookmarkPath = path.join(tempDir, "bookmark.docx");
  const bookmarkOutputPath = path.join(tempDir, "bookmark.sanitized.docx");
  const bookmarkZip = new JSZip();
  bookmarkZip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  bookmarkZip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:bookmarkStart w:id="0" w:name="李明"/><w:r><w:t>公开文本</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p></w:body></w:document>');
  await fs.writeFile(bookmarkPath, await bookmarkZip.generateAsync({ type: "nodebuffer" }));

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: bookmarkPath,
    outputPath: bookmarkOutputPath,
    entities: [manualEntity()]
  }), /DOCX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(bookmarkOutputPath));

  const stylePath = path.join(tempDir, "style.docx");
  const styleOutputPath = path.join(tempDir, "style.sanitized.docx");
  const styleZip = new JSZip();
  styleZip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  styleZip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>公开文本</w:t></w:r></w:p></w:body></w:document>');
  styleZip.file("word/styles.xml", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="s1"><w:name w:val="李明"/></w:style></w:styles>');
  await fs.writeFile(stylePath, await styleZip.generateAsync({ type: "nodebuffer" }));

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: stylePath,
    outputPath: styleOutputPath,
    entities: [manualEntity()]
  }), /DOCX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(styleOutputPath));
});

test("blocks docx unconfirmed structured values in any xml part", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "hidden-phone.docx");
  const outputPath = path.join(tempDir, "hidden-phone.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>李明</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/styles.xml", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="s1"><w:name w:val="13800138000"/></w:style></w:styles>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity()]
  }), /DOCX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(outputPath));
});

test("sanitizes docx chart text", async () => {
  const tempDir = await makeTempDir();
  const chartPath = path.join(tempDir, "chart.docx");
  const sanitizedChartPath = path.join(tempDir, "chart.sanitized.docx");
  const chartZip = new JSZip();
  chartZip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  chartZip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  chartZip.file("word/charts/chart1.xml", '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:v>李明</c:v></c:chartSpace>');
  await fs.writeFile(chartPath, await chartZip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(chartPath, "doc1");
  assert.match(extracted.textSegments.map((segment) => segment.text).join("\n"), /李明/);
  await sanitizeDocxDocument({ filePath: chartPath, outputPath: sanitizedChartPath, entities: [manualEntity()] });
  const sanitized = await extractDocxDocument(sanitizedChartPath, "doc1");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("sanitizes and restores docx custom xml text and attributes", async () => {
  const tempDir = await makeTempDir();
  const customPath = path.join(tempDir, "custom.docx");
  const sanitizedCustomPath = path.join(tempDir, "custom.sanitized.docx");
  const restoredCustomPath = path.join(tempDir, "custom.restored.docx");
  const customZip = new JSZip();
  customZip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  customZip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  customZip.file("customXml/item1.xml", '<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="text" owner="李明" phone="13800138000"><name>李明</name><note><![CDATA[邮箱 liming@example.com]]></note><!--账号 6222021234567890123--></root>');
  await fs.writeFile(customPath, await customZip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(customPath, "doc1");
  const extractedText = extracted.textSegments.map((segment) => segment.text).join("\n");
  assert.match(extractedText, /李明/);
  assert.match(extractedText, /13800138000/);
  assert.match(extractedText, /liming@example\.com/);
  assert.match(extractedText, /6222021234567890123/);
  assert.ok(extracted.warnings.some((warning) => warning.includes("自定义 XML")));

  const entities = detectEntities([extracted]);
  entities.push(manualEntity({ filePath: customPath }));
  await sanitizeDocxDocument({ filePath: customPath, outputPath: sanitizedCustomPath, entities });

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(sanitizedCustomPath));
  const customXml = await sanitizedZip.file("customXml/item1.xml").async("text");
  assert.doesNotMatch(customXml, /李明|13800138000|liming@example\.com|6222021234567890123/);
  assert.match(customXml, /PERSON_001/);
  assert.match(customXml, /ENTITY_001/);
  assert.match(customXml, /ENTITY_002/);
  assert.match(customXml, /ENTITY_003/);
  assert.match(customXml, /xsi:type="text"/);

  await restoreDocxDocument({ filePath: sanitizedCustomPath, outputPath: restoredCustomPath, entities });
  const restoredZip = await JSZip.loadAsync(await fs.readFile(restoredCustomPath));
  const restoredCustomXml = await restoredZip.file("customXml/item1.xml").async("text");
  assert.match(restoredCustomXml, /李明/);
  assert.match(restoredCustomXml, /13800138000/);
  assert.match(restoredCustomXml, /liming@example\.com/);
  assert.match(restoredCustomXml, /6222021234567890123/);
});

test("blocks unconfirmed structured values in docx custom xml", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "custom-hidden-phone.docx");
  const outputPath = path.join(tempDir, "custom-hidden-phone.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>李明</w:t></w:r></w:p></w:body></w:document>');
  zip.file("customXml/item1.xml", '<root><phone>13800138000</phone></root>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity()]
  }), /DOCX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(outputPath));
});

test("blocks rather than rewriting docx custom xml item properties", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "custom-item-props.docx");
  const outputPath = path.join(tempDir, "custom-item-props.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>公开文本</w:t></w:r></w:p></w:body></w:document>');
  zip.file("customXml/itemProps1.xml", '<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="13800138000"/>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  assert.doesNotMatch(extracted.textSegments.map((segment) => segment.text).join("\n"), /13800138000/);

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity({
      type: "phone",
      originalValue: "13800138000",
      maskedValue: "<ENTITY_001>",
      stableId: "ENTITY_001"
    })]
  }), /DOCX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(outputPath));
});

test("sanitizes docx custom properties and settings docVars", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "metadata.docx");
  const outputPath = path.join(tempDir, "metadata.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  zip.file("docProps/custom.xml", '<Properties xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property><vt:lpwstr>李明</vt:lpwstr></property></Properties>');
  zip.file("word/settings.xml", '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docVars><w:docVar w:name="owner" w:val="李明"/></w:docVars></w:settings>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const customXml = await sanitizedZip.file("docProps/custom.xml").async("text");
  const settingsXml = await sanitizedZip.file("word/settings.xml").async("text");
  assert.doesNotMatch(customXml, /李明/);
  assert.doesNotMatch(settingsXml, /李明/);
  assert.match(customXml, /PERSON_001/);
  assert.match(settingsXml, /PERSON_001/);
});

test("sanitizes docx comment author attributes and people metadata", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "comments.docx");
  const outputPath = path.join(tempDir, "comments.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  zip.file("word/comments.xml", '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="李明" w:initials="LM"><w:p><w:r><w:t>无敏感正文</w:t></w:r></w:p></w:comment></w:comments>');
  zip.file("word/people.xml", '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="李明"/></w15:people>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const commentsXml = await sanitizedZip.file("word/comments.xml").async("text");
  const peopleXml = await sanitizedZip.file("word/people.xml").async("text");
  assert.doesNotMatch(commentsXml, /李明/);
  assert.doesNotMatch(peopleXml, /李明/);
  assert.match(commentsXml, /PERSON_001/);
  assert.match(peopleXml, /PERSON_001/);
});

test("sanitizes docx external relationship targets", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "link.docx");
  const outputPath = path.join(tempDir, "link.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>邮箱链接</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:liming@example.com" TargetMode="External"/></Relationships>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  const entities = detectEntities([extracted]);
  assert.ok(entities.some((entity) => entity.originalValue === "liming@example.com"));

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const rels = await sanitizedZip.file("word/_rels/document.xml.rels").async("text");
  assert.doesNotMatch(rels, /liming@example\.com/);
  assert.match(rels, /ENTITY_001/);
});

test("sanitizes xlsx cell text", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.xlsx");
  const outputPath = path.join(tempDir, "fixture.sanitized.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.getCell("A1").value = "负责人李明";
  await workbook.xlsx.writeFile(inputPath);

  const extracted = await extractXlsxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments[0].text, /李明/);

  await sanitizeXlsxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitized = await extractXlsxDocument(outputPath, "doc1");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("sanitizes xlsx worksheet names", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "sheet-name.xlsx");
  const outputPath = path.join(tempDir, "sheet-name.sanitized.xlsx");
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("李明");
  await workbook.xlsx.writeFile(inputPath);

  const extracted = await extractXlsxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  await sanitizeXlsxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitizedWorkbook = new ExcelJS.Workbook();
  await sanitizedWorkbook.xlsx.readFile(outputPath);
  assert.equal(sanitizedWorkbook.worksheets[0].name, "<PERSON_001>");
  const sanitized = await extractXlsxDocument(outputPath, "doc1");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("sanitizes xlsx headers and footers", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "header-footer.xlsx");
  const outputPath = path.join(tempDir, "header-footer.sanitized.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.headerFooter.oddHeader = "负责人李明";
  worksheet.headerFooter.oddFooter = "电话13800138000";
  await workbook.xlsx.writeFile(inputPath);

  const extracted = await extractXlsxDocument(inputPath, "doc1");
  const entities = detectEntities([extracted]);
  entities.push(manualEntity({ filePath: inputPath }));

  await sanitizeXlsxDocument({ filePath: inputPath, outputPath, entities });
  const sanitizedWorkbook = new ExcelJS.Workbook();
  await sanitizedWorkbook.xlsx.readFile(outputPath);
  const sanitizedSheet = sanitizedWorkbook.worksheets[0];
  assert.doesNotMatch(sanitizedSheet.headerFooter.oddHeader, /李明/);
  assert.doesNotMatch(sanitizedSheet.headerFooter.oddFooter, /13800138000/);
  assert.match(sanitizedSheet.headerFooter.oddHeader, /PERSON_001/);
  assert.match(sanitizedSheet.headerFooter.oddFooter, /ENTITY_001/);
});

test("blocks xlsx unconfirmed structured values in data validations", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "data-validation.xlsx");
  const outputPath = path.join(tempDir, "data-validation.sanitized.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.getCell("A1").value = "李明";
  worksheet.getCell("B1").dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: ['"是,否"'],
    showInputMessage: true,
    promptTitle: "13800138000",
    prompt: "13800138000"
  };
  await workbook.xlsx.writeFile(inputPath);

  await assert.rejects(() => sanitizeXlsxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity()]
  }), /XLSX 脱敏后仍检测到原始敏感信息/);
  await assert.rejects(() => fs.access(outputPath));
});

test("detects and sanitizes numeric xlsx sensitive cells", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "numeric.xlsx");
  const outputPath = path.join(tempDir, "numeric.sanitized.xlsx");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  worksheet.getCell("A1").value = 13800138000;
  await workbook.xlsx.writeFile(inputPath);

  const extracted = await extractXlsxDocument(inputPath, "doc1");
  const entities = detectEntities([extracted]);
  assert.ok(entities.some((entity) => entity.originalValue === "13800138000"));

  await sanitizeXlsxDocument({ filePath: inputPath, outputPath, entities });
  const sanitized = await extractXlsxDocument(outputPath, "doc1");
  const text = sanitized.textSegments.map((segment) => segment.text).join("\n");
  assert.doesNotMatch(text, /13800138000/);
  assert.match(text, /<ENTITY_001>/);
});

test("sanitizes text PDF by regenerating safe PDF", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "fixture.pdf");
  const outputPath = path.join(tempDir, "fixture.sanitized.pdf");
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.addPage();
  page.drawText("Contact 13800138000 email liming@example.com", { x: 50, y: 700, size: 12, font });
  await fs.writeFile(inputPath, await pdfDoc.save());

  const extracted = await extractPdfDocument(inputPath, "doc1");
  const entities = detectEntities([extracted]);
  assert.ok(entities.length >= 2);

  await sanitizePdfDocument({ filePath: inputPath, outputPath, entities });
  const sanitized = await extractPdfDocument(outputPath, "doc1");
  const text = sanitized.textSegments.map((segment) => segment.text).join("\n");
  assert.doesNotMatch(text, /13800138000/);
  assert.doesNotMatch(text, /liming@example\.com/);
});
