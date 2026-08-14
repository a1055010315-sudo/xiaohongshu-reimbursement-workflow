import path from "node:path";

const MAX_EXCEL_ROW = 1_048_576;
const CELL_RANGE = /\$?([A-Z]{1,3})\$?(\d+)(?:\s*:\s*\$?([A-Z]{1,3})\$?(\d+))?/giu;
const WHOLE_COLUMN_RANGE = /\$?[A-Z]{1,3}\s*:\s*\$?[A-Z]{1,3}/giu;
const WHOLE_ROW_RANGE = /(?<![A-Z0-9_.])\$?(\d+)\s*:\s*\$?(\d+)(?![A-Z0-9_.])/giu;
const QUALIFIED_REFERENCE = /(?:'((?:[^']|'')+)'|((?:\[[^\]]+\])?[\p{L}\p{N}_.]+))!\s*(\$?[A-Z]{1,3}\$?\d+(?:\s*:\s*\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}\s*:\s*\$?[A-Z]{1,3}|\$?\d+\s*:\s*\$?\d+)/giu;

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function parseAttrs(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    attrs[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function relationshipPartPath(partPath) {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

function normalizeTarget(sourcePart, target) {
  const normalized = String(target ?? "").replace(/\\/gu, "/");
  return normalized.startsWith("/")
    ? normalized.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), normalized));
}

function intersects(start, end, controlledStart, controlledEnd) {
  return start <= controlledEnd && end >= controlledStart;
}

function referenceRows(reference) {
  const value = String(reference).replace(/\s/gu, "").toUpperCase();
  if (/^\$?[A-Z]{1,3}:\$?[A-Z]{1,3}$/u.test(value)) return { start: 1, end: MAX_EXCEL_ROW };
  const rowRange = /^\$?(\d+):\$?(\d+)$/u.exec(value);
  if (rowRange) return { start: Math.min(Number(rowRange[1]), Number(rowRange[2])), end: Math.max(Number(rowRange[1]), Number(rowRange[2])) };
  const cellRange = /^\$?[A-Z]{1,3}\$?(\d+)(?::\$?[A-Z]{1,3}\$?(\d+))?$/u.exec(value);
  if (!cellRange) return null;
  const first = Number(cellRange[1]);
  const last = Number(cellRange[2] ?? cellRange[1]);
  return { start: Math.min(first, last), end: Math.max(first, last) };
}

function sheetSpecTargets(spec, editableName, sheetOrder) {
  const withoutBook = String(spec).replace(/^\[[^\]]+\]/u, "").replaceAll("''", "'");
  if (!withoutBook.includes(":")) return withoutBook.toLocaleLowerCase("en-US") === editableName.toLocaleLowerCase("en-US");
  const [first, last, ...rest] = withoutBook.split(":");
  if (rest.length) return withoutBook.includes(editableName);
  const start = sheetOrder.findIndex((name) => name.toLocaleLowerCase("en-US") === first.toLocaleLowerCase("en-US"));
  const end = sheetOrder.findIndex((name) => name.toLocaleLowerCase("en-US") === last.toLocaleLowerCase("en-US"));
  const target = sheetOrder.findIndex((name) => name.toLocaleLowerCase("en-US") === editableName.toLocaleLowerCase("en-US"));
  return start >= 0 && end >= 0 && target >= Math.min(start, end) && target <= Math.max(start, end);
}

function qualifiedHits(text, editableName, sheetOrder, controlledStart, controlledEnd) {
  const hits = [];
  const decoded = decodeXml(text);
  for (const match of decoded.matchAll(QUALIFIED_REFERENCE)) {
    const spec = match[1]?.replaceAll("''", "'") ?? match[2] ?? "";
    const rows = referenceRows(match[3]);
    if (rows && sheetSpecTargets(spec, editableName, sheetOrder) && intersects(rows.start, rows.end, controlledStart, controlledEnd)) {
      hits.push({ reference: match[0], index: match.index, length: match[0].length });
    }
  }
  return hits;
}

function unqualifiedHits(text, controlledStart, controlledEnd) {
  let value = decodeXml(text).replace(/"(?:[^"]|"")*"/gu, (match) => " ".repeat(match.length));
  value = value.replace(QUALIFIED_REFERENCE, (match) => " ".repeat(match.length));
  const hits = [];
  for (const match of value.matchAll(CELL_RANGE)) {
    const before = value[match.index - 1] ?? "";
    const after = value[match.index + match[0].length] ?? "";
    if (/[A-Z0-9_.]/iu.test(before) || /[A-Z0-9_.]/iu.test(after)) continue;
    const first = Number(match[2]);
    const last = Number(match[4] ?? match[2]);
    if (intersects(Math.min(first, last), Math.max(first, last), controlledStart, controlledEnd)) hits.push(match[0]);
  }
  for (const match of value.matchAll(WHOLE_COLUMN_RANGE)) hits.push(match[0]);
  for (const match of value.matchAll(WHOLE_ROW_RANGE)) {
    if (intersects(Math.min(Number(match[1]), Number(match[2])), Math.max(Number(match[1]), Number(match[2])), controlledStart, controlledEnd)) hits.push(match[0]);
  }
  return hits;
}

