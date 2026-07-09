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
  detectEntities,
  detectStructuredValues
} = require("../src/main/services/entity-service");
const {
  clearEntitySetStoreForTest,
  configureEntitySetStore,
  exportEntitySet,
  importEntitySet,
  listEntitySets,
  saveEntitySet
} = require("../src/main/services/entity-set-service");
const {
  clearOutputDirectoryStoreForTest,
  configureOutputDirectoryStore,
  getLastOutputDirectory,
  saveLastOutputDirectory
} = require("../src/main/services/output-directory-service");
const {
  previewOutputFile
} = require("../src/main/services/output-preview-service");
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
  summarizeFile
} = require("../src/main/services/document-service");
const {
  assertAuthorizedOutputFilePath,
  assertPreviewPayloadAuthorized,
  assertRestorePayloadAuthorized,
  assertSanitizePayloadAuthorized,
  authorizeFilePaths,
  authorizeOutputDirectory,
  authorizeOutputFilePaths,
  revokeAuthorizedOutputFilePath,
  clearAuthorizationsForTest
} = require("../src/main/services/path-authorization-service");
const {
  entitySetSaveSchema,
  sanitizeRunSchema,
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

test("persists last output directory and ignores stale paths", async () => {
  const tempDir = await makeTempDir();
  const outputDir = path.join(tempDir, "exports");
  await fs.mkdir(outputDir);

  configureOutputDirectoryStore(tempDir);
  assert.equal(await getLastOutputDirectory(), null);
  assert.equal(await saveLastOutputDirectory(outputDir), outputDir);
  assert.equal(await getLastOutputDirectory(), outputDir);

  clearOutputDirectoryStoreForTest();
  configureOutputDirectoryStore(tempDir);
  assert.equal(await getLastOutputDirectory(), outputDir);

  await fs.rm(outputDir, { recursive: true, force: true });
  assert.equal(await getLastOutputDirectory(), null);
  clearOutputDirectoryStoreForTest();
});

test("previews generated txt and docx output files", async () => {
  const tempDir = await makeTempDir();
  const textPath = path.join(tempDir, "result.txt");
  const docxPath = path.join(tempDir, "result.docx");
  await fs.writeFile(textPath, "负责人张三", "utf8");
  await writeDocxWithText(docxPath, "负责人李四");

  const textPreview = await previewOutputFile(textPath);
  assert.equal(textPreview.content, "负责人张三");
  assert.equal(textPreview.truncated, false);

  const docxPreview = await previewOutputFile(docxPath);
  assert.match(docxPreview.content, /【正文】/);
  assert.match(docxPreview.content, /负责人李四/);

  await assert.rejects(() => previewOutputFile(path.join(tempDir, "mapping.json")), (error) => {
    return error.code === "OUTPUT_PREVIEW_UNSUPPORTED";
  });

  const largeTextPath = path.join(tempDir, "large.txt");
  await fs.writeFile(largeTextPath, "a".repeat(130000), "utf8");
  const largePreview = await previewOutputFile(largeTextPath);
  assert.equal(largePreview.truncated, true);
  assert.ok(largePreview.content.length < 130000);
  assert.ok(largePreview.content.startsWith("a".repeat(1000)));
});

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
  assert.deepEqual(detected.map((entity) => entity.maskedValue), ["138****8000", "<ENTITY_002>", "<ENTITY_003>"]);

  const text = "李明和明";
  const result = applySanitization(text, [
    manualEntity({ originalValue: "明", maskedValue: "<CHAR_001>", stableId: "CHAR_001" }),
    manualEntity({ originalValue: "李明", maskedValue: "<PERSON_001>", stableId: "PERSON_001" })
  ]);
  assert.equal(result, "<PERSON_001>和<CHAR_001>");
});

test("masks phone numbers with first three digits and stars", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "电话+86 13800138000，备用86-13900139000。"
    }]
  }];

  const detected = detectEntities(documents);
  const byValue = new Map(detected.map((entity) => [entity.originalValue, entity]));
  assert.equal(byValue.get("+86 13800138000").maskedValue, "+86 138****8000");
  assert.equal(byValue.get("86-13900139000").maskedValue, "86-139****9000");
});

test("allows duplicate phone masks for same prefix phone numbers", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "电话13800138000，备用13899998000。"
    }]
  }];

  assert.deepEqual(detectEntities(documents).map((entity) => entity.maskedValue), [
    "138****8000",
    "138****8000"
  ]);
});

