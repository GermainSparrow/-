const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("jszip");
const { AppError } = require("./app-error");
const { applyRestoration, applySanitization, detectStructuredValues, findOriginalLeaks } = require("./entity-service");
const { collectXmlText, decodeXml, encodeXml, transformXmlText } = require("./xml-utils");

function isProcessableXmlPath(fileName) {
  return (
    fileName === "word/document.xml" ||
    /^word\/header\d+\.xml$/.test(fileName) ||
    /^word\/footer\d+\.xml$/.test(fileName) ||
    /^word\/charts\/.*\.xml$/.test(fileName) ||
    /^word\/diagrams\/.*\.xml$/.test(fileName) ||
    /^word\/glossary\/.*\.xml$/.test(fileName) ||
    fileName === "word/footnotes.xml" ||
    fileName === "word/endnotes.xml" ||
    fileName === "word/comments.xml" ||
    fileName === "word/commentsExtended.xml" ||
    fileName === "word/commentsIds.xml" ||
    fileName === "word/people.xml" ||
    fileName === "word/settings.xml" ||
    fileName === "docProps/core.xml" ||
    fileName === "docProps/app.xml" ||
    fileName === "docProps/custom.xml"
  );
}

function isIgnoredXmlPath(fileName) {
  return (
    fileName === "[Content_Types].xml" ||
    fileName === "word/styles.xml" ||
    fileName === "word/numbering.xml" ||
    fileName === "word/fontTable.xml" ||
    fileName === "word/webSettings.xml" ||
    fileName === "word/theme/theme1.xml" ||
    /^word\/_rels\//.test(fileName) ||
    /^_rels\//.test(fileName) ||
    /^docProps\/_rels\//.test(fileName)
  );
}

function isRelationshipPath(fileName) {
  return fileName.endsWith(".rels");
}

function inspectDocxZip(zip) {
  const warnings = [];
  const fileNames = Object.keys(zip.files);

  if (fileNames.some((name) => name.startsWith("word/media/"))) {
    throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含图片，第一版无法确认图片内是否包含敏感信息");
  }

  if (fileNames.some((name) => name.startsWith("word/embeddings/"))) {
    throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含嵌入对象，第一版无法可靠脱敏");
  }

  if (fileNames.some((name) => name.endsWith("vbaProject.bin"))) {
    throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含宏，第一版无法可靠脱敏");
  }

  if (fileNames.some((name) => name.startsWith("customXml/") && name.endsWith(".xml"))) {
    throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含自定义 XML，第一版无法可靠确认其中是否包含敏感信息");
  }

  return warnings;
}

function assertNoUnsupportedTextXml(fileName, xml) {
  if (isProcessableXmlPath(fileName) || isIgnoredXmlPath(fileName) || isRelationshipPath(fileName)) {
    return;
  }

  if (/<(?:w:t|a:t|c:v|dc:title|dc:subject|dc:creator|dc:description|cp:keywords|vt:lpwstr|vt:lpstr|vt:bstr)\b/.test(xml)) {
    throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", `Word 文档包含未覆盖的文本 XML 部件：${fileName}`);
  }
}

