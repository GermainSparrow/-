const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { AppError } = require("./app-error");
const { extractDocxDocument } = require("./docx-processor");

const MAX_PREVIEW_CHARS = 120000;
const PREVIEW_STREAM_CHUNK_SIZE = 65536;
const TRUNCATION_NOTICE = "\n\n……内容过长，预览已截断。";

function friendlySegmentLabel(label) {
  const normalized = String(label || "").replace(/\\/g, "/");
  if (normalized === "word/document.xml") return "正文";
  const headerMatch = normalized.match(/^word\/header(\d*)\.xml$/u);
  if (headerMatch) return `页眉${headerMatch[1] || ""}`;
  const footerMatch = normalized.match(/^word\/footer(\d*)\.xml$/u);
  if (footerMatch) return `页脚${footerMatch[1] || ""}`;
  if (normalized === "word/comments.xml") return "批注";
  if (normalized === "word/footnotes.xml") return "脚注";
  if (normalized === "word/endnotes.xml") return "尾注";
  if (normalized.includes("/charts/")) return "图表";
  if (normalized.startsWith("customXml/")) return "自定义内容";
  if (normalized.endsWith(".rels")) return "外部链接";
  return normalized || "内容";
}

function formatSegments(textSegments) {
  return textSegments
    .map((segment) => {
      const label = friendlySegmentLabel(segment.label);
      const text = String(segment.text || "").trim();
      return label ? `【${label}】\n${text}` : text;
    })
    .filter(Boolean)
    .join("\n\n");
}

function boundedPreview(content, forceTruncated = false) {
  const truncated = forceTruncated || content.length > MAX_PREVIEW_CHARS;
  if (!truncated) {
    return {
      content,
      truncated: false
    };
  }

  return {
    content: `${content.slice(0, MAX_PREVIEW_CHARS)}${TRUNCATION_NOTICE}`,
    truncated: true
  };
}

async function previewTextFile(filePath) {
  const decoder = new TextDecoder("utf-8");
  const stream = fs.createReadStream(filePath, {
    highWaterMark: PREVIEW_STREAM_CHUNK_SIZE
  });
  let content = "";
  let truncated = false;

  try {
    for await (const chunk of stream) {
      content += decoder.decode(chunk, { stream: true });
      if (content.length > MAX_PREVIEW_CHARS) {
        truncated = true;
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  if (!truncated) {
    content += decoder.decode();
  }

  return boundedPreview(content, truncated);
}

async function previewOutputFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let preview;
  let warnings = [];

  if (extension === ".docx") {
    const document = await extractDocxDocument(filePath, "output-preview");
    preview = boundedPreview(formatSegments(document.textSegments));
    warnings = document.warnings || [];
  } else if (extension === ".txt") {
    preview = await previewTextFile(filePath);
  } else {
    throw new AppError("OUTPUT_PREVIEW_UNSUPPORTED", "当前仅支持预览 DOCX 和 TXT 输出文件", {
      extension
    });
  }

  return {
    filePath,
    content: preview.content,
    warnings,
    truncated: preview.truncated
  };
}

module.exports = {
  previewOutputFile
};