function allowedControlledFormula(cell, controlledStart, controlledEnd) {
  const match = /^\s*=?\s*SUM\(\s*\$?C\$?(\d+)\s*:\s*\$?C\$?(\d+)\s*\)\s*$/iu.exec(cell.formula ?? "");
  if (!match || !/^D\d+$/u.test(cell.ref)) return false;
  const first = Number(match[1]);
  const last = Number(match[2]);
  return first >= controlledStart && last <= controlledEnd && first <= last;
}

function addFailure(failures, code, detail) {
  failures.add(`${code}:${detail}`);
}

function scanSheetFormulas(metadata, editableSheet, controlledStart, controlledEnd, failures) {
  const sheetOrder = metadata.sheets.map((sheet) => sheet.name);
  for (const sheet of metadata.sheets) {
    for (const cell of sheet.cells.values()) {
      if (cell.formula === null) continue;
      const row = Number(/\d+$/u.exec(cell.ref)?.[0] ?? 0);
      if (sheet.name === editableSheet.name && row >= controlledStart && row <= controlledEnd) {
        if (!allowedControlledFormula(cell, controlledStart, controlledEnd)) addFailure(failures, "controlled-formula", `${sheet.name}!${cell.ref}`);
        continue;
      }
      const qualified = qualifiedHits(cell.formula, editableSheet.name, sheetOrder, controlledStart, controlledEnd);
      const unqualified = sheet.name === editableSheet.name ? unqualifiedHits(cell.formula, controlledStart, controlledEnd) : [];
      if (qualified.length || unqualified.length) {
        addFailure(failures, sheet.name === editableSheet.name ? "editable-outside-formula" : "protected-formula", `${sheet.name}!${cell.ref}`);
      }
    }
  }
}

async function scanDefinedNames(metadata, editableSheet, controlledStart, controlledEnd, failures) {
  const workbookXml = await metadata.zip.file("xl/workbook.xml")?.async("string");
  const sheetOrder = metadata.sheets.map((sheet) => sheet.name);
  for (const match of (workbookXml ?? "").matchAll(/<(?:\w+:)?definedName\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?definedName\s*>/gu)) {
    const attrs = parseAttrs(`<definedName ${match[1]}>`);
    const name = attrs.name ?? "(unnamed)";
    if (["_xlnm.Print_Area", "_xlnm.Print_Titles"].includes(name)) continue;
    const formula = decodeXml(match[2]);
    const localIndex = attrs.localSheetId === undefined ? null : Number(attrs.localSheetId);
    const localSheet = Number.isSafeInteger(localIndex) ? metadata.sheets[localIndex]?.name : null;
    const qualified = qualifiedHits(formula, editableSheet.name, sheetOrder, controlledStart, controlledEnd);
    const unqualified = localSheet === editableSheet.name || localSheet === null ? unqualifiedHits(formula, controlledStart, controlledEnd) : [];
    if (qualified.length || unqualified.length) addFailure(failures, "defined-name", name);
  }
}

function rangeAttrs(xml, elementName = null) {
  const expression = elementName
    ? new RegExp(`<(?:\\w+:)?${elementName}\\b[^>]*>`, "gu")
    : /<(?:\w+:)?[\w.-]+\b[^>]*>/gu;
  const refs = [];
  for (const match of String(xml ?? "").matchAll(expression)) {
    const ref = parseAttrs(match[0]).ref;
    if (ref && referenceRows(ref)) refs.push(ref);
  }
  return refs;
}

function anyRefIntersects(refs, controlledStart, controlledEnd) {
  return refs.some((ref) => {
    const rows = referenceRows(ref);
    return rows && intersects(rows.start, rows.end, controlledStart, controlledEnd);
  });
}