function collectExternalRelationshipTargets(xml) {
  const targets = [];
  xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    if (!/TargetMode=(["'])External\1/.test(tag)) return tag;
    const targetMatch = tag.match(/\bTarget=(["'])(.*?)\1/);
    if (targetMatch?.[2]) {
      targets.push(decodeXml(targetMatch[2]));
    }
    return tag;
  });
  return targets;
}

function transformExternalRelationshipTargets(xml, transform) {
  return xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    if (!/TargetMode=(["'])External\1/.test(tag)) return tag;
    return tag.replace(/\bTarget=(["'])(.*?)\1/, (_match, quote, target) => {
      return `Target=${quote}${encodeXml(transform(decodeXml(target)))}${quote}`;
    });
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attributePattern(attributeNames) {
  const names = attributeNames.map(escapeRegExp).join("|");
  return new RegExp(`\\b((?:[A-Za-z_][\\w.-]*:)?(?:${names}))=(["'])(.*?)\\2`, "g");
}

function collectTextAttributes(xml, tagPattern, attributeNames) {
  const values = [];
  const pattern = attributePattern(attributeNames);
  xml.replace(tagPattern, (tag) => {
    pattern.lastIndex = 0;
    tag.replace(pattern, (_match, _attributeName, _quote, value) => {
      values.push(decodeXml(value));
      return _match;
    });
    return tag;
  });
  return values;
}

function transformTextAttributes(xml, tagPattern, attributeNames, transform) {
  const pattern = attributePattern(attributeNames);
  return xml.replace(tagPattern, (tag) => {
    pattern.lastIndex = 0;
    return tag.replace(pattern, (_match, attributeName, quote, value) => {
      return `${attributeName}=${quote}${encodeXml(transform(decodeXml(value)))}${quote}`;
    });
  });
}

function collectDocxText(fileName, xml) {
  const texts = collectXmlText(xml);
  if (fileName === "word/settings.xml") {
    texts.push(...collectTextAttributes(xml, /<(?:[A-Za-z_][\w.-]*:)?docVar\b[^>]*>/g, ["name", "val"]));
  }
  if (fileName === "word/comments.xml") {
    texts.push(...collectTextAttributes(xml, /<(?:[A-Za-z_][\w.-]*:)?comment\b[^>]*>/g, ["author", "initials"]));
  }
  if (fileName === "word/people.xml") {
    texts.push(...collectTextAttributes(xml, /<(?:[A-Za-z_][\w.-]*:)?person\b[^>]*>/g, ["author"]));
  }
  return texts;
}

function transformDocxText(fileName, xml, transform) {
  let transformedXml = transformXmlText(xml, transform);
  if (fileName === "word/settings.xml") {
    transformedXml = transformTextAttributes(
      transformedXml,
      /<(?:[A-Za-z_][\w.-]*:)?docVar\b[^>]*>/g,
      ["name", "val"],
      transform
    );
  }
  if (fileName === "word/comments.xml") {
    transformedXml = transformTextAttributes(
      transformedXml,
      /<(?:[A-Za-z_][\w.-]*:)?comment\b[^>]*>/g,
      ["author", "initials"],
      transform
    );
  }
  if (fileName === "word/people.xml") {
    transformedXml = transformTextAttributes(
      transformedXml,
      /<(?:[A-Za-z_][\w.-]*:)?person\b[^>]*>/g,
      ["author"],
      transform
    );
  }
  return transformedXml;
}

async function findXmlLeaksInZip(zip, entities) {
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

async function loadZip(filePath) {
  try {
    return await JSZip.loadAsync(await fs.readFile(filePath));
  } catch (error) {
    throw new AppError("DOCX_READ_FAILED", "无法读取 DOCX 文件，可能是损坏、加密或格式不受支持", null);
  }
}

async function extractDocxDocument(filePath, docId) {
  const zip = await loadZip(filePath);
  const warnings = inspectDocxZip(zip);
  const textSegments = [];

  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir || (!fileName.endsWith(".xml") && !fileName.endsWith(".rels"))) continue;
    const xml = await zip.file(fileName).async("text");
    assertNoUnsupportedTextXml(fileName, xml);
    if (isRelationshipPath(fileName)) {
      const text = collectExternalRelationshipTargets(xml).join("\n");
      if (text) {
        textSegments.push({
          id: `${docId}:${fileName}:external-targets`,
          label: fileName,
          text
        });
      }
      continue;
    }
    if (!isProcessableXmlPath(fileName)) continue;
    if (/<w:(del|ins)\b/.test(xml) || /<w:vanish\b/.test(xml)) {
      throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含修订记录或隐藏文本，请接受修订并清理隐藏内容后重试");
    }
    const text = collectDocxText(fileName, xml).join("");
    if (text) {
      textSegments.push({
        id: `${docId}:${fileName}`,
        label: fileName,
        text
      });
    }
  }

  return {
    kind: "docx",
    path: filePath,
    docId,
    textSegments,
    warnings
  };
}

async function transformDocxFile({ filePath, outputPath, entities, mode }) {
  const zip = await loadZip(filePath);
  const warnings = inspectDocxZip(zip);
  const transform = mode === "restore"
    ? (text) => applyRestoration(text, entities)
    : (text) => applySanitization(text, entities);

  for (const fileName of Object.keys(zip.files)) {
    if (zip.files[fileName].dir || (!fileName.endsWith(".xml") && !fileName.endsWith(".rels"))) continue;
    const file = zip.file(fileName);
    const xml = await file.async("text");
    assertNoUnsupportedTextXml(fileName, xml);
    if (isRelationshipPath(fileName)) {
      zip.file(fileName, transformExternalRelationshipTargets(xml, transform));
      continue;
    }
    if (!isProcessableXmlPath(fileName)) continue;
    if (/<w:(del|ins)\b/.test(xml) || /<w:vanish\b/.test(xml)) {
      throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "Word 文档包含修订记录或隐藏文本，请接受修订并清理隐藏内容后重试");
    }
    zip.file(fileName, transformDocxText(fileName, xml, transform));
  }

  if (mode !== "restore") {
    const xmlLeaks = await findXmlLeaksInZip(zip, entities);
    if (xmlLeaks.length) {
      throw new AppError("SANITIZE_LEAK_DETECTED", "DOCX 脱敏后仍检测到原始敏感信息，可能存在未覆盖的 XML 属性或部件", xmlLeaks);
    }
  }

  const outputBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  });
  await fs.writeFile(outputPath, outputBytes);

  if (mode !== "restore") {
    const extracted = await extractDocxDocument(outputPath, "verify");
    const leaks = findOriginalLeaks(extracted.textSegments.map((segment) => segment.text).join("\n"), entities);
    if (leaks.length) {
      await fs.unlink(outputPath).catch(() => {});
      throw new AppError("SANITIZE_LEAK_DETECTED", "DOCX 脱敏后仍检测到原始敏感信息，可能存在跨样式分段内容", leaks);
    }
  }

  return { warnings };
}

async function sanitizeDocxDocument(options) {
  return transformDocxFile({ ...options, mode: "sanitize" });
}

async function restoreDocxDocument(options) {
  return transformDocxFile({ ...options, mode: "restore" });
}

module.exports = {
  extractDocxDocument,
  restoreDocxDocument,
  sanitizeDocxDocument
};
