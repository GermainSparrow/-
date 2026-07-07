const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("fontkit");
const { AppError } = require("./app-error");
const { applyRestoration, applySanitization, findOriginalLeaks } = require("./entity-service");

let pdfjsPromise = null;

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsPromise;
}

function hasImageOperators(pdfjs, operatorList) {
  const imageOps = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintJpegXObject,
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageMaskXObjectGroup,
    pdfjs.OPS.paintImageXObjectRepeat
  ].filter(Boolean));

  return operatorList.fnArray.some((fn) => imageOps.has(fn));
}

async function extractPdfPages(filePath) {
  const pdfjs = await getPdfjs();
  const bytes = await fs.readFile(filePath);
  let pdfDocument;

  try {
    pdfDocument = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      useSystemFonts: true
    }).promise;
  } catch (error) {
    throw new AppError("PDF_READ_FAILED", "无法读取 PDF 文件，可能是损坏、加密或格式不受支持", null);
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const operatorList = await page.getOperatorList();

    if (!textContent.items.length) {
      throw new AppError("BLOCKED_SCANNED_PDF", "PDF 包含无法抽取文本的页面，第一版不做 OCR，已阻断处理", {
        pageNumber
      });
    }

    if (hasImageOperators(pdfjs, operatorList)) {
      throw new AppError("BLOCKED_UNCONFIRMED_CONTENT", "PDF 包含图片内容，第一版无法确认图片内是否包含敏感信息");
    }

    pages.push({
      pageNumber,
      text: textContent.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim()
    });
  }

  return pages;
}

async function extractPdfDocument(filePath, docId) {
  const pages = await extractPdfPages(filePath);
  return {
    kind: "pdf",
    path: filePath,
    docId,
    textSegments: pages.map((page) => ({
      id: `${docId}:page:${page.pageNumber}`,
      label: `第 ${page.pageNumber} 页`,
      text: page.text
    })),
    warnings: ["PDF 将重生成安全文本 PDF，不保留原版式。"]
  };
}

function findFontPath() {
  const candidates = [
    "C:/Windows/Fonts/NotoSansSC-VF.ttf",
    "C:/Windows/Fonts/Deng.ttf",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsunb.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function wrapLine(line, font, fontSize, maxWidth) {
  const chars = Array.from(line);
  const lines = [];
  let current = "";

  for (const char of chars) {
    const next = current + char;
    if (font.widthOfTextAtSize(next, fontSize) > maxWidth && current) {
      lines.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function writeTextPdf(outputPath, pages) {
  const pdfDoc = await PDFDocument.create();
  const fontPath = findFontPath();
  let font;

  if (fontPath) {
    pdfDoc.registerFontkit(fontkit);
    const fontBytes = await fs.readFile(fontPath);
    font = await pdfDoc.embedFont(fontBytes, { subset: false });
  } else {
    const text = pages.map((page) => page.text).join("\n");
    if (/[^\x00-\x7F]/.test(text)) {
      throw new AppError("PDF_FONT_MISSING", "未找到可嵌入的中文字体，无法生成中文 PDF");
    }
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const pageSize = [595.28, 841.89];
  const margin = 48;
  const fontSize = 11;
  const lineHeight = 17;
  const maxWidth = pageSize[0] - margin * 2;

  for (const sourcePage of pages) {
    let page = pdfDoc.addPage(pageSize);
    let y = page.getHeight() - margin;
    const paragraphs = sourcePage.text.split(/\r?\n/);

    page.drawText(`来源 PDF 第 ${sourcePage.pageNumber} 页`, {
      x: margin,
      y,
      size: 10,
      font,
      color: rgb(0.35, 0.35, 0.35)
    });
    y -= lineHeight * 1.5;

    for (const paragraph of paragraphs) {
      const lines = wrapLine(paragraph, font, fontSize, maxWidth);
      for (const line of lines) {
        if (y < margin) {
          page = pdfDoc.addPage(pageSize);
          y = page.getHeight() - margin;
        }
        page.drawText(line, {
          x: margin,
          y,
          size: fontSize,
          font,
          color: rgb(0.08, 0.1, 0.1)
        });
        y -= lineHeight;
      }
      y -= lineHeight * 0.5;
    }
  }

  await fs.writeFile(outputPath, await pdfDoc.save());
}

async function sanitizePdfDocument({ filePath, outputPath, entities }) {
  const pages = await extractPdfPages(filePath);
  const sanitizedPages = pages.map((page) => ({
    ...page,
    text: applySanitization(page.text, entities)
  }));
  const leaks = findOriginalLeaks(sanitizedPages.map((page) => page.text).join("\n"), entities);
  if (leaks.length) {
    throw new AppError("SANITIZE_LEAK_DETECTED", "PDF 脱敏后仍检测到原始敏感信息", leaks);
  }
  await writeTextPdf(outputPath, sanitizedPages);
  return { warnings: ["PDF 已重生成安全文本 PDF，不保留原版式。"] };
}

async function restorePdfDocument({ filePath, outputPath, entities }) {
  const pages = await extractPdfPages(filePath);
  const restoredPages = pages.map((page) => ({
    ...page,
    text: applyRestoration(page.text, entities)
  }));
  await writeTextPdf(outputPath, restoredPages);
  return { warnings: ["PDF 已重生成文本 PDF，不保留原版式。"] };
}

module.exports = {
  extractPdfDocument,
  restorePdfDocument,
  sanitizePdfDocument
};