test("detects person names from common name fields", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "\u9879\u76ee\u8d1f\u8d23\u4eba\u674e\u660e\uff0c\u8054\u7cfb\u4eba\uff1a\u5f20\u4e09\uff1b\u7535\u8bdd13800138000\u3002"
    }]
  }];

  const detected = detectEntities(documents);
  const originals = detected.map((entity) => entity.originalValue);
  assert.deepEqual(originals, ["\u674e\u660e", "\u5f20\u4e09", "13800138000"]);
  assert.ok(detected.every((entity) => entity.type === "entity"));
  assert.deepEqual(detected.map((entity) => entity.maskedValue), ["\u674e\u56db", "\u738b\u4e94", "138****8000"]);

  const organizationFieldDocuments = [{
    docId: "doc2",
    path: "fixture.txt",
    textSegments: [{
      id: "doc2:text",
      text: "\u8d1f\u8d23\u4eba\u5355\u4f4d\uff1a\u56db\u5ddd\u8def\u6865\u516c\u53f8\uff0c\u8054\u7cfb\u4eba\uff1a\u674e\u660e\uff0c\u7535\u8bdd13800138000\u3002"
    }]
  }];
  assert.deepEqual(
    detectEntities(organizationFieldDocuments).map((entity) => entity.originalValue),
    ["\u674e\u660e", "13800138000"]
  );

  const titleContextDocuments = [{
    docId: "doc3",
    path: "fixture.txt",
    textSegments: [{
      id: "doc3:text",
      text: "\u516c\u53f8\u515a\u59d4\u4e66\u8bb0\u3001\u8463\u4e8b\u957f\u674e\u7389\u53cb\uff0c\u515a\u59d4\u526f\u4e66\u8bb0\u3001\u8463\u4e8b\u3001\u603b\u7ecf\u7406\u90b9\u589e\u5bcc\u7b49\u9886\u5bfc\u51fa\u5e2d\uff0c\u516c\u53f8\u515a\u59d4\u59d4\u5458\u3001\u603b\u5de5\u7a0b\u5e08\u5f20\u5251\u5b81\u4e3b\u6301\u3002\u516c\u53f8\u515a\u59d4\u526f\u4e66\u8bb0\u3001\u8463\u4e8b\u3001\u603b\u7ecf\u7406\u90b9\u589e\u5bcc\u81f4\u5f00\u5e55\u8bcd\u3002"
    }]
  }];
  const titleContextDetected = detectEntities(titleContextDocuments);
  const titleContextByValue = new Map(titleContextDetected.map((entity) => [entity.originalValue, entity]));
  assert.deepEqual(titleContextDetected.map((entity) => entity.originalValue), [
    "\u674e\u7389\u53cb",
    "\u90b9\u589e\u5bcc",
    "\u5f20\u5251\u5b81"
  ]);
  assert.deepEqual(titleContextDetected.map((entity) => entity.maskedValue), [
    "\u5f20\u4e09",
    "\u674e\u56db",
    "\u738b\u4e94"
  ]);
  assert.equal(titleContextByValue.get("\u90b9\u589e\u5bcc").locations.length, 2);
  assert.deepEqual(detectStructuredValues("\u8d1f\u8d23\u4eba\u5f20\u4e09"), [{
    type: "person",
    originalValue: "\u5f20\u4e09"
  }]);
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

test("detects ASCII custom entity aliases only on alphanumeric boundaries", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "SRBG、SRBG〔2026〕1号、SRBG-2026、XSRBG、SRBGX、fooSRBGbar、SRBG_2026。"
    }]
  }];
  const entitySets = [{
    id: "set1",
    name: "测试词库",
    enabled: true,
    items: [{
      id: "item1",
      type: "company",
      canonicalName: "四川路桥建设集团股份有限公司",
      aliases: ["SRBG"],
      enabled: true
    }]
  }];

  const detected = detectEntities(documents, entitySets).filter((entity) => entity.source === "custom");
  assert.deepEqual(detected.map((entity) => entity.originalValue), ["SRBG"]);
  assert.equal(detected[0].locations.length, 3);
});

test("generates organization-style masked values for custom entity defaults", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "\u56db\u5ddd\u8def\u822a\u516c\u53f8\u3001\u8700\u9053\u96c6\u56e2\u3001\u56db\u5ddd\u8def\u6865\u9700\u8981\u8131\u654f\u3002"
    }]
  }];
  const entitySets = [{
    id: "set1",
    name: "\u673a\u6784\u8bcd\u5e93",
    enabled: true,
    items: [
      {
        id: "item1",
        type: "entity",
        canonicalName: "\u56db\u5ddd\u8def\u822a",
        aliases: ["\u56db\u5ddd\u8def\u822a\u516c\u53f8"],
        enabled: true
      },
      {
        id: "item2",
        type: "entity",
        canonicalName: "\u8700\u9053\u96c6\u56e2",
        aliases: [],
        enabled: true
      },
      {
        id: "item3",
        type: "entity",
        canonicalName: "\u56db\u5ddd\u8def\u6865",
        aliases: [],
        enabled: true
      }
    ]
  }];

  const byValue = new Map(detectEntities(documents, entitySets).map((entity) => [entity.originalValue, entity]));
  assert.equal(byValue.get("\u56db\u5ddd\u8def\u822a\u516c\u53f8").maskedValue, "A\u516c\u53f8");
  assert.equal(byValue.get("\u8700\u9053\u96c6\u56e2").maskedValue, "B\u96c6\u56e2");
  assert.equal(byValue.get("\u56db\u5ddd\u8def\u6865").maskedValue, "C\u516c\u53f8");
});

