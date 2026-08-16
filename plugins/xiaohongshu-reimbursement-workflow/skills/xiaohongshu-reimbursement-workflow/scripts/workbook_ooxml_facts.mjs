import path from "node:path";

import {
  canonicalDigest,
  loadBundledDependency,
} from "./workflow_primitives.mjs";
import {
  assertStableFileSnapshotCurrent,
  openWorkbookSnapshot,
  readSnapshotStructuralParts,
} from "./workbook_snapshot.mjs";

const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_DOCUMENT_REL_NS = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const STRICT_MAIN_NS = "http://purl.oclc.org/ooxml/spreadsheetml/main";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const MAX_EXCEL_COLUMN = 16_384;
const MAX_EXCEL_ROW = 1_048_576;
const FORBIDDEN_PART_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAIN_NAMESPACES = new Set([MAIN_NS, STRICT_MAIN_NS]);

const RELATIONSHIP_TYPES = Object.freeze(Object.fromEntries(
  ["officeDocument", "worksheet", "styles", "sharedStrings"].map((kind) => [
    kind,
    new Set([`${DOCUMENT_REL_NS}/${kind}`, `${STRICT_DOCUMENT_REL_NS}/${kind}`]),
  ]),
));

const CONTENT_TYPES = Object.freeze({
  workbook: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  ]),
  worksheet: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
  ]),
  styles: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
  ]),
  sharedStrings: new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  ]),
});

const FACT_BUDGET_FIELDS = Object.freeze([
  "xmlElementsPerPart",
  "xmlDepth",
  "xmlAttributesPerElement",
  "xmlAttributeValueChars",
  "xmlTextCharsPerNode",
  "totalXmlTextChars",
  "sheetCount",
  "relationshipCount",
  "definedNameCount",
  "customNumberFormatCount",
  "cellFormatCount",
  "sharedStringCount",
  "sharedStringItemChars",
  "sharedStringTotalChars",
  "rowsPerSheet",
  "totalRows",
  "cellsPerSheet",
  "totalCells",
  "mergesPerSheet",
  "totalMerges",
  "columnRangesPerSheet",
  "totalColumnRanges",
]);

export const DEFAULT_OOXML_FACT_BUDGETS = Object.freeze({
  xmlElementsPerPart: 1_000_000,
  xmlDepth: 64,
  xmlAttributesPerElement: 64,
  xmlAttributeValueChars: 8_192,
  xmlTextCharsPerNode: 1_048_576,
  totalXmlTextChars: 16_777_216,
  sheetCount: 64,
  relationshipCount: 4_096,
  definedNameCount: 4_096,
  customNumberFormatCount: 2_048,
  cellFormatCount: 8_192,
  sharedStringCount: 100_000,
  sharedStringItemChars: 1_048_576,
  sharedStringTotalChars: 8_388_608,
  rowsPerSheet: 50_000,
  totalRows: 100_000,
  cellsPerSheet: 300_000,
  totalCells: 500_000,
  mergesPerSheet: 50_000,
  totalMerges: 100_000,
  columnRangesPerSheet: 16_384,
  totalColumnRanges: 32_768,
});

const BUILTIN_NUMBER_FORMATS = new Map([
  [0, "General"],
  [1, "0"],
  [2, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [14, "mm-dd-yy"],
  [22, "m/d/yy h:mm"],
  [49, "@"],
]);

const WORKBOOK_OPAQUE_TOP_LEVEL = new Set([
  "fileVersion",
  "fileSharing",
  "workbookProtection",
  "bookViews",
  "functionGroups",
  "externalReferences",
  "calcPr",
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
]);

const STYLE_OPAQUE_TOP_LEVEL = new Set([
  "fonts",
  "fills",
  "borders",
  "cellStyleXfs",
  "cellStyles",
  "dxfs",
  "tableStyles",
  "colors",
]);

const WORKSHEET_OPAQUE_TOP_LEVEL = new Set([
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
]);
const RICH_TEXT_PROPERTY_ELEMENTS = new Set([
  "b",
  "charset",
  "color",
  "condense",
  "extend",
  "family",
  "i",
  "outline",
  "rFont",
  "scheme",
  "shadow",
  "strike",
  "sz",
  "u",
  "vertAlign",
]);

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unknown field ${key}.`);
  }
}

function normalizeFactBudgets(value = {}) {
  requireObject(value, "OOXML fact budgets");
  rejectUnknownFields(value, new Set(FACT_BUDGET_FIELDS), "OOXML fact budgets");
  return Object.freeze(Object.fromEntries(FACT_BUDGET_FIELDS.map((field) => {
    const selected = value[field] ?? DEFAULT_OOXML_FACT_BUDGETS[field];
    if (!Number.isSafeInteger(selected) || selected < 1) {
      throw new Error(`OOXML fact budget ${field} must be a positive safe integer.`);
    }
    return [field, selected];
  })));
}

function normalizeOptions(options) {
  if (options === undefined) return { factBudgets: normalizeFactBudgets(), workbookBudgets: undefined };
  const value = requireObject(options, "OOXML fact options");
  rejectUnknownFields(value, new Set(["factBudgets", "workbookBudgets"]), "OOXML fact options");
  return {
    factBudgets: normalizeFactBudgets(value.factBudgets),
    workbookBudgets: value.workbookBudgets,
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function controlledPath(stack, frame) {
  return [...stack.map((item) => item.local), frame.local].join("/");
}

function budgetError(field, limit) {
  return new Error(`OOXML facts exceed ${field} budget ${limit}.`);
}

function incrementBudget(metrics, budgets, field, amount = 1) {
  metrics[field] = (metrics[field] ?? 0) + amount;
  if (metrics[field] > budgets[field]) throw budgetError(field, budgets[field]);
  return metrics[field];
}

function isMainNamespace(uri) {
  return MAIN_NAMESPACES.has(uri);
}

function semanticAttributes(tag) {
  return Object.values(tag.attributes).filter((attribute) => attribute.uri !== XMLNS_NS);
}

function attributesByIdentity(tag, local, uri = "") {
  return semanticAttributes(tag).filter((attribute) => attribute.local === local && attribute.uri === uri);
}

function attribute(tag, local, { required = false, uri = "" } = {}) {
  const matches = attributesByIdentity(tag, local, uri);
  if (matches.length > 1) throw new Error(`Element ${tag.name} has duplicate ${local} attributes.`);
  if (required && matches.length === 0) throw new Error(`Element ${tag.name} is missing ${local}.`);
  return matches[0]?.value ?? null;
}

function assertControlledAttributes(tag, unqualified, field, namespaced = []) {
  const allowedNamespaced = new Set(namespaced.map(([uri, local]) => `${uri}\u0000${local}`));
  for (const item of semanticAttributes(tag)) {
    if (item.uri === "") {
      if (!unqualified.has(item.local)) throw new Error(`${field} contains unknown controlled attribute ${item.name}.`);
    } else if (item.uri === XML_NS && item.local === "space") {
      if (!unqualified.has("xml:space")) throw new Error(`${field} contains unsupported xml:space.`);
    } else if (!allowedNamespaced.has(`${item.uri}\u0000${item.local}`)) {
      // Extension attributes remain byte-bound by the structural part digest.
    }
  }
}

function canonicalXmlElement(tag, field) {
  const identities = new Set();
  const attributes = semanticAttributes(tag).map((item) => {
    const identity = `${item.uri}\u0000${item.local}`;
    if (identities.has(identity)) throw new Error(`${field} contains duplicate expanded attribute ${item.name}.`);
    identities.add(identity);
    return { uri: item.uri, local: item.local, value: item.value };
  });
  attributes.sort((left, right) => (
    left.uri.localeCompare(right.uri, "en")
    || left.local.localeCompare(right.local, "en")
  ));
  return { uri: tag.uri, local: tag.local, attributes };
}

function activeRichPropertyRoot(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].richPropertyEvents) return stack[index];
  }
  return null;
}

function beginRichTextRun(frame) {
  frame.richPropertiesSeen = false;
  frame.richPropertiesDigest = null;
  frame.richTextSeen = false;
}

function beginRichTextProperties(frame, parent, field) {
  if (parent.richPropertiesSeen || parent.richTextSeen) {
    throw new Error(`${field} has duplicate or out-of-order rich text properties.`);
  }
  assertControlledAttributes(frame.tag, new Set(), `${field} rPr`);
  parent.richPropertiesSeen = true;
  frame.richPropertyEvents = [{ event: "open", element: canonicalXmlElement(frame.tag, `${field} rPr`) }];
}

function captureRichPropertyOpen(frame, parent, stack, field) {
  const root = activeRichPropertyRoot(stack);
  if (!root) return false;
  if (parent === root && isMainNamespace(frame.uri)) {
    if (!RICH_TEXT_PROPERTY_ELEMENTS.has(frame.local)) {
      throw new Error(`${field} contains unsupported rich text property ${frame.local}.`);
    }
    const allowed = frame.local === "color"
      ? new Set(["auto", "indexed", "rgb", "theme", "tint"])
      : new Set(["val"]);
    assertControlledAttributes(frame.tag, allowed, `${field} ${frame.local}`);
  } else if (isMainNamespace(parent.uri) && RICH_TEXT_PROPERTY_ELEMENTS.has(parent.local)) {
    throw new Error(`${field} rich text property ${parent.local} must not contain child elements.`);
  }
  root.richPropertyEvents.push({ event: "open", element: canonicalXmlElement(frame.tag, field) });
  return true;
}

function captureRichPropertyText(text, frame, stack, field) {
  const root = activeRichPropertyRoot(stack);
  if (!root) return false;
  if (frame === root || (isMainNamespace(frame.uri) && RICH_TEXT_PROPERTY_ELEMENTS.has(frame.local))) {
    requireWhitespace(text, `${field} rich text properties`);
  } else {
    root.richPropertyEvents.push({ event: "text", text });
  }
  return true;
}

function captureRichPropertyClose(frame, parent, stack) {
  if (frame.richPropertyEvents) {
    frame.richPropertyEvents.push({ event: "close", uri: frame.uri, local: frame.local });
    parent.richPropertiesDigest = canonicalDigest(frame.richPropertyEvents);
    return true;
  }
  const root = activeRichPropertyRoot(stack);
  if (!root) return false;
  root.richPropertyEvents.push({ event: "close", uri: frame.uri, local: frame.local });
  return true;
}

function parseBoolean(value, field, defaultValue = null) {
  if (value === null) return defaultValue;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${field} must be 0, 1, false, or true.`);
}

function parseSafeInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${field} must be a canonical non-negative integer string.`);
  }
  const integer = BigInt(value);
  if (integer < BigInt(min) || integer > BigInt(max)) {
    throw new Error(`${field} is outside its allowed integer range.`);
  }
  return Number(integer);
}

function validateDecimalString(value, field, { nonNegative = false } = {}) {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[Ee][+-]?\d+)?$/u.test(value)
    || (nonNegative && value.startsWith("-"))
  ) {
    throw new Error(`${field} must be a valid${nonNegative ? " non-negative" : ""} decimal string.`);
  }
  return value;
}

function columnIndexFromName(name, field) {
  if (!/^[A-Z]{1,3}$/u.test(name)) throw new Error(`${field} has an invalid Excel column.`);
  let value = 0;
  for (const character of name) value = value * 26 + character.charCodeAt(0) - 64;
  if (value < 1 || value > MAX_EXCEL_COLUMN) throw new Error(`${field} exceeds the Excel column limit.`);
  return value;
}

function parseCellReference(value, field) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(value ?? "");
  if (!match) throw new Error(`${field} must be an uppercase A1 cell reference.`);
  return {
    ref: value,
    row: parseSafeInteger(match[2], `${field} row`, { min: 1, max: MAX_EXCEL_ROW }),
    column: columnIndexFromName(match[1], field),
  };
}

function parseCellRange(value, field) {
  const parts = String(value ?? "").split(":");
  if (parts.length < 1 || parts.length > 2) throw new Error(`${field} must be one A1 cell or one A1 range.`);
  const start = parseCellReference(parts[0], `${field} start`);
  const end = parseCellReference(parts[1] ?? parts[0], `${field} end`);
  if (end.row < start.row || end.column < start.column) throw new Error(`${field} has descending range endpoints.`);
  return {
    ref: value,
    startRow: start.row,
    startColumn: start.column,
    endRow: end.row,
    endColumn: end.column,
  };
}

function relationshipPartFor(sourcePartName) {
  if (sourcePartName === null) return "_rels/.rels";
  return path.posix.join(
    path.posix.dirname(sourcePartName),
    "_rels",
    `${path.posix.basename(sourcePartName)}.rels`,
  );
}

function relationshipSourceFor(partName) {
  if (partName === "_rels/.rels") return null;
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/u.exec(partName);
  if (!match) throw new Error(`Relationship part path is not canonical: ${partName}`);
  return `${match[1] ?? ""}${match[2]}`;
}

function resolveRelationshipTarget(sourcePartName, target, field) {
  if (
    typeof target !== "string"
    || !target
    || target.includes("\\")
    || target.includes("?")
    || target.includes("#")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
    || target.startsWith("//")
    || /%(?:25|2e|2f|3f|23|5c)/iu.test(target)
  ) {
    throw new Error(`${field} is an unsafe package relationship target.`);
  }
  let decoded;
  try {
    decoded = decodeURI(target);
  } catch {
    throw new Error(`${field} has invalid percent encoding.`);
  }
  if (decoded.includes("%") || decoded.includes("?") || decoded.includes("#") || decoded.includes("\\")) {
    throw new Error(`${field} contains an unsafe encoded target character.`);
  }
  const joined = decoded.startsWith("/")
    ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(sourcePartName ?? ""), decoded);
  const normalized = path.posix.normalize(joined);
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized !== normalized.normalize("NFC")
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || FORBIDDEN_PART_SEGMENTS.has(segment.toLowerCase()))
  ) {
    throw new Error(`${field} escapes or ambiguously identifies the XLSX package.`);
  }
  return normalized;
}

function relationshipHasType(relationship, kind) {
  return RELATIONSHIP_TYPES[kind].has(relationship.type);
}

function extensionOrError(frame, parent, field) {
  if (parent && parent.local === "extLst" && isMainNamespace(parent.uri)) return true;
  throw new Error(`${field} contains unsupported extension element ${frame.tag.name}.`);
}

function parseXml(bytes, partName, budgets, metrics, handlers) {
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${partName} is not valid UTF-8 XML.`, { cause: error });
  }
  if (!xml) throw new Error(`${partName} is empty.`);
  const loaded = loadBundledDependency("sax");
  const sax = loaded.default ?? loaded;
  const parser = sax.parser(true, {
    position: false,
    strictEntities: true,
    trim: false,
    normalize: false,
    xmlns: true,
  });
  const stack = [];
  let elementCount = 0;
  let parseError = null;
  let pendingAttributeNames = new Set();
  let xmlDeclarationSeen = false;

  parser.onerror = (error) => {
    parseError ??= error;
  };
  parser.ondoctype = () => {
    throw new Error(`${partName} contains a forbidden DOCTYPE declaration.`);
  };
  parser.onsgmldeclaration = () => {
    throw new Error(`${partName} contains a forbidden SGML declaration.`);
  };
  parser.onprocessinginstruction = ({ name }) => {
    if (name.toLowerCase() === "xml" && !xmlDeclarationSeen && elementCount === 0 && stack.length === 0) {
      xmlDeclarationSeen = true;
      return;
    }
    throw new Error(`${partName} contains unsupported processing instruction ${name}.`);
  };
  parser.onopentagstart = () => {
    pendingAttributeNames = new Set();
  };
  parser.onattribute = ({ name }) => {
    if (pendingAttributeNames.has(name)) {
      throw new Error(`${partName} contains duplicate XML attribute ${name}.`);
    }
    pendingAttributeNames.add(name);
  };
  parser.onopentag = (tag) => {
    elementCount += 1;
    if (elementCount > budgets.xmlElementsPerPart) throw budgetError("xmlElementsPerPart", budgets.xmlElementsPerPart);
    if (stack.length + 1 > budgets.xmlDepth) throw budgetError("xmlDepth", budgets.xmlDepth);
    const attrs = semanticAttributes(tag);
    if (attrs.length > budgets.xmlAttributesPerElement) {
      throw budgetError("xmlAttributesPerElement", budgets.xmlAttributesPerElement);
    }
    for (const item of attrs) {
      if (Array.from(item.value).length > budgets.xmlAttributeValueChars) {
        throw budgetError("xmlAttributeValueChars", budgets.xmlAttributeValueChars);
      }
    }
    const parent = stack.at(-1) ?? null;
    const frame = {
      tag,
      local: tag.local,
      uri: tag.uri,
      opaque: parent?.opaque ?? false,
      textChars: 0,
    };
    if (!frame.opaque && handlers.open?.(frame, parent, stack) === true) frame.opaque = true;
    stack.push(frame);
  };
  const consumeText = (text) => {
    const frame = stack.at(-1);
    if (!frame) {
      if (text.trim()) throw new Error(`${partName} contains text outside its document element.`);
      return;
    }
    frame.textChars += text.length;
    if (frame.textChars > budgets.xmlTextCharsPerNode) {
      throw budgetError("xmlTextCharsPerNode", budgets.xmlTextCharsPerNode);
    }
    incrementBudget(metrics, budgets, "totalXmlTextChars", text.length);
    if (!frame.opaque) handlers.text?.(text, frame, stack);
  };
  parser.ontext = consumeText;
  parser.oncdata = consumeText;
  parser.onclosetag = () => {
    const frame = stack.pop();
    if (!frame) throw new Error(`${partName} has an unmatched closing element.`);
    if (!frame.opaque) handlers.close?.(frame, stack.at(-1) ?? null, stack);
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    parseError ??= error;
  }
  if (parseError) {
    throw new Error(`${partName} is malformed or unsupported XML: ${parseError.message}`, { cause: parseError });
  }
  if (stack.length !== 0) throw new Error(`${partName} is not a balanced XML document.`);
  handlers.finish?.();
}

function requireWhitespace(text, field) {
  if (text.trim()) throw new Error(`${field} contains unexpected text.`);
}

function contentTypeFor(partName, contentTypes) {
  const override = contentTypes.overrides.get(partName);
  if (override) return override;
  const extension = path.posix.extname(partName).slice(1).toLowerCase();
  return contentTypes.defaults.get(extension) ?? null;
}

function parseContentTypes(part, budgets, metrics) {
  const defaults = new Map();
  const overrides = new Map();
  let rootSeen = false;
  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent) {
      if (frame.uri !== CONTENT_TYPES_NS) return extensionOrError(frame, parent, part.name);
      if (!parent) {
        if (frame.local !== "Types" || rootSeen) throw new Error(`${part.name} must have one Types root.`);
        rootSeen = true;
        assertControlledAttributes(frame.tag, new Set(), `${part.name} Types`);
        return false;
      }
      if (parent.local !== "Types" || !["Default", "Override"].includes(frame.local)) {
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      if (frame.local === "Default") {
        assertControlledAttributes(frame.tag, new Set(["Extension", "ContentType"]), `${part.name} Default`);
        const extension = attribute(frame.tag, "Extension", { required: true }).toLowerCase();
        const contentType = attribute(frame.tag, "ContentType", { required: true });
        if (!/^[a-z0-9]+$/u.test(extension) || defaults.has(extension)) {
          throw new Error(`${part.name} has duplicate or invalid Default extension ${extension}.`);
        }
        defaults.set(extension, contentType);
      } else {
        assertControlledAttributes(frame.tag, new Set(["PartName", "ContentType"]), `${part.name} Override`);
        const rawName = attribute(frame.tag, "PartName", { required: true });
        const contentType = attribute(frame.tag, "ContentType", { required: true });
        if (!rawName.startsWith("/") || rawName.includes("\\") || rawName.includes("?") || rawName.includes("#")) {
          throw new Error(`${part.name} has an unsafe Override PartName.`);
        }
        const name = rawName.slice(1);
        if (!name || path.posix.normalize(name) !== name || overrides.has(name)) {
          throw new Error(`${part.name} has duplicate or non-canonical Override PartName ${rawName}.`);
        }
        overrides.set(name, contentType);
      }
      return false;
    },
    text(text, frame) {
      if (frame.local === "Types" || frame.local === "Default" || frame.local === "Override") {
        requireWhitespace(text, `${part.name} ${frame.local}`);
      }
    },
    finish() {
      if (!rootSeen) throw new Error(`${part.name} is missing its Types root.`);
    },
  });
  return { defaults, overrides };
}

