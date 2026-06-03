import { createLogger } from "@finn/core";
import type { PdfResult } from "@firecrawl/pdf-inspector";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, parse } from "node:path";
import { tmpdir } from "node:os";

const logger = createLogger("document-extractor");

export const DEFAULT_DOCUMENT_MAX_CHARACTERS = 80_000;
export const MAX_DOCUMENT_MAX_CHARACTERS = 250_000;

export type DocumentKind = "pdf" | "docx" | "spreadsheet" | "text" | "html" | "office-convertible";
export type DocumentOcrMode = "auto" | "always" | "never";

export interface ExtractDocumentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
  maxCharacters?: number;
  offset?: number;
  ocrMode?: DocumentOcrMode;
  tempRoot?: string;
}

export interface ExtractDocumentResult {
  filename: string;
  mimeType: string;
  kind: DocumentKind;
  sizeBytes: number;
  content: string;
  offset: number;
  maxCharacters: number;
  totalCharacters: number;
  truncated: boolean;
  nextOffset: number | null;
  extraction: {
    method: string;
    warnings: string[];
    pageCount?: number;
    pdfType?: string;
    pagesNeedingOcr?: number[];
    ocrApplied?: boolean;
  };
}

interface FullExtraction {
  kind: DocumentKind;
  content: string;
  method: string;
  warnings: string[];
  pageCount?: number;
  pdfType?: string;
  pagesNeedingOcr?: number[];
  ocrApplied?: boolean;
}

type PdfInspector = typeof import("@firecrawl/pdf-inspector");

const pdfMimeTypes = new Set(["application/pdf"]);
const docxMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const spreadsheetMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "text/tab-separated-values",
]);
const officeConvertibleMimeTypes = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const plainTextMimeTypes = new Set([
  "application/json",
  "application/xml",
  "text/calendar",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/xml",
]);
const htmlMimeTypes = new Set(["text/html", "application/xhtml+xml"]);
const officeConvertibleExtensions = new Set([
  ".doc",
  ".odt",
  ".rtf",
  ".ppt",
  ".pptx",
  ".odp",
  ".ods",
  ".xls",
]);

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function sanitizeFilename(value: string): string {
  const safe = basename(value).replace(/[^\w .@()-]+/g, "_").trim();
  return safe.length > 0 ? safe : `document-${Date.now()}`;
}

function resolveDocumentKind(filename: string, mimeType: string): DocumentKind {
  const ext = extname(filename).toLowerCase();
  const normalizedMimeType = normalizeMimeType(mimeType);

  if (pdfMimeTypes.has(normalizedMimeType) || ext === ".pdf") return "pdf";
  if (docxMimeTypes.has(normalizedMimeType) || ext === ".docx") return "docx";
  if (["text/csv", "text/tab-separated-values"].includes(normalizedMimeType) || [".csv", ".tsv"].includes(ext)) return "spreadsheet";
  if (spreadsheetMimeTypes.has(normalizedMimeType) || [".xlsx", ".xlsm"].includes(ext)) return "spreadsheet";
  if (htmlMimeTypes.has(normalizedMimeType) || [".html", ".htm"].includes(ext)) return "html";
  if (plainTextMimeTypes.has(normalizedMimeType) || [".txt", ".md", ".markdown", ".json", ".xml", ".log"].includes(ext)) return "text";
  if (officeConvertibleMimeTypes.has(normalizedMimeType) || officeConvertibleExtensions.has(ext)) return "office-convertible";

  throw new Error(`Unsupported document type: ${mimeType || "unknown"} (${filename})`);
}

function sliceContent(content: string, input: Pick<ExtractDocumentInput, "maxCharacters" | "offset">): Pick<ExtractDocumentResult, "content" | "offset" | "maxCharacters" | "totalCharacters" | "truncated" | "nextOffset"> {
  const maxCharacters = Math.min(input.maxCharacters ?? DEFAULT_DOCUMENT_MAX_CHARACTERS, MAX_DOCUMENT_MAX_CHARACTERS);
  const offset = Math.min(input.offset ?? 0, content.length);
  const nextOffset = offset + maxCharacters < content.length ? offset + maxCharacters : null;
  return {
    content: content.slice(offset, offset + maxCharacters),
    offset,
    maxCharacters,
    totalCharacters: content.length,
    truncated: nextOffset !== null,
    nextOffset,
  };
}

function stripHtml(content: string): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function normalizeExtractedContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

async function extractPdf(input: ExtractDocumentInput): Promise<FullExtraction> {
  try {
    return await extractPdfWithInspector(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message, filename: input.filename }, "pdf-inspector extraction failed; falling back to pdftotext");
    return extractPdfWithPoppler(input, [`pdf-inspector unavailable: ${message}`]);
  }
}