test("avoids organization-style masked value collisions with original values", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "A\u516c\u53f8\u3001\u56db\u5ddd\u8def\u822a\u516c\u53f8\u3001B\u516c\u53f8\u9700\u8981\u8131\u654f\u3002"
    }]
  }];
  const entitySets = [{
    id: "set1",
    name: "\u673a\u6784\u8bcd\u5e93",
    enabled: true,
    items: [
      { id: "item1", type: "entity", canonicalName: "A\u516c\u53f8", aliases: [], enabled: true },
      { id: "item2", type: "entity", canonicalName: "\u56db\u5ddd\u8def\u822a\u516c\u53f8", aliases: [], enabled: true },
      { id: "item3", type: "entity", canonicalName: "B\u516c\u53f8", aliases: [], enabled: true }
    ]
  }];

  const detected = detectEntities(documents, entitySets);
  const originals = new Set(detected.map((entity) => entity.originalValue));
  const maskedValues = detected.map((entity) => entity.maskedValue);
  assert.deepEqual(maskedValues, ["C\u516c\u53f8", "D\u516c\u53f8", "E\u516c\u53f8"]);
  assert.equal(new Set(maskedValues).size, maskedValues.length);
  assert.ok(maskedValues.every((maskedValue) => !originals.has(maskedValue)));
});

test("keeps non-person custom entity defaults as stable placeholders", () => {
  const documents = [{
    docId: "doc1",
    path: "fixture.txt",
    textSegments: [{
      id: "doc1:text",
      text: "\u5408\u540c\u6761\u6b3e\u9700\u8981\u8131\u654f\u3002"
    }]
  }];
  const detected = detectEntities(documents, [{
    id: "set1",
    name: "\u4e1a\u52a1\u8bcd\u5e93",
    enabled: true,
    items: [{
      id: "item1",
      type: "entity",
      canonicalName: "\u5408\u540c\u6761\u6b3e",
      aliases: [],
      enabled: true
    }]
  }]);

  assert.equal(detected[0].maskedValue, "<ENTITY_001>");
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
  const outputPath = path.join(tempDir, "result.docx");
  const nestedOutputPath = path.join(tempDir, "nested", "result.docx");
  assert.throws(() => assertAuthorizedOutputFilePath(outputPath), (error) => {
    return error.code === "UNAUTHORIZED_OUTPUT_FILE_PATH";
  });

  authorizeOutputDirectory(tempDir);
  assert.throws(() => assertAuthorizedOutputFilePath(outputPath), (error) => {
    return error.code === "UNAUTHORIZED_OUTPUT_FILE_PATH";
  });
  authorizeOutputFilePaths([outputPath]);
  assert.doesNotThrow(() => assertAuthorizedOutputFilePath(outputPath));
  assert.throws(() => assertAuthorizedOutputFilePath(nestedOutputPath), (error) => {
    return error.code === "UNAUTHORIZED_OUTPUT_FILE_PATH";
  });
  authorizeOutputFilePaths([nestedOutputPath]);
  assert.doesNotThrow(() => assertAuthorizedOutputFilePath(nestedOutputPath));
  revokeAuthorizedOutputFilePath(outputPath);
  assert.throws(() => assertAuthorizedOutputFilePath(outputPath), (error) => {
    return error.code === "UNAUTHORIZED_OUTPUT_FILE_PATH";
  });
  assert.throws(() => assertAuthorizedOutputFilePath(path.join(`${tempDir}-sibling`, "result.docx")), (error) => {
    return error.code === "UNAUTHORIZED_OUTPUT_FILE_PATH";
  });
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
  assert.deepEqual(outputNames.filter((name) => (
    name.includes(".sanitized") ||
    name.includes(".mapping.enc") ||
    name.includes("_加密映射文件")
  )), []);
});

test("restoration does not write a report file", async () => {
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

  const result = await runRestoration({
    source: { kind: "text", text: "负责人<PERSON_001>" },
    mappingPath,
    outputDir: tempDir,
    credential
  });

  const outputNames = await fs.readdir(tempDir);
  assert.equal(result.reportPath, null);
  assert.equal(outputNames.filter((name) => name.includes(".restore-report")).length, 0);
  assert.equal(outputNames.filter((name) => name.includes(".restored")).length, 1);
});

test("uses safe text output names without writing reports", async () => {
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
  assert.equal(outputs.reportFile, null);
  assert.equal((await fs.readdir(tempDir)).filter((name) => name.includes("report")).length, 0);
});

test("can generate copyable irreversible sanitized text without output files", async () => {
  const tempDir = await makeTempDir();
  const text = "负责人李明，电话13800138000。";
  const preview = await previewSanitization({ kind: "text", text });
  const docId = preview.files[0].docId;

  const result = await runSanitization({
    source: { kind: "text", text, docId },
    mode: "irreversible",
    textOutputMode: "copy",
    entities: preview.entities
  });
  const item = result.results[0];

  assert.equal(item.outputs.sanitizedFile, null);
  assert.equal(item.outputs.mappingFile, null);
  assert.ok(item.sanitizedText);
  assert.doesNotMatch(item.sanitizedText, /李明|13800138000/);
  assert.deepEqual(await fs.readdir(tempDir), []);
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
  assert.equal(path.basename(outputs.sanitizedFile), "fixture_已脱敏.docx");
  assert.equal(path.basename(outputs.mappingFile), "fixture_加密映射文件.json");
  const sanitized = await extractDocxDocument(outputs.sanitizedFile, "verify");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  const restoreResult = await runRestoration({
    source: { kind: "word", path: outputs.sanitizedFile },
    mappingPath: outputs.mappingFile,
    outputDir: tempDir,
    credential
  });
  assert.equal(path.basename(restoreResult.outputPath), "fixture_已还原.docx");
  const restored = await extractDocxDocument(restoreResult.outputPath, "verify");
  assert.match(restored.textSegments.map((segment) => segment.text).join("\n"), /李明/);
});