function parseRelationships(part, sourcePartName, packagePartNames, budgets, metrics) {
  const items = [];
  const ids = new Set();
  let rootSeen = false;
  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent) {
      if (frame.uri !== PACKAGE_REL_NS) return extensionOrError(frame, parent, part.name);
      if (!parent) {
        if (frame.local !== "Relationships" || rootSeen) {
          throw new Error(`${part.name} must have one Relationships root.`);
        }
        rootSeen = true;
        assertControlledAttributes(frame.tag, new Set(), `${part.name} Relationships`);
        return false;
      }
      if (parent.local !== "Relationships" || frame.local !== "Relationship") {
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      assertControlledAttributes(
        frame.tag,
        new Set(["Id", "Type", "Target", "TargetMode"]),
        `${part.name} Relationship`,
      );
      const id = attribute(frame.tag, "Id", { required: true });
      const type = attribute(frame.tag, "Type", { required: true });
      const target = attribute(frame.tag, "Target", { required: true });
      const rawTargetMode = attribute(frame.tag, "TargetMode");
      if (!id || ids.has(id)) throw new Error(`${part.name} has duplicate relationship Id ${id}.`);
      ids.add(id);
      if (!type) throw new Error(`${part.name} relationship ${id} has an empty Type.`);
      let targetMode;
      let resolvedPartName;
      if (rawTargetMode === null || rawTargetMode === "Internal") {
        targetMode = "Internal";
        resolvedPartName = resolveRelationshipTarget(sourcePartName, target, `${part.name} relationship ${id} target`);
        if (!packagePartNames.has(resolvedPartName)) {
          throw new Error(`${part.name} relationship ${id} target part is missing: ${resolvedPartName}`);
        }
      } else if (rawTargetMode === "External") {
        targetMode = "External";
        resolvedPartName = null;
      } else {
        throw new Error(`${part.name} relationship ${id} has invalid TargetMode ${rawTargetMode}.`);
      }
      incrementBudget(metrics, budgets, "relationshipCount");
      items.push({
        sourcePartName,
        relationshipPartName: part.name,
        id,
        type,
        target,
        targetMode,
        resolvedPartName,
      });
      return false;
    },
    text(text, frame) {
      requireWhitespace(text, `${part.name} ${frame.local}`);
    },
    finish() {
      if (!rootSeen) throw new Error(`${part.name} is missing its Relationships root.`);
    },
  });
  return items;
}

function parseWorkbook(part, budgets, metrics) {
  const sheets = [];
  const definedNames = [];
  const opaqueControlledPaths = new Set();
  const sheetIds = new Set();
  const sheetNames = new Set();
  const relationshipIds = new Set();
  let rootSeen = false;
  let workbookPrCount = 0;
  let sheetsCount = 0;
  let definedNamesCount = 0;
  let date1904 = false;

  const markOpaque = (frame, stack) => {
    opaqueControlledPaths.add(controlledPath(stack, frame));
    return true;
  };
  const markOpaqueAttribute = (frame, stack, item) => {
    opaqueControlledPaths.add(`${controlledPath(stack, frame)}@{${item.uri}}${item.local}`);
  };

  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent, stack) {
      if (!isMainNamespace(frame.uri)) return extensionOrError(frame, parent, part.name);
      for (const item of semanticAttributes(frame.tag)) {
        if (item.uri === "" || (item.uri === XML_NS && item.local === "space")) continue;
        const sheetRelationshipId = frame.local === "sheet"
          && item.local === "id"
          && (item.uri === DOCUMENT_REL_NS || item.uri === STRICT_DOCUMENT_REL_NS);
        if (!sheetRelationshipId) markOpaqueAttribute(frame, stack, item);
      }
      if (!parent) {
        if (frame.local !== "workbook" || rootSeen) throw new Error(`${part.name} must have one workbook root.`);
        assertControlledAttributes(frame.tag, new Set(), `${part.name} workbook`);
        rootSeen = true;
        return false;
      }
      if (parent.local === "workbook") {
        if (frame.local === "workbookPr") {
          workbookPrCount += 1;
          if (workbookPrCount !== 1) throw new Error(`${part.name} contains duplicate workbookPr elements.`);
          for (const item of semanticAttributes(frame.tag)) {
            if (item.uri === "" && item.local !== "date1904") {
              opaqueControlledPaths.add(`${controlledPath(stack, frame)}@${item.local}`);
            }
          }
          date1904 = parseBoolean(attribute(frame.tag, "date1904"), `${part.name} date1904`, false);
          return false;
        }
        if (frame.local === "sheets") {
          sheetsCount += 1;
          if (sheetsCount !== 1) throw new Error(`${part.name} contains duplicate sheets containers.`);
          assertControlledAttributes(frame.tag, new Set(), `${part.name} sheets`);
          return false;
        }
        if (frame.local === "definedNames") {
          definedNamesCount += 1;
          if (definedNamesCount !== 1) throw new Error(`${part.name} contains duplicate definedNames containers.`);
          assertControlledAttributes(frame.tag, new Set(), `${part.name} definedNames`);
          return false;
        }
        if (frame.local === "extLst" || WORKBOOK_OPAQUE_TOP_LEVEL.has(frame.local)) {
          return markOpaque(frame, stack);
        }
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "sheets") {
        if (frame.local !== "sheet") throw new Error(`${part.name} sheets contains unknown controlled child ${frame.local}.`);
        assertControlledAttributes(
          frame.tag,
          new Set(["name", "sheetId", "state"]),
          `${part.name} sheet`,
          [[DOCUMENT_REL_NS, "id"], [STRICT_DOCUMENT_REL_NS, "id"]],
        );
        const name = attribute(frame.tag, "name", { required: true });
        const sheetId = parseSafeInteger(attribute(frame.tag, "sheetId", { required: true }), `${part.name} sheetId`, {
          min: 1,
        });
        const relationshipIdMatches = [
          ...attributesByIdentity(frame.tag, "id", DOCUMENT_REL_NS),
          ...attributesByIdentity(frame.tag, "id", STRICT_DOCUMENT_REL_NS),
        ];
        if (relationshipIdMatches.length !== 1) throw new Error(`${part.name} sheet must have exactly one relationship id.`);
        const relationshipId = relationshipIdMatches[0].value;
        const state = attribute(frame.tag, "state") ?? "visible";
        if (!name || Array.from(name).length > 31) throw new Error(`${part.name} sheet name is empty or exceeds 31 characters.`);
        if (!new Set(["visible", "hidden", "veryHidden"]).has(state)) {
          throw new Error(`${part.name} sheet ${name} has invalid state ${state}.`);
        }
        const foldedName = name.toLowerCase();
        if (sheetIds.has(sheetId) || sheetNames.has(foldedName) || relationshipIds.has(relationshipId)) {
          throw new Error(`${part.name} contains duplicate sheet identity.`);
        }
        sheetIds.add(sheetId);
        sheetNames.add(foldedName);
        relationshipIds.add(relationshipId);
        incrementBudget(metrics, budgets, "sheetCount");
        sheets.push({
          order: sheets.length,
          name,
          sheetId,
          state,
          relationshipId,
        });
        return false;
      }
      if (parent.local === "definedNames") {
        if (frame.local !== "definedName") {
          throw new Error(`${part.name} definedNames contains unknown controlled child ${frame.local}.`);
        }
        assertControlledAttributes(
          frame.tag,
          new Set(["name", "localSheetId", "hidden", "function", "vbProcedure", "xlm", "functionGroupId", "shortcutKey", "publishToServer", "workbookParameter", "comment", "customMenu", "description", "help", "statusBar"]),
          `${part.name} definedName`,
        );
        for (const item of semanticAttributes(frame.tag)) {
          if (
            item.uri === ""
            && !new Set(["name", "localSheetId", "hidden"]).has(item.local)
          ) {
            opaqueControlledPaths.add(`${controlledPath(stack, frame)}@${item.local}`);
          }
        }
        const localSheetIdRaw = attribute(frame.tag, "localSheetId");
        frame.definedName = {
          name: attribute(frame.tag, "name", { required: true }),
          localSheetId: localSheetIdRaw === null
            ? null
            : parseSafeInteger(localSheetIdRaw, `${part.name} localSheetId`),
          hidden: parseBoolean(attribute(frame.tag, "hidden"), `${part.name} definedName hidden`, false),
          text: "",
        };
        incrementBudget(metrics, budgets, "definedNameCount");
        return false;
      }
      if (frame.local === "sheet" || frame.local === "workbookPr") {
        throw new Error(`${part.name} ${frame.local} must not contain child elements.`);
      }
      throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
    },
    text(text, frame) {
      if (frame.definedName) frame.definedName.text += text;
      else requireWhitespace(text, `${part.name} ${frame.local}`);
    },
    close(frame) {
      if (frame.definedName) definedNames.push(frame.definedName);
    },
    finish() {
      if (!rootSeen || sheetsCount !== 1 || sheets.length === 0) {
        throw new Error(`${part.name} is missing its workbook sheets contract.`);
      }
      for (const item of definedNames) {
        if (!item.name || (item.localSheetId !== null && item.localSheetId >= sheets.length)) {
          throw new Error(`${part.name} contains an invalid definedName identity.`);
        }
      }
    },
  });
  return {
    date1904,
    definedNames,
    opaqueControlledPaths: [...opaqueControlledPaths].sort((left, right) => left.localeCompare(right, "en")),
    sheets,
  };
}

