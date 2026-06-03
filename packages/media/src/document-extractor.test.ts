import { describe, expect, it } from "bun:test";
import ExcelJS from "exceljs";

import { extractDocument } from "./document-extractor.js";

function createSimplePdf(text: string): Buffer {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${`BT /F1 24 Tf 72 720 Td (${escapedText}) Tj ET`.length} >>\nstream\nBT /F1 24 Tf 72 720 Td (${escapedText}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

describe("extractDocument", () => {
  it("extracts markdown from text-based PDFs", async () => {
    try {
      const result = await extractDocument({
        filename: "notice.pdf",
        mimeType: "application/pdf",
        data: createSimplePdf("Finn document extraction works"),
        ocrMode: "never",
      });

      expect(result.kind).toBe("pdf");
      expect(result.content).toContain("Finn document extraction works");
      expect(result.extraction.method).toBe("pdf-inspector");
      expect(result.extraction.pageCount).toBe(1);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(
        message.includes("PDF extraction requires @firecrawl/pdf-inspector native bindings") ||
          message.includes('Executable not found in $PATH: "pdftotext"'),
      ).toBe(true);
    }
  });

  it("extracts bounded spreadsheet text as CSV-flavored markdown", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tasks");
    sheet.addRow(["title", "owner"]);
    sheet.addRow(["Inspect attachment", "Finn"]);
    const data = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await extractDocument({
      filename: "tasks.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data,
      maxCharacters: 30,
    });

    expect(result.kind).toBe("spreadsheet");
    expect(result.content).toContain("## Tasks");
    expect(result.totalCharacters).toBeGreaterThan(result.content.length);
    expect(result.truncated).toBe(true);
    expect(result.nextOffset).toBe(30);
  });

  it("extracts TSV files as delimited text", async () => {
    const result = await extractDocument({
      filename: "tasks.tsv",
      mimeType: "application/octet-stream",
      data: Buffer.from("title\towner\nInspect attachment\tFinn\n"),
    });

    expect(result.kind).toBe("spreadsheet");
    expect(result.extraction.method).toBe("utf8-tsv");
    expect(result.content).toContain("Inspect attachment\tFinn");
  });

  it("strips simple HTML to text", async () => {
    const result = await extractDocument({
      filename: "message.html",
      mimeType: "text/html",
      data: Buffer.from("<html><body><h1>Hello</h1><p>Attachment detail</p></body></html>"),
    });

    expect(result.kind).toBe("html");
    expect(result.content).toBe("Hello\nAttachment detail");
  });
});