test("does not block docx output when detected person names use fake masked values", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "auto-person.docx");
  await writeDocxWithText(inputPath, "负责人李明，电话13800138000。");

  const preview = await previewSanitization({ kind: "word", path: inputPath });
  const docId = preview.files[0].docId;
  assert.deepEqual(preview.entities.map((entity) => entity.originalValue), ["李明", "13800138000"]);

  const sanitizeResult = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: preview.entities,
    outputDir: tempDir
  });

  const sanitized = await extractDocxDocument(sanitizeResult.results[0].outputs.sanitizedFile, "verify");
  const sanitizedText = sanitized.textSegments.map((segment) => segment.text).join("\n");
  assert.match(sanitizedText, /张三/);
  assert.doesNotMatch(sanitizedText, /李明|13800138000/);
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

test("allows blank output directory for copy-only text sanitization", () => {
  const parsed = parseWithSchema(sanitizeRunSchema, {
    source: { kind: "text", text: "负责人李明" },
    mode: "irreversible",
    entities: [manualEntity()],
    outputDir: "",
    textOutputMode: "copy",
    acknowledgements: {}
  });

  assert.equal(parsed.outputDir, undefined);
  assert.equal(parsed.textOutputMode, "copy");
  assert.throws(() => parseWithSchema(sanitizeRunSchema, {
    source: { kind: "text", text: "负责人李明" },
    mode: "irreversible",
    entities: [manualEntity()],
    outputDir: "",
    textOutputMode: "file",
    acknowledgements: {}
  }), /参数校验失败/);
});