function parseStyles(part, budgets, metrics) {
  const customNumberFormats = [];
  const cellFormats = [];
  const customIds = new Set();
  let rootSeen = false;
  let numFmtsSeen = 0;
  let cellXfsSeen = 0;
  let expectedNumFmts = null;
  let expectedCellXfs = null;

  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent) {
      if (!isMainNamespace(frame.uri)) return extensionOrError(frame, parent, part.name);
      if (!parent) {
        if (frame.local !== "styleSheet" || rootSeen) throw new Error(`${part.name} must have one styleSheet root.`);
        rootSeen = true;
        return false;
      }
      if (parent.local === "styleSheet") {
        if (frame.local === "numFmts") {
          numFmtsSeen += 1;
          if (numFmtsSeen !== 1) throw new Error(`${part.name} contains duplicate numFmts.`);
          const count = attribute(frame.tag, "count");
          expectedNumFmts = count === null ? null : parseSafeInteger(count, `${part.name} numFmts count`);
          return false;
        }
        if (frame.local === "cellXfs") {
          cellXfsSeen += 1;
          if (cellXfsSeen !== 1) throw new Error(`${part.name} contains duplicate cellXfs.`);
          const count = attribute(frame.tag, "count");
          expectedCellXfs = count === null ? null : parseSafeInteger(count, `${part.name} cellXfs count`, { min: 1 });
          return false;
        }
        if (frame.local === "extLst") return false;
        if (STYLE_OPAQUE_TOP_LEVEL.has(frame.local)) return true;
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "numFmts") {
        if (frame.local !== "numFmt") throw new Error(`${part.name} numFmts contains unknown child ${frame.local}.`);
        assertControlledAttributes(frame.tag, new Set(["numFmtId", "formatCode"]), `${part.name} numFmt`);
        const numFmtId = parseSafeInteger(attribute(frame.tag, "numFmtId", { required: true }), `${part.name} numFmtId`, {
          max: 65_535,
        });
        const formatCode = attribute(frame.tag, "formatCode", { required: true });
        if (customIds.has(numFmtId)) throw new Error(`${part.name} has duplicate numFmtId ${numFmtId}.`);
        customIds.add(numFmtId);
        incrementBudget(metrics, budgets, "customNumberFormatCount");
        customNumberFormats.push({ numFmtId, formatCode });
        return false;
      }
      if (parent.local === "cellXfs") {
        if (frame.local !== "xf") throw new Error(`${part.name} cellXfs contains unknown child ${frame.local}.`);
        const numFmtIdRaw = attribute(frame.tag, "numFmtId") ?? "0";
        const numFmtId = parseSafeInteger(numFmtIdRaw, `${part.name} cellXfs numFmtId`, { max: 65_535 });
        incrementBudget(metrics, budgets, "cellFormatCount");
        cellFormats.push({ index: cellFormats.length, numFmtId, formatCode: null });
        return true;
      }
      if (parent.local === "extLst") return extensionOrError(frame, parent, part.name);
      if (frame.local === "numFmt") throw new Error(`${part.name} numFmt must not contain child elements.`);
      throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
    },
    text(text, frame) {
      requireWhitespace(text, `${part.name} ${frame.local}`);
    },
    finish() {
      if (!rootSeen || cellXfsSeen !== 1 || cellFormats.length === 0) {
        throw new Error(`${part.name} is missing its cellXfs contract.`);
      }
      if (expectedNumFmts !== null && expectedNumFmts !== customNumberFormats.length) {
        throw new Error(`${part.name} numFmts count does not match actual records.`);
      }
      if (expectedCellXfs !== null && expectedCellXfs !== cellFormats.length) {
        throw new Error(`${part.name} cellXfs count does not match actual records.`);
      }
    },
  });
  const formatCodes = new Map(BUILTIN_NUMBER_FORMATS);
  for (const item of customNumberFormats) formatCodes.set(item.numFmtId, item.formatCode);
  for (const item of cellFormats) item.formatCode = formatCodes.get(item.numFmtId) ?? null;
  return { customNumberFormats, cellFormats };
}

function parseSharedStrings(part, budgets, metrics) {
  const items = [];
  let rootSeen = false;
  let expectedCount = null;
  let expectedUniqueCount = null;
  let currentItem = null;
  let totalChars = 0;

  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent, stack) {
      if (captureRichPropertyOpen(frame, parent, stack, part.name)) return false;
      if (!isMainNamespace(frame.uri)) return extensionOrError(frame, parent, part.name);
      if (!parent) {
        if (frame.local !== "sst" || rootSeen) throw new Error(`${part.name} must have one sst root.`);
        rootSeen = true;
        const count = attribute(frame.tag, "count");
        const uniqueCount = attribute(frame.tag, "uniqueCount");
        expectedCount = count === null ? null : parseSafeInteger(count, `${part.name} count`);
        expectedUniqueCount = uniqueCount === null ? null : parseSafeInteger(uniqueCount, `${part.name} uniqueCount`);
        return false;
      }
      if (parent.local === "sst") {
        if (frame.local === "si") {
          if (currentItem) throw new Error(`${part.name} contains nested shared string items.`);
          incrementBudget(metrics, budgets, "sharedStringCount");
          currentItem = { segments: [] };
          return false;
        }
        if (frame.local === "extLst") return false;
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      if (!currentItem) throw new Error(`${part.name} contains shared string content outside si.`);
      if (frame.local === "t" && ["si", "r"].includes(parent.local)) {
        assertControlledAttributes(frame.tag, new Set(["xml:space"]), `${part.name} text`);
        if (parent.local === "r") {
          if (parent.richTextSeen) throw new Error(`${part.name} rich run contains duplicate text.`);
          parent.richTextSeen = true;
          frame.richPropertiesDigest = parent.richPropertiesDigest;
        }
        frame.text = "";
        frame.run = parent.local === "r";
        return false;
      }
      if (frame.local === "r" && parent.local === "si") {
        beginRichTextRun(frame);
        return false;
      }
      if (frame.local === "rPr" && parent.local === "r") {
        beginRichTextProperties(frame, parent, part.name);
        return false;
      }
      if (["rPh", "phoneticPr"].includes(frame.local)) return true;
      if (frame.local === "extLst") return false;
      if (parent.local === "extLst") return extensionOrError(frame, parent, part.name);
      throw new Error(`${part.name} contains unknown controlled shared string child ${frame.local}.`);
    },
    text(text, frame, stack) {
      if (captureRichPropertyText(text, frame, stack, part.name)) return;
      if (Object.hasOwn(frame, "text")) frame.text += text;
      else requireWhitespace(text, `${part.name} ${frame.local}`);
    },
    close(frame, parent, stack) {
      if (captureRichPropertyClose(frame, parent, stack)) return;
      if (Object.hasOwn(frame, "text")) {
        currentItem.segments.push({
          kind: frame.run ? "run" : "plain",
          text: frame.text,
          richPropertiesDigest: frame.run ? frame.richPropertiesDigest : null,
        });
      }
      if (frame.local === "r" && !frame.richTextSeen) {
        throw new Error(`${part.name} rich run is missing text.`);
      }
      if (frame.local === "si") {
        const text = currentItem.segments.map((segment) => segment.text).join("");
        if (text.length > budgets.sharedStringItemChars) {
          throw budgetError("sharedStringItemChars", budgets.sharedStringItemChars);
        }
        totalChars += text.length;
        if (totalChars > budgets.sharedStringTotalChars) {
          throw budgetError("sharedStringTotalChars", budgets.sharedStringTotalChars);
        }
        items.push({ index: items.length, text, richTextDigest: canonicalDigest(currentItem.segments) });
        currentItem = null;
      }
    },
    finish() {
      if (!rootSeen || currentItem) throw new Error(`${part.name} has an incomplete shared string contract.`);
      if (expectedUniqueCount !== null && expectedUniqueCount !== items.length) {
        throw new Error(`${part.name} uniqueCount does not match actual shared strings.`);
      }
      if (expectedCount !== null && expectedCount < items.length) {
        throw new Error(`${part.name} count is smaller than uniqueCount.`);
      }
    },
  });
  return { count: expectedCount, uniqueCount: expectedUniqueCount, items };
}

function optionalDecimalAttribute(tag, name, field, options) {
  const value = attribute(tag, name);
  return value === null ? null : validateDecimalString(value, field, options);
}

function optionalIntegerAttribute(tag, name, field, options) {
  const value = attribute(tag, name);
  return value === null ? null : parseSafeInteger(value, field, options);
}

function optionalBooleanAttribute(tag, name, field) {
  return parseBoolean(attribute(tag, name), field, null);
}

function optionalEnumAttribute(tag, name, field, allowed) {
  const value = attribute(tag, name);
  if (value !== null && !allowed.has(value)) throw new Error(`${field} has unsupported value ${value}.`);
  return value;
}

function parseSheetFormat(tag, field) {
  assertControlledAttributes(
    tag,
    new Set([
      "baseColWidth",
      "defaultColWidth",
      "defaultRowHeight",
      "customHeight",
      "zeroHeight",
      "thickTop",
      "thickBottom",
      "outlineLevelRow",
      "outlineLevelCol",
    ]),
    field,
  );
  const baseColWidth = attribute(tag, "baseColWidth");
  return {
    defaultRowHeight: optionalDecimalAttribute(tag, "defaultRowHeight", `${field} defaultRowHeight`, { nonNegative: true }),
    defaultColWidth: optionalDecimalAttribute(tag, "defaultColWidth", `${field} defaultColWidth`, { nonNegative: true }),
    baseColWidth: baseColWidth === null
      ? null
      : String(parseSafeInteger(baseColWidth, `${field} baseColWidth`, { max: MAX_EXCEL_COLUMN })),
    customHeight: optionalBooleanAttribute(tag, "customHeight", `${field} customHeight`),
    zeroHeight: optionalBooleanAttribute(tag, "zeroHeight", `${field} zeroHeight`),
    thickTop: optionalBooleanAttribute(tag, "thickTop", `${field} thickTop`),
    thickBottom: optionalBooleanAttribute(tag, "thickBottom", `${field} thickBottom`),
    outlineLevelRow: optionalIntegerAttribute(tag, "outlineLevelRow", `${field} outlineLevelRow`, { max: 7 }),
    outlineLevelColumn: optionalIntegerAttribute(tag, "outlineLevelCol", `${field} outlineLevelCol`, { max: 7 }),
  };
}

function parseColumn(tag, field) {
  assertControlledAttributes(
    tag,
    new Set([
      "min",
      "max",
      "width",
      "style",
      "hidden",
      "bestFit",
      "customWidth",
      "phonetic",
      "outlineLevel",
      "collapsed",
    ]),
    field,
  );
  const min = parseSafeInteger(attribute(tag, "min", { required: true }), `${field} min`, {
    min: 1,
    max: MAX_EXCEL_COLUMN,
  });
  const max = parseSafeInteger(attribute(tag, "max", { required: true }), `${field} max`, {
    min: 1,
    max: MAX_EXCEL_COLUMN,
  });
  if (max < min) throw new Error(`${field} has descending min/max indexes.`);
  return {
    min,
    max,
    width: optionalDecimalAttribute(tag, "width", `${field} width`, { nonNegative: true }),
    styleIndex: optionalIntegerAttribute(tag, "style", `${field} style`, { max: 65_535 }),
    hidden: optionalBooleanAttribute(tag, "hidden", `${field} hidden`),
    bestFit: optionalBooleanAttribute(tag, "bestFit", `${field} bestFit`),
    customWidth: optionalBooleanAttribute(tag, "customWidth", `${field} customWidth`),
    phonetic: optionalBooleanAttribute(tag, "phonetic", `${field} phonetic`),
    outlineLevel: optionalIntegerAttribute(tag, "outlineLevel", `${field} outlineLevel`, { max: 7 }),
    collapsed: optionalBooleanAttribute(tag, "collapsed", `${field} collapsed`),
  };
}

function parseRowSpans(tag, field) {
  const value = attribute(tag, "spans");
  if (value === null) return null;
  if (value !== value.trim() || value.length === 0) {
    throw new Error(`${field} spans must be a canonical cell-span list.`);
  }
  let previousMax = 0;
  const spans = value.split(/\s+/u).map((item, index) => {
    const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(item);
    if (!match) throw new Error(`${field} spans[${index}] must be min:max.`);
    const min = parseSafeInteger(match[1], `${field} spans[${index}] min`, {
      min: 1,
      max: MAX_EXCEL_COLUMN,
    });
    const max = parseSafeInteger(match[2], `${field} spans[${index}] max`, {
      min: 1,
      max: MAX_EXCEL_COLUMN,
    });
    if (min > max || min <= previousMax) {
      throw new Error(`${field} spans are descending or overlap.`);
    }
    previousMax = max;
    return `${min}:${max}`;
  });
  return spans.join(" ");
}

