import crypto from "node:crypto";

const MAX_XML_CHARS = 8 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9]*$/u;
const XML_NAME_PREFIX = "(?:[A-Za-z_][\\w.-]*:)?";
const THEME_ORDER = Object.freeze([
  "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink",
]);

function fail(message) {
  throw new Error(`Workbook Style Contract ${message}`);
}

function record(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function cleanString(value, field) {
  if (typeof value !== "string" || !value || value !== value.trim()) fail(`${field} must be a non-empty trimmed string.`);
  return value;
}

function exactKeys(value, allowed, field) {
  record(value, field);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${field} contains unknown field ${key}.`);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${field} is missing ${key}.`);
}

function assertXml(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be non-empty XML text.`);
  if (value.length > MAX_XML_CHARS) fail(`${field} exceeds the ${MAX_XML_CHARS}-character audit limit.`);
  if (/<!DOCTYPE|<!ENTITY/iu.test(value)) fail(`${field} contains a forbidden DTD or entity declaration.`);
  return value;
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function attributes(tag) {
  const output = Object.create(null);
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/gu)) {
    const key = match[1].includes(":") ? match[1].split(":").at(-1) : match[1];
    if (Object.hasOwn(output, key)) fail(`XML tag contains duplicate attribute ${key}.`);
    output[key] = decodeXml(match[2]);
  }
  return output;
}

function elementBlock(xml, name, { required = true } = {}) {
  const regex = new RegExp(`<${XML_NAME_PREFIX}${name}\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/${XML_NAME_PREFIX}${name}\\s*>)`, "giu");
  const matches = [...xml.matchAll(regex)].map((match) => match[0]);
  if (matches.length > 1) fail(`XML contains duplicate ${name} elements where one was expected.`);
  if (required && matches.length !== 1) fail(`XML is missing ${name}.`);
  return matches[0] ?? null;
}

function elementItems(xml, name) {
  return [...xml.matchAll(new RegExp(`<${XML_NAME_PREFIX}${name}\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/${XML_NAME_PREFIX}${name}\\s*>)`, "giu"))]
    .map((match) => match[0]);
}

function openingTag(xml) {
  return /^<[^>]+>/u.exec(xml)?.[0] ?? "";
}

function childTag(xml, name) {
  return new RegExp(`<${XML_NAME_PREFIX}${name}\\b[^>]*?\\/?\\s*>`, "iu").exec(xml)?.[0] ?? null;
}

function childBoolean(xml, name) {
  const tag = childTag(xml, name);
  if (!tag) return false;
  const value = attributes(tag).val;
  return value === undefined || value === "1" || value === "true";
}

function childValue(xml, name) {
  const tag = childTag(xml, name);
  return tag ? attributes(tag).val ?? null : null;
}

function normalizeArgb(value, field) {
  if (typeof value !== "string" || !/^(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/u.test(value)) fail(`${field} is not an RGB/ARGB value.`);
  return (value.length === 6 ? `FF${value}` : value).toUpperCase();
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { hue: hue / 6, saturation, lightness };
}

function hslToRgb(hue, saturation, lightness) {
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const hueChannel = (p, q, value) => {
    let t = value;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [hueChannel(p, q, hue + 1 / 3), hueChannel(p, q, hue), hueChannel(p, q, hue - 1 / 3)].map((value) => Math.round(value * 255));
}

function applyTint(argb, tint) {
  if (tint === 0) return argb;
  const red = Number.parseInt(argb.slice(2, 4), 16);
  const green = Number.parseInt(argb.slice(4, 6), 16);
  const blue = Number.parseInt(argb.slice(6, 8), 16);
  const hsl = rgbToHsl(red, green, blue);
  const lightness = tint < 0
    ? hsl.lightness * (1 + tint)
    : hsl.lightness * (1 - tint) + tint;
  const [r, g, b] = hslToRgb(hsl.hue, hsl.saturation, Math.max(0, Math.min(1, lightness)));
  return `FF${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function themePalette(themeXml) {
  if (themeXml === null || themeXml === undefined) return [];
  assertXml(themeXml, "themeXml");
  const scheme = elementBlock(themeXml, "clrScheme");
  return THEME_ORDER.map((name) => {
    const block = elementBlock(scheme, name);
    const srgb = childTag(block, "srgbClr");
    if (srgb) return normalizeArgb(attributes(srgb).val, `theme.${name}`);
    const system = childTag(block, "sysClr");
    if (system) return normalizeArgb(attributes(system).lastClr, `theme.${name}`);
    fail(`theme.${name} has no resolvable RGB color.`);
  });
}

function colorSignature(tag, palette, field) {
  if (!tag) return null;
  const value = attributes(tag);
  const tint = value.tint === undefined ? 0 : Number(value.tint);
  if (!Number.isFinite(tint) || tint < -1 || tint > 1) fail(`${field}.tint is invalid.`);
  if (value.rgb !== undefined) {
    const argb = normalizeArgb(value.rgb, `${field}.rgb`);
    return applyTint(argb, tint);
  }
  if (value.theme !== undefined) {
    const index = Number(value.theme);
    if (!Number.isSafeInteger(index) || index < 0 || index >= palette.length) fail(`${field}.theme is outside the loaded theme.`);
    return applyTint(palette[index], tint);
  }
  if (value.indexed !== undefined) return `indexed:${Number(value.indexed)}:${tint}`;
  if (value.auto !== undefined) return `auto:${value.auto}:${tint}`;
  return null;
}

function borderEdge(block, name, palette, field) {
  const tag = new RegExp(`<${XML_NAME_PREFIX}${name}\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/${XML_NAME_PREFIX}${name}\\s*>)`, "iu").exec(block)?.[0] ?? null;
  if (!tag) return null;
  const style = attributes(openingTag(tag)).style ?? "none";
  return { style, color: colorSignature(childTag(tag, "color"), palette, `${field}.${name}.color`) };
}

function parseStyleSheet(stylesXml, themeXml) {
  assertXml(stylesXml, "stylesXml");
  const palette = themePalette(themeXml);
  const numFormats = new Map();
  const numFmtsBlock = elementBlock(stylesXml, "numFmts", { required: false });
  for (const item of numFmtsBlock ? elementItems(numFmtsBlock, "numFmt") : []) {
    const value = attributes(openingTag(item));
    const id = Number(value.numFmtId);
    if (!Number.isSafeInteger(id) || id < 0 || typeof value.formatCode !== "string") fail("numFmt is invalid.");
    if (numFormats.has(id)) fail(`numFmtId ${id} is duplicated.`);
    numFormats.set(id, value.formatCode);
  }
  const fonts = elementItems(elementBlock(stylesXml, "fonts"), "font");
  const fills = elementItems(elementBlock(stylesXml, "fills"), "fill");
  const borders = elementItems(elementBlock(stylesXml, "borders"), "border");
  const cellFormats = elementItems(elementBlock(stylesXml, "cellXfs"), "xf");
  if (fonts.length === 0 || fills.length === 0 || borders.length === 0 || cellFormats.length === 0) fail("stylesXml has an empty required collection.");
  return { palette, numFormats, fonts, fills, borders, cellFormats };
}

function semanticStyle(parsed, styleIndex, field) {
  if (!Number.isSafeInteger(styleIndex) || styleIndex < 0 || styleIndex >= parsed.cellFormats.length) fail(`${field} style index is outside cellXfs.`);
  const xf = parsed.cellFormats[styleIndex];
  const xfAttrs = attributes(openingTag(xf));
  const fontId = Number(xfAttrs.fontId ?? 0);
  const fillId = Number(xfAttrs.fillId ?? 0);
  const borderId = Number(xfAttrs.borderId ?? 0);
  const numFmtId = Number(xfAttrs.numFmtId ?? 0);
  if (![fontId, fillId, borderId, numFmtId].every((value) => Number.isSafeInteger(value) && value >= 0)) fail(`${field} has invalid style references.`);
  const font = parsed.fonts[fontId];
  const fill = parsed.fills[fillId];
  const border = parsed.borders[borderId];
  if (!font || !fill || !border) fail(`${field} references a missing style component.`);
  const alignmentTag = childTag(xf, "alignment");
  const protectionTag = childTag(xf, "protection");
  const alignment = alignmentTag ? attributes(alignmentTag) : Object.create(null);
  const protection = protectionTag ? attributes(protectionTag) : Object.create(null);
  const pattern = new RegExp(`<${XML_NAME_PREFIX}patternFill\\b[^>]*?(?:\\/\\s*>|>[\\s\\S]*?<\\/${XML_NAME_PREFIX}patternFill\\s*>)`, "iu").exec(fill)?.[0] ?? null;
  const patternAttrs = pattern ? attributes(openingTag(pattern)) : Object.create(null);
  return {
    font: {
      name: childValue(font, "name"),
      sizePoints: childValue(font, "sz") === null ? null : Number(childValue(font, "sz")),
      bold: childBoolean(font, "b"),
      italic: childBoolean(font, "i"),
      underline: childValue(font, "u") ?? (childTag(font, "u") ? "single" : null),
      color: colorSignature(childTag(font, "color"), parsed.palette, `${field}.font.color`),
    },
    fill: {
      patternType: patternAttrs.patternType ?? "none",
      foreground: pattern ? colorSignature(childTag(pattern, "fgColor"), parsed.palette, `${field}.fill.foreground`) : null,
      background: pattern ? colorSignature(childTag(pattern, "bgColor"), parsed.palette, `${field}.fill.background`) : null,
    },
    border: Object.fromEntries(["left", "right", "top", "bottom", "diagonal"]
      .map((edge) => [edge, borderEdge(border, edge, parsed.palette, `${field}.border`)])
      .filter(([, value]) => value !== null)),
    alignment: {
      horizontal: alignment.horizontal ?? null,
      vertical: alignment.vertical ?? null,
      wrapText: alignment.wrapText === "1" || alignment.wrapText === "true",
      shrinkToFit: alignment.shrinkToFit === "1" || alignment.shrinkToFit === "true",
      textRotation: alignment.textRotation === undefined ? 0 : Number(alignment.textRotation),
      indent: alignment.indent === undefined ? 0 : Number(alignment.indent),
    },
    numberFormat: parsed.numFormats.get(numFmtId) ?? `builtin:${numFmtId}`,
    protection: protectionTag ? {
      locked: protection.locked === undefined ? null : protection.locked === "1" || protection.locked === "true",
      hidden: protection.hidden === undefined ? null : protection.hidden === "1" || protection.hidden === "true",
    } : null,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalStyleDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

export function extractRoleSignatures({ stylesXml, themeXml = null, styleRoles }) {
  record(styleRoles, "styleRoles");
  const parsed = parseStyleSheet(stylesXml, themeXml);
  const signatures = Object.create(null);
  for (const role of Object.keys(styleRoles).sort()) {
    if (!ROLE_RE.test(role)) fail(`styleRoles contains invalid role ${role}.`);
    signatures[role] = semanticStyle(parsed, styleRoles[role], `styleRoles.${role}`);
  }
  return signatures;
}

function numericAttribute(value, field, { integer = false } = {}) {
  if (value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || (integer && !Number.isSafeInteger(result))) fail(`${field} is invalid.`);
  return result;
}

function worksheetCellStyles(worksheetXml) {
  const result = Object.create(null);
  for (const match of worksheetXml.matchAll(new RegExp(`<${XML_NAME_PREFIX}c\\b[^>]*\\br\\s*=\\s*"([A-Z]{1,3}[1-9]\\d*)"[^>]*>`, "giu"))) {
    const style = numericAttribute(attributes(match[0]).s ?? "0", `${match[1]}.style`, { integer: true });
    result[match[1]] = style;
  }
  return result;
}

function workbookPrintNames(workbookXml) {
  if (!workbookXml) return Object.create(null);
  assertXml(workbookXml, "workbookXml");
  const output = Object.create(null);
  for (const block of elementItems(workbookXml, "definedName")) {
    const name = attributes(openingTag(block)).name;
    if (!name || !name.startsWith("_xlnm.")) continue;
    const text = decodeXml(block.replace(/^<[^>]+>/u, "").replace(/<\/[^>]+>$/u, ""));
    output[name] = text;
  }
  return output;
}

function drawingGeometry(drawingXml) {
  if (!drawingXml) return [];
  assertXml(drawingXml, "drawingXml");
  const anchors = [];
  for (const block of elementItems(drawingXml, "oneCellAnchor")) {
    const from = elementBlock(block, "from");
    const extent = childTag(block, "ext");
    const textValue = (name) => {
      const match = new RegExp(`<${XML_NAME_PREFIX}${name}\\b[^>]*>(-?[0-9]+)<\\/${XML_NAME_PREFIX}${name}\\s*>`, "iu").exec(from);
      return match ? Number(match[1]) : null;
    };
    const extentAttrs = extent ? attributes(extent) : Object.create(null);
    anchors.push({
      kind: "oneCellAnchor",
      column: textValue("col"),
      columnOffsetEmu: textValue("colOff"),
      row: textValue("row"),
      rowOffsetEmu: textValue("rowOff"),
      widthEmu: numericAttribute(extentAttrs.cx, "drawing.ext.cx", { integer: true }),
      heightEmu: numericAttribute(extentAttrs.cy, "drawing.ext.cy", { integer: true }),
    });
  }
  return anchors;
}

export function extractWorksheetLayoutSignature({ worksheetXml, workbookXml = null, drawingXml = null }) {
  assertXml(worksheetXml, "worksheetXml");
  const columnsBlock = elementBlock(worksheetXml, "cols", { required: false });
  const columns = (columnsBlock ? elementItems(columnsBlock, "col") : []).map((item) => {
    const value = attributes(openingTag(item));
    return {
      min: numericAttribute(value.min, "column.min", { integer: true }),
      max: numericAttribute(value.max, "column.max", { integer: true }),
      width: numericAttribute(value.width, "column.width"),
      hidden: value.hidden === "1" || value.hidden === "true",
      bestFit: value.bestFit === "1" || value.bestFit === "true",
      style: numericAttribute(value.style, "column.style", { integer: true }),
    };
  });
  const rows = [];
  for (const item of elementItems(elementBlock(worksheetXml, "sheetData"), "row")) {
    const value = attributes(openingTag(item));
    rows.push({
      row: numericAttribute(value.r, "row.r", { integer: true }),
      heightPoints: numericAttribute(value.ht, "row.ht"),
      hidden: value.hidden === "1" || value.hidden === "true",
    });
  }
  const mergesBlock = elementBlock(worksheetXml, "mergeCells", { required: false });
  const merges = (mergesBlock ? elementItems(mergesBlock, "mergeCell") : []).map((item) => attributes(openingTag(item)).ref).sort();
  const sheetView = elementBlock(worksheetXml, "sheetView", { required: false });
  const viewAttributes = sheetView ? attributes(openingTag(sheetView)) : Object.create(null);
  const pane = sheetView ? childTag(sheetView, "pane") : null;
  const printOptions = elementBlock(worksheetXml, "printOptions", { required: false });
  const pageMargins = elementBlock(worksheetXml, "pageMargins", { required: false });
  const pageSetup = elementBlock(worksheetXml, "pageSetup", { required: false });
  const autoFilter = elementBlock(worksheetXml, "autoFilter", { required: false });
  return {
    columns,
    rows,
    merges,
    cellStyles: worksheetCellStyles(worksheetXml),
    view: {
      showGridLines: !(viewAttributes.showGridLines === "0" || viewAttributes.showGridLines === "false"),
      zoomScale: numericAttribute(viewAttributes.zoomScale, "sheetView.zoomScale", { integer: true }),
      pane: pane ? attributes(pane) : null,
    },
    autoFilterRef: autoFilter ? attributes(openingTag(autoFilter)).ref ?? null : null,
    print: {
      options: printOptions ? attributes(openingTag(printOptions)) : null,
      margins: pageMargins ? attributes(openingTag(pageMargins)) : null,
      setup: pageSetup ? attributes(openingTag(pageSetup)) : null,
      definedNames: workbookPrintNames(workbookXml),
    },
    drawingAnchors: drawingGeometry(drawingXml),
  };
}

function replaceRangeEndRow(range, row, field) {
  const match = /^([A-Z]{1,3}[1-9]\d*):([A-Z]{1,3})[1-9]\d*$/u.exec(range);
  if (!match || !Number.isSafeInteger(row) || row < 1) fail(`${field} cannot be resolved for a generated workbook.`);
  return `${match[1]}:${match[2]}${row}`;
}

function absoluteCellRange(range, field) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/u.exec(range);
  if (!match) fail(`${field} must be a rectangular A1 range.`);
  return `$${match[1]}$${match[2]}:$${match[3]}$${match[4]}`;
}

function quotedSheetName(name) {
  return `'${name.replaceAll("'", "''")}'`;
}

function auditOutputPolicy(mismatches, layout, entry, definition, layoutMode, layoutBinding, field) {
  const policy = entry.outputPolicy;
  if (!policy) return null;
  const setupPolicy = policy.print && layoutMode === "template" ? null : policy.print ?? policy;
  const setup = layout.print.setup ?? Object.create(null);
  const setupBinding = Object.create(null);
  for (const key of ["orientation", "paperSize", "fitToWidth", "fitToHeight"]) {
    if (!setupPolicy || setupPolicy[key] === undefined) continue;
    setupBinding[key] = setup[key] ?? null;
    if (setup[key] !== setupPolicy[key]) mismatches.push({ field: `${field}.${key}`, expected: setupPolicy[key], actual: setup[key] ?? null });
  }
  if (policy.autoFilter === undefined) return { layoutMode, setup: setupBinding };
  const dynamicSummaryRow = layoutBinding.resolvedDynamicRows[0]?.row ?? null;
  const summaryRow = layoutMode === "generated" ? dynamicSummaryRow : policy.summaryRow;
  const dataEndRow = layoutMode === "generated" && summaryRow !== null ? summaryRow - 1 : policy.dataEndRow;
  const expectedAutoFilter = layoutMode === "generated"
    ? replaceRangeEndRow(policy.autoFilter, dataEndRow, `${field}.autoFilter`)
    : policy.autoFilter;
  const expectedPrintArea = layoutMode === "generated"
    ? replaceRangeEndRow(policy.printArea, summaryRow, `${field}.printArea`)
    : policy.printArea;
  if (layout.autoFilterRef !== expectedAutoFilter) mismatches.push({ field: `${field}.autoFilter`, expected: expectedAutoFilter, actual: layout.autoFilterRef });
  const sheetName = cleanString(definition.sheetName, `${field}.sheetName`);
  const expectedFilterDatabaseName = `${quotedSheetName(sheetName)}!${absoluteCellRange(expectedAutoFilter, `${field}.autoFilter`)}`;
  const expectedPrintAreaName = `${quotedSheetName(sheetName)}!${absoluteCellRange(expectedPrintArea, `${field}.printArea`)}`;
  const expectedPrintTitlesName = `${quotedSheetName(sheetName)}!$${policy.repeatHeaderRow}:$${policy.repeatHeaderRow}`;
  const actualFilterDatabaseName = layout.print.definedNames["_xlnm._FilterDatabase"] ?? null;
  const actualPrintAreaName = layout.print.definedNames["_xlnm.Print_Area"] ?? null;
  const actualPrintTitlesName = layout.print.definedNames["_xlnm.Print_Titles"] ?? null;
  if (actualFilterDatabaseName !== expectedFilterDatabaseName) mismatches.push({ field: `${field}.definedNames.FilterDatabase`, expected: expectedFilterDatabaseName, actual: actualFilterDatabaseName });
  if (actualPrintAreaName !== expectedPrintAreaName) mismatches.push({ field: `${field}.definedNames.Print_Area`, expected: expectedPrintAreaName, actual: actualPrintAreaName });
  if (actualPrintTitlesName !== expectedPrintTitlesName) mismatches.push({ field: `${field}.definedNames.Print_Titles`, expected: expectedPrintTitlesName, actual: actualPrintTitlesName });
  return {
    layoutMode,
    summaryRow,
    dataEndRow,
    autoFilterRef: layout.autoFilterRef,
    setup: setupBinding,
    filterDatabaseName: actualFilterDatabaseName,
    printAreaName: actualPrintAreaName,
    printTitlesName: actualPrintTitlesName,
  };
}

function validateRoleCoverage(entry, definition, field) {
  const coverage = record(entry.codeRoleCoverage, `${field}.codeRoleCoverage`);
  exactKeys(coverage, new Set(["consumer", "direct", "moneyFamilies", "templateOnly"]), `${field}.codeRoleCoverage`);
  const direct = record(coverage.direct, `${field}.codeRoleCoverage.direct`);
  const money = record(coverage.moneyFamilies, `${field}.codeRoleCoverage.moneyFamilies`);
  if (!Array.isArray(coverage.templateOnly)) fail(`${field}.codeRoleCoverage.templateOnly must be an array.`);
  const moneyFamilies = new Set(definition.moneyStyleRoles ?? []);
  const coveredMoneyFamilies = new Set([
    ...Object.keys(money),
    ...coverage.templateOnly.filter((role) => moneyFamilies.has(role)),
  ]);
  if (JSON.stringify([...coveredMoneyFamilies].sort()) !== JSON.stringify([...moneyFamilies].sort())) fail(`${field} money-family coverage differs from template manifest.`);
  const manifestRoles = new Set(Object.keys(definition.styleRoles).filter((role) => !/[0-3]$/u.test(role) || !moneyFamilies.has(role.slice(0, -1))));
  const declared = [...Object.keys(direct), ...Object.keys(money), ...coverage.templateOnly];
  if (new Set(declared).size !== declared.length) fail(`${field} role coverage overlaps or duplicates a role.`);
  if (JSON.stringify([...manifestRoles].sort()) !== JSON.stringify([...declared].sort())) fail(`${field} role coverage is not exhaustive.`);
  for (const [role, tokens] of Object.entries({ ...direct, ...money })) {
    if (!ROLE_RE.test(role) || !Array.isArray(tokens) || tokens.length === 0 || tokens.some((token) => typeof token !== "string" || !token)) fail(`${field}.${role} code tokens are invalid.`);
  }
  for (const role of coverage.templateOnly) if (!ROLE_RE.test(role)) fail(`${field}.templateOnly contains invalid role ${role}.`);
  return coverage;
}

export function assertTemplateCodeRoleCoverage({ contract, templateManifest, sourceTexts }) {
  validateWorkbookStyleContract(contract);
  record(templateManifest, "templateManifest");
  record(sourceTexts, "sourceTexts");
  const results = [];
  for (const [templateId, entry] of Object.entries(contract.templates)) {
    if (!entry.codeRoleCoverage) continue;
    const definition = templateManifest.templates?.[templateId];
    if (!definition) fail(`${templateId} is absent from template-manifest.json.`);
    const coverage = validateRoleCoverage(entry, definition, `templates.${templateId}`);
    const source = sourceTexts[coverage.consumer];
    if (typeof source !== "string") fail(`${templateId} consumer ${coverage.consumer} was not supplied.`);
    for (const [role, tokens] of Object.entries({ ...coverage.direct, ...coverage.moneyFamilies })) {
      for (const token of tokens) if (!source.includes(token)) fail(`${templateId}.${role} consumer token ${JSON.stringify(token)} is absent.`);
    }
    results.push({ templateId, consumer: coverage.consumer, coveredRoleCount: Object.keys(definition.styleRoles).length });
  }
  return results;
}

function mismatch(list, field, actual, expected) {
  if (canonicalStyleDigest(actual) !== canonicalStyleDigest(expected)) list.push({ field, expected, actual });
}

function auditMoneyFamilies(mismatches, definition, signatures, entry, field) {
  for (const family of definition.moneyStyleRoles ?? []) {
    const expectedFormats = entry.moneyNumberFormats;
    const visuals = [];
    for (let digits = 0; digits <= 3; digits += 1) {
      const role = `${family}${digits}`;
      const signature = signatures[role];
      if (!signature) {
        mismatches.push({ field: `${field}.${role}`, expected: "defined semantic role", actual: null });
        continue;
      }
      if (signature.numberFormat !== expectedFormats[digits]) mismatches.push({ field: `${field}.${role}.numberFormat`, expected: expectedFormats[digits], actual: signature.numberFormat });
      const visual = structuredClone(signature);
      delete visual.numberFormat;
      visuals.push(canonicalStyleDigest(visual));
    }
    if (new Set(visuals).size > 1) mismatches.push({ field: `${field}.${family}`, expected: "one visual style across 0-3 digit formats", actual: visuals });
  }
}

function auditLayout(mismatches, layout, entry, styleRoles, field, layoutMode) {
  const expected = entry.layout;
  mismatch(mismatches, `${field}.columns`, layout.columns, expected.columns);
  if (layout.view.showGridLines !== expected.showGridLines) mismatches.push({ field: `${field}.showGridLines`, expected: expected.showGridLines, actual: layout.view.showGridLines });
  for (const ref of expected.requiredMerges) if (!layout.merges.includes(ref)) mismatches.push({ field: `${field}.merge.${ref}`, expected: true, actual: false });
  const fixedStyleCells = layoutMode === "generated" && expected.generatedFixedStyleCells
    ? expected.generatedFixedStyleCells
    : expected.fixedStyleCells;
  const boundFixedCells = Object.create(null);
  for (const [ref, role] of Object.entries(fixedStyleCells)) {
    const expectedStyle = styleRoles[role];
    boundFixedCells[ref] = layout.cellStyles[ref] ?? null;
    if (layout.cellStyles[ref] !== expectedStyle) mismatches.push({ field: `${field}.cellStyles.${ref}`, expected: { role, style: expectedStyle }, actual: layout.cellStyles[ref] ?? null });
  }
  const resolvedDynamicRows = [];
  if (layoutMode === "generated") for (const [index, rule] of (expected.dynamicStyleRows ?? []).entries()) {
    const anchorStyle = styleRoles[rule.anchorRole];
    const candidates = Object.entries(layout.cellStyles).flatMap(([ref, style]) => {
      const match = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(ref);
      return match && match[1] === rule.anchorColumn && style === anchorStyle ? [Number(match[2])] : [];
    });
    const row = candidates.length === 0 ? null : Math.max(...candidates);
    if (row === null) {
      mismatches.push({ field: `${field}.dynamicStyleRows.${index}`, expected: { anchorColumn: rule.anchorColumn, anchorRole: rule.anchorRole }, actual: null });
      continue;
    }
    const cells = Object.create(null);
    for (const [column, role] of Object.entries(rule.cells)) {
      const ref = `${column}${row}`;
      cells[ref] = layout.cellStyles[ref] ?? null;
      if (layout.cellStyles[ref] !== styleRoles[role]) mismatches.push({ field: `${field}.dynamicStyleRows.${index}.${ref}`, expected: { role, style: styleRoles[role] }, actual: layout.cellStyles[ref] ?? null });
    }
    resolvedDynamicRows.push({ index, row, cells });
  }
  const panePolicy = expected.pane;
  if (panePolicy === "none" && layout.view.pane !== null) mismatches.push({ field: `${field}.pane`, expected: null, actual: layout.view.pane });
  if (panePolicy && panePolicy !== "none") mismatch(mismatches, `${field}.pane`, layout.view.pane, panePolicy);
  return { layoutMode, boundFixedCells, resolvedDynamicRows };
}

export function validateWorkbookStyleContract(contract) {
  record(contract, "contract");
  if (contract.schemaVersion !== 2) fail("schemaVersion must be 2.");
  cleanString(contract.contractId, "contract.contractId");
  record(contract.authority, "contract.authority");
  record(contract.runtimeBudget, "contract.runtimeBudget");
  const semanticStyles = record(contract.semanticStyles, "contract.semanticStyles");
  for (const [digest, signature] of Object.entries(semanticStyles)) {
    if (!SHA256_RE.test(digest) || canonicalStyleDigest(signature) !== digest) fail(`contract.semanticStyles.${digest} is not content-addressed correctly.`);
  }
  const templates = record(contract.templates, "contract.templates");
  if (Object.keys(templates).length === 0) fail("contract.templates must not be empty.");
  for (const [templateId, entry] of Object.entries(templates)) {
    cleanString(templateId, `contract.templates.${templateId}`);
    record(entry, `contract.templates.${templateId}`);
    if (!SHA256_RE.test(entry.assetSha256 ?? "")) fail(`contract.templates.${templateId}.assetSha256 is invalid.`);
    if (!Array.isArray(entry.requiredRoles) || entry.requiredRoles.length === 0 || new Set(entry.requiredRoles).size !== entry.requiredRoles.length) fail(`contract.templates.${templateId}.requiredRoles is invalid.`);
    for (const role of entry.requiredRoles) if (!ROLE_RE.test(role)) fail(`contract.templates.${templateId}.requiredRoles contains ${role}.`);
    if (!Array.isArray(entry.moneyNumberFormats) || JSON.stringify(entry.moneyNumberFormats) !== JSON.stringify(["0", "0.0", "0.00", "0.000"])) fail(`contract.templates.${templateId}.moneyNumberFormats is invalid.`);
    const roleSignatures = record(entry.roleSignatures, `contract.templates.${templateId}.roleSignatures`);
    for (const role of entry.requiredRoles) {
      const digest = roleSignatures[role];
      if (!SHA256_RE.test(digest ?? "") || !semanticStyles[digest]) fail(`contract.templates.${templateId}.roleSignatures.${role} is invalid.`);
    }
    if (!SHA256_RE.test(entry.roleSignaturesDigest ?? "") || entry.roleSignaturesDigest !== canonicalStyleDigest(roleSignatures)) fail(`contract.templates.${templateId}.roleSignaturesDigest is invalid.`);
    record(entry.layout, `contract.templates.${templateId}.layout`);
    if (!Array.isArray(entry.layout.columns) || !Array.isArray(entry.layout.requiredMerges)) fail(`contract.templates.${templateId}.layout arrays are invalid.`);
    record(entry.layout.fixedStyleCells, `contract.templates.${templateId}.layout.fixedStyleCells`);
    if (entry.layout.generatedFixedStyleCells !== undefined) record(entry.layout.generatedFixedStyleCells, `contract.templates.${templateId}.layout.generatedFixedStyleCells`);
    if (entry.layout.dynamicStyleRows !== undefined) {
      if (!Array.isArray(entry.layout.dynamicStyleRows)) fail(`contract.templates.${templateId}.layout.dynamicStyleRows must be an array.`);
      for (const [index, rule] of entry.layout.dynamicStyleRows.entries()) {
        record(rule, `contract.templates.${templateId}.layout.dynamicStyleRows.${index}`);
        if (!/^[A-Z]{1,3}$/u.test(rule.anchorColumn ?? "") || !ROLE_RE.test(rule.anchorRole ?? "")) fail(`contract.templates.${templateId}.layout.dynamicStyleRows.${index} anchor is invalid.`);
        record(rule.cells, `contract.templates.${templateId}.layout.dynamicStyleRows.${index}.cells`);
      }
    }
    if (typeof entry.layout.showGridLines !== "boolean") fail(`contract.templates.${templateId}.layout.showGridLines must be boolean.`);
    if (entry.outputPolicy !== undefined) {
      const policy = record(entry.outputPolicy, `contract.templates.${templateId}.outputPolicy`);
      if (policy.print !== undefined) {
        const print = record(policy.print, `contract.templates.${templateId}.outputPolicy.print`);
        for (const key of ["orientation", "paperSize", "fitToWidth", "fitToHeight"]) cleanString(print[key], `contract.templates.${templateId}.outputPolicy.print.${key}`);
      }
      if (policy.autoFilter !== undefined) {
        for (const key of ["headerRow", "dataStartRow", "dataEndRow", "summaryRow", "repeatHeaderRow"]) {
          if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) fail(`contract.templates.${templateId}.outputPolicy.${key} is invalid.`);
        }
        if (policy.dataStartRow !== policy.headerRow + 1 || policy.summaryRow !== policy.dataEndRow + 1) fail(`contract.templates.${templateId}.outputPolicy row boundaries are invalid.`);
        for (const key of ["autoFilter", "printArea", "orientation", "paperSize", "fitToWidth", "fitToHeight"]) cleanString(policy[key], `contract.templates.${templateId}.outputPolicy.${key}`);
      }
    }
  }
  return contract;
}

export function auditOpenedWorkbookStyleContract({ contract, templateId, templateDefinition, styleRoles, parts, layoutMode = "template", throwOnMismatch = true }) {
  const started = process.hrtime.bigint();
  validateWorkbookStyleContract(contract);
  const entry = contract.templates[templateId];
  if (!entry) fail(`template ${templateId} is not declared.`);
  record(templateDefinition, "templateDefinition");
  record(styleRoles, "styleRoles");
  record(parts, "parts");
  if (layoutMode !== "template" && layoutMode !== "generated") fail("layoutMode must be template or generated.");
  const allowedPartKeys = new Set(["stylesXml", "themeXml", "worksheetXml", "workbookXml", "drawingXml"]);
  for (const key of Object.keys(parts)) if (!allowedPartKeys.has(key)) fail(`parts contains unsupported field ${key}; pass only already-opened OOXML text.`);
  const mismatches = [];
  const signatures = extractRoleSignatures({ stylesXml: parts.stylesXml, themeXml: parts.themeXml ?? null, styleRoles });
  for (const role of entry.requiredRoles) {
    if (!signatures[role]) mismatches.push({ field: `roles.${role}`, expected: "defined", actual: null });
    else mismatch(mismatches, `roles.${role}`, signatures[role], contract.semanticStyles[entry.roleSignatures[role]]);
  }
  auditMoneyFamilies(mismatches, templateDefinition, signatures, entry, `templates.${templateId}.moneyFamilies`);
  const layout = extractWorksheetLayoutSignature({ worksheetXml: parts.worksheetXml, workbookXml: parts.workbookXml ?? null, drawingXml: parts.drawingXml ?? null });
  const layoutBinding = auditLayout(mismatches, layout, entry, styleRoles, `templates.${templateId}.layout`, layoutMode);
  const outputPolicyBinding = auditOutputPolicy(mismatches, layout, entry, templateDefinition, layoutMode, layoutBinding, `templates.${templateId}.outputPolicy`);
  const styleRolesDigest = canonicalStyleDigest(Object.fromEntries(entry.requiredRoles.map((role) => [role, signatures[role]])));
  const layoutDigest = canonicalStyleDigest({ columns: layout.columns, view: layout.view, autoFilterRef: layout.autoFilterRef, print: layout.print, requiredMerges: entry.layout.requiredMerges.map((ref) => [ref, layout.merges.includes(ref)]), layoutBinding, outputPolicyBinding });
  const binding = Object.freeze({
    kind: "workbook-style-contract-binding-v1",
    contractId: contract.contractId,
    templateId,
    assetSha256: entry.assetSha256,
    styleRolesDigest,
    layoutDigest,
    bindingDigest: canonicalStyleDigest({ contractId: contract.contractId, templateId, assetSha256: entry.assetSha256, styleRolesDigest, layoutDigest }),
  });
  const elapsedNanoseconds = process.hrtime.bigint() - started;
  const metrics = Object.freeze({
    styleContractChecks: 1,
    stylePartsInflated: 0,
    styleBytesInflated: 0,
    styleMismatchCount: mismatches.length,
    styleCheckMs: Number(elapsedNanoseconds) / 1_000_000,
    addedFileReads: 0,
    addedImageDecodes: 0,
    addedComCalls: 0,
    addedZipOpens: 0,
  });
  if (throwOnMismatch && mismatches.length > 0) {
    const error = new Error(`Workbook Style Contract ${templateId} has ${mismatches.length} mismatch(es).`);
    error.code = "WORKBOOK_STYLE_CONTRACT_MISMATCH";
    error.mismatches = mismatches;
    error.metrics = metrics;
    throw error;
  }
  return Object.freeze({ ok: mismatches.length === 0, mismatches, binding, metrics });
}