test("preview includes built in shudao entity set entries", async () => {
  clearEntitySetStoreForTest();
  try {
    const preview = await previewSanitization({
      kind: "text",
      text: "四川路桥与四川路航联合施工。SRBG、川路桥发〔2026〕1号、川路航发〔2026〕2号、蜀道司发〔2026〕3号、蜀道司办〔2025〕77号。蜀道、蜀道投资集团、成渝公司、四川成渝高速、蜀道高速集团、蜀道资本集团、蜀道铁路投资集团、蜀道新制式轨道集团、蜀道物流集团、蜀道集采平台。"
    });
    const customValues = preview.entities
      .filter((entity) => entity.source === "custom")
      .map((entity) => entity.originalValue);
    assert.ok(customValues.includes("四川路桥"));
    assert.ok(customValues.includes("四川路航"));
    assert.ok(customValues.includes("SRBG"));
    assert.ok(customValues.includes("川路桥发"));
    assert.ok(customValues.includes("川路航发"));
    assert.ok(customValues.includes("蜀道司发"));
    assert.ok(customValues.includes("蜀道司办"));
    assert.ok(customValues.includes("蜀道"));
    assert.ok(customValues.includes("蜀道投资集团"));
    assert.ok(customValues.includes("成渝公司"));
    assert.ok(customValues.includes("四川成渝高速"));
    assert.ok(customValues.includes("蜀道高速集团"));
    assert.ok(customValues.includes("蜀道资本集团"));
    assert.ok(customValues.includes("蜀道铁路投资集团"));
    assert.ok(customValues.includes("蜀道新制式轨道集团"));
    assert.ok(customValues.includes("蜀道物流集团"));
    assert.ok(customValues.includes("蜀道集采平台"));
    assert.ok(preview.entities.every((entity) => entity.source !== "custom" || entity.type === "entity"));
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("merges updated built in aliases into existing local entity set store", async () => {
  const tempDir = await makeTempDir();
  clearEntitySetStoreForTest();
  configureEntitySetStore(tempDir);
  try {
    await fs.writeFile(path.join(tempDir, "entity-sets.json"), JSON.stringify([{
      id: "builtin-shudao-companies",
      name: "蜀道系公司实体集",
      enabled: true,
      version: "2026.07.08",
      updatedAt: "2026-07-08T00:00:00.000Z",
      items: [
        {
          id: "shudao-group",
          type: "company",
          canonicalName: "蜀道投资集团有限责任公司",
          aliases: ["蜀道集团"],
          enabled: true
        },
        {
          id: "shudao-srbc-listed",
          type: "company",
          canonicalName: "四川路桥建设集团股份有限公司",
          aliases: ["四川路桥", "路桥股份"],
          enabled: true
        },
        {
          id: "shudao-cygs",
          type: "company",
          canonicalName: "四川成渝高速公路股份有限公司",
          aliases: ["四川成渝"],
          enabled: true
        },
        {
          id: "shudao-shugao",
          type: "company",
          canonicalName: "四川蜀道高速公路集团有限公司",
          aliases: [],
          enabled: true
        },
        {
          id: "srbc-luhang",
          type: "company",
          canonicalName: "四川路航建设工程有限责任公司",
          aliases: ["四川路航", "路航公司"],
          enabled: true
        }
      ]
    }], null, 2), "utf8");

    const [entitySet] = await listEntitySets();
    const aliasesById = new Map(entitySet.items.map((item) => [item.id, item.aliases]));
    assert.ok(aliasesById.get("shudao-group").includes("蜀道司发"));
    assert.ok(aliasesById.get("shudao-group").includes("蜀道司办"));
    assert.ok(aliasesById.get("shudao-group").includes("蜀道投资集团"));
    assert.ok(aliasesById.get("shudao-srbc-listed").includes("SRBG"));
    assert.ok(aliasesById.get("shudao-srbc-listed").includes("川路桥发"));
    assert.ok(aliasesById.get("shudao-cygs").includes("成渝公司"));
    assert.ok(aliasesById.get("shudao-shugao").includes("蜀道高速集团"));
    assert.ok(aliasesById.get("srbc-luhang").includes("川路航发"));
    assert.equal(entitySet.version, "2026.07.09.1");
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("keeps removed built in aliases when later default aliases are merged", async () => {
  const tempDir = await makeTempDir();
  clearEntitySetStoreForTest();
  configureEntitySetStore(tempDir);
  try {
    await fs.writeFile(path.join(tempDir, "entity-sets.json"), JSON.stringify([{
      id: "builtin-shudao-companies",
      name: "蜀道系公司实体集",
      enabled: true,
      version: "2026.07.09",
      updatedAt: "2026-07-09T00:00:00.000Z",
      items: [
        {
          id: "shudao-group",
          type: "company",
          canonicalName: "蜀道投资集团有限责任公司",
          aliases: ["蜀道集团", "蜀道司发"],
          enabled: true
        },
        {
          id: "shudao-srbc-listed",
          type: "company",
          canonicalName: "四川路桥建设集团股份有限公司",
          aliases: ["四川路桥", "路桥股份", "川路桥", "川路桥发"],
          enabled: true
        }
      ]
    }], null, 2), "utf8");

    const [entitySet] = await listEntitySets();
    const aliasesById = new Map(entitySet.items.map((item) => [item.id, item.aliases]));
    assert.ok(aliasesById.get("shudao-group").includes("蜀道司办"));
    assert.equal(aliasesById.get("shudao-srbc-listed").includes("SRBG"), false);
    assert.equal(entitySet.version, "2026.07.09.1");
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("respects saved built in alias removals after default merge", async () => {
  const tempDir = await makeTempDir();
  clearEntitySetStoreForTest();
  configureEntitySetStore(tempDir);
  try {
    const sets = await listEntitySets();
    const builtin = sets.find((entitySet) => entitySet.id === "builtin-shudao-companies");
    const updatedBuiltin = {
      ...builtin,
      items: builtin.items.map((item) => (
        item.id === "shudao-srbc-listed"
          ? { ...item, aliases: item.aliases.filter((alias) => alias !== "SRBG") }
          : item
      ))
    };

    await saveEntitySet(updatedBuiltin);
    const reloaded = await listEntitySets();
    const srbcAliases = reloaded
      .find((entitySet) => entitySet.id === "builtin-shudao-companies")
      .items.find((item) => item.id === "shudao-srbc-listed")
      .aliases;
    assert.equal(srbcAliases.includes("SRBG"), false);
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

test("saves entity sets while omitting blank draft items", async () => {
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
  assert.equal(item.outputs.sanitizedFile, null);
  assert.ok(item.outputs.mappingFile);
  assert.match(path.basename(item.outputs.mappingFile), /^\d{8}_\d{6}_加密映射文件(?:-\d+)?\.json$/u);
  assert.equal((await fs.readdir(tempDir)).filter((name) => (
    name.includes(".sanitized") ||
    name.includes(".mapping.enc")
  )).length, 0);

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

test("warns when reversible sanitization uses duplicate masked values", async () => {
  const tempDir = await makeTempDir();
  const text = "电话13800138000，备用13899998000。";
  const credential = { method: "password", password: "restore-password" };
  const preview = await previewSanitization({ kind: "text", text });
  const docId = preview.files[0].docId;

  const sanitizeResult = await runSanitization({
    source: { kind: "text", text, docId },
    mode: "reversible",
    entities: preview.entities,
    outputDir: tempDir,
    credential
  });

  const item = sanitizeResult.results[0];
  assert.equal(item.sanitizedText.match(/138\*{4}8000/g).length, 2);
  assert.ok(item.warnings.some((warning) => warning.includes("重复脱敏值")));
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

test("sanitizes docx red-head titles split across text runs and drawing text", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "red-head-title.docx");
  const outputPath = path.join(tempDir, "red-head-title.sanitized.docx");
  const restoredPath = path.join(tempDir, "red-head-title.restored.docx");
  const companyName = "四川公路桥梁建设集团有限公司";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>四川公路</w:t></w:r><w:r><w:t>桥梁建设</w:t></w:r><w:r><w:t>集团有限公司文件</w:t></w:r></w:p>',
    '<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:p><a:r><a:t>四川公路桥梁</a:t></a:r><a:r><a:t>建设集团有限公司文件</a:t></a:r></a:p></a:graphicData></a:graphic></w:drawing></w:r></w:p>',
    '</w:body></w:document>'
  ].join(""));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(inputPath, "doc1");
  assert.match(extracted.textSegments.map((segment) => segment.text).join("\n"), new RegExp(companyName));

  const entities = [manualEntity({ originalValue: companyName, maskedValue: "A公司", stableId: "ENTITY_001" })];
  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities });
  const sanitized = await extractDocxDocument(outputPath, "doc1");
  const sanitizedText = sanitized.textSegments.map((segment) => segment.text).join("\n");
  assert.doesNotMatch(sanitizedText, new RegExp(companyName));
  assert.match(sanitizedText, /A公司文件/);

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.doesNotMatch(documentXml, /四川公路|桥梁建设|集团有限公司/);

  await restoreDocxDocument({ filePath: outputPath, outputPath: restoredPath, entities });
  const restored = await extractDocxDocument(restoredPath, "doc1");
  assert.match(restored.textSegments.map((segment) => segment.text).join("\n"), new RegExp(`${companyName}文件`));
});

test("does not sanitize docx text ranges across separate paragraphs", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "split-paragraphs.docx");
  const outputPath = path.join(tempDir, "split-paragraphs.sanitized.docx");
  const companyName = "四川公路桥梁建设集团有限公司";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>四川公路</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>桥梁建设集团有限公司</w:t></w:r></w:p>',
    '</w:body></w:document>'
  ].join(""));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity({ originalValue: companyName, maskedValue: "A公司", stableId: "ENTITY_001" })]
  });

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.doesNotMatch(documentXml, /A公司/);
  assert.match(documentXml, /四川公路/);
  assert.match(documentXml, /桥梁建设集团有限公司/);
});

test("sanitizes docx red-head title text with degraded organization suffix", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "degraded-red-head.docx");
  const outputPath = path.join(tempDir, "degraded-red-head.sanitized.docx");
  const companyName = "四川公路桥梁建设集团有限公司";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>四川公路桥梁建设集有限</w:t></w:r><w:r><w:t>公文</w:t></w:r><w:r><w:t>件</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>四川公路桥梁建设集团有限公司</w:t></w:r></w:p>',
    '</w:body></w:document>'
  ].join(""));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity({ originalValue: companyName, maskedValue: "A公司", stableId: "ENTITY_001" })]
  });

  const sanitized = await extractDocxDocument(outputPath, "doc1");
  assert.match(sanitized.textSegments.map((segment) => segment.text).join("\n"), /A公司文件/);
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.doesNotMatch(documentXml, /四川公路桥梁建设集有限/);
  assert.doesNotMatch(documentXml, new RegExp(companyName));
});