function parseRow(tag, field) {
  assertControlledAttributes(
    tag,
    new Set([
      "r",
      "spans",
      "s",
      "customFormat",
      "ht",
      "hidden",
      "customHeight",
      "outlineLevel",
      "collapsed",
      "thickTop",
      "thickBot",
      "ph",
    ]),
    field,
  );
  return {
    index: parseSafeInteger(attribute(tag, "r", { required: true }), `${field} r`, {
      min: 1,
      max: MAX_EXCEL_ROW,
    }),
    spans: parseRowSpans(tag, field),
    styleIndex: optionalIntegerAttribute(tag, "s", `${field} style`, { max: 65_535 }),
    customFormat: optionalBooleanAttribute(tag, "customFormat", `${field} customFormat`),
    height: optionalDecimalAttribute(tag, "ht", `${field} ht`, { nonNegative: true }),
    customHeight: optionalBooleanAttribute(tag, "customHeight", `${field} customHeight`),
    hidden: optionalBooleanAttribute(tag, "hidden", `${field} hidden`),
    outlineLevel: optionalIntegerAttribute(tag, "outlineLevel", `${field} outlineLevel`, { max: 7 }),
    collapsed: optionalBooleanAttribute(tag, "collapsed", `${field} collapsed`),
    thickTop: optionalBooleanAttribute(tag, "thickTop", `${field} thickTop`),
    thickBottom: optionalBooleanAttribute(tag, "thickBot", `${field} thickBot`),
    phonetic: optionalBooleanAttribute(tag, "ph", `${field} ph`),
    cells: [],
  };
}

function parseSheetView(tag, field) {
  const allowed = new Set([
    "windowProtection",
    "showFormulas",
    "showGridLines",
    "showRowColHeaders",
    "showZeros",
    "rightToLeft",
    "tabSelected",
    "showRuler",
    "showOutlineSymbols",
    "defaultGridColor",
    "showWhiteSpace",
    "view",
    "topLeftCell",
    "colorId",
    "zoomScale",
    "zoomScaleNormal",
    "zoomScaleSheetLayoutView",
    "zoomScalePageLayoutView",
    "workbookViewId",
  ]);
  assertControlledAttributes(tag, allowed, field);
  const workbookViewId = parseSafeInteger(
    attribute(tag, "workbookViewId", { required: true }),
    `${field} workbookViewId`,
  );
  const topLeftCell = attribute(tag, "topLeftCell");
  if (topLeftCell !== null) parseCellReference(topLeftCell, `${field} topLeftCell`);
  return {
    workbookViewId,
    windowProtection: optionalBooleanAttribute(tag, "windowProtection", `${field} windowProtection`),
    showFormulas: optionalBooleanAttribute(tag, "showFormulas", `${field} showFormulas`),
    showGridLines: optionalBooleanAttribute(tag, "showGridLines", `${field} showGridLines`),
    showRowColHeaders: optionalBooleanAttribute(tag, "showRowColHeaders", `${field} showRowColHeaders`),
    showZeros: optionalBooleanAttribute(tag, "showZeros", `${field} showZeros`),
    rightToLeft: optionalBooleanAttribute(tag, "rightToLeft", `${field} rightToLeft`),
    tabSelected: optionalBooleanAttribute(tag, "tabSelected", `${field} tabSelected`),
    showRuler: optionalBooleanAttribute(tag, "showRuler", `${field} showRuler`),
    showOutlineSymbols: optionalBooleanAttribute(tag, "showOutlineSymbols", `${field} showOutlineSymbols`),
    defaultGridColor: optionalBooleanAttribute(tag, "defaultGridColor", `${field} defaultGridColor`),
    showWhiteSpace: optionalBooleanAttribute(tag, "showWhiteSpace", `${field} showWhiteSpace`),
    view: optionalEnumAttribute(tag, "view", `${field} view`, new Set(["normal", "pageBreakPreview", "pageLayout"])),
    topLeftCell,
    colorId: optionalIntegerAttribute(tag, "colorId", `${field} colorId`),
    zoomScale: optionalDecimalAttribute(tag, "zoomScale", `${field} zoomScale`, { nonNegative: true }),
    zoomScaleNormal: optionalDecimalAttribute(tag, "zoomScaleNormal", `${field} zoomScaleNormal`, { nonNegative: true }),
    zoomScaleSheetLayoutView: optionalDecimalAttribute(tag, "zoomScaleSheetLayoutView", `${field} zoomScaleSheetLayoutView`, { nonNegative: true }),
    zoomScalePageLayoutView: optionalDecimalAttribute(tag, "zoomScalePageLayoutView", `${field} zoomScalePageLayoutView`, { nonNegative: true }),
    pane: null,
    selections: [],
  };
}

function parsePane(tag, field) {
  assertControlledAttributes(
    tag,
    new Set(["xSplit", "ySplit", "topLeftCell", "activePane", "state"]),
    field,
  );
  const topLeftCell = attribute(tag, "topLeftCell");
  if (topLeftCell !== null) parseCellReference(topLeftCell, `${field} topLeftCell`);
  return {
    xSplit: optionalDecimalAttribute(tag, "xSplit", `${field} xSplit`, { nonNegative: true }),
    ySplit: optionalDecimalAttribute(tag, "ySplit", `${field} ySplit`, { nonNegative: true }),
    topLeftCell,
    activePane: optionalEnumAttribute(
      tag,
      "activePane",
      `${field} activePane`,
      new Set(["bottomRight", "topRight", "bottomLeft", "topLeft"]),
    ),
    state: optionalEnumAttribute(
      tag,
      "state",
      `${field} state`,
      new Set(["split", "frozen", "frozenSplit"]),
    ),
  };
}

function parseSelection(tag, field) {
  assertControlledAttributes(tag, new Set(["pane", "activeCell", "activeCellId", "sqref"]), field);
  const activeCell = attribute(tag, "activeCell");
  if (activeCell !== null) parseCellReference(activeCell, `${field} activeCell`);
  const sqref = attribute(tag, "sqref");
  if (sqref !== null) {
    for (const [index, reference] of sqref.trim().split(/\s+/u).entries()) {
      parseCellRange(reference.replaceAll("$", ""), `${field} sqref[${index}]`);
    }
  }
  return {
    pane: optionalEnumAttribute(
      tag,
      "pane",
      `${field} pane`,
      new Set(["bottomRight", "topRight", "bottomLeft", "topLeft"]),
    ),
    activeCell,
    activeCellId: optionalIntegerAttribute(tag, "activeCellId", `${field} activeCellId`, {
      max: 4_294_967_295,
    }),
    sqref,
  };
}

function parsePrintOptions(tag, field) {
  assertControlledAttributes(
    tag,
    new Set(["horizontalCentered", "verticalCentered", "headings", "gridLines", "gridLinesSet"]),
    field,
  );
  return {
    horizontalCentered: optionalBooleanAttribute(tag, "horizontalCentered", `${field} horizontalCentered`),
    verticalCentered: optionalBooleanAttribute(tag, "verticalCentered", `${field} verticalCentered`),
    headings: optionalBooleanAttribute(tag, "headings", `${field} headings`),
    gridLines: optionalBooleanAttribute(tag, "gridLines", `${field} gridLines`),
    gridLinesSet: optionalBooleanAttribute(tag, "gridLinesSet", `${field} gridLinesSet`),
  };
}

function parsePageMargins(tag, field) {
  assertControlledAttributes(tag, new Set(["left", "right", "top", "bottom", "header", "footer"]), field);
  return Object.fromEntries(["left", "right", "top", "bottom", "header", "footer"].map((name) => {
    const value = attribute(tag, name, { required: true });
    return [name, validateDecimalString(value, `${field} ${name}`, { nonNegative: true })];
  }));
}

function parsePageSetup(tag, field) {
  assertControlledAttributes(
    tag,
    new Set([
      "paperSize",
      "paperHeight",
      "paperWidth",
      "scale",
      "firstPageNumber",
      "fitToWidth",
      "fitToHeight",
      "pageOrder",
      "orientation",
      "usePrinterDefaults",
      "blackAndWhite",
      "draft",
      "cellComments",
      "useFirstPageNumber",
      "errors",
      "horizontalDpi",
      "verticalDpi",
      "copies",
    ]),
    field,
    [[DOCUMENT_REL_NS, "id"], [STRICT_DOCUMENT_REL_NS, "id"]],
  );
  const integerString = (name) => {
    const value = attribute(tag, name);
    return value === null ? null : String(parseSafeInteger(value, `${field} ${name}`));
  };
  const relationshipIdMatches = [
    ...attributesByIdentity(tag, "id", DOCUMENT_REL_NS),
    ...attributesByIdentity(tag, "id", STRICT_DOCUMENT_REL_NS),
  ];
  if (relationshipIdMatches.length > 1) throw new Error(`${field} has duplicate relationship ids.`);
  return {
    paperSize: integerString("paperSize"),
    paperHeight: optionalDecimalAttribute(tag, "paperHeight", `${field} paperHeight`, { nonNegative: true }),
    paperWidth: optionalDecimalAttribute(tag, "paperWidth", `${field} paperWidth`, { nonNegative: true }),
    scale: optionalDecimalAttribute(tag, "scale", `${field} scale`, { nonNegative: true }),
    firstPageNumber: integerString("firstPageNumber"),
    fitToWidth: integerString("fitToWidth"),
    fitToHeight: integerString("fitToHeight"),
    pageOrder: optionalEnumAttribute(tag, "pageOrder", `${field} pageOrder`, new Set(["downThenOver", "overThenDown"])),
    orientation: optionalEnumAttribute(tag, "orientation", `${field} orientation`, new Set(["default", "portrait", "landscape"])),
    usePrinterDefaults: optionalBooleanAttribute(tag, "usePrinterDefaults", `${field} usePrinterDefaults`),
    blackAndWhite: optionalBooleanAttribute(tag, "blackAndWhite", `${field} blackAndWhite`),
    draft: optionalBooleanAttribute(tag, "draft", `${field} draft`),
    cellComments: attribute(tag, "cellComments"),
    useFirstPageNumber: optionalBooleanAttribute(tag, "useFirstPageNumber", `${field} useFirstPageNumber`),
    errors: attribute(tag, "errors"),
    horizontalDpi: integerString("horizontalDpi"),
    verticalDpi: integerString("verticalDpi"),
    copies: integerString("copies"),
    relationshipId: relationshipIdMatches[0]?.value ?? null,
  };
}

