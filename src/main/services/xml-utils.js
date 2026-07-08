const XML_TEXT_TAGS = [
  "w:t",
  "w:instrText",
  "a:t",
  "c:v",
  "dc:title",
  "dc:subject",
  "dc:creator",
  "dc:description",
  "cp:keywords",
  "cp:lastModifiedBy",
  "cp:category",
  "cp:contentStatus",
  "cp:version",
  "vt:lpwstr",
  "vt:lpstr",
  "vt:bstr",
  "Company",
  "Manager",
  "Application"
];

const XML_TEXT_PATTERN = new RegExp(
  `<(${XML_TEXT_TAGS.map((tag) => tag.replace(":", "\\:")).join("|")})([^>]*)>([\\s\\S]*?)<\\/\\1>`,
  "g"
);
const XML_CDATA_OR_COMMENT_PATTERN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g;
const XML_GENERIC_TEXT_PATTERN = />([^<>]+)</g;
const XML_TAG_PATTERN = /<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(\s[^<>]*?)?\/?>/g;
const XML_ATTRIBUTE_PATTERN = /\s((?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*)=(["'])([\s\S]*?)\2/g;
const XML_BLOCK_TOKEN_PREFIX = "__DOC_SANITIZER_XML_BLOCK_";
const XML_BLOCK_TOKEN_PATTERN = /^__DOC_SANITIZER_XML_BLOCK_\d+__$/;
const STRUCTURAL_XML_ATTRIBUTES = new Set([
  "xsi:type",
  "xsi:nil",
  "xsi:schemaLocation",
  "xsi:noNamespaceSchemaLocation"
]);

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isStructuralXmlAttribute(attributeName) {
  return (
    attributeName === "xmlns" ||
    attributeName.startsWith("xmlns:") ||
    attributeName.startsWith("xml:") ||
    STRUCTURAL_XML_ATTRIBUTES.has(attributeName)
  );
}

function isProtectedTokenText(value) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => XML_BLOCK_TOKEN_PATTERN.test(part));
}

function encodeCdata(value) {
  return value.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function encodeXmlComment(value) {
  return value.replace(/--/g, "- -").replace(/-$/g, "- ");
}

function collectGenericXmlAttributes(xml) {
  const texts = [];
  xml.replace(XML_TAG_PATTERN, (tag) => {
    XML_ATTRIBUTE_PATTERN.lastIndex = 0;
    tag.replace(XML_ATTRIBUTE_PATTERN, (_match, attributeName, _quote, value) => {
      if (!isStructuralXmlAttribute(attributeName)) {
        const decoded = decodeXml(value);
        if (decoded.trim()) {
          texts.push(decoded);
        }
      }
      return _match;
    });
    return tag;
  });
  return texts;
}

function transformGenericXmlAttributes(xml, transform) {
  return xml.replace(XML_TAG_PATTERN, (tag) => {
    XML_ATTRIBUTE_PATTERN.lastIndex = 0;
    return tag.replace(XML_ATTRIBUTE_PATTERN, (_match, attributeName, quote, value) => {
      if (isStructuralXmlAttribute(attributeName)) {
        return _match;
      }
      const decoded = decodeXml(value);
      if (!decoded.trim()) {
        return _match;
      }
      return ` ${attributeName}=${quote}${encodeXml(transform(decoded))}${quote}`;
    });
  });
}

function collectGenericXmlTextNodes(xml) {
  const texts = [];
  xml.replace(XML_GENERIC_TEXT_PATTERN, (_match, inner) => {
    const decoded = decodeXml(inner);
    if (decoded.trim() && !isProtectedTokenText(decoded)) {
      texts.push(decoded);
    }
    return _match;
  });
  return texts;
}

function transformGenericXmlTextNodes(xml, transform) {
  return xml.replace(XML_GENERIC_TEXT_PATTERN, (_match, inner) => {
    const decoded = decodeXml(inner);
    if (!decoded.trim() || isProtectedTokenText(decoded)) {
      return _match;
    }
    return `>${encodeXml(transform(decoded))}<`;
  });
}

function collectGenericXmlText(xml) {
  const texts = [];
  const protectedXml = xml.replace(XML_CDATA_OR_COMMENT_PATTERN, (block) => {
    const isCdata = block.startsWith("<![CDATA[");
    const inner = isCdata ? block.slice(9, -3) : block.slice(4, -3);
    if (inner.trim()) {
      texts.push(inner);
    }
    return "";
  });

  texts.push(...collectGenericXmlAttributes(protectedXml));
  texts.push(...collectGenericXmlTextNodes(protectedXml));
  return texts;
}

function transformGenericXmlText(xml, transform) {
  const protectedBlocks = [];
  let transformedXml = xml.replace(XML_CDATA_OR_COMMENT_PATTERN, (block) => {
    const isCdata = block.startsWith("<![CDATA[");
    const inner = isCdata ? block.slice(9, -3) : block.slice(4, -3);
    const transformedBlock = isCdata
      ? `<![CDATA[${encodeCdata(transform(inner))}]]>`
      : `<!--${encodeXmlComment(transform(inner))}-->`;
    const token = `${XML_BLOCK_TOKEN_PREFIX}${protectedBlocks.length}__`;
    protectedBlocks.push(transformedBlock);
    return token;
  });

  transformedXml = transformGenericXmlAttributes(transformedXml, transform);
  transformedXml = transformGenericXmlTextNodes(transformedXml, transform);

  return transformedXml.replace(new RegExp(`${XML_BLOCK_TOKEN_PREFIX}(\\d+)__`, "g"), (_match, index) => {
    return protectedBlocks[Number(index)] ?? _match;
  });
}

function collectXmlText(xml) {
  const texts = [];
  XML_TEXT_PATTERN.lastIndex = 0;
  let match;
  while ((match = XML_TEXT_PATTERN.exec(xml)) !== null) {
    texts.push(decodeXml(match[3]));
  }
  return texts;
}

function transformXmlText(xml, transform) {
  return xml.replace(XML_TEXT_PATTERN, (_full, tag, attrs, inner) => {
    return `<${tag}${attrs}>${encodeXml(transform(decodeXml(inner)))}</${tag}>`;
  });
}

module.exports = {
  collectGenericXmlText,
  collectXmlText,
  decodeXml,
  encodeXml,
  transformGenericXmlText,
  transformXmlText
};