test("previews docx red-head degraded title when full organization appears nowhere else", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "degraded-red-head-only.docx");
  const companyName = "四川公路桥梁建设集团有限公司";
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:r><w:t>四川公路桥梁建设集有限</w:t></w:r><w:r><w:t>公文</w:t></w:r><w:r><w:t>件</w:t></w:r></w:p>',
    '</w:body></w:document>'
  ].join(""));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  clearEntitySetStoreForTest();
  try {
    const preview = await previewSanitization({ kind: "word", path: inputPath });
    assert.ok(preview.entities.some((entity) => entity.originalValue === companyName));

    const docId = preview.files[0].docId;
    const result = await runSanitization({
      source: { kind: "word", path: inputPath, docId },
      mode: "irreversible",
      entities: preview.entities,
      outputDir: tempDir
    });

    const sanitized = await extractDocxDocument(result.results[0].outputs.sanitizedFile, "doc1");
    assert.match(sanitized.textSegments.map((segment) => segment.text).join("\n"), /A公司文件/);
  } finally {
    clearEntitySetStoreForTest();
  }
});

test("does not sanitize docx text ranges across nested text box paragraphs", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "nested-textbox.docx");
  const outputPath = path.join(tempDir, "nested-textbox.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p>',
    '<w:r><w:t>OUT</w:t></w:r>',
    '<w:r><w:txbxContent><w:p><w:r><w:t>IN</w:t></w:r><w:r><w:t>NER</w:t></w:r></w:p></w:txbxContent></w:r>',
    '<w:r><w:t>TAIL</w:t></w:r>',
    '</w:p>',
    '</w:body></w:document>'
  ].join(""));
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [
      manualEntity({ originalValue: "OUTIN", maskedValue: "BAD", stableId: "ENTITY_001" }),
      manualEntity({ id: "manual-2", originalValue: "INNER", maskedValue: "BOX", stableId: "ENTITY_002" })
    ]
  });

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.doesNotMatch(documentXml, /BAD/);
  assert.match(documentXml, /OUT/);
  assert.match(documentXml, /BOX/);
  assert.match(documentXml, /TAIL/);
  assert.doesNotMatch(documentXml, /INNER/);
});