function parsePageSetUpPr(tag, field) {
  assertControlledAttributes(tag, new Set(["autoPageBreaks", "fitToPage"]), field);
  return {
    autoPageBreaks: optionalBooleanAttribute(tag, "autoPageBreaks", `${field} autoPageBreaks`),
    fitToPage: optionalBooleanAttribute(tag, "fitToPage", `${field} fitToPage`),
  };
}

function parseHeaderFooter(tag, field) {
  assertControlledAttributes(
    tag,
    new Set(["differentOddEven", "differentFirst", "scaleWithDoc", "alignWithMargins"]),
    field,
  );
  return {
    differentOddEven: optionalBooleanAttribute(tag, "differentOddEven", `${field} differentOddEven`),
    differentFirst: optionalBooleanAttribute(tag, "differentFirst", `${field} differentFirst`),
    scaleWithDoc: optionalBooleanAttribute(tag, "scaleWithDoc", `${field} scaleWithDoc`),
    alignWithMargins: optionalBooleanAttribute(tag, "alignWithMargins", `${field} alignWithMargins`),
    oddHeader: null,
    oddFooter: null,
    evenHeader: null,
    evenFooter: null,
    firstHeader: null,
    firstFooter: null,
  };
}

function validateCellScalar(type, value, field) {
  if (type === "n") return validateDecimalString(value, field);
  if (type === "b") {
    if (value !== "0" && value !== "1") throw new Error(`${field} boolean must be 0 or 1.`);
    return value;
  }
  if (type === "e") {
    if (!new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA"]).has(value)) {
      throw new Error(`${field} is not a supported Excel error literal.`);
    }
    return value;
  }
  if (type === "d") {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(value)) {
      throw new Error(`${field} is not an ISO 8601 cell date string.`);
    }
    return value;
  }
  return value;
}

function finalizeCell(cell, styles, sharedStrings, field) {
  const type = cell.type ?? "n";
  const allowedTypes = new Set(["n", "s", "inlineStr", "str", "b", "e", "d"]);
  if (!allowedTypes.has(type)) throw new Error(`${field} has unsupported cell type ${type}.`);
  if (styles) {
    if (cell.styleIndex >= styles.cellFormats.length) throw new Error(`${field} style index is outside cellXfs.`);
  } else if (cell.styleIndex !== 0) {
    throw new Error(`${field} uses a style index without a styles part.`);
  }
  const cellFormat = styles?.cellFormats[cell.styleIndex] ?? { numFmtId: 0, formatCode: "General" };
  let value = null;
  let cachedValue = null;
  if (cell.formula) {
    if (cell.inlineSegments !== null) throw new Error(`${field} formula cannot contain inline string content.`);
    if (cell.valueSeen) cachedValue = validateCellScalar(type, cell.valueText, `${field} cached value`);
  } else if (cell.inlineSegments !== null) {
    if (type !== "inlineStr" || cell.valueSeen) throw new Error(`${field} inline string contract is inconsistent.`);
    value = {
      raw: null,
      text: cell.inlineSegments.map((segment) => segment.text).join(""),
      richTextDigest: canonicalDigest(cell.inlineSegments),
    };
  } else if (cell.valueSeen) {
    if (type === "s") {
      const index = parseSafeInteger(cell.valueText, `${field} shared string index`);
      if (!sharedStrings || index >= sharedStrings.items.length) {
        throw new Error(`${field} shared string index is outside sharedStrings.`);
      }
      value = {
        raw: cell.valueText,
        text: sharedStrings.items[index].text,
        richTextDigest: sharedStrings.items[index].richTextDigest,
      };
    } else {
      const raw = validateCellScalar(type, cell.valueText, `${field} value`);
      value = { raw, text: type === "str" ? raw : null };
    }
  } else if (type === "inlineStr") {
    throw new Error(`${field} inlineStr cell is missing is content.`);
  }
  return {
    ref: cell.ref,
    row: cell.row,
    column: cell.column,
    type,
    styleIndex: cell.styleIndex,
    cellMetadataIndex: cell.cellMetadataIndex,
    valueMetadataIndex: cell.valueMetadataIndex,
    phonetic: cell.phonetic,
    numberFormat: {
      numFmtId: cellFormat.numFmtId,
      formatCode: cellFormat.formatCode,
    },
    value,
    formula: cell.formula,
    cachedValue,
  };
}

function assertNonOverlappingMerges(merges, field) {
  const events = [];
  for (const item of merges) {
    events.push({ row: item.startRow, delta: 1, start: item.startColumn, end: item.endColumn });
    if (item.endRow < MAX_EXCEL_ROW) {
      events.push({ row: item.endRow + 1, delta: -1, start: item.startColumn, end: item.endColumn });
    }
  }
  events.sort((left, right) => left.row - right.row || left.delta - right.delta || left.start - right.start);
  const tree = new Int32Array(4 * (MAX_EXCEL_COLUMN + 1));
  const lazy = new Int32Array(tree.length);
  const update = (node, left, right, start, end, delta) => {
    if (start <= left && right <= end) {
      tree[node] += delta;
      lazy[node] += delta;
      return;
    }
    const middle = Math.floor((left + right) / 2);
    if (start <= middle) update(node * 2, left, middle, start, end, delta);
    if (end > middle) update(node * 2 + 1, middle + 1, right, start, end, delta);
    tree[node] = lazy[node] + Math.max(tree[node * 2], tree[node * 2 + 1]);
  };
  for (const event of events) {
    update(1, 1, MAX_EXCEL_COLUMN, event.start, event.end, event.delta);
    if (tree[1] > 1) throw new Error(`${field} contains overlapping merge ranges.`);
    if (tree[1] < 0) throw new Error(`${field} contains contradictory merge range events.`);
  }
}