async function extractPdfWithInspector(input: ExtractDocumentInput): Promise<FullExtraction> {
  const pdfInspector = await loadPdfInspector();
  const firstPass = pdfInspector.processPdf(input.data);
  const firstPassWarnings: string[] = [];
  const firstPassContent = normalizeExtractedContent(firstPass.markdown ?? "");
  const shouldOcr = shouldApplyOcr(firstPass, input.ocrMode ?? "auto", firstPassContent);

  if (!shouldOcr) {
    return pdfExtractionFromResult(firstPass, firstPassContent, false, firstPassWarnings);
  }

  try {
    const ocrData = await runOcrPdf(input);
    const ocrPass = pdfInspector.processPdf(ocrData);
    const ocrContent = normalizeExtractedContent(ocrPass.markdown ?? "");
    return pdfExtractionFromResult(ocrPass, ocrContent, true, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    firstPassWarnings.push(`OCR fallback failed: ${message}`);
    logger.warn({ error: message, filename: input.filename }, "PDF OCR fallback failed");
    return pdfExtractionFromResult(firstPass, firstPassContent, false, firstPassWarnings);
  }
}

async function extractPdfWithPoppler(input: ExtractDocumentInput, warnings: string[]): Promise<FullExtraction> {
  const firstPassContent = normalizeExtractedContent(await runPdftotext(input.data, input.filename, input.tempRoot));
  const shouldOcr = input.ocrMode === "always" || ((input.ocrMode ?? "auto") === "auto" && firstPassContent.length === 0);

  if (!shouldOcr) {
    return {
      kind: "pdf",
      content: firstPassContent,
      method: "pdftotext",
      warnings: firstPassContent.length === 0 ? [...warnings, "PDF contained no extractable text."] : warnings,
      ocrApplied: false,
    };
  }

  try {
    const ocrData = await runOcrPdf(input);
    const ocrContent = normalizeExtractedContent(await runPdftotext(ocrData, input.filename, input.tempRoot));
    return {
      kind: "pdf",
      content: ocrContent,
      method: "pdftotext+ocrmypdf",
      warnings: ocrContent.length === 0 ? [...warnings, "OCR completed but produced no extractable text."] : warnings,
      ocrApplied: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "pdf",
      content: firstPassContent,
      method: "pdftotext",
      warnings: [...warnings, `OCR fallback failed: ${message}`],
      ocrApplied: false,
    };
  }
}

async function runPdftotext(data: Buffer, filename: string, tempRoot?: string): Promise<string> {
  const root = tempRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const tempDir = await mkdtemp(join(root, ".finn-pdf-text-"));
  const inputPath = join(tempDir, sanitizeFilename(filename || "input.pdf"));

  try {
    await writeFile(inputPath, data);
    const proc = Bun.spawn([
      "pdftotext",
      "-layout",
      inputPath,
      "-",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`pdftotext exited with code ${exitCode}: ${stderrText || stdoutText}`.trim());
    }

    return stdoutText;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function loadPdfInspector(): Promise<PdfInspector> {
  try {
    return await import("@firecrawl/pdf-inspector");
  } catch (error) {
    throw new Error(
      `PDF extraction requires @firecrawl/pdf-inspector native bindings for this platform: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function shouldApplyOcr(result: PdfResult, ocrMode: DocumentOcrMode, content: string): boolean {
  if (ocrMode === "never") return false;
  if (ocrMode === "always") return true;
  return result.pagesNeedingOcr.length > 0 || content.length === 0;
}

function pdfExtractionFromResult(result: PdfResult, content: string, ocrApplied: boolean, warnings: string[]): FullExtraction {
  const pagesNeedingOcr = result.pagesNeedingOcr;
  if (!ocrApplied && pagesNeedingOcr.length > 0) {
    warnings.push(`Pages need OCR: ${pagesNeedingOcr.join(", ")}`);
  }
  if (content.length === 0) {
    warnings.push("PDF contained no extractable text.");
  }

  return {
    kind: "pdf",
    content,
    method: ocrApplied ? "pdf-inspector+ocrmypdf" : "pdf-inspector",
    warnings,
    pageCount: result.pageCount,
    pdfType: result.pdfType,
    pagesNeedingOcr,
    ocrApplied,
  };
}

async function runOcrPdf(input: ExtractDocumentInput): Promise<Buffer> {
  const tempRoot = input.tempRoot ?? tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, ".finn-document-ocr-"));
  const inputPath = join(tempDir, sanitizeFilename(input.filename || "input.pdf"));
  const outputPath = join(tempDir, "output.pdf");
  const ocrFlag = input.ocrMode === "always" ? "--force-ocr" : "--skip-text";

  try {
    await writeFile(inputPath, input.data);
    const proc = Bun.spawn([
      "ocrmypdf",
      ocrFlag,
      "--rotate-pages",
      "--deskew",
      "--optimize",
      "0",
      inputPath,
      outputPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`ocrmypdf exited with code ${exitCode}: ${stderrText || stdoutText}`.trim());
    }

    return Buffer.from(await Bun.file(outputPath).arrayBuffer());
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractDocx(input: ExtractDocumentInput): Promise<FullExtraction> {
  const result = await mammoth.extractRawText({ buffer: input.data });
  return {
    kind: "docx",
    content: normalizeExtractedContent(result.value),
    method: "mammoth",
    warnings: result.messages.map((message) => message.message),
  };
}

async function extractSpreadsheet(input: ExtractDocumentInput): Promise<FullExtraction> {
  const workbook = new ExcelJS.Workbook();
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  const ext = extname(input.filename).toLowerCase();
  if (normalizedMimeType === "text/csv" || ext === ".csv") {
    return extractDelimitedText(input, "CSV", "utf8-csv");
  }
  if (normalizedMimeType === "text/tab-separated-values" || ext === ".tsv") {
    return extractDelimitedText(input, "TSV", "utf8-tsv");
  }

  // ExcelJS declares its own Buffer shape, but the runtime accepts Node buffers.
  const workbookData = input.data as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookData);
  const sections = workbook.worksheets
    .map(worksheetToMarkdown)
    .filter((section) => section.trim().length > 0);

  return {
    kind: "spreadsheet",
    content: normalizeExtractedContent(sections.join("\n\n")),
    method: "exceljs",
    warnings: sections.length === 0 ? ["Spreadsheet contained no extractable cell text."] : [],
  };
}

function extractDelimitedText(input: ExtractDocumentInput, label: "CSV" | "TSV", method: string): FullExtraction {
  return {
    kind: "spreadsheet",
    content: normalizeExtractedContent([`## ${label}`, "```csv", input.data.toString("utf8").trim(), "```"].join("\n")),
    method,
    warnings: input.data.length === 0 ? [`${label} contained no extractable text.`] : [],
  };
}

function worksheetToMarkdown(worksheet: ExcelJS.Worksheet): string {
  const rows: string[] = [];
  worksheet.eachRow((row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : Object.values(row.values);
    const line = values.map(formatCellValue).join(",");
    if (line.trim().length > 0) {
      rows.push(line);
    }
  });

  if (rows.length === 0) {
    return "";
  }

  return [`## ${worksheet.name}`, "```csv", ...rows, "```"].join("\n");
}

function formatCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return escapeCsv(value.text);
    if ("result" in value) return escapeCsv(String(value.result ?? ""));
    if ("richText" in value && Array.isArray(value.richText)) {
      return escapeCsv(value.richText.map((part) => part.text).join(""));
    }
    if ("hyperlink" in value && "text" in value) {
      return escapeCsv(`${String(value.text)} (${String(value.hyperlink)})`);
    }
  }
  return escapeCsv(String(value));
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function extractText(input: ExtractDocumentInput, kind: "text" | "html"): FullExtraction {
  const raw = input.data.toString("utf8");
  return {
    kind,
    content: normalizeExtractedContent(kind === "html" ? stripHtml(raw) : raw),
    method: kind === "html" ? "html-text" : "utf8",
    warnings: [],
  };
}

async function extractOfficeConvertible(input: ExtractDocumentInput): Promise<FullExtraction> {
  const tempRoot = input.tempRoot ?? tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, ".finn-document-convert-"));
  const inputPath = join(tempDir, sanitizeFilename(input.filename));

  try {
    await writeFile(inputPath, input.data);
    const proc = Bun.spawn([
      "soffice",
      "--headless",
      "--convert-to",
      "txt:Text",
      "--outdir",
      tempDir,
      inputPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`soffice exited with code ${exitCode}: ${stderrText || stdoutText}`.trim());
    }

    const baseName = parse(inputPath).name;
    const entries = await readdir(tempDir);
    const outputName = entries.find((entry) => entry === `${baseName}.txt`)
      ?? entries.find((entry) => extname(entry).toLowerCase() === ".txt");
    if (!outputName) {
      throw new Error("LibreOffice did not produce a text file.");
    }

    return {
      kind: "office-convertible",
      content: normalizeExtractedContent(await readFile(join(tempDir, outputName), "utf8")),
      method: "libreoffice",
      warnings: [],
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
  const kind = resolveDocumentKind(input.filename, input.mimeType);
  const full = kind === "pdf"
    ? await extractPdf(input)
    : kind === "docx"
      ? await extractDocx(input)
      : kind === "spreadsheet"
        ? await extractSpreadsheet(input)
        : kind === "html"
          ? extractText(input, "html")
          : kind === "text"
            ? extractText(input, "text")
            : await extractOfficeConvertible(input);
  const sliced = sliceContent(full.content, input);

  return {
    filename: input.filename,
    mimeType: input.mimeType,
    kind: full.kind,
    sizeBytes: input.data.length,
    ...sliced,
    extraction: {
      method: full.method,
      warnings: full.warnings,
      ...(full.pageCount !== undefined ? { pageCount: full.pageCount } : {}),
      ...(full.pdfType !== undefined ? { pdfType: full.pdfType } : {}),
      ...(full.pagesNeedingOcr !== undefined ? { pagesNeedingOcr: full.pagesNeedingOcr } : {}),
      ...(full.ocrApplied !== undefined ? { ocrApplied: full.ocrApplied } : {}),
    },
  };
}