async function scanEditableRelationships(metadata, editableSheet, controlledStart, controlledEnd, failures) {
  const relPath = relationshipPartPath(editableSheet.path);
  const relXml = await metadata.zip.file(relPath)?.async("string");
  const relationships = [];
  for (const match of (relXml ?? "").matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) relationships.push(parseAttrs(match[0]));

  for (const match of editableSheet.xml.matchAll(/<(?:\w+:)?hyperlink\b[^>]*\/?\s*>/gu)) {
    const attrs = parseAttrs(match[0]);
    const rows = referenceRows(attrs.ref);
    const locationHits = attrs.location
      ? [...qualifiedHits(attrs.location, editableSheet.name, metadata.sheets.map((sheet) => sheet.name), controlledStart, controlledEnd), ...unqualifiedHits(attrs.location, controlledStart, controlledEnd)]
      : [];
    if ((rows && intersects(rows.start, rows.end, controlledStart, controlledEnd)) || locationHits.length) addFailure(failures, "editable-hyperlink", attrs.ref ?? attrs.location ?? "ambiguous");
  }

  for (const relation of relationships) {
    const type = relation.Type ?? "";
    const shortType = type.slice(type.lastIndexOf("/") + 1);
    if (shortType === "printerSettings") continue;
    if (shortType === "hyperlink") {
      const linked = [...editableSheet.xml.matchAll(/<(?:\w+:)?hyperlink\b[^>]*\/?\s*>/gu)].some((match) => parseAttrs(match[0])["r:id"] === relation.Id);
      if (!linked) addFailure(failures, "ambiguous-relationship", `hyperlink:${relation.Id ?? "unknown"}`);
      continue;
    }

    if ((relation.TargetMode ?? "Internal") === "External") {
      addFailure(failures, "unsupported-relationship", `${shortType || "external"}:${relation.Id ?? "unknown"}`);
      continue;
    }
    const target = normalizeTarget(editableSheet.path, relation.Target);
    const targetXml = await metadata.zip.file(target)?.async("string");
    if (!targetXml) {
      addFailure(failures, "missing-relationship-target", `${shortType}:${target}`);
      continue;
    }
    if (shortType === "comments" || shortType === "threadedComment" || shortType === "threadedComments") {
      const refs = rangeAttrs(targetXml, "comment");
      if (!refs.length) addFailure(failures, "ambiguous-relationship", `${shortType}:${target}`);
      else if (anyRefIntersects(refs, controlledStart, controlledEnd)) addFailure(failures, "editable-comment", refs.join(","));
      continue;
    }
    if (shortType === "table") {
      const refs = rangeAttrs(targetXml);
      if (!refs.length) addFailure(failures, "ambiguous-relationship", `table:${target}`);
      else if (anyRefIntersects(refs, controlledStart, controlledEnd)) addFailure(failures, "editable-table", refs.join(","));
      continue;
    }
    if (shortType === "drawing") {
      const anchorRows = [...targetXml.matchAll(/<(?:\w+:)?row\b[^>]*>(\d+)<\/(?:\w+:)?row\s*>/gu)].map((match) => Number(match[1]) + 1);
      if (anchorRows.some((row) => row >= controlledStart && row <= controlledEnd)) addFailure(failures, "editable-drawing-anchor", target);
      continue;
    }
    if (shortType === "vmlDrawing") {
      const anchorRows = [...targetXml.matchAll(/<(?:\w+:)?Row\b[^>]*>(\d+)<\/(?:\w+:)?Row\s*>/gu)].map((match) => Number(match[1]) + 1);
      if (!anchorRows.length) addFailure(failures, "ambiguous-relationship", `vmlDrawing:${target}`);
      else if (anchorRows.some((row) => row >= controlledStart && row <= controlledEnd)) addFailure(failures, "editable-vml-anchor", target);
      continue;
    }
    addFailure(failures, "unsupported-relationship", `${shortType || type || "unknown"}:${target}`);
  }
}

async function scanRelatedXmlParts(metadata, editableSheet, controlledStart, controlledEnd, failures) {
  const sheetOrder = metadata.sheets.map((sheet) => sheet.name);
  const ignored = new Set(["xl/workbook.xml", "xl/styles.xml", "xl/sharedStrings.xml"]);
  const sheetParts = new Set(metadata.sheets.map((sheet) => sheet.path));
  const entries = Object.values(metadata.zip.files).filter((entry) => !entry.dir && entry.name.startsWith("xl/") && entry.name.endsWith(".xml") && !ignored.has(entry.name) && !sheetParts.has(entry.name) && !entry.name.startsWith("xl/theme/"));
  for (const entry of entries) {
    const xml = await entry.async("string");
    if (qualifiedHits(xml, editableSheet.name, sheetOrder, controlledStart, controlledEnd).length) addFailure(failures, "related-part-reference", entry.name);
  }
}

/**
 * Fail closed before a controlled segment is reordered when OOXML outside that
 * segment depends on its row addresses.  The builder intentionally does not
 * rewrite formulas, names, drawings, tables, comments or other package parts.
 */
export async function assertControlledSegmentReferenceSafety({ metadata, editableSheet, startRow, endRow, profileId = "profile" }) {
  if (!metadata?.zip || !editableSheet?.path) throw new Error("Controlled-segment dependency guard requires workbook metadata and its resolved editable sheet.");
  if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow) || startRow < 1 || endRow < startRow - 1) throw new Error("Controlled-segment dependency guard received an invalid row interval.");
  if (endRow < startRow) return { ok: true, dependencyCount: 0 };
  const failures = new Set();
  scanSheetFormulas(metadata, editableSheet, startRow, endRow, failures);
  await Promise.all([
    scanDefinedNames(metadata, editableSheet, startRow, endRow, failures),
    scanEditableRelationships(metadata, editableSheet, startRow, endRow, failures),
    scanRelatedXmlParts(metadata, editableSheet, startRow, endRow, failures),
  ]);
  if (failures.size) throw new Error(`CONTROLLED_SEGMENT_DEPENDENCY:${profileId}:${[...failures].sort().join(",")}`);
  return { ok: true, dependencyCount: 0 };
}