test("previews and sanitizes docx headers and footers", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "header-footer.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文负责人李明</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/header1.xml", '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉负责人王强</w:t></w:r></w:p></w:hdr>');
  zip.file("word/footer1.xml", '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚负责人赵敏</w:t></w:r></w:p></w:ftr>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  const preview = await previewSanitization({ kind: "word", path: inputPath });
  const previewValues = preview.entities.map((entity) => entity.originalValue);
  assert.ok(previewValues.includes("李明"));
  assert.ok(previewValues.includes("王强"));
  assert.ok(previewValues.includes("赵敏"));

  const docId = preview.files[0].docId;
  const result = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: [
      manualEntity({ id: "body", docId, filePath: inputPath, originalValue: "李明", maskedValue: "张三", stableId: "PERSON_001" }),
      manualEntity({ id: "header", docId, filePath: inputPath, originalValue: "王强", maskedValue: "李四", stableId: "PERSON_002" }),
      manualEntity({ id: "footer", docId, filePath: inputPath, originalValue: "赵敏", maskedValue: "王五", stableId: "PERSON_003" })
    ],
    outputDir: tempDir
  });

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(result.results[0].outputs.sanitizedFile));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  const headerXml = await sanitizedZip.file("word/header1.xml").async("text");
  const footerXml = await sanitizedZip.file("word/footer1.xml").async("text");
  assert.doesNotMatch(`${documentXml}\n${headerXml}\n${footerXml}`, /李明|王强|赵敏/);
  assert.match(documentXml, /张三/);
  assert.match(headerXml, /李四/);
  assert.match(footerXml, /王五/);
});

test("does not escape docx structural tags with text-tag prefixes", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "prefix-structure.docx");
  const outputPath = path.join(tempDir, "prefix-structure.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:topLinePunct w:val="0"/><w:autoSpaceDE/></w:pPr><w:r><w:t>负责人李明</w:t></w:r></w:p></w:body></w:document>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await sanitizeDocxDocument({ filePath: inputPath, outputPath, entities: [manualEntity()] });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  assert.match(documentXml, /<w:topLinePunct w:val="0"\/>/);
  assert.match(documentXml, /<w:autoSpaceDE\/>/);
  assert.doesNotMatch(documentXml, /&lt;w:topLinePunct|&lt;w:autoSpaceDE/);
  assert.doesNotMatch(documentXml, /李明/);
});

test("previews docx images and requires keep or delete choice before sanitization", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "image.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>负责人李明</w:t></w:r><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>');
  zip.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
  zip.file("word/header1.xml", '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>');
  zip.file("word/_rels/header1.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>');
  zip.file("word/footer1.xml", '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml"><w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId3"/></v:shape></w:pict></w:r></w:p></w:ftr>');
  zip.file("word/_rels/footer1.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image3.png"/></Relationships>');
  zip.file("word/charts/chart1.xml", '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:spPr><a:blipFill><a:blip r:embed="rId4"/></a:blipFill></c:spPr></c:chartSpace>');
  zip.file("word/charts/_rels/chart1.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image4.png"/></Relationships>');
  zip.file("word/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.file("word/media/image2.png", Buffer.from([0x89, 0x50, 0x4e, 0x48]));
  zip.file("word/media/image3.png", Buffer.from([0x89, 0x50, 0x4e, 0x49]));
  zip.file("word/media/image4.png", Buffer.from([0x89, 0x50, 0x4e, 0x4a]));
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
  assert.deepEqual((await fs.readdir(tempDir)).filter((name) => name.includes("_已脱敏")), []);

  const result = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: [entity],
    outputDir: tempDir,
    acknowledgements: { imageHandling: "keep", imageContentUnmodified: true }
  });
  const item = result.results[0];
  assert.ok(item.warnings.some((warning) => warning.includes("图片内内容无法修改")));

  const keptZip = await JSZip.loadAsync(await fs.readFile(item.outputs.sanitizedFile));
  assert.ok(keptZip.file("word/media/image1.png"));
  assert.ok(keptZip.file("word/media/image2.png"));
  assert.ok(keptZip.file("word/media/image3.png"));
  assert.ok(keptZip.file("word/media/image4.png"));
  assert.match(await keptZip.file("word/_rels/document.xml.rels").async("text"), /relationships\/image/);
  const sanitized = await extractDocxDocument(item.outputs.sanitizedFile, "verify");
  assert.doesNotMatch(sanitized.textSegments.map((segment) => segment.text).join("\n"), /李明/);

  const deleteResult = await runSanitization({
    source: { kind: "word", path: inputPath, docId },
    mode: "irreversible",
    entities: [entity],
    outputDir: tempDir,
    acknowledgements: { imageHandling: "delete" }
  });
  const deleteItem = deleteResult.results[0];
  assert.ok(deleteItem.warnings.every((warning) => !warning.includes("图片内内容无法修改")));
  const deletedZip = await JSZip.loadAsync(await fs.readFile(deleteItem.outputs.sanitizedFile));
  assert.deepEqual(Object.keys(deletedZip.files).filter((name) => name.startsWith("word/media/")), []);
  assert.doesNotMatch(await deletedZip.file("word/_rels/document.xml.rels").async("text"), /relationships\/image|rId1/);
  assert.doesNotMatch(await deletedZip.file("word/_rels/header1.xml.rels").async("text"), /relationships\/image|rId2/);
  assert.doesNotMatch(await deletedZip.file("word/_rels/footer1.xml.rels").async("text"), /relationships\/image|rId3/);
  assert.doesNotMatch(await deletedZip.file("word/charts/_rels/chart1.xml.rels").async("text"), /relationships\/image|rId4/);
  assert.doesNotMatch(await deletedZip.file("word/document.xml").async("text"), /<w:drawing|rId1/);
  assert.doesNotMatch(await deletedZip.file("word/header1.xml").async("text"), /<w:drawing|rId2/);
  assert.doesNotMatch(await deletedZip.file("word/footer1.xml").async("text"), /<w:pict|rId3/);
  assert.doesNotMatch(await deletedZip.file("word/charts/chart1.xml").async("text"), /<a:blip\b|<a:blipFill\b|rId4/);
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

test("ignores docx font table panose numeric metadata during structured leak scan", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "font-table-panose.docx");
  const outputPath = path.join(tempDir, "font-table-panose.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/fontTable.xml", '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Arial"><w:panose1 w:val="020B0604020202020204"/></w:font><w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/></w:font></w:fonts>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity({
      originalValue: "Alice",
      maskedValue: "<ENTITY_001>",
      stableId: "ENTITY_001"
    })]
  });

  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const documentXml = await sanitizedZip.file("word/document.xml").async("text");
  const fontTableXml = await sanitizedZip.file("word/fontTable.xml").async("text");
  assert.doesNotMatch(documentXml, /Alice/);
  assert.match(documentXml, /ENTITY_001/);
  assert.match(fontTableXml, /020B0604020202020204/);
  assert.match(fontTableXml, /020F0502020204030204/);
});

