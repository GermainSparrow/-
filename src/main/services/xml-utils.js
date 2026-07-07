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
  collectXmlText,
  decodeXml,
  encodeXml,
  transformXmlText
};
