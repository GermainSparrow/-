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
  `<(${XML_TEXT_TAGS.map((tag) => tag.replace(":", "\\:")).join("|")})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`,
  "g"
);
const WORD_TEXT_RANGE_PATTERN = /<(w:t|w:instrText)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
const DRAWING_TEXT_RANGE_PATTERN = /<(a:t)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
const XML_TEXT_RANGE_SCOPES = [
  { tagName: "w:p", textPattern: WORD_TEXT_RANGE_PATTERN },
  { tagName: "a:p", textPattern: DRAWING_TEXT_RANGE_PATTERN }
];
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagPatternForScope(tagName) {
  return new RegExp(`<\\/?${escapeRegExp(tagName)}(?:\\s[^>]*)?\\/?>`, "g");
}

function collectElementScopes(xml, tagName, textPattern) {
  const scopes = [];
  const stack = [];
  const tagPattern = tagPatternForScope(tagName);
  let match;
  while ((match = tagPattern.exec(xml)) !== null) {
    const token = match[0];
    const isClosing = token.startsWith("</");
    const isSelfClosing = token.endsWith("/>");
    if (!isClosing && !isSelfClosing) {
      stack.push(match.index);
      continue;
    }
    if (!isClosing || !stack.length) continue;

    scopes.push({
      start: stack.pop(),
      end: match.index + token.length,
      textPattern
    });
  }
  return scopes;
}

function collectTextRangeScopes(xml) {
  const scopes = XML_TEXT_RANGE_SCOPES.flatMap((scope) => (
    collectElementScopes(xml, scope.tagName, scope.textPattern)
  ));

  return scopes
    .filter((scope, index) => !scopes.some((other, otherIndex) => (
      otherIndex !== index &&
      scope.start < other.start &&
      other.end < scope.end
    )))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function collectXmlTextWithRangeBoundaries(xml) {
  const records = [];
  const scopedRanges = [];
  for (const scope of collectTextRangeScopes(xml)) {
    scopedRanges.push({
      start: scope.start,
      end: scope.end
    });
    const texts = [];
    const scopeXml = xml.slice(scope.start, scope.end);
    scope.textPattern.lastIndex = 0;
    let textMatch;
    while ((textMatch = scope.textPattern.exec(scopeXml)) !== null) {
      texts.push(decodeXml(textMatch[3]));
    }
    const text = texts.join("");
    if (text) {
      records.push({
        index: scope.start,
        text
      });
    }
  }

  XML_TEXT_PATTERN.lastIndex = 0;
  let match;
  while ((match = XML_TEXT_PATTERN.exec(xml)) !== null) {
    if (textRangeOverlaps(scopedRanges, match.index, match.index + match[0].length)) continue;
    records.push({
      index: match.index,
      text: decodeXml(match[3])
    });
  }
  if (!records.length) return collectXmlText(xml);

  return records
    .sort((left, right) => left.index - right.index)
    .flatMap((record) => [record.text, "\n"]);
}

function transformXmlText(xml, transform) {
  return xml.replace(XML_TEXT_PATTERN, (_full, tag, attrs, inner) => {
    return `<${tag}${attrs || ""}>${encodeXml(transform(decodeXml(inner)))}</${tag}>`;
  });
}

function textRangeOverlaps(ranges, start, end) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function collectReplacementRanges(text, replacements) {
  const ranges = [];
  const orderedReplacements = replacements
    .filter((replacement) => replacement?.from && replacement.to)
    .sort((left, right) => right.from.length - left.from.length);

  for (const replacement of orderedReplacements) {
    let index = text.indexOf(replacement.from);
    while (index !== -1) {
      const end = index + replacement.from.length;
      if (!textRangeOverlaps(ranges, index, end)) {
        ranges.push({
          start: index,
          end,
          to: replacement.to
        });
      }
      index = text.indexOf(replacement.from, index + replacement.from.length);
    }
  }

  return ranges.sort((left, right) => left.start - right.start);
}

function replacementRangeOverlapsNode(range, node) {
  return range.start < node.end && range.end > node.start;
}

function textForNodeWithReplacements(node, ranges) {
  let cursor = 0;
  let result = "";
  for (const range of ranges) {
    if (!replacementRangeOverlapsNode(range, node)) continue;

    const localStart = Math.max(range.start, node.start) - node.start;
    const localEnd = Math.min(range.end, node.end) - node.start;
    result += node.text.slice(cursor, localStart);
    if (range.start >= node.start && range.start < node.end) {
      result += range.to;
    }
    cursor = localEnd;
  }
  return result + node.text.slice(cursor);
}

function transformXmlTextRangesInScope(xml, replacements, textPattern) {
  const nodes = [];
  let logicalText = "";
  textPattern.lastIndex = 0;
  let match;
  while ((match = textPattern.exec(xml)) !== null) {
    const text = decodeXml(match[3]);
    const start = logicalText.length;
    logicalText += text;
    nodes.push({
      start,
      end: logicalText.length,
      text
    });
  }

  if (!nodes.length || !logicalText) return xml;
  const ranges = collectReplacementRanges(logicalText, replacements);
  if (!ranges.length) return xml;

  const transformedTexts = nodes.map((node) => textForNodeWithReplacements(node, ranges));
  let nodeIndex = 0;
  return xml.replace(textPattern, (_full, tag, attrs) => {
    const text = transformedTexts[nodeIndex++] || "";
    return `<${tag}${attrs || ""}>${encodeXml(text)}</${tag}>`;
  });
}

function transformXmlTextRanges(xml, replacements) {
  const scopes = collectTextRangeScopes(xml);
  if (!scopes.length) return xml;

  let transformedXml = "";
  let cursor = 0;
  for (const scope of scopes) {
    if (scope.start < cursor) continue;
    transformedXml += xml.slice(cursor, scope.start);
    transformedXml += transformXmlTextRangesInScope(
      xml.slice(scope.start, scope.end),
      replacements,
      scope.textPattern
    );
    cursor = scope.end;
  }
  return transformedXml + xml.slice(cursor);
}

module.exports = {
  collectGenericXmlText,
  collectXmlText,
  collectXmlTextWithRangeBoundaries,
  decodeXml,
  encodeXml,
  transformGenericXmlText,
  transformXmlText,
  transformXmlTextRanges
};