test("blocks non-panose structured values in docx font table", async () => {
  const tempDir = await makeTempDir();
  const inputPath = path.join(tempDir, "font-table-hidden-account.docx");
  const outputPath = path.join(tempDir, "font-table-hidden-account.sanitized.docx");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Alice</w:t></w:r></w:p></w:body></w:document>');
  zip.file("word/fontTable.xml", '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="6222021234567890123"><w:panose1 w:val="020B0604020202020204"/></w:font></w:fonts>');
  await fs.writeFile(inputPath, await zip.generateAsync({ type: "nodebuffer" }));

  await assert.rejects(() => sanitizeDocxDocument({
    filePath: inputPath,
    outputPath,
    entities: [manualEntity({
      originalValue: "Alice",
      maskedValue: "<ENTITY_001>",
      stableId: "ENTITY_001"
    })]
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

test("detects and sanitizes mixed chart paragraph and value text", async () => {
  const tempDir = await makeTempDir();
  const chartPath = path.join(tempDir, "mixed-chart.docx");
  const sanitizedChartPath = path.join(tempDir, "mixed-chart.sanitized.docx");
  const chartZip = new JSZip();
  chartZip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  chartZip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:body></w:document>');
  chartZip.file("word/charts/chart1.xml", [
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    '<c:title><a:p><a:r><a:t>图表标题</a:t></a:r></a:p></c:title>',
    '<c:ser><c:tx><c:v>四川路桥</c:v></c:tx></c:ser>',
    '</c:chartSpace>'
  ].join(""));
  await fs.writeFile(chartPath, await chartZip.generateAsync({ type: "nodebuffer" }));

  const extracted = await extractDocxDocument(chartPath, "doc1");
  const extractedText = extracted.textSegments.map((segment) => segment.text).join("\n");
  assert.match(extractedText, /图表标题/);
  assert.match(extractedText, /四川路桥/);

  await sanitizeDocxDocument({
    filePath: chartPath,
    outputPath: sanitizedChartPath,
    entities: [manualEntity({ originalValue: "四川路桥", maskedValue: "A公司", stableId: "ENTITY_001" })]
  });
  const sanitizedZip = await JSZip.loadAsync(await fs.readFile(sanitizedChartPath));
  const chartXml = await sanitizedZip.file("word/charts/chart1.xml").async("text");
  assert.match(chartXml, /图表标题/);
  assert.match(chartXml, /A公司/);
  assert.doesNotMatch(chartXml, /四川路桥/);
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
  assert.match(customXml, /138\*{4}8000/);
  assert.match(customXml, /ENTITY_001/);
  assert.match(customXml, /ENTITY_002/);
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

  await sanitizeXlsxDocument({ filePath: inputPath, outputPath, entities });
  const sanitizedWorkbook = new ExcelJS.Workbook();
  await sanitizedWorkbook.xlsx.readFile(outputPath);
  const sanitizedSheet = sanitizedWorkbook.worksheets[0];
  assert.doesNotMatch(sanitizedSheet.headerFooter.oddHeader, /李明/);
  assert.doesNotMatch(sanitizedSheet.headerFooter.oddFooter, /13800138000/);
  assert.match(sanitizedSheet.headerFooter.oddHeader, /张三/);
  assert.match(sanitizedSheet.headerFooter.oddFooter, /138\*{4}8000/);
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
  assert.match(text, /138\*{4}8000/);
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
