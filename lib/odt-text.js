import AdmZip from "adm-zip";

function decodeXmlEntities(value = "") {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function cellTextFromXml(cellXml = "") {
  return decodeXmlEntities(
    String(cellXml || "")
      .replace(/<text:tab[^/]*\/>/gi, "\t")
      .replace(/<text:line-break[^/]*\/>/gi, " ")
      .replace(/<text:s[^/]*\/>/gi, " ")
      .replace(/<\/text:p>/gi, " ")
      .replace(/<\/text:h>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prefer table-aware extraction so 2-column menus (Café | Ta med) stay aligned.
 * Non-table paragraphs are appended afterward.
 */
export function extractTextFromOdt(buffer) {
  if (!buffer?.length) return "";
  try {
    const zip = new AdmZip(Buffer.from(buffer));
    const entry = zip.getEntry("content.xml");
    if (!entry) return "";
    const xml = entry.getData().toString("utf8");
    const chunks = [];

    const tables = [...String(xml).matchAll(/<table:table\b[\s\S]*?<\/table:table>/gi)];
    if (tables.length) {
      tables.forEach((match, tableIndex) => {
        const tableXml = match[0] || "";
        chunks.push(`=== TABLE ${tableIndex + 1} ===`);
        const rows = [...tableXml.matchAll(/<table:table-row\b[\s\S]*?<\/table:table-row>/gi)];
        for (const rowMatch of rows) {
          const rowXml = rowMatch[0] || "";
          const cells = [...rowXml.matchAll(/<table:table-cell\b[\s\S]*?<\/table:table-cell>/gi)].map((cellMatch) =>
            cellTextFromXml(cellMatch[0] || "")
          );
          // Keep empty cells so column positions stay stable for dual-price menus.
          if (cells.some((cell) => cell)) chunks.push(cells.join(" | "));
        }
        chunks.push("");
      });
    }

    // Strip tables, then gather remaining paragraph text (titles, notes, lists).
    const withoutTables = String(xml).replace(/<table:table\b[\s\S]*?<\/table:table>/gi, " ");
    const loose = decodeXmlEntities(
      withoutTables
        .replace(/<text:tab[^/]*\/>/gi, "\t")
        .replace(/<text:line-break[^/]*\/>/gi, "\n")
        .replace(/<text:s[^/]*\/>/gi, " ")
        .replace(/<\/text:p>/gi, "\n")
        .replace(/<\/text:h>/gi, "\n")
        .replace(/<\/text:list-item>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (loose) {
      if (chunks.length) chunks.push("=== OTHER TEXT ===", loose);
      else chunks.push(loose);
    }

    return chunks.join("\n").trim();
  } catch {
    return "";
  }
}