function parseWorksheet(part, identity, styles, sharedStrings, budgets, metrics) {
  const opaqueControlledPaths = new Set();
  const worksheet = {
    ...identity,
    partSha256: part.sha256,
    opaqueControlledPaths: [],
    dimensionRef: null,
    sheetFormat: null,
    columns: [],
    views: [],
    rows: [],
    merges: [],
    print: {
      printOptions: null,
      pageMargins: null,
      pageSetup: null,
      pageSetUpPr: null,
      headerFooter: null,
    },
  };
  const singletonTop = new Set();
  let rootSeen = false;
  let currentRow = null;
  let currentCell = null;
  let currentView = null;
  let lastRowIndex = 0;
  let lastColumnMax = 0;
  let sheetCellCount = 0;

  const claimTop = (name) => {
    if (singletonTop.has(name)) throw new Error(`${part.name} contains duplicate ${name}.`);
    singletonTop.add(name);
  };
  const ensurePerSheet = (field, count) => {
    if (count > budgets[field]) throw budgetError(field, budgets[field]);
  };
  const markOpaque = (frame, stack) => {
    opaqueControlledPaths.add(controlledPath(stack, frame));
    return true;
  };

  parseXml(part.bytes, part.name, budgets, metrics, {
    open(frame, parent, stack) {
      if (captureRichPropertyOpen(frame, parent, stack, part.name)) return false;
      if (!isMainNamespace(frame.uri)) return extensionOrError(frame, parent, part.name);
      for (const item of semanticAttributes(frame.tag)) {
        if (item.uri === "" || (item.uri === XML_NS && item.local === "space")) continue;
        const pageSetupRelationshipId = frame.local === "pageSetup"
          && item.local === "id"
          && (item.uri === DOCUMENT_REL_NS || item.uri === STRICT_DOCUMENT_REL_NS);
        if (!pageSetupRelationshipId) {
          opaqueControlledPaths.add(`${controlledPath(stack, frame)}@{${item.uri}}${item.local}`);
        }
      }
      if (!parent) {
        if (frame.local !== "worksheet" || rootSeen) throw new Error(`${part.name} must have one worksheet root.`);
        assertControlledAttributes(frame.tag, new Set(), `${part.name} worksheet`);
        rootSeen = true;
        return false;
      }
      if (parent.local === "worksheet") {
        if (frame.local === "sheetPr") {
          claimTop("sheetPr");
          for (const item of semanticAttributes(frame.tag)) {
            if (item.uri === "" || (item.uri === XML_NS && item.local === "space")) {
              opaqueControlledPaths.add(`${controlledPath(stack, frame)}@${item.local}`);
            }
          }
          return false;
        }
        if (frame.local === "dimension") {
          claimTop("dimension");
          assertControlledAttributes(frame.tag, new Set(["ref"]), `${part.name} dimension`);
          const ref = attribute(frame.tag, "ref", { required: true });
          parseCellRange(ref, `${part.name} dimension`);
          worksheet.dimensionRef = ref;
          return false;
        }
        if (frame.local === "sheetViews") {
          claimTop("sheetViews");
          assertControlledAttributes(frame.tag, new Set(), `${part.name} sheetViews`);
          return false;
        }
        if (frame.local === "sheetFormatPr") {
          claimTop("sheetFormatPr");
          worksheet.sheetFormat = parseSheetFormat(frame.tag, `${part.name} sheetFormatPr`);
          return false;
        }
        if (frame.local === "cols") {
          claimTop("cols");
          assertControlledAttributes(frame.tag, new Set(), `${part.name} cols`);
          return false;
        }
        if (frame.local === "sheetData") {
          claimTop("sheetData");
          assertControlledAttributes(frame.tag, new Set(), `${part.name} sheetData`);
          return false;
        }
        if (frame.local === "mergeCells") {
          claimTop("mergeCells");
          assertControlledAttributes(frame.tag, new Set(["count"]), `${part.name} mergeCells`);
          const count = attribute(frame.tag, "count");
          frame.expectedCount = count === null ? null : parseSafeInteger(count, `${part.name} mergeCells count`);
          return false;
        }
        if (frame.local === "printOptions") {
          claimTop("printOptions");
          worksheet.print.printOptions = parsePrintOptions(frame.tag, `${part.name} printOptions`);
          return false;
        }
        if (frame.local === "pageMargins") {
          claimTop("pageMargins");
          worksheet.print.pageMargins = parsePageMargins(frame.tag, `${part.name} pageMargins`);
          return false;
        }
        if (frame.local === "pageSetup") {
          claimTop("pageSetup");
          worksheet.print.pageSetup = parsePageSetup(frame.tag, `${part.name} pageSetup`);
          return false;
        }
        if (frame.local === "headerFooter") {
          claimTop("headerFooter");
          worksheet.print.headerFooter = parseHeaderFooter(frame.tag, `${part.name} headerFooter`);
          return false;
        }
        if (frame.local === "extLst" || WORKSHEET_OPAQUE_TOP_LEVEL.has(frame.local)) {
          return markOpaque(frame, stack);
        }
        throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "sheetPr") {
        if (frame.local === "pageSetUpPr") {
          if (worksheet.print.pageSetUpPr) throw new Error(`${part.name} contains duplicate pageSetUpPr.`);
          worksheet.print.pageSetUpPr = parsePageSetUpPr(frame.tag, `${part.name} pageSetUpPr`);
          return false;
        }
        if (["tabColor", "outlinePr", "extLst"].includes(frame.local)) return markOpaque(frame, stack);
        throw new Error(`${part.name} sheetPr contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "sheetViews") {
        if (frame.local === "sheetView") {
          currentView = parseSheetView(frame.tag, `${part.name} sheetView`);
          return false;
        }
        if (frame.local === "extLst") return markOpaque(frame, stack);
        throw new Error(`${part.name} sheetViews contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "sheetView") {
        if (frame.local === "pane") {
          if (!currentView || currentView.pane) throw new Error(`${part.name} sheetView contains duplicate pane.`);
          currentView.pane = parsePane(frame.tag, `${part.name} pane`);
          return false;
        }
        if (frame.local === "selection") {
          if (!currentView) throw new Error(`${part.name} selection is outside sheetView.`);
          currentView.selections.push(parseSelection(frame.tag, `${part.name} selection`));
          return false;
        }
        if (["pivotSelection", "extLst"].includes(frame.local)) return markOpaque(frame, stack);
        throw new Error(`${part.name} sheetView contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "cols") {
        if (frame.local !== "col") throw new Error(`${part.name} cols contains unknown controlled child ${frame.local}.`);
        const column = parseColumn(frame.tag, `${part.name} col`);
        if (column.min <= lastColumnMax) throw new Error(`${part.name} column ranges are descending or overlap.`);
        lastColumnMax = column.max;
        ensurePerSheet("columnRangesPerSheet", worksheet.columns.length + 1);
        incrementBudget(metrics, budgets, "totalColumnRanges");
        worksheet.columns.push(column);
        return false;
      }
      if (parent.local === "sheetData") {
        if (frame.local !== "row") {
          throw new Error(`${part.name} sheetData contains unknown controlled child ${frame.local}.`);
        }
        if (currentRow) throw new Error(`${part.name} contains nested rows.`);
        currentRow = parseRow(frame.tag, `${part.name} row`);
        if (currentRow.index <= lastRowIndex) throw new Error(`${part.name} row indexes are duplicate or out of order.`);
        lastRowIndex = currentRow.index;
        currentRow.lastCellColumn = 0;
        ensurePerSheet("rowsPerSheet", worksheet.rows.length + 1);
        incrementBudget(metrics, budgets, "totalRows");
        return false;
      }
      if (parent.local === "row") {
        if (frame.local !== "c") throw new Error(`${part.name} row contains unknown controlled child ${frame.local}.`);
        if (!currentRow || currentCell) throw new Error(`${part.name} has a cell outside one current row.`);
        assertControlledAttributes(frame.tag, new Set(["r", "s", "t", "cm", "vm", "ph"]), `${part.name} cell`);
        const parsedRef = parseCellReference(attribute(frame.tag, "r", { required: true }), `${part.name} cell ref`);
        if (parsedRef.row !== currentRow.index) throw new Error(`${part.name} cell coordinate contradicts its row index.`);
        if (parsedRef.column <= currentRow.lastCellColumn) {
          throw new Error(`${part.name} cell coordinates are duplicate or out of order.`);
        }
        currentRow.lastCellColumn = parsedRef.column;
        currentCell = {
          ...parsedRef,
          type: attribute(frame.tag, "t"),
          styleIndex: optionalIntegerAttribute(frame.tag, "s", `${part.name} cell style`, { max: 65_535 }) ?? 0,
          cellMetadataIndex: optionalIntegerAttribute(frame.tag, "cm", `${part.name} cell metadata`, { max: 65_535 }),
          valueMetadataIndex: optionalIntegerAttribute(frame.tag, "vm", `${part.name} value metadata`, { max: 65_535 }),
          phonetic: optionalBooleanAttribute(frame.tag, "ph", `${part.name} cell phonetic`),
          formula: null,
          formulaSeen: false,
          valueSeen: false,
          valueText: "",
          inlineSegments: null,
          inlineSeen: false,
        };
        sheetCellCount += 1;
        ensurePerSheet("cellsPerSheet", sheetCellCount);
        incrementBudget(metrics, budgets, "totalCells");
        return false;
      }
      if (parent.local === "c") {
        if (!currentCell) throw new Error(`${part.name} cell content has no current cell.`);
        if (frame.local === "f") {
          if (currentCell.formulaSeen) throw new Error(`${part.name} cell contains duplicate f elements.`);
          assertControlledAttributes(frame.tag, new Set(["t", "ref", "si"]), `${part.name} formula`);
          const type = attribute(frame.tag, "t");
          const ref = attribute(frame.tag, "ref");
          const sharedIndex = attribute(frame.tag, "si");
          if (type !== null && type !== "normal") {
            throw new Error(`${part.name} contains unsupported ${type} formula semantics.`);
          }
          if (ref !== null || sharedIndex !== null) {
            throw new Error(`${part.name} normal formula must not carry shared or array identity.`);
          }
          currentCell.formulaSeen = true;
          frame.formulaText = "";
          frame.formulaType = type;
          return false;
        }
        if (frame.local === "v") {
          if (currentCell.valueSeen) throw new Error(`${part.name} cell contains duplicate v elements.`);
          assertControlledAttributes(frame.tag, new Set(), `${part.name} value`);
          currentCell.valueSeen = true;
          frame.valueText = "";
          return false;
        }
        if (frame.local === "is") {
          if (currentCell.inlineSeen) throw new Error(`${part.name} cell contains duplicate is elements.`);
          assertControlledAttributes(frame.tag, new Set(), `${part.name} inline string`);
          currentCell.inlineSeen = true;
          currentCell.inlineSegments = [];
          return false;
        }
        throw new Error(`${part.name} cell contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "is") {
        if (frame.local === "t") {
          assertControlledAttributes(frame.tag, new Set(["xml:space"]), `${part.name} inline text`);
          frame.richText = "";
          frame.richKind = "plain";
          return false;
        }
        if (frame.local === "r") {
          assertControlledAttributes(frame.tag, new Set(), `${part.name} inline rich run`);
          beginRichTextRun(frame);
          return false;
        }
        throw new Error(`${part.name} inline string contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "r" && currentCell?.inlineSegments) {
        if (frame.local === "t") {
          assertControlledAttributes(frame.tag, new Set(["xml:space"]), `${part.name} inline run text`);
          if (parent.richTextSeen) throw new Error(`${part.name} inline rich run contains duplicate text.`);
          parent.richTextSeen = true;
          frame.richText = "";
          frame.richKind = "run";
          frame.richPropertiesDigest = parent.richPropertiesDigest;
          return false;
        }
        if (frame.local === "rPr") {
          beginRichTextProperties(frame, parent, part.name);
          return false;
        }
        throw new Error(`${part.name} inline rich run contains unknown controlled child ${frame.local}.`);
      }
      if (parent.local === "mergeCells") {
        if (frame.local !== "mergeCell") {
          throw new Error(`${part.name} mergeCells contains unknown controlled child ${frame.local}.`);
        }
        assertControlledAttributes(frame.tag, new Set(["ref"]), `${part.name} mergeCell`);
        const merge = parseCellRange(attribute(frame.tag, "ref", { required: true }), `${part.name} mergeCell`);
        ensurePerSheet("mergesPerSheet", worksheet.merges.length + 1);
        incrementBudget(metrics, budgets, "totalMerges");
        worksheet.merges.push(merge);
        return false;
      }
      if (parent.local === "headerFooter") {
        const fields = new Set(["oddHeader", "oddFooter", "evenHeader", "evenFooter", "firstHeader", "firstFooter"]);
        if (!fields.has(frame.local)) {
          throw new Error(`${part.name} headerFooter contains unknown controlled child ${frame.local}.`);
        }
        if (worksheet.print.headerFooter[frame.local] !== null) {
          throw new Error(`${part.name} headerFooter contains duplicate ${frame.local}.`);
        }
        assertControlledAttributes(frame.tag, new Set(), `${part.name} ${frame.local}`);
        frame.headerFooterField = frame.local;
        frame.headerFooterText = "";
        return false;
      }
      if ([
        "dimension",
        "sheetFormatPr",
        "col",
        "pane",
        "selection",
        "mergeCell",
        "printOptions",
        "pageMargins",
        "pageSetup",
        "pageSetUpPr",
      ].includes(parent.local)) {
        throw new Error(`${part.name} ${parent.local} must not contain child elements.`);
      }
      throw new Error(`${part.name} contains unknown controlled child ${frame.local}.`);
    },
    text(text, frame, stack) {
      if (captureRichPropertyText(text, frame, stack, part.name)) return;
      if (Object.hasOwn(frame, "formulaText")) frame.formulaText += text;
      else if (Object.hasOwn(frame, "valueText")) frame.valueText += text;
      else if (Object.hasOwn(frame, "richText")) frame.richText += text;
      else if (Object.hasOwn(frame, "headerFooterText")) frame.headerFooterText += text;
      else requireWhitespace(text, `${part.name} ${frame.local}`);
    },
    close(frame, parent, stack) {
      if (captureRichPropertyClose(frame, parent, stack)) return;
      if (Object.hasOwn(frame, "formulaText")) {
        if (!frame.formulaText) throw new Error(`${part.name} formula text must not be empty.`);
        currentCell.formula = {
          text: frame.formulaText,
          type: frame.formulaType,
          ref: null,
          sharedIndex: null,
        };
      }
      if (Object.hasOwn(frame, "valueText")) currentCell.valueText = frame.valueText;
      if (Object.hasOwn(frame, "richText")) {
        currentCell.inlineSegments.push({
          kind: frame.richKind,
          text: frame.richText,
          richPropertiesDigest: frame.richKind === "run" ? frame.richPropertiesDigest : null,
        });
      }
      if (Object.hasOwn(frame, "headerFooterText")) {
        worksheet.print.headerFooter[frame.headerFooterField] = frame.headerFooterText;
      }
      if (frame.local === "r" && !frame.richTextSeen) {
        throw new Error(`${part.name} inline rich run is missing text.`);
      }
      if (frame.local === "c") {
        currentRow.cells.push(finalizeCell(currentCell, styles, sharedStrings, `${part.name} cell ${currentCell.ref}`));
        currentCell = null;
      } else if (frame.local === "row") {
        delete currentRow.lastCellColumn;
        worksheet.rows.push(currentRow);
        currentRow = null;
      } else if (frame.local === "sheetView") {
        worksheet.views.push(currentView);
        currentView = null;
      } else if (frame.local === "mergeCells" && frame.expectedCount !== null && frame.expectedCount !== worksheet.merges.length) {
        throw new Error(`${part.name} mergeCells count does not match actual ranges.`);
      }
    },
    finish() {
      if (!rootSeen || currentRow || currentCell || currentView) {
        throw new Error(`${part.name} has an incomplete worksheet contract.`);
      }
      if (!singletonTop.has("sheetData")) throw new Error(`${part.name} is missing sheetData.`);
    },
  });

  for (const column of worksheet.columns) {
    if (column.styleIndex !== null && (!styles || column.styleIndex >= styles.cellFormats.length)) {
      throw new Error(`${part.name} column style index is outside cellXfs.`);
    }
  }
  assertNonOverlappingMerges(worksheet.merges, part.name);
  worksheet.opaqueControlledPaths = [...opaqueControlledPaths]
    .sort((left, right) => left.localeCompare(right, "en"));
  return worksheet;
}

function requireSingleRelationship(relationships, kind, field, { optional = false } = {}) {
  const matches = relationships.filter((item) => relationshipHasType(item, kind));
  if (matches.length === 0 && optional) return null;
  if (matches.length !== 1) throw new Error(`${field} must contain exactly one ${kind} relationship.`);
  const item = matches[0];
  if (item.targetMode !== "Internal" || item.resolvedPartName === null) {
    throw new Error(`${field} ${kind} relationship must be internal.`);
  }
  return item;
}

function partsWithContentType(packagePartNames, contentTypes, expected) {
  return [...packagePartNames]
    .filter((name) => name !== "[Content_Types].xml" && expected.has(contentTypeFor(name, contentTypes)))
    .sort();
}

function assertSameIdentitySet(actual, expected, field) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${field} contains orphan or ambiguously bound core parts.`);
  }
}

export async function readWorkbookOoxmlFacts(stableSnapshot, options) {
  const { factBudgets, workbookBudgets } = normalizeOptions(options);
  const workbookSnapshot = await openWorkbookSnapshot(stableSnapshot, {
    ...(workbookBudgets === undefined ? {} : { budgets: workbookBudgets }),
  });
  const structuralMetadata = workbookSnapshot.parts
    .filter((part) => !part.directory && part.structural)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const structuralParts = await readSnapshotStructuralParts(
    workbookSnapshot,
    structuralMetadata.map((part) => part.name),
    { concurrency: 3 },
  );
  const partByName = new Map(structuralParts.map((part) => [part.name, part]));
  const packagePartNames = new Set(
    workbookSnapshot.parts.filter((part) => !part.directory).map((part) => part.name),
  );
  const metrics = Object.create(null);

  const contentTypesPart = partByName.get("[Content_Types].xml");
  if (!contentTypesPart) throw new Error("XLSX package is missing [Content_Types].xml.");
  const contentTypes = parseContentTypes(contentTypesPart, factBudgets, metrics);

  const relationshipParts = structuralParts
    .filter((part) => part.name.endsWith(".rels"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const relationships = [];
  const relationshipsBySource = new Map();
  for (const part of relationshipParts) {
    const sourcePartName = relationshipSourceFor(part.name);
    if (sourcePartName !== null && !packagePartNames.has(sourcePartName)) {
      throw new Error(`Relationship part ${part.name} has no source package part.`);
    }
    const parsed = parseRelationships(part, sourcePartName, packagePartNames, factBudgets, metrics);
    if (relationshipsBySource.has(sourcePartName)) {
      throw new Error(`XLSX package contains duplicate relationship parts for ${sourcePartName ?? "package root"}.`);
    }
    relationshipsBySource.set(sourcePartName, parsed);
    relationships.push(...parsed);
  }

  const rootRelationships = relationshipsBySource.get(null);
  if (!rootRelationships) throw new Error("XLSX package is missing its root relationships part.");
  const officeDocument = requireSingleRelationship(rootRelationships, "officeDocument", "Root relationships");
  const workbookPart = partByName.get(officeDocument.resolvedPartName);
  if (!workbookPart) throw new Error("Root officeDocument relationship does not identify structural workbook XML.");
  if (!CONTENT_TYPES.workbook.has(contentTypeFor(workbookPart.name, contentTypes))) {
    throw new Error("Root officeDocument target does not have the XLSX workbook content type.");
  }
  assertSameIdentitySet(
    partsWithContentType(packagePartNames, contentTypes, CONTENT_TYPES.workbook),
    [workbookPart.name],
    "Workbook content types",
  );

  const workbookRelationships = relationshipsBySource.get(workbookPart.name);
  if (!workbookRelationships) throw new Error("Workbook is missing its relationship part.");
  const workbook = parseWorkbook(workbookPart, factBudgets, metrics);
  assertSameIdentitySet(
    workbookRelationships.filter((item) => relationshipHasType(item, "worksheet")).map((item) => item.id),
    workbook.sheets.map((sheet) => sheet.relationshipId),
    "Workbook worksheet relationships",
  );
  const workbookRelationshipById = new Map(workbookRelationships.map((item) => [item.id, item]));
  const worksheetPartNames = new Set();
  const sheetIdentities = workbook.sheets.map((sheet) => {
    const relationship = workbookRelationshipById.get(sheet.relationshipId);
    if (!relationship || !relationshipHasType(relationship, "worksheet") || relationship.targetMode !== "Internal") {
      throw new Error(`Workbook sheet ${sheet.name} is not bound to one internal worksheet relationship.`);
    }
    if (worksheetPartNames.has(relationship.resolvedPartName)) {
      throw new Error(`Workbook worksheet part is reused by multiple non-equivalent sheet identities: ${relationship.resolvedPartName}`);
    }
    if (!CONTENT_TYPES.worksheet.has(contentTypeFor(relationship.resolvedPartName, contentTypes))) {
      throw new Error(`Workbook sheet ${sheet.name} target has the wrong worksheet content type.`);
    }
    worksheetPartNames.add(relationship.resolvedPartName);
    const part = partByName.get(relationship.resolvedPartName);
    if (!part) throw new Error(`Workbook sheet ${sheet.name} target is not structural XML.`);
    return {
      ...sheet,
      partName: relationship.resolvedPartName,
      partSha256: part.sha256,
    };
  });
  const worksheetCoreParts = new Set(partsWithContentType(packagePartNames, contentTypes, CONTENT_TYPES.worksheet));
  for (const name of packagePartNames) {
    if (/^xl\/worksheets\/[^/]+\.xml$/iu.test(name)) worksheetCoreParts.add(name);
  }
  assertSameIdentitySet(
    worksheetCoreParts,
    worksheetPartNames,
    "Orphan worksheet core parts",
  );

  const stylesRelationship = requireSingleRelationship(
    workbookRelationships,
    "styles",
    "Workbook relationships",
    { optional: true },
  );
  const sharedStringsRelationship = requireSingleRelationship(
    workbookRelationships,
    "sharedStrings",
    "Workbook relationships",
    { optional: true },
  );
  const stylesCoreParts = new Set(partsWithContentType(packagePartNames, contentTypes, CONTENT_TYPES.styles));
  if (packagePartNames.has("xl/styles.xml")) stylesCoreParts.add("xl/styles.xml");
  if (stylesRelationship && !CONTENT_TYPES.styles.has(contentTypeFor(stylesRelationship.resolvedPartName, contentTypes))) {
    throw new Error("Workbook styles relationship target has the wrong styles content type.");
  }
  assertSameIdentitySet(
    stylesCoreParts,
    stylesRelationship ? [stylesRelationship.resolvedPartName] : [],
    "Orphan styles core parts",
  );
  const sharedStringsCoreParts = new Set(
    partsWithContentType(packagePartNames, contentTypes, CONTENT_TYPES.sharedStrings),
  );
  if (packagePartNames.has("xl/sharedStrings.xml")) sharedStringsCoreParts.add("xl/sharedStrings.xml");
  if (
    sharedStringsRelationship
    && !CONTENT_TYPES.sharedStrings.has(contentTypeFor(sharedStringsRelationship.resolvedPartName, contentTypes))
  ) {
    throw new Error("Workbook sharedStrings relationship target has the wrong shared strings content type.");
  }
  assertSameIdentitySet(
    sharedStringsCoreParts,
    sharedStringsRelationship ? [sharedStringsRelationship.resolvedPartName] : [],
    "Shared strings content types",
  );

  let parsedStyles = null;
  let styles = null;
  if (stylesRelationship) {
    const part = partByName.get(stylesRelationship.resolvedPartName);
    if (!part) throw new Error("Workbook styles relationship does not identify structural XML.");
    parsedStyles = parseStyles(part, factBudgets, metrics);
    styles = {
      partName: part.name,
      partSha256: part.sha256,
      customNumberFormats: parsedStyles.customNumberFormats,
      cellFormats: parsedStyles.cellFormats,
    };
  }

  let parsedSharedStrings = null;
  let sharedStrings = null;
  if (sharedStringsRelationship) {
    const part = partByName.get(sharedStringsRelationship.resolvedPartName);
    if (!part) throw new Error("Workbook sharedStrings relationship does not identify structural XML.");
    parsedSharedStrings = parseSharedStrings(part, factBudgets, metrics);
    sharedStrings = {
      partName: part.name,
      partSha256: part.sha256,
      count: parsedSharedStrings.count,
      uniqueCount: parsedSharedStrings.uniqueCount,
      items: parsedSharedStrings.items,
    };
  }

  const worksheets = sheetIdentities.map((identity) => parseWorksheet(
    partByName.get(identity.partName),
    identity,
    parsedStyles,
    parsedSharedStrings,
    factBudgets,
    metrics,
  ));

  await assertStableFileSnapshotCurrent(stableSnapshot);
  const body = {
    kind: "workbook-ooxml-facts-v1",
    source: {
      size: stableSnapshot.size,
      sha256: stableSnapshot.sha256,
    },
    package: {
      workbookPartName: workbookPart.name,
      nonStructuralPartNames: workbookSnapshot.parts
        .filter((part) => !part.directory && !part.structural)
        .map((part) => part.name)
        .sort((left, right) => left.localeCompare(right, "en")),
      structuralParts: structuralMetadata.map((metadata) => {
        const part = partByName.get(metadata.name);
        return {
          name: metadata.name,
          uncompressedSize: metadata.uncompressedSize,
          sha256: part.sha256,
        };
      }),
      relationships,
    },
    workbook: {
      date1904: workbook.date1904,
      definedNames: workbook.definedNames,
      opaqueControlledPaths: workbook.opaqueControlledPaths,
      sheets: sheetIdentities,
    },
    styles,
    sharedStrings,
    worksheets,
  };
  const facts = {
    ...body,
    factsDigest: canonicalDigest(body),
  };
  return deepFreeze(facts);
}
