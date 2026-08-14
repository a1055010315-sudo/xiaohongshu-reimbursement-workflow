import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCES = path.resolve(HERE, "..", "references");
const PROFILE_ALIASES = new Map([["xhs", "xiaohongshu"]]);
const REQUIRED_COLUMNS = ["A", "B", "C", "D", "E", "F"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const CELL_REF = /^\$?([A-Z]{1,3})\$?(\d+)$/;
const RANGE_REF = /^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/;

let packagesPromise;
let contractsPromise;

export function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

export function digestObject(value) {
  return sha256Bytes(Buffer.from(stableJson(value), "utf8"));
}

export async function readJson(filePath, field = "JSON file") {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Unable to read ${field}: ${cleanError(error)}`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${field} must be valid UTF-8 JSON: ${cleanError(error)}`);
  }
}

async function loadPackage(name) {
  const require = createRequire(import.meta.url);
  let resolved;
  try {
    resolved = require.resolve(name);
  } catch {
    throw new Error(`${name} is unavailable; run with the bundled Node runtime and workspace dependencies.`);
  }
  return import(pathToFileURL(resolved).href);
}

export async function packages() {
  packagesPromise ??= Promise.all([
    loadPackage("@oai/artifact-tool"),
    loadPackage("jszip").then((module) => module.default ?? module),
  ]).then(([artifact, JSZip]) => ({ artifact, JSZip }));
  return packagesPromise;
}

export async function loadContracts() {
  contractsPromise ??= Promise.all([
    fs.readFile(path.join(REFERENCES, "ledger-profiles.json")),
    fs.readFile(path.join(REFERENCES, "workbook-style-contract.json")),
  ]).then(([profileBytes, styleBytes]) => {
    let profileConfig;
    let styleContract;
    try {
      profileConfig = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(profileBytes));
      styleContract = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(styleBytes));
    } catch (error) {
      throw new Error(`Workbook contracts must be valid UTF-8 JSON: ${cleanError(error)}`);
    }
    if (profileConfig?.schemaVersion !== 1 || styleContract?.schemaVersion !== 1) {
      throw new Error("Unsupported workbook profile/style contract version.");
    }
    const order = profileConfig.profileOrder;
    if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== order.length) {
      throw new Error("ledger-profiles.profileOrder must contain three unique profiles.");
    }
    for (const id of order) {
      if (!profileConfig.profiles?.[id]) throw new Error(`Missing ledger profile: ${id}`);
      if (styleContract.allowedProfileOverrides?.[id] !== profileConfig.profiles[id].themeOverride) {
        throw new Error(`Profile/style theme mismatch for ${id}.`);
      }
    }
    if (stableJson(profileConfig.semanticColumns) !== stableJson(styleContract.semanticColumns)) {
      throw new Error("Profile and style semantic column contracts disagree.");
    }
    return {
      profileConfig,
      styleContract,
      profileConfigDigest: sha256Bytes(profileBytes),
      styleContractDigest: sha256Bytes(styleBytes),
    };
  });
  return contractsPromise;
}

export function canonicalProfileId(value, profileConfig) {
  if (typeof value !== "string" || !value.trim()) throw new Error("profile id must be a non-empty string.");
  const raw = value.trim();
  const normalized = PROFILE_ALIASES.get(raw) ?? profileConfig.aliases?.[raw] ?? raw;
  if (!profileConfig.profiles?.[normalized]) throw new Error(`Unsupported reimbursement profile: ${raw}`);
  return normalized;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a non-empty string without control whitespace.`);
  }
  return value.trim();
}

function validIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseAmount(value, field) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !DECIMAL.test(text)) {
    throw new Error(`${field} must be a decimal with at most three places.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const numeric = Number(text);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > 9_000_000_000_000) throw new Error(`${field} is out of range.`);
  const milliunits = BigInt(whole) * 1000n + BigInt(`${whole.startsWith("-") ? "-" : ""}${(fraction + "000").slice(0, 3)}` || "0");
  if (milliunits === 0n && text.startsWith("-")) throw new Error(`${field} must not be negative zero.`);
  return { text, numeric, decimals: fraction.length === 3 ? 3 : fraction.length === 0 ? 0 : 2, milliunits };
}

export function normalizeTransactions(rawTransactions, profileId) {
  if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
    throw new Error(`profiles.${profileId}.transactions must be a non-empty array.`);
  }
  const ids = new Set();
  const sourceOrders = new Set();
  return rawTransactions.map((raw, index) => {
    const item = requireObject(raw, `profiles.${profileId}.transactions[${index}]`);
    const id = requireString(item.id ?? `TX-${index + 1}`, `transactions[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate transaction id in ${profileId}: ${id}`);
    ids.add(id);
    const date = requireString(item.date, `transactions[${index}].date`);
    if (!validIsoDate(date)) throw new Error(`transactions[${index}].date must be a valid ISO date.`);
    const amount = parseAmount(item.amount, `transactions[${index}].amount`);
    const sourceOrder = item.sourceOrder ?? index + 1;
    if (!Number.isSafeInteger(sourceOrder) || sourceOrder < 1) throw new Error(`transactions[${index}].sourceOrder must be a positive safe integer.`);
    if (sourceOrders.has(sourceOrder)) throw new Error(`Duplicate sourceOrder in ${profileId}: ${sourceOrder}`);
    sourceOrders.add(sourceOrder);
    const project = requireString(item.project ?? item.description, `transactions[${index}].project`);
    const person = requireString(item.personOrSubject ?? item.person ?? item.subject, `transactions[${index}].personOrSubject`);
    const classification = requireString(item.classification ?? item.category ?? item.note, `transactions[${index}].classification`);
    const rowType = requireString(item.rowType ?? "expense", `transactions[${index}].rowType`);
    if (rowType !== "expense") throw new Error(`transactions[${index}].rowType must be expense in the normal reimbursement workflow.`);
    const settlement = requireString(item.settlement ?? "employee_reimbursement", `transactions[${index}].settlement`);
    if (!["employee_reimbursement", "company_paid_no_reimbursement"].includes(settlement)) {
      throw new Error(`transactions[${index}].settlement is unsupported.`);
    }
    const expectedSettlementDisplay = settlement === "employee_reimbursement" ? "待报销" : "对公已付，不实报";
    const settlementDisplay = requireString(item.settlementDisplay ?? expectedSettlementDisplay, `transactions[${index}].settlementDisplay`);
    if (settlementDisplay !== expectedSettlementDisplay) {
      throw new Error(`transactions[${index}].settlementDisplay must be derived from settlement.`);
    }
    return { id, date, project, amount: amount.text, amountNumber: amount.numeric, decimals: amount.decimals, person, classification, rowType, settlement, settlementDisplay, sourceOrder };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.sourceOrder - right.sourceOrder);
}

export async function normalizeBatchPlan(rawPlan) {
  const plan = requireObject(rawPlan, "batch plan");
  if (plan.version !== 1) throw new Error("batch plan.version must be 1.");
  const { profileConfig, styleContract, profileConfigDigest, styleContractDigest } = await loadContracts();
  const rawIds = plan.affectedProfiles ?? Object.keys(requireObject(plan.profiles, "batch plan.profiles"));
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 3) throw new Error("affectedProfiles must contain one to three profile ids.");
  const affectedProfiles = [...new Set(rawIds.map((id) => canonicalProfileId(id, profileConfig)))]
    .sort((a, b) => profileConfig.profileOrder.indexOf(a) - profileConfig.profileOrder.indexOf(b));
  if (affectedProfiles.length !== rawIds.length) throw new Error("affectedProfiles must not contain aliases for the same profile twice.");
  const rawProfiles = requireObject(plan.profiles, "batch plan.profiles");
  const normalizedProfileKeys = Object.keys(rawProfiles).map((key) => canonicalProfileId(key, profileConfig));
  if (new Set(normalizedProfileKeys).size !== normalizedProfileKeys.length) {
    throw new Error("profiles must not contain aliases for the same profile twice.");
  }
  const suppliedProfiles = normalizedProfileKeys
    .sort((a, b) => profileConfig.profileOrder.indexOf(a) - profileConfig.profileOrder.indexOf(b));
  if (
    suppliedProfiles.length !== affectedProfiles.length ||
    suppliedProfiles.some((profileId, index) => profileId !== affectedProfiles[index])
  ) {
    throw new Error("profiles keys must exactly match affectedProfiles; extra or missing profiles are forbidden.");
  }
  const profiles = {};
  for (const profileId of affectedProfiles) {
    const aliases = Object.entries(rawProfiles).filter(([key]) => canonicalProfileId(key, profileConfig) === profileId);
    if (aliases.length !== 1) throw new Error(`profiles must contain exactly one entry for ${profileId}.`);
    const item = requireObject(aliases[0][1], `profiles.${profileId}`);
    const baselinePath = path.resolve(requireString(item.baselinePath, `profiles.${profileId}.baselinePath`));
    const candidatePath = path.resolve(requireString(item.candidatePath ?? item.outputPath, `profiles.${profileId}.candidatePath`));
    if (!path.isAbsolute(item.baselinePath) || !path.isAbsolute(item.candidatePath ?? item.outputPath)) {
      throw new Error(`${profileId} baselinePath/candidatePath must be absolute.`);
    }
    if (baselinePath.toLowerCase() === candidatePath.toLowerCase()) throw new Error(`${profileId} baselinePath and candidatePath must differ.`);
    if (path.extname(baselinePath).toLowerCase() !== ".xlsx" || path.extname(candidatePath).toLowerCase() !== ".xlsx") {
      throw new Error(`${profileId} baselinePath/candidatePath must be .xlsx files.`);
    }
    const config = profileConfig.profiles[profileId];
    if (!config.rootWorkbookNames.includes(path.basename(baselinePath))) {
      throw new Error(`${profileId} baseline filename is outside the profile whitelist.`);
    }
    const allowedDirectory = config.profileDirectory ?? profileConfig.profileDirectories?.[profileId];
    if (allowedDirectory && path.basename(path.dirname(baselinePath)) !== allowedDirectory) {
      throw new Error(`${profileId} baseline parent directory is outside the profile whitelist.`);
    }
    const transactions = normalizeTransactions(item.transactions, profileId);
    const candidateRevision = item.candidateRevision ?? 1;
    let detailPath = null;
    if (item.detailPath !== undefined) {
      detailPath = path.resolve(requireString(item.detailPath, `${profileId}.detailPath`));
      if (!path.isAbsolute(item.detailPath) || path.extname(detailPath).toLowerCase() !== ".xlsx") throw new Error(`${profileId}.detailPath must be an absolute .xlsx path.`);
      if (detailPath.toLowerCase() === baselinePath.toLowerCase() || detailPath.toLowerCase() === candidatePath.toLowerCase()) throw new Error(`${profileId}.detailPath must be distinct from baseline/candidate.`);
    }
    if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 1) throw new Error(`${profileId}.candidateRevision must be a positive safe integer.`);
    const rawControl = item.controlledSegment ?? {
      startRow: item.controlledSegmentStartRow ?? item.rebuildStartRow ?? item.appendStartRow,
      startDate: item.controlledSegmentStartDate,
      endRow: item.controlledSegmentEndRow,
    };
    if (!rawControl || typeof rawControl !== "object" || Array.isArray(rawControl)) throw new Error(`${profileId}.controlledSegment must be an object.`);
    const controlledSegment = {};
    if (rawControl.startRow !== undefined) {
      if (!Number.isSafeInteger(rawControl.startRow) || rawControl.startRow < 2) throw new Error(`${profileId}.controlledSegment.startRow must be a safe integer >= 2.`);
      controlledSegment.startRow = rawControl.startRow;
    }
    if (rawControl.startDate !== undefined) {
      const startDate = requireString(rawControl.startDate, `${profileId}.controlledSegment.startDate`);
      if (!validIsoDate(startDate)) throw new Error(`${profileId}.controlledSegment.startDate must be a valid ISO date.`);
      controlledSegment.startDate = startDate;
    }
    if (rawControl.endRow !== undefined) {
      if (!Number.isSafeInteger(rawControl.endRow) || rawControl.endRow < 2) throw new Error(`${profileId}.controlledSegment.endRow must be a safe integer >= 2.`);
      controlledSegment.endRow = rawControl.endRow;
    }
    if (!controlledSegment.startRow && !controlledSegment.startDate) {
      throw new Error(`${profileId}.controlledSegment requires startRow or startDate; append-only construction is forbidden.`);
    }
    const titleYear = item.titleYear;
    if (titleYear !== undefined && (!Number.isSafeInteger(titleYear) || titleYear < 1900 || titleYear > 9999)) throw new Error(`${profileId}.titleYear must be a four-digit safe integer.`);
    const detailTitle = detailPath ? requireString(item.detailTitle ?? `${config.displayName}明细`, `${profileId}.detailTitle`) : null;
    const period = item.period === undefined || item.period === null ? null : requireString(item.period, `${profileId}.period`);
    profiles[profileId] = { profileId, baselinePath, candidatePath, detailPath, detailTitle, period, candidateRevision, transactions, controlledSegment, titleYear, config };
  }
  const digestInput = {
    version: 1,
    affectedProfiles,
    profiles: Object.fromEntries(affectedProfiles.map((id) => [id, {
      baselinePath: profiles[id].baselinePath,
      candidatePath: profiles[id].candidatePath,
      candidateRevision: profiles[id].candidateRevision,
      detailPath: profiles[id].detailPath,
      detailTitle: profiles[id].detailTitle,
      period: profiles[id].period,
      controlledSegment: profiles[id].controlledSegment,
      titleYear: profiles[id].titleYear ?? null,
      transactions: profiles[id].transactions.map(({ amountNumber, ...transaction }) => transaction),
    }])),
  };
  return { version: 1, batchId: plan.batchId ?? null, taskRoot: plan.taskRoot ?? null, affectedProfiles, profiles, profileConfig, styleContract, profileConfigDigest, styleContractDigest, planDigest: digestObject(digestInput) };
}

export function columnNumber(column) {
  let value = 0;
  for (const char of column) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

export function columnName(number) {
  let result = "";
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

export function parseRange(ref) {
  const match = RANGE_REF.exec(ref.replace(/\$/gu, "").toUpperCase());
  if (!match) throw new Error(`Invalid A1 range: ${ref}`);
  return { startCol: columnNumber(match[1]), startRow: Number(match[2]), endCol: columnNumber(match[3]), endRow: Number(match[4]) };
}

function decodeXml(value) {
  return value.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function encodeXml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function parseAttrs(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) result[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  return result;
}

function xmlBoolean(value) {
  if (value === undefined) return null;
  if (["1", "true"].includes(value)) return true;
  if (["0", "false"].includes(value)) return false;
  return `invalid:${value}`;
}

function canonicalXmlFragment(fragment) {
  let value = String(fragment ?? "")
    .replace(/^\uFEFF/u, "")
    .replace(/<\?xml\b[\s\S]*?\?>/gu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");
  value = value.replace(/<\s*\/\s*([\w:.-]+)\s*>/gu, (_, rawName) => `</${rawName}>`);
  value = value.replace(/<\s*([\w:.-]+)([^<>]*?)(\/?)\s*>/gu, (_, rawName, rawAttrs, selfClosing) => {
    const name = rawName;
    const attrs = Object.entries(parseAttrs(`<node ${rawAttrs}>`))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([attrName, attrValue]) => ` ${attrName}="${encodeXml(attrValue)}"`)
      .join("");
    return `<${name}${attrs}${selfClosing ? "/" : ""}>`;
  });
  return value.replace(/>\s+</gu, "><").trim();
}

function inlineStringSemantic(inner) {
  const match = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is\s*>/u.exec(inner);
  if (!match) return null;
  let body = match[1].replace(
    /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t\s*>/gu,
    (_, text) => `<t value="${encodeXml(decodeXml(text))}"/>`,
  );
  body = body.replace(/<(?:\w+:)?t\b[^>]*\/\s*>/gu, '<t value=""/>');
  return canonicalXmlFragment(`<is>${body}</is>`);
}

function normalizeTarget(base, target) {
  const normalized = target.replace(/\\/gu, "/");
  return normalized.startsWith("/") ? normalized.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(base), normalized));
}

function relationshipEntries(xml, base) {
  const result = [];
  for (const match of (xml ?? "").matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) {
    const attrs = parseAttrs(match[0]);
    const targetMode = attrs.TargetMode ?? "Internal";
    result.push({
      id: attrs.Id ?? "",
      type: attrs.Type ?? "",
      targetMode,
      target: !attrs.Target ? "" : targetMode === "External" ? attrs.Target : normalizeTarget(base, attrs.Target),
    });
  }
  return result;
}

function relationshipMap(xml, base) {
  return new Map(relationshipEntries(xml, base).filter((entry) => entry.id && entry.target).map((entry) => [entry.id, entry.target]));
}

function relationshipPartPath(partPath) {
  return path.posix.join(path.posix.dirname(partPath), "_rels", `${path.posix.basename(partPath)}.rels`);
}

function protectedFeatureSignature(xml) {
  const names = [
    "sheetPr", "sheetViews", "sheetFormatPr", "sheetProtection", "protectedRanges", "scenarios",
    "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "phoneticPr",
    "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins",
    "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches",
    "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "picture",
    "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
  ];
  const blocks = [];
  for (const name of names) {
    const expression = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?${name}\\s*>)`, "gu");
    for (const match of xml.matchAll(expression)) {
      blocks.push(`${name}:${match[0].replace(/>\s+</gu, "><").trim()}`);
    }
  }
  return digestObject(blocks);
}

async function relationshipClosureSignature(zip, startPart) {
  const visited = new Set();
  const entries = [];
  async function visit(sourcePart) {
    const normalizedSource = path.posix.normalize(sourcePart);
    if (visited.has(normalizedSource)) return;
    visited.add(normalizedSource);
    const relPath = relationshipPartPath(normalizedSource);
    const relXml = await zip.file(relPath)?.async("string");
    if (!relXml) return;
    for (const match of relXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) {
      const attrs = parseAttrs(match[0]);
      const targetMode = attrs.TargetMode ?? "Internal";
      const target = targetMode === "External" ? attrs.Target : normalizeTarget(normalizedSource, attrs.Target ?? "");
      const targetBytes = targetMode === "External" || !target ? null : await zip.file(target)?.async("nodebuffer");
      entries.push({
        source: normalizedSource,
        type: attrs.Type ?? "",
        target,
        targetMode,
        targetSha256: targetBytes ? sha256Bytes(targetBytes) : null,
      });
      if (targetBytes) await visit(target);
    }
  }
  await visit(startPart);
  return digestObject(entries.sort((left, right) => stableJson(left).localeCompare(stableJson(right))));
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si\s*>/gu)].map((match) => [...match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t\s*>/gu)].map((part) => decodeXml(part[1])).join(""));
}

function parseThemeColors(xml) {
  const block = /<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const colors = [];
  for (const match of block.matchAll(/<(?:\w+:)?(?:dk1|lt1|dk2|lt2|accent1|accent2|accent3|accent4|accent5|accent6|hlink|folHlink)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:dk1|lt1|dk2|lt2|accent1|accent2|accent3|accent4|accent5|accent6|hlink|folHlink)\s*>/gu)) {
    const srgb = /<(?:\w+:)?srgbClr\b[^>]*\/?\s*>/u.exec(match[1])?.[0];
    const system = /<(?:\w+:)?sysClr\b[^>]*\/?\s*>/u.exec(match[1])?.[0];
    colors.push((srgb ? parseAttrs(srgb).val : system ? parseAttrs(system).lastClr : null)?.toUpperCase() ?? null);
  }
  return colors;
}

function tintRgb(rgb, tint = 0) {
  if (!rgb || !/^[0-9A-F]{6}$/u.test(rgb)) return null;
  const apply = (value) => Math.max(0, Math.min(255, Math.round(tint < 0 ? value * (1 + tint) : value * (1 - tint) + 255 * tint)));
  const values = [0, 2, 4].map((index) => apply(Number.parseInt(rgb.slice(index, index + 2), 16)).toString(16).padStart(2, "0").toUpperCase());
  return `FF${values.join("")}`;
}

function effectiveColor(raw, themeColors) {
  if (!raw) return null;
  if (raw.rgb) return raw.rgb.length === 6 ? `FF${raw.rgb}` : raw.rgb;
  const themeRgb = raw.theme === null ? null : themeColors[raw.theme];
  return tintRgb(themeRgb, raw.tint ?? 0);
}

function parseStyles(xml, themeColors) {
  const numFmts = new Map([[0, "General"], [1, "0"], [2, "0.00"], [14, "m/d/yy"]]);
  const numFmtBlock = /<(?:\w+:)?numFmts\b[^>]*>([\s\S]*?)<\/(?:\w+:)?numFmts\s*>/u.exec(xml ?? "")?.[1] ?? "";
  for (const match of numFmtBlock.matchAll(/<(?:\w+:)?numFmt\b[^>]*\/?\s*>/gu)) {
    const attrs = parseAttrs(match[0]);
    if (attrs.numFmtId !== undefined) numFmts.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
  }
  const block = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const baseBlock = /<(?:\w+:)?cellStyleXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellStyleXfs\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const xfPattern = /<(?:\w+:)?xf\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?xf\s*>)/gu;
  const protectionSemantic = (attrs, inner) => {
    const tags = [...(inner ?? "").matchAll(/<(?:\w+:)?protection\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:\w+:)?protection\s*>)/gu)];
    return {
      applyProtection: xmlBoolean(attrs.applyProtection),
      nodes: tags.map((tag) => {
        const protectionAttrs = parseAttrs(tag[0]);
        return { locked: xmlBoolean(protectionAttrs.locked), hidden: xmlBoolean(protectionAttrs.hidden) };
      }),
    };
  };
  const baseXfs = [...baseBlock.matchAll(xfPattern)].map((match) => {
    const attrs = parseAttrs(`<xf ${match[1]}>`);
    return protectionSemantic(attrs, match[2] ?? "");
  });
  const fontsBlock = /<(?:\w+:)?fonts\b[^>]*>([\s\S]*?)<\/(?:\w+:)?fonts\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const fonts = [...fontsBlock.matchAll(/<(?:\w+:)?font\b[^>]*>([\s\S]*?)<\/(?:\w+:)?font\s*>/gu)].map((match) => {
    const body = match[1];
    const tag = (name) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*\\/?\\s*>`, "u").exec(body)?.[0];
    const name = tag("name");
    const size = tag("sz");
    const color = tag("color");
    const colorAttrs = color ? parseAttrs(color) : {};
    return {
      name: name ? parseAttrs(name).val ?? null : null,
      size: size ? Number(parseAttrs(size).val) : null,
      bold: /<(?:\w+:)?b\b[^>]*\/?\s*>/u.test(body),
      colorRaw: color ? { rgb: colorAttrs.rgb?.toUpperCase() ?? null, theme: colorAttrs.theme === undefined ? null : Number(colorAttrs.theme), tint: colorAttrs.tint === undefined ? null : Number(colorAttrs.tint) } : null,
    };
  });
  const fillsBlock = /<(?:\w+:)?fills\b[^>]*>([\s\S]*?)<\/(?:\w+:)?fills\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const fills = [...fillsBlock.matchAll(/<(?:\w+:)?fill\b[^>]*>([\s\S]*?)<\/(?:\w+:)?fill\s*>/gu)].map((match) => {
    const fg = /<(?:\w+:)?fgColor\b[^>]*\/?\s*>/u.exec(match[1])?.[0];
    if (!fg) return null;
    const attrs = parseAttrs(fg);
    return { rgb: attrs.rgb?.toUpperCase() ?? null, theme: attrs.theme === undefined ? null : Number(attrs.theme), tint: attrs.tint === undefined ? null : Number(attrs.tint) };
  });
  const bordersBlock = /<(?:\w+:)?borders\b[^>]*>([\s\S]*?)<\/(?:\w+:)?borders\s*>/u.exec(xml ?? "")?.[1] ?? "";
  const borders = [...bordersBlock.matchAll(/<(?:\w+:)?border\b[^>]*>([\s\S]*?)<\/(?:\w+:)?border\s*>/gu)].map((match) => {
    const body = match[1];
    return Object.fromEntries(["left", "right", "top", "bottom"].map((edge) => {
      const tag = new RegExp(`<(?:\\w+:)?${edge}\\b([^>]*)`, "u").exec(body);
      const style = tag ? parseAttrs(`<${edge} ${tag[1]}>`).style ?? null : null;
      return [edge, style === "none" ? null : style];
    }));
  });
  const styles = [];
  for (const match of block.matchAll(xfPattern)) {
    const attrs = parseAttrs(`<xf ${match[1]}>`);
    const alignmentTag = /<(?:\w+:)?alignment\b[^>]*\/?\s*>/u.exec(match[2] ?? "")?.[0];
    const alignment = alignmentTag ? parseAttrs(alignmentTag) : {};
    const fontId = Number(attrs.fontId ?? 0);
    const fillId = Number(attrs.fillId ?? 0);
    const xfId = Number(attrs.xfId ?? 0);
    const font = fonts[fontId] ?? null;
    if (font) font.color = effectiveColor(font.colorRaw, themeColors);
    const fill = fills[fillId] ?? null;
    styles.push({
      id: styles.length,
      numFmtId: Number(attrs.numFmtId ?? 0),
      numberFormat: numFmts.get(Number(attrs.numFmtId ?? 0)) ?? `numFmt:${attrs.numFmtId}`,
      fontId, fillId, borderId: Number(attrs.borderId ?? 0), xfId, font, fill: fill ? { ...fill, effectiveArgb: effectiveColor(fill, themeColors) } : null, border: borders[Number(attrs.borderId ?? 0)] ?? null,
      horizontal: alignment.horizontal ?? null,
      vertical: alignment.vertical ?? null,
      wrapText: ["1", "true"].includes(alignment.wrapText),
      shrinkToFit: ["1", "true"].includes(alignment.shrinkToFit),
      protection: protectionSemantic(attrs, match[2] ?? ""),
      baseProtection: baseXfs[xfId] ?? null,
    });
  }
  return styles.length ? styles : [{ id: 0, numberFormat: "General", horizontal: null, vertical: null, wrapText: false, shrinkToFit: false, fontId: 0, fillId: 0, borderId: 0, xfId: 0, protection: { applyProtection: null, nodes: [] }, baseProtection: null }];
}

function cellText(inner, attrs, strings) {
  if (attrs.t === "inlineStr") return [...inner.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t\s*>/gu)].map((match) => decodeXml(match[1])).join("");
  const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v\s*>/u.exec(inner)?.[1];
  if (v === undefined) return "";
  if (attrs.t === "s") return strings[Number(v)] ?? "";
  return decodeXml(v);
}

function parseSheet(name, sheetPath, xml, strings, styles) {
  const cells = new Map();
  const pattern = /<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?c>|<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*)\/>/gu;
  for (const match of xml.matchAll(pattern)) {
    const attrs = parseAttrs(`<c ${match[1] ?? match[3] ?? ""}>`);
    const ref = attrs.r?.replace(/\$/gu, "").toUpperCase();
    if (!ref || !CELL_REF.test(ref)) continue;
    const inner = match[2] ?? "";
    const formulaNode = /<(?:\w+:)?f\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?f\s*>)/u.exec(inner);
    const styleId = Number(attrs.s ?? 0);
    cells.set(ref, {
      ref,
      attrs,
      inner,
      value: cellText(inner, attrs, strings),
      formula: formulaNode ? decodeXml(formulaNode[2] ?? "").trim() : null,
      formulaAttrs: formulaNode ? parseAttrs(`<f ${formulaNode[1]}>`) : null,
      formulaPresent: Boolean(formulaNode),
      inlineStringSemantic: inlineStringSemantic(inner),
      styleId,
      style: styles[styleId] ?? styles[0],
      hasPayload: /<(?:\w+:)?(?:v|f|is|t)\b/iu.test(inner),
    });
  }
  const merges = [...xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\/?\s*>/gu)].map((match) => parseAttrs(match[0]).ref?.replace(/\$/gu, "").toUpperCase()).filter(Boolean);
  const rows = new Map();
  for (const match of xml.matchAll(/<(?:\w+:)?row\b[^>]*>/gu)) {
    const attrs = parseAttrs(match[0]);
    if (attrs.r) rows.set(Number(attrs.r), { height: attrs.ht === undefined ? null : Number(attrs.ht), customHeight: ["1", "true"].includes(attrs.customHeight), hidden: ["1", "true"].includes(attrs.hidden) });
  }
  const columns = [];
  for (const match of xml.matchAll(/<(?:\w+:)?col\b[^>]*\/?\s*>/gu)) {
    const attrs = parseAttrs(match[0]);
    columns.push({ min: Number(attrs.min), max: Number(attrs.max), width: attrs.width === undefined ? null : Number(attrs.width), hidden: ["1", "true"].includes(attrs.hidden) });
  }
  const pageBreakRows = new Set([...xml.matchAll(/<(?:\w+:)?brk\b[^>]*\/?\s*>/gu)].map((match) => Number(parseAttrs(match[0]).id)).filter(Number.isFinite));
  const usedRows = [...cells.keys()].map((ref) => Number(CELL_REF.exec(ref)?.[2] ?? 0));
  const cellMetadataSignature = digestObject([...cells.values()].map((cell) => ({
    ref: cell.ref,
    attrs: cell.attrs,
    value: cell.value,
    formula: cell.formulaPresent ? { attrs: cell.formulaAttrs, text: cell.formula } : null,
    inlineString: cell.inlineStringSemantic,
  })).sort((left, right) => left.ref.localeCompare(right.ref)));
  const styleProtectionSignature = digestObject([...cells.values()].map((cell) => ({
    ref: cell.ref,
    styleId: cell.styleId,
    xfId: cell.style.xfId,
    protection: cell.style.protection,
    baseProtection: cell.style.baseProtection,
  })).sort((left, right) => left.ref.localeCompare(right.ref)));
  return {
    name,
    path: sheetPath,
    xml,
    xmlSha256: sha256Bytes(Buffer.from(xml, "utf8")),
    cellMetadataSignature,
    styleProtectionSignature,
    cells,
    merges,
    rows,
    columns,
    pageBreakRows,
    maxUsedRow: usedRows.length ? Math.max(...usedRows) : 0,
  };
}

async function packagePartInventory(zip) {
  const files = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  const pairs = await Promise.all(files.map(async ([name, entry]) => [name.replace(/\\/gu, "/").replace(/^\/+/, ""), sha256Bytes(await entry.async("nodebuffer"))]));
  pairs.sort(([left], [right]) => left.localeCompare(right));
  const result = {};
  for (const [name, digest] of pairs) {
    if (Object.hasOwn(result, name)) throw new Error(`Workbook ZIP contains duplicate normalized part path: ${name}.`);
    result[name] = digest;
  }
  return result;
}

export async function readWorkbookMetadata(filePath) {
  const { JSZip } = await packages();
  const bytes = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(bytes);
  const rootRels = await zip.file("_rels/.rels")?.async("string");
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const workbookRels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!rootRels || !workbookXml || !workbookRels) throw new Error("Workbook OOXML metadata is incomplete.");
  const rels = relationshipMap(workbookRels, "xl/workbook.xml");
  const strings = sharedStrings(await zip.file("xl/sharedStrings.xml")?.async("string"));
  const stylesXml = await zip.file("xl/styles.xml")?.async("string");
  const themeXml = await zip.file("xl/theme/theme1.xml")?.async("string");
  const styles = parseStyles(stylesXml, parseThemeColors(themeXml));
  const packageParts = await packagePartInventory(zip);
  const sheets = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?\s*>/gu)) {
    const attrs = parseAttrs(match[0]);
    const sheetPath = rels.get(attrs["r:id"]);
    const xml = sheetPath ? await zip.file(sheetPath)?.async("string") : null;
    if (!attrs.name || !sheetPath || !xml) throw new Error("Workbook sheet relationship is incomplete.");
    const sheet = parseSheet(attrs.name, sheetPath, xml, strings, styles);
    sheet.protectedFeatureSignature = protectedFeatureSignature(xml);
    sheet.relationshipClosureSignature = await relationshipClosureSignature(zip, sheetPath);
    sheets.push(sheet);
  }
  const definedNames = [];
  for (const match of workbookXml.matchAll(/<(?:\w+:)?definedName\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?definedName\s*>/gu)) {
    const attrs = parseAttrs(`<definedName ${match[1]}>`);
    definedNames.push({ name: attrs.name ?? "", localSheetId: attrs.localSheetId === undefined ? null : Number(attrs.localSheetId), value: decodeXml(match[2].replace(/<[^>]+>/gu, "")) });
  }
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904=(?:"(?:1|true)"|'(?:1|true)')/iu.test(workbookXml);
  return {
    filePath: path.resolve(filePath),
    bytesSha256: sha256Bytes(bytes),
    zip,
    packageParts,
    rootRels,
    workbookXml,
    workbookRels,
    stylesXml,
    styles,
    sheets,
    definedNames,
    date1904,
  };
}

function replaceWorksheetNode(xml, name, replacement) {
  const expression = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/(?:\\w+:)?${name}\\s*>)`, "gu");
  return xml.replace(expression, replacement);
}

function documentPrefix(xml, rootName) {
  return new RegExp(`<((?:\\w+:)?)${rootName}\\b`, "u").exec(xml)?.[1] ?? "";
}

function applyFreezePane(xml, freezeRow) {
  const prefix = documentPrefix(xml, "worksheet");
  const pane = `<${prefix}pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/>`;
  const selection = `<${prefix}selection pane="bottomLeft" activeCell="A${freezeRow + 1}" sqref="A${freezeRow + 1}"/>`;
  const viewsExpression = /<(?:\w+:)?sheetViews\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheetViews\s*>/u;
  const viewsMatch = viewsExpression.exec(xml);
  if (!viewsMatch) {
    const block = `<${prefix}sheetViews><${prefix}sheetView workbookViewId="0">${pane}${selection}</${prefix}sheetView></${prefix}sheetViews>`;
    const sheetPr = /<(?:\w+:)?sheetPr\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetPr\s*>)/u.exec(xml);
    const offset = sheetPr ? sheetPr.index + sheetPr[0].length : /<(?:\w+:)?worksheet\b[^>]*>/u.exec(xml)[0].length;
    return `${xml.slice(0, offset)}${block}${xml.slice(offset)}`;
  }
  let block = viewsMatch[0].replace(/<(?:\w+:)?pane\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?pane\s*>)/gu, "");
  block = block.replace(/<(?:\w+:)?selection\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?selection\s*>)/gu, "");
  const selfClosingView = /<((?:\w+:)?sheetView)\b([^>]*)\/\s*>/u.exec(block);
  if (selfClosingView) {
    block = block.replace(selfClosingView[0], `<${selfClosingView[1]}${selfClosingView[2]}>${pane}${selection}</${selfClosingView[1]}>`);
  } else {
    block = block.replace(/(<(?:\w+:)?sheetView\b[^>]*>)/u, `$1${pane}${selection}`);
  }
  return `${xml.slice(0, viewsMatch.index)}${block}${xml.slice(viewsMatch.index + viewsMatch[0].length)}`;
}

function applyFitToPageProperty(xml) {
  const prefix = documentPrefix(xml, "worksheet");
  const pageSetupProperty = `<${prefix}pageSetUpPr fitToPage="1"/>`;
  const expression = /<(?:\w+:)?sheetPr\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetPr\s*>)/u;
  const match = expression.exec(xml);
  let block;
  if (!match) {
    block = `<${prefix}sheetPr>${pageSetupProperty}</${prefix}sheetPr>`;
    const opening = /<(?:\w+:)?worksheet\b[^>]*>/u.exec(xml);
    return `${xml.slice(0, opening.index + opening[0].length)}${block}${xml.slice(opening.index + opening[0].length)}`;
  }
  block = match[0].replace(/<(?:\w+:)?pageSetUpPr\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?pageSetUpPr\s*>)/gu, "");
  const sheetPrName = /<((?:\w+:)?sheetPr)\b/u.exec(block)?.[1] ?? `${prefix}sheetPr`;
  if (/\/\s*>$/u.test(block)) block = block.replace(/\/\s*>$/u, `>${pageSetupProperty}</${sheetPrName}>`);
  else block = block.replace(/<\/(?:\w+:)?sheetPr\s*>$/u, `${pageSetupProperty}</${sheetPrName}>`);
  return `${xml.slice(0, match.index)}${block}${xml.slice(match.index + match[0].length)}`;
}

function applyPrintNodes(xml) {
  for (const name of ["printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks"]) xml = replaceWorksheetNode(xml, name, "");
  const prefix = documentPrefix(xml, "worksheet");
  const block = `<${prefix}printOptions horizontalCentered="1" headings="0" gridLines="0"/><${prefix}pageMargins left="0.3" right="0.3" top="0.3" bottom="0.3" header="0.15" footer="0.15"/><${prefix}pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><${prefix}headerFooter><${prefix}oddFooter>&amp;8第 &amp;P 页 / 共 &amp;N 页</${prefix}oddFooter></${prefix}headerFooter>`;
  const anchor = /<(?:\w+:)?(?:customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/gu.exec(xml);
  const offset = anchor?.index ?? xml.search(/<\/(?:\w+:)?worksheet\s*>/u);
  return `${xml.slice(0, offset)}${block}${xml.slice(offset)}`;
}

function upsertPrintDefinedNames(workbookXml, sheetName, sheetIndex, headerRow, endRow) {
  const prefix = documentPrefix(workbookXml, "workbook");
  const retained = [];
  const expression = /<(?:\w+:)?definedName\b([^>]*)>[\s\S]*?<\/(?:\w+:)?definedName\s*>/gu;
  let match;
  let cursor = 0;
  while ((match = expression.exec(workbookXml))) {
    retained.push(workbookXml.slice(cursor, match.index));
    const attrs = parseAttrs(`<definedName ${match[1]}>`);
    const targeted = ["_xlnm.Print_Area", "_xlnm.Print_Titles"].includes(attrs.name) && Number(attrs.localSheetId) === sheetIndex;
    if (!targeted) retained.push(match[0]);
    cursor = match.index + match[0].length;
  }
  retained.push(workbookXml.slice(cursor));
  workbookXml = retained.join("");
  const quoted = `'${sheetName.replace(/'/gu, "''")}'`;
  const names = `<${prefix}definedName name="_xlnm.Print_Area" localSheetId="${sheetIndex}">${encodeXml(`${quoted}!$A$1:$F$${endRow}`)}</${prefix}definedName><${prefix}definedName name="_xlnm.Print_Titles" localSheetId="${sheetIndex}">${encodeXml(`${quoted}!$${headerRow}:$${headerRow}`)}</${prefix}definedName>`;
  const container = /<(?:\w+:)?definedNames\b[^>]*>[\s\S]*?<\/(?:\w+:)?definedNames\s*>/u.exec(workbookXml);
  if (container) {
    const containerName = /<((?:\w+:)?definedNames)\b/u.exec(container[0])?.[1] ?? `${prefix}definedNames`;
    const block = container[0].replace(/<\/(?:\w+:)?definedNames\s*>$/u, `${names}</${containerName}>`);
    return `${workbookXml.slice(0, container.index)}${block}${workbookXml.slice(container.index + container[0].length)}`;
  }
  const offset = workbookXml.search(/<(?:\w+:)?calcPr\b|<\/(?:\w+:)?workbook\s*>/u);
  return `${workbookXml.slice(0, offset)}<${prefix}definedNames>${names}</${prefix}definedNames>${workbookXml.slice(offset)}`;
}

export async function applyWorkbookDisplayContract(workbookPath, sheetName, headerRow, endRow) {
  const { JSZip } = await packages();
  const bytes = await fs.readFile(workbookPath);
  const zip = await JSZip.loadAsync(bytes);
  const metadata = await readWorkbookMetadata(workbookPath);
  const sheetIndex = metadata.sheets.findIndex((sheet) => sheet.name === sheetName);
  if (sheetIndex < 0) throw new Error(`Display contract cannot resolve sheet ${sheetName}.`);
  const sheetPath = metadata.sheets[sheetIndex].path;
  let xml = await zip.file(sheetPath)?.async("string");
  let workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!xml || !workbookXml) throw new Error("Display contract cannot read workbook OOXML.");
  xml = applyFitToPageProperty(xml);
  xml = applyFreezePane(xml, headerRow);
  xml = applyPrintNodes(xml);
  workbookXml = upsertPrintDefinedNames(workbookXml, sheetName, sheetIndex, headerRow, endRow);
  zip.file(sheetPath, xml);
  zip.file("xl/workbook.xml", workbookXml);
  await fs.writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export function displayContractFailures(metadata, sheet, headerRow, endRow) {
  const failures = [];
  const pane = /<(?:\w+:)?pane\b[^>]*\/?>/u.exec(sheet.xml);
  const paneAttrs = pane ? parseAttrs(pane[0]) : {};
  if (Number(paneAttrs.ySplit) !== headerRow || paneAttrs.topLeftCell !== `A${headerRow + 1}` || paneAttrs.state !== "frozen") failures.push("freeze-pane");
  const setupPr = /<(?:\w+:)?pageSetUpPr\b[^>]*\/?>/u.exec(sheet.xml);
  if (!setupPr || !["1", "true"].includes(parseAttrs(setupPr[0]).fitToPage)) failures.push("fit-to-page-mode");
  const setup = /<(?:\w+:)?pageSetup\b[^>]*\/?>/u.exec(sheet.xml);
  const setupAttrs = setup ? parseAttrs(setup[0]) : {};
  if (setupAttrs.paperSize !== "9" || setupAttrs.orientation !== "landscape" || setupAttrs.fitToWidth !== "1" || setupAttrs.fitToHeight !== "0") failures.push("page-setup");
  const options = /<(?:\w+:)?printOptions\b[^>]*\/?>/u.exec(sheet.xml);
  if (!options || !["1", "true"].includes(parseAttrs(options[0]).horizontalCentered)) failures.push("print-options");
  if (!/<(?:\w+:)?pageMargins\b/u.test(sheet.xml) || !/<(?:\w+:)?headerFooter\b/u.test(sheet.xml)) failures.push("print-margins-footer");
  if (/<(?:\w+:)?(?:rowBreaks|colBreaks)\b/u.test(sheet.xml)) failures.push("manual-page-breaks");
  const sheetIndex = metadata.sheets.findIndex((candidate) => candidate.name === sheet.name);
  const quoted = `'${sheet.name.replace(/'/gu, "''")}'`;
  const definedNames = Array.isArray(metadata.definedNames) ? metadata.definedNames : [];
  const area = definedNames.find((item) => item.name === "_xlnm.Print_Area" && item.localSheetId === sheetIndex)?.value;
  const titles = definedNames.find((item) => item.name === "_xlnm.Print_Titles" && item.localSheetId === sheetIndex)?.value;
  if (area !== `${quoted}!$A$1:$F$${endRow}`) failures.push("print-area");
  if (titles !== `${quoted}!$${headerRow}:$${headerRow}`) failures.push("print-titles");
  return failures;
}

export function excelDateToIso(value, date1904 = false) {
  const serial = Number(value);
  if (!Number.isFinite(serial)) return null;
  const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
  // The ledger stores business dates, not datetimes.  Excel serials may still
  // contain a time fraction; rounding would move every value after noon into
  // the following day and could silently reorder a reimbursement.
  return new Date(epoch + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function dateFromCell(cell, metadata, yearHint) {
  if (!cell || cell.value === "") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(cell.value)) return excelDateToIso(cell.value, metadata.date1904);
  const text = cell.value.trim();
  if (validIsoDate(text)) return text;
  const full = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/u.exec(text);
  const short = /^(\d{1,2})[./-](\d{1,2})$/u.exec(text);
  const candidate = full
    ? `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`
    : short && yearHint
      ? `${yearHint}-${short[1].padStart(2, "0")}-${short[2].padStart(2, "0")}`
      : null;
  return candidate && validIsoDate(candidate) ? candidate : null;
}

function coveringMerge(sheet, column, row) {
  const number = columnNumber(column);
  return sheet.merges.map((ref) => ({ ref, range: parseRange(ref) })).find(({ range }) => range.startCol === number && range.endCol === number && row >= range.startRow && row <= range.endRow) ?? null;
}

function inheritedCell(sheet, column, row) {
  const cell = cellAt(sheet, column, row);
  if (cell.value !== "" || cell.formula !== null) return cell;
  const merge = coveringMerge(sheet, column, row);
  return merge ? cellAt(sheet, column, merge.range.startRow) : cell;
}

function businessRecordAt(metadata, sheet, row, yearHint) {
  const project = cellAt(sheet, "B", row).value.trim();
  const amountCell = cellAt(sheet, "C", row);
  if (amountCell.value === "" || !Number.isFinite(Number(amountCell.value))) return null;
  const date = dateFromCell(inheritedCell(sheet, "A", row), metadata, yearHint);
  const amount = parseAmount(Number(amountCell.value), `${sheet.name}!C${row}`);
  const person = inheritedCell(sheet, "E", row).value.trim();
  const classification = inheritedCell(sheet, "F", row).value.trim();
  if (!person || !classification) throw new Error(`Unable to inherit person/classification at ${sheet.name}!${row}.`);
  const dMerge = coveringMerge(sheet, "D", row);
  const groupAnchor = dMerge?.range.startRow ?? row;
  return {
    id: `BASE-${row}`,
    origin: "baseline",
    date,
    project,
    amount: amount.text,
    amountNumber: amount.numeric,
    decimals: amountCell.style.numberFormat === "0.000" ? 3 : amountCell.style.numberFormat === "0" ? 0 : amount.decimals,
    person,
    classification,
    rowType: `baseline-group-${groupAnchor}`,
    settlement: "baseline-projection",
    sourceOrder: row,
    baselineRow: row,
  };
}

function hasBusinessPayload(sheet, row) {
  return ["A", "B", "C", "D", "E", "F"].some((column) => cellAt(sheet, column, row).hasPayload);
}

export function extractControlledSegment(metadata, profile, preflight) {
  const sheet = preflight.sheet;
  const control = profile.controlledSegment;
  const yearHint = control.startDate?.slice(0, 4) ?? profile.transactions[0]?.date.slice(0, 4);
  const allRecords = [];
  for (let row = preflight.headerRow + 1; row <= sheet.maxUsedRow; row += 1) {
    const record = businessRecordAt(metadata, sheet, row, yearHint);
    if (record) allRecords.push(record);
  }
  let startRow = control.startRow;
  if (!startRow) {
    const eligible = allRecords.filter((record) => record.date === null || record.date >= control.startDate);
    if (!eligible.length) {
      if (allRecords.length === 0) startRow = preflight.headerRow + 1;
      else throw new Error(`${profile.profileId} controlledSegment.startDate is after every baseline record.`);
    } else startRow = Math.min(...eligible.map((record) => record.baselineRow));
  }
  if (startRow <= preflight.headerRow) throw new Error(`${profile.profileId} controlled segment overlaps its header.`);
  const recordsAfterStart = allRecords.filter((record) => record.baselineRow >= startRow);
  const endRow = control.endRow ?? (recordsAfterStart.length ? Math.max(...recordsAfterStart.map((record) => record.baselineRow)) : startRow - 1);
  if (endRow < startRow - 1) throw new Error(`${profile.profileId} controlled segment end precedes its start.`);
  const records = recordsAfterStart.filter((record) => record.baselineRow <= endRow);
  for (let row = startRow; row <= endRow; row += 1) {
    if (!records.some((record) => record.baselineRow === row) && hasBusinessPayload(sheet, row)) {
      throw new Error(`${profile.profileId} controlled segment contains a non-business payload row at ${sheet.name}!${row}.`);
    }
  }
  if (control.startDate) {
    const outsideDate = records.find((record) => record.date !== null && record.date < control.startDate);
    if (outsideDate) throw new Error(`${profile.profileId} controlled segment includes ${outsideDate.date} before startDate ${control.startDate}.`);
    const newOutside = profile.transactions.find((record) => record.date < control.startDate);
    if (newOutside) throw new Error(`${profile.profileId} transaction ${newOutside.id} is before controlledSegment.startDate.`);
  }
  for (const ref of sheet.merges) {
    const range = parseRange(ref);
    if (range.endRow < startRow || range.startRow > endRow) continue;
    if (range.startRow < startRow || range.endRow > endRow) throw new Error(`${profile.profileId} merge ${ref} crosses the controlled-segment boundary.`);
  }
  return { startRow, endRow, records };
}

export function combineControlledRecords(segment, profile) {
  const baseline = segment.records.map((record, index) => ({ ...record, stableOrder: index + 1 }));
  const offset = baseline.length;
  const added = profile.transactions.map((record, index) => ({ ...record, origin: "batch", stableOrder: offset + index + 1 }));
  const combined = [...baseline, ...added]
    .sort((left, right) => {
      if (left.date === null && right.date === null) return left.stableOrder - right.stableOrder;
      if (left.date === null) return 1;
      if (right.date === null) return -1;
      return left.date.localeCompare(right.date) || left.stableOrder - right.stableOrder;
    })
    .map((record, index) => ({ ...record, sourceOrder: index + 1, row: segment.startRow + index }));
  const expectedMultiset = [...baseline, ...added].map((record) => stableJson({ date: record.date, project: record.project, amount: record.amount, person: record.person, classification: record.classification, rowType: record.rowType, settlement: record.settlement, origin: record.origin })).sort();
  return { records: combined, baselineRecordCount: baseline.length, batchRecordCount: added.length, expectedMultisetDigest: digestObject(expectedMultiset) };
}

export function layoutFromCombined(combined, startRow) {
  const records = combined.records.map((record, index) => ({ ...record, row: startRow + index }));
  const groups = [];
  for (const row of records) {
    const key = stableJson([row.person, row.classification, row.rowType, row.settlement]);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  const dateGroups = [];
  for (const row of records) {
    if (row.date === null) continue;
    const last = dateGroups.at(-1);
    if (last?.date === row.date) last.rows.push(row);
    else dateGroups.push({ date: row.date, rows: [row] });
  }
  return { rows: records, groups, dateGroups, endRow: startRow + records.length - 1 };
}

export function cellAt(sheet, column, row) {
  return sheet.cells.get(`${column}${row}`) ?? { ref: `${column}${row}`, value: "", formula: null, hasPayload: false, styleId: 0, style: { numberFormat: "General", horizontal: null, vertical: null, wrapText: false, shrinkToFit: false } };
}

export function resolveProfileSheet(metadata, profile) {
  const expected = profile.config.rootSheet;
  const fingerprints = expected.headerFingerprints ?? (expected.headerFingerprint ? [expected.headerFingerprint] : []);
  const candidateRows = expected.headerRowCandidates;
  if (!Array.isArray(candidateRows) || candidateRows.length === 0 || candidateRows.some((row) => !Number.isSafeInteger(row) || row < 1)) {
    throw new Error(`${profile.profileId} must declare fixed positive headerRowCandidates.`);
  }
  const matches = [];
  for (const sheet of metadata.sheets) {
    for (const row of candidateRows) {
      const fingerprint = fingerprints.find((candidate) => REQUIRED_COLUMNS.every((column, index) => cellAt(sheet, column, row).value.trim() === candidate[index]));
      if (fingerprint) {
        matches.push({ sheet, headerRow: row, fingerprint, nameMatched: expected.names.includes(sheet.name) });
      }
    }
  }
  const namedMatches = matches.filter((match) => match.nameMatched);
  const selected = namedMatches.length === 1 ? namedMatches : [];
  if (selected.length !== 1) throw new Error(`${profile.profileId} must have exactly one editable sheet selected by an allowed name, fixed header row, and A:F fingerprint; found ${matches.length} fingerprint matches and ${namedMatches.length} allowed-name matches.`);
  return selected[0];
}

export function resolvedThemeRole(styleContract, themeOverride, roleName, semanticRoleName = roleName) {
  const semanticRole = styleContract.roles[semanticRoleName];
  if (!semanticRole) throw new Error(`Unknown semantic style role: ${semanticRoleName}`);
  const theme = styleContract.themeRoles[themeOverride];
  if (!theme) throw new Error(`Unknown theme override: ${themeOverride}`);
  const inherited = theme.inherits ? styleContract.themeRoles[theme.inherits] : {};
  const colorToken = theme.overrides?.[roleName] ?? theme[roleName] ?? inherited?.[roleName];
  const fillArgb = styleContract.tokens.colors[colorToken] ?? theme.overrides?.primaryFillArgb ?? theme.primaryFillArgb ?? inherited?.primaryFillArgb;
  if (!fillArgb) throw new Error(`Theme ${themeOverride} does not resolve fill for role ${roleName}.`);
  const unchanged = theme.unchangedRoles?.includes(roleName) ?? false;
  const fontColorArgb = unchanged ? semanticRole.font.colorArgb : (theme.overrides?.fontColorArgb ?? semanticRole.font.colorArgb);
  return { semanticRole, fillArgb: fillArgb.toUpperCase(), fontColorArgb: fontColorArgb.toUpperCase() };
}

function styleAlignmentPass(style, { merged = false } = {}) {
  const horizontal = style.horizontal;
  const vertical = style.vertical;
  return (!merged || horizontal === "center") && ["center", "centerContinuous"].includes(horizontal ?? "center") && ["center", "middle"].includes(vertical ?? "center") && (!merged || style.wrapText) && !style.shrinkToFit;
}

export function preflightWorkbook(metadata, profile, styleContract) {
  const { sheet, headerRow, fingerprint } = resolveProfileSheet(metadata, profile);
  const issues = [];
  const protectedGroups = profile.config.requiredProtectedSheetGroups
    ?? (profile.config.knownProtectedSheets ?? []).map((name) => [name]);
  for (const [groupIndex, names] of protectedGroups.entries()) {
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string" || name.trim() === "")) {
      issues.push({ level: "STRUCTURE_DRIFT", code: "INVALID_REQUIRED_PROTECTED_SHEET_GROUP", groupIndex });
      continue;
    }
    if (!names.some((protectedName) => metadata.sheets.some((candidate) => candidate.name === protectedName))) {
      issues.push({ level: "STRUCTURE_DRIFT", code: "MISSING_REQUIRED_PROTECTED_SHEET_GROUP", aliases: names });
    }
  }
  const { titleCell, canonicalTitleTemplate } = profile.config.rootSheet;
  let canonicalTitle;
  try { canonicalTitle = canonicalTitleForProfile(profile); } catch (error) { issues.push({ level: "STRUCTURE_DRIFT", code: "INVALID_TITLE_BINDING", error: cleanError(error) }); }
  if (titleCell || canonicalTitle || canonicalTitleTemplate) {
    if (!titleCell || !canonicalTitle || !CELL_REF.test(titleCell.toUpperCase())) issues.push({ level: "STRUCTURE_DRIFT", code: "INVALID_TITLE_BINDING" });
    else {
      const titleMatch = CELL_REF.exec(titleCell.toUpperCase());
      const titleValue = cellAt(sheet, titleMatch[1], Number(titleMatch[2])).value.trim();
      if (titleValue !== canonicalTitle) issues.push({ level: "STYLE_DRIFT", code: "FORMAL_TITLE_DRIFT", cell: titleCell, expected: canonicalTitle, actual: titleValue });
      if (styleContract.layout.formalTitleForbiddenTokens.some((token) => titleValue.includes(token))) issues.push({ level: "STYLE_DRIFT", code: "FORMAL_TITLE_STATUS_TOKEN", cell: titleCell, actual: titleValue });
      const titleStyle = cellAt(sheet, titleMatch[1], Number(titleMatch[2])).style;
      const expectedTitle = resolvedThemeRole(styleContract, profile.config.themeOverride, "title");
      if (
        titleStyle.font?.name !== expectedTitle.semanticRole.font.name ||
        Math.abs((titleStyle.font?.size ?? 0) - expectedTitle.semanticRole.font.sizePoints) > 0.01 ||
        titleStyle.font?.bold !== expectedTitle.semanticRole.font.bold ||
        titleStyle.font?.color !== expectedTitle.fontColorArgb ||
        titleStyle.fill?.effectiveArgb !== expectedTitle.fillArgb ||
        !["center", "centerContinuous"].includes(titleStyle.horizontal) ||
        !["center", "middle"].includes(titleStyle.vertical) ||
        !titleStyle.wrapText || titleStyle.shrinkToFit
      ) issues.push({ level: "STYLE_DRIFT", code: "FORMAL_TITLE_STYLE", cell: titleCell });
    }
  }
  const expected = fingerprint;
  for (let index = 0; index < REQUIRED_COLUMNS.length; index += 1) {
    const column = REQUIRED_COLUMNS[index];
    const actual = cellAt(sheet, column, headerRow).value.trim();
    if (actual !== expected[index]) issues.push({ level: "STRUCTURE_DRIFT", code: `HEADER_${column}`, cell: `${column}${headerRow}`, expected: expected[index], actual });
  }
  const d = cellAt(sheet, "D", headerRow).value.trim();
  if (d !== expected[3]) issues.push({ level: "STRUCTURE_DRIFT", code: "MISSING_GROUP_TOTAL_COLUMN", cell: `D${headerRow}` });
  for (const column of REQUIRED_COLUMNS) {
    const style = cellAt(sheet, column, headerRow).style;
    if (!["center", "centerContinuous", null].includes(style.horizontal) || !["center", "middle", null].includes(style.vertical) || style.shrinkToFit) {
      issues.push({ level: "STYLE_DRIFT", code: "HEADER_ALIGNMENT", cell: `${column}${headerRow}` });
    }
    const role = styleContract.roles.ledgerRootHeader ?? styleContract.roles.header;
    const expectedHeader = resolvedThemeRole(styleContract, profile.config.themeOverride, "header", styleContract.roles.ledgerRootHeader ? "ledgerRootHeader" : "header");
    const expectedFill = expectedHeader.fillArgb;
    const expectedFontColor = expectedHeader.fontColorArgb;
    const borderPolicy = role.borderPolicy ?? role.borderToken;
    if (
      style.font?.name !== role.font.name ||
      Math.abs((style.font?.size ?? 0) - role.font.sizePoints) > 0.01 ||
      style.font?.bold !== role.font.bold ||
      style.font?.color !== expectedFontColor ||
      style.fill?.effectiveArgb !== expectedFill ||
      (borderPolicy === "none" && Object.values(style.border ?? {}).some(Boolean))
    ) issues.push({ level: "STYLE_DRIFT", code: "HEADER_STYLE", cell: `${column}${headerRow}`, expected: { font: { name: role.font.name, size: role.font.sizePoints, bold: role.font.bold, color: expectedFontColor }, fill: expectedFill, borderPolicy }, actual: { font: style.font, fill: style.fill, border: style.border } });
  }
  for (const [row, descriptor] of sheet.rows) {
    if (row <= headerRow || !descriptor.hidden) continue;
    if (REQUIRED_COLUMNS.some((column) => cellAt(sheet, column, row).hasPayload)) {
      issues.push({ level: "STRUCTURE_DRIFT", code: "HIDDEN_BUSINESS_ROW", row });
    }
  }
  for (const cell of sheet.cells.values()) {
    const match = CELL_REF.exec(cell.ref);
    if (!match || columnNumber(match[1]) <= 6 || !cell.hasPayload) continue;
    issues.push({ level: "STRUCTURE_DRIFT", code: "UNMANAGED_BUSINESS_COLUMN", cell: cell.ref });
  }
  const widths = styleContract.layout.columnWidths.ledgerRoot;
  for (const column of REQUIRED_COLUMNS) {
    const number = columnNumber(column);
    const descriptor = sheet.columns.find((item) => number >= item.min && number <= item.max);
    if (!descriptor || !(descriptor.width > 0)) issues.push({ level: "LAYOUT_DRIFT", code: "MISSING_EXPLICIT_COLUMN_WIDTH", column });
    else if (Math.abs(descriptor.width - widths[column]) > 0.05) issues.push({ level: "LAYOUT_DRIFT", code: "COLUMN_WIDTH_DRIFT", column, expected: widths[column], actual: descriptor.width });
    if (descriptor?.hidden) issues.push({ level: "STRUCTURE_DRIFT", code: "HIDDEN_BUSINESS_COLUMN", column });
  }
  for (const ref of sheet.merges) {
    const range = parseRange(ref);
    const touchesBusinessGroup = range.endCol >= 4 && range.startCol <= 6;
    if (!touchesBusinessGroup || range.startRow <= headerRow) continue;
    const matching = ["D", "E", "F"].map((column) => `${column}${range.startRow}:${column}${range.endRow}`);
    if (!matching.every((candidate) => sheet.merges.includes(candidate))) issues.push({ level: "LAYOUT_DRIFT", code: "D_E_F_MERGE_MISMATCH", merge: ref });
    if (range.startCol >= 4 && range.startCol <= 6 && !styleAlignmentPass(cellAt(sheet, columnName(range.startCol), range.startRow).style, { merged: true })) {
      issues.push({ level: "LAYOUT_DRIFT", code: "MERGED_ANCHOR_DISPLAY", merge: ref });
    }
  }
  for (const failure of displayContractFailures(metadata, sheet, headerRow, Math.max(headerRow, sheet.maxUsedRow))) {
    issues.push({ level: "LAYOUT_DRIFT", code: `DISPLAY_${failure.toUpperCase().replace(/-/gu, "_")}` });
  }
  const blocking = issues.filter((issue) => issue.level === "STRUCTURE_DRIFT");
  return { sheet, headerRow, issues, blocking };
}

export function deriveLayout(profile) {
  const records = profile.transactions;
  const startRow = profile.appendStartRow;
  if (!startRow) throw new Error(`${profile.profileId} appendStartRow has not been resolved.`);
  const rows = records.map((record, index) => ({ ...record, row: startRow + index }));
  const groups = [];
  for (const row of rows) {
    const key = stableJson([row.person, row.classification, row.rowType, row.settlement]);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  const dateGroups = [];
  for (const row of rows) {
    const last = dateGroups.at(-1);
    if (last?.date === row.date) last.rows.push(row);
    else dateGroups.push({ date: row.date, rows: [row] });
  }
  return { rows, groups, dateGroups, endRow: startRow + rows.length - 1 };
}

export function rowHeightFor(record) {
  const units = (value) => [...value].reduce((sum, character) => sum + (/^[\u0000-\u00ff]$/u.test(character) ? 1 : 2), 0);
  const lines = Math.max(1, Math.ceil(units(record.project) / 42), Math.ceil(units(record.classification) / 45));
  return Math.ceil(Math.max(30, lines * 21 + 6) * 4) / 4;
}

export function canonicalTitleForProfile(profile) {
  const { canonicalTitle, canonicalTitleTemplate } = profile.config.rootSheet;
  if (!canonicalTitleTemplate) return canonicalTitle ?? null;
  if (profile.titleYear !== undefined) return canonicalTitleTemplate.replaceAll("{year}", String(profile.titleYear));
  const years = new Set(profile.transactions.map((record) => record.date.slice(0, 4)));
  if (profile.controlledSegment.startDate) years.add(profile.controlledSegment.startDate.slice(0, 4));
  if (!years.size) throw new Error(`${profile.profileId} title year cannot be derived.`);
  return canonicalTitleTemplate.replaceAll("{year}", [...years].sort().at(-1));
}

export function expectedNumberFormat(decimals, styleContract) {
  if (decimals === 3) return styleContract.numberFormats.explicitThreeDecimals;
  if (decimals === 0) return styleContract.numberFormats.integer;
  return styleContract.numberFormats.ordinaryFraction;
}

export function totalNumberFormat(records, styleContract) {
  const totalMilliunits = records.reduce(
    (sum, record, index) => sum + parseAmount(record.amount, `records[${index}].amount`).milliunits,
    0n,
  );
  if (totalMilliunits % 1000n === 0n) return styleContract.numberFormats.integer;
  if (totalMilliunits % 10n === 0n) return styleContract.numberFormats.ordinaryFraction;
  return styleContract.numberFormats.explicitThreeDecimals;
}

export function protectedSheetNames(metadata, editableSheetName) {
  return metadata.sheets.map((sheet) => sheet.name).filter((name) => name !== editableSheetName);
}

const APPEND_ONLY_STYLE_COLLECTIONS = [
  ["numFmts", "numFmt"],
  ["fonts", "font"],
  ["fills", "fill"],
  ["borders", "border"],
  ["cellXfs", "xf"],
];

function styleCollection(xml, collectionName, itemName) {
  const expression = new RegExp(`<(?:\\w+:)?${collectionName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${collectionName}\\s*>`, "gu");
  const matches = [...String(xml ?? "").matchAll(expression)];
  if (matches.length > 1) throw new Error(`Styles OOXML contains duplicate ${collectionName} collections.`);
  if (!matches.length) return null;
  const match = matches[0];
  const itemExpression = new RegExp(`<(?:\\w+:)?${itemName}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/(?:\\w+:)?${itemName}\\s*>)`, "gu");
  const entries = [...match[1].matchAll(itemExpression)].map((entry) => entry[0]);
  const residual = match[1].replace(itemExpression, "").replace(/<!--[\s\S]*?-->/gu, "").trim();
  if (residual) throw new Error(`Styles OOXML ${collectionName} contains unparsed content.`);
  return { full: match[0], index: match.index, entries };
}

function withoutXfProtection(fragment) {
  return fragment
    .replace(/\s+applyProtection\s*=\s*(?:"[^"]*"|'[^']*')/gu, "")
    .replace(/<(?:\w+:)?protection\b[^>]*(?:\/\s*>|>[\s\S]*?<\/(?:\w+:)?protection\s*>)/gu, "")
    .replace(/<((?:\w+:)?xf)\b([^>]*)>\s*<\/\1\s*>/gu, "<$1$2/>");
}

function styleEntryEqual(left, right, { ignoreProtection = false } = {}) {
  const normalize = (value) => canonicalXmlFragment(ignoreProtection ? withoutXfProtection(value) : value);
  return normalize(left) === normalize(right);
}

function replaceStyleCollectionEntries(xml, collectionName, info, entries) {
  const opening = /^<([\w:.-]+)\b[^>]*>/u.exec(info.full)?.[0];
  const qualifiedName = /^<([\w:.-]+)/u.exec(info.full)?.[1];
  if (!opening || !qualifiedName) throw new Error(`Styles OOXML ${collectionName} collection is malformed.`);
  const updatedOpening = /\bcount\s*=/u.test(opening)
    ? opening.replace(/\bcount\s*=\s*(?:"[^"]*"|'[^']*')/u, `count="${entries.length}"`)
    : opening.replace(/>$/u, ` count="${entries.length}">`);
  const replacement = `${updatedOpening}${entries.join("")}</${qualifiedName}>`;
  return `${xml.slice(0, info.index)}${replacement}${xml.slice(info.index + info.full.length)}`;
}

function mergeBaselineStylePrefixes(baselineXml, candidateXml) {
  let merged = candidateXml;
  for (const [collectionName, itemName] of [...APPEND_ONLY_STYLE_COLLECTIONS, ["cellStyleXfs", "xf"]]) {
    const baseline = styleCollection(baselineXml, collectionName, itemName);
    if (!baseline) continue;
    const candidate = styleCollection(merged, collectionName, itemName);
    if (!candidate || candidate.entries.length < baseline.entries.length) {
      throw new Error(`Candidate styles cannot preserve the baseline ${collectionName} prefix.`);
    }
    if (collectionName === "cellStyleXfs" && candidate.entries.length !== baseline.entries.length) {
      throw new Error("Candidate unexpectedly appended cellStyleXfs entries.");
    }
    for (let index = 0; index < baseline.entries.length; index += 1) {
      const protectionOnlyLoss = ["cellXfs", "cellStyleXfs"].includes(collectionName);
      if (!styleEntryEqual(baseline.entries[index], candidate.entries[index], { ignoreProtection: protectionOnlyLoss })) {
        throw new Error(`Candidate changed baseline ${collectionName} entry ${index}.`);
      }
    }
    merged = replaceStyleCollectionEntries(
      merged,
      collectionName,
      candidate,
      [...baseline.entries, ...candidate.entries.slice(baseline.entries.length)],
    );
  }
  return merged;
}

function styleTablesAreAppendOnly(baselineXml, candidateXml) {
  try {
    for (const [collectionName, itemName] of APPEND_ONLY_STYLE_COLLECTIONS) {
      const baseline = styleCollection(baselineXml, collectionName, itemName);
      const candidate = styleCollection(candidateXml, collectionName, itemName);
      if (!baseline) continue;
      if (!candidate || candidate.entries.length < baseline.entries.length) return false;
      for (let index = 0; index < baseline.entries.length; index += 1) {
        if (!styleEntryEqual(baseline.entries[index], candidate.entries[index])) return false;
      }
    }
    const removeAppendOnly = (xml) => APPEND_ONLY_STYLE_COLLECTIONS.reduce((value, [name]) => value.replace(
      new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:\\w+:)?${name}\\s*>`, "gu"),
      "",
    ), String(xml ?? ""));
    return canonicalXmlFragment(removeAppendOnly(baselineXml)) === canonicalXmlFragment(removeAppendOnly(candidateXml));
  } catch {
    return false;
  }
}

export async function restoreProtectedSheetParts(baselinePath, candidatePath, editableSheetName) {
  const { JSZip } = await packages();
  const [baselineMeta, candidateMeta] = await Promise.all([readWorkbookMetadata(baselinePath), readWorkbookMetadata(candidatePath)]);
  const baselineNames = baselineMeta.sheets.map((sheet) => sheet.name);
  const candidateNames = candidateMeta.sheets.map((sheet) => sheet.name);
  if (stableJson(baselineNames) !== stableJson(candidateNames)) throw new Error("Candidate changed the workbook sheet set or order.");
  for (const sourceSheet of baselineMeta.sheets) {
    if (sourceSheet.name === editableSheetName) continue;
    const targetSheet = candidateMeta.sheets.find((sheet) => sheet.name === sourceSheet.name);
    if (!targetSheet || targetSheet.path !== sourceSheet.path) throw new Error(`Protected sheet part path changed: ${sourceSheet.name}`);
    const sourceXml = await baselineMeta.zip.file(sourceSheet.path)?.async("string");
    const targetXml = await candidateMeta.zip.file(targetSheet.path)?.async("string");
    if (!sourceXml || !targetXml) throw new Error(`Protected sheet part missing: ${sourceSheet.name}`);
    candidateMeta.zip.file(targetSheet.path, sourceXml);
    const visited = new Set();
    const copyClosure = async (sourcePart) => {
      const normalizedSource = path.posix.normalize(sourcePart);
      if (visited.has(normalizedSource)) return;
      visited.add(normalizedSource);
      const relPath = relationshipPartPath(normalizedSource);
      const relBytes = await baselineMeta.zip.file(relPath)?.async("nodebuffer");
      if (!relBytes) { candidateMeta.zip.remove(relPath); return; }
      candidateMeta.zip.file(relPath, relBytes);
      const relXml = relBytes.toString("utf8");
      for (const match of relXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?\s*>/gu)) {
        const attrs = parseAttrs(match[0]);
        if ((attrs.TargetMode ?? "Internal") === "External" || !attrs.Target) continue;
        const target = normalizeTarget(normalizedSource, attrs.Target);
        const targetBytes = await baselineMeta.zip.file(target)?.async("nodebuffer");
        if (!targetBytes) throw new Error(`Protected relationship target is missing: ${target}`);
        candidateMeta.zip.file(target, targetBytes);
        await copyClosure(target);
      }
    };
    await copyClosure(sourceSheet.path);
  }
  if (!baselineMeta.stylesXml || !candidateMeta.stylesXml) throw new Error("Workbook styles part is missing during protected-sheet restoration.");
  candidateMeta.zip.file("xl/styles.xml", mergeBaselineStylePrefixes(baselineMeta.stylesXml, candidateMeta.stylesXml));
  const output = await candidateMeta.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(candidatePath, output);
}

export function protectedSheetsEqual(baselineMeta, candidateMeta, editableSheetName) {
  const failures = [];
  const baselineNames = baselineMeta.sheets.map((sheet) => sheet.name);
  const candidateNames = candidateMeta.sheets.map((sheet) => sheet.name);
  if (stableJson(baselineNames) !== stableJson(candidateNames)) failures.push("sheet-set-or-order");
  for (const baselineSheet of baselineMeta.sheets) {
    if (baselineSheet.name === editableSheetName) continue;
    const candidateSheet = candidateMeta.sheets.find((sheet) => sheet.name === baselineSheet.name);
    if (!candidateSheet) { failures.push(baselineSheet.name); continue; }
    if (candidateSheet.path !== baselineSheet.path) failures.push(`${baselineSheet.name}:part-path`);
    const contentSemantic = (sheet) => ({
      cells: [...sheet.cells.values()].map((cell) => ({
        ref: cell.ref,
        attrs: cell.attrs,
        value: cell.value,
        formula: cell.formulaPresent ? { attrs: cell.formulaAttrs, text: cell.formula } : null,
        inlineString: cell.inlineStringSemantic,
      })).sort((a, b) => a.ref.localeCompare(b.ref)),
      merges: [...sheet.merges].sort(), rows: [...sheet.rows.entries()].sort((a, b) => a[0] - b[0]), columns: sheet.columns,
    });
    const styleSemantic = (sheet) => [...sheet.cells.values()].map((cell) => ({ ref: cell.ref, style: {
        numberFormat: cell.style.numberFormat,
        font: cell.style.font,
        fill: cell.style.fill,
        border: cell.style.border,
        horizontal: cell.style.horizontal,
        vertical: cell.style.vertical,
        wrapText: cell.style.wrapText,
        shrinkToFit: cell.style.shrinkToFit,
        xfId: cell.style.xfId,
        protection: cell.style.protection,
        baseProtection: cell.style.baseProtection,
      } })).sort((a, b) => a.ref.localeCompare(b.ref));
    if (stableJson(contentSemantic(candidateSheet)) !== stableJson(contentSemantic(baselineSheet))) failures.push(`${baselineSheet.name}:content-layout`);
    if (stableJson(styleSemantic(candidateSheet)) !== stableJson(styleSemantic(baselineSheet))) failures.push(`${baselineSheet.name}:computed-style`);
    if (candidateSheet.protectedFeatureSignature !== baselineSheet.protectedFeatureSignature) failures.push(`${baselineSheet.name}:sheet-features`);
    if (candidateSheet.relationshipClosureSignature !== baselineSheet.relationshipClosureSignature) failures.push(`${baselineSheet.name}:relationships`);
  }
  return failures;
}

function relationshipSemanticState(xml, sourcePart) {
  const entries = relationshipEntries(xml, sourcePart);
  const ids = new Set();
  let valid = true;
  for (const entry of entries) {
    if (!entry.id || !entry.type || !entry.target || ids.has(entry.id)) valid = false;
    ids.add(entry.id);
  }
  const semantic = entries.map(({ type, target, targetMode }) => ({ type, target, targetMode }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return { valid, semantic, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

function workbookSemanticState(metadata, editableSheetName) {
  const sheetIndex = metadata.sheets.findIndex((sheet) => sheet.name === editableSheetName);
  if (sheetIndex < 0) return { valid: false, xml: "" };
  const relationships = relationshipSemanticState(metadata.workbookRels, "xl/workbook.xml");
  let valid = relationships.valid;
  let xml = metadata.workbookXml;
  xml = xml.replace(/<(?:\w+:)?definedName\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?definedName\s*>)/gu, (full, rawAttrs) => {
    const attrs = parseAttrs(`<definedName ${rawAttrs}>`);
    const editablePrintName = ["_xlnm.Print_Area", "_xlnm.Print_Titles"].includes(attrs.name) && Number(attrs.localSheetId) === sheetIndex;
    return editablePrintName ? "" : full;
  });
  xml = xml.replace(/<(?:\w+:)?definedNames\b[^>]*>\s*<\/(?:\w+:)?definedNames\s*>/gu, "");
  xml = xml.replace(/([\w.-]+):id\s*=\s*(?:"([^"]*)"|'([^']*)')/gu, (_, prefix, doubleQuoted, singleQuoted) => {
    const id = doubleQuoted ?? singleQuoted ?? "";
    const relation = relationships.byId.get(id);
    if (!relation) {
      valid = false;
      return `${prefix}:id="unresolved-relationship"`;
    }
    const digest = digestObject({ type: relation.type, target: relation.target, targetMode: relation.targetMode });
    return `${prefix}:id="relationship-${digest}"`;
  });
  return { valid, xml: canonicalXmlFragment(xml) };
}

export function workbookPackageIntegrityFailures(baselineMeta, candidateMeta, editableSheetName) {
  const failures = [];
  const baselineParts = baselineMeta.packageParts ?? {};
  const candidateParts = candidateMeta.packageParts ?? {};
  const baselineNames = Object.keys(baselineParts).sort();
  const candidateNames = Object.keys(candidateParts).sort();
  const baselineSet = new Set(baselineNames);
  const candidateSet = new Set(candidateNames);
  for (const name of candidateNames) if (!baselineSet.has(name)) failures.push(`part-added:${name}`);
  for (const name of baselineNames) if (!candidateSet.has(name)) failures.push(`part-deleted:${name}`);

  const baselineEditable = baselineMeta.sheets.find((sheet) => sheet.name === editableSheetName);
  const candidateEditable = candidateMeta.sheets.find((sheet) => sheet.name === editableSheetName);
  if (!baselineEditable || !candidateEditable || baselineEditable.path !== candidateEditable.path) failures.push("editable-sheet-part-path");
  const editablePath = baselineEditable?.path ?? "";
  const editableRelsPath = editablePath ? relationshipPartPath(editablePath) : "";

  const baselineRootRels = relationshipSemanticState(baselineMeta.rootRels, "");
  const candidateRootRels = relationshipSemanticState(candidateMeta.rootRels, "");
  if (!baselineRootRels.valid || !candidateRootRels.valid || stableJson(baselineRootRels.semantic) !== stableJson(candidateRootRels.semantic)) failures.push("root-relationships");
  const baselineWorkbookRels = relationshipSemanticState(baselineMeta.workbookRels, "xl/workbook.xml");
  const candidateWorkbookRels = relationshipSemanticState(candidateMeta.workbookRels, "xl/workbook.xml");
  if (!baselineWorkbookRels.valid || !candidateWorkbookRels.valid || stableJson(baselineWorkbookRels.semantic) !== stableJson(candidateWorkbookRels.semantic)) failures.push("workbook-relationships");
  const baselineWorkbook = workbookSemanticState(baselineMeta, editableSheetName);
  const candidateWorkbook = workbookSemanticState(candidateMeta, editableSheetName);
  if (!baselineWorkbook.valid || !candidateWorkbook.valid || baselineWorkbook.xml !== candidateWorkbook.xml) failures.push("workbook-metadata");
  if (!styleTablesAreAppendOnly(baselineMeta.stylesXml, candidateMeta.stylesXml)) failures.push("styles-not-append-only");

  for (const name of baselineNames) {
    if (!candidateSet.has(name) || baselineParts[name] === candidateParts[name]) continue;
    if ([editablePath, "xl/styles.xml", "xl/workbook.xml", "_rels/.rels", "xl/_rels/workbook.xml.rels"].includes(name)) continue;
    if (name === editableRelsPath && baselineEditable?.relationshipClosureSignature === candidateEditable?.relationshipClosureSignature) continue;
    failures.push(`part-modified:${name}`);
  }
  return [...new Set(failures)];
}

export function assertNoMergedChildPayload(sheet, mergeRefs) {
  const failures = [];
  for (const ref of mergeRefs) {
    const range = parseRange(ref);
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let col = range.startCol; col <= range.endCol; col += 1) {
        if (row === range.startRow && col === range.startCol) continue;
        const cell = sheet.cells.get(`${columnName(col)}${row}`);
        if (cell) failures.push(`${sheet.name}!${columnName(col)}${row}`);
      }
    }
  }
  return failures;
}

export async function stripMergedChildCells(workbookPath, sheetName) {
  const { JSZip } = await packages();
  const metadata = await readWorkbookMetadata(workbookPath);
  const sheet = metadata.sheets.find((item) => item.name === sheetName);
  if (!sheet) throw new Error(`Unable to strip merged children from missing sheet: ${sheetName}`);
  const zip = await JSZip.loadAsync(await fs.readFile(workbookPath));
  let xml = await zip.file(sheet.path)?.async("string");
  if (!xml) throw new Error(`Unable to read sheet XML for merged-child cleanup: ${sheetName}`);
  const followerRefs = new Set();
  for (const ref of sheet.merges) {
    const range = parseRange(ref);
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let col = range.startCol; col <= range.endCol; col += 1) {
        if (row === range.startRow && col === range.startCol) continue;
        followerRefs.add(`${columnName(col)}${row}`);
      }
    }
  }
  const cellPattern = /<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?c\s*>|<(?:\w+:)?c\b([^>]*\br=(?:"[^"]+"|'[^']+')[^>]*)\/>/gu;
  xml = xml.replace(cellPattern, (full, openAttrs, _inner, selfAttrs) => {
    const ref = parseAttrs(`<c ${openAttrs ?? selfAttrs ?? ""}>`).r?.replace(/\$/gu, "").toUpperCase();
    return ref && followerRefs.has(ref) ? "" : full;
  });
  zip.file(sheet.path, xml);
  await fs.writeFile(workbookPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export function mergedStylePass(style) {
  return styleAlignmentPass(style, { merged: true });
}

export function formulaForGroup(startRow, endRow) {
  return `SUM(C${startRow}:C${endRow})`;
}

export function formulaEquivalent(actual, expected) {
  return actual?.replace(/^=/u, "").replace(/\s+/gu, "").toUpperCase() === expected.replace(/^=/u, "").replace(/\s+/gu, "").toUpperCase();
}

export async function openWorkbook(filePath) {
  const { artifact } = await packages();
  return artifact.SpreadsheetFile.importXlsx(await artifact.FileBlob.load(filePath));
}

export async function exportWorkbook(workbook, outputPath) {
  const { artifact } = await packages();
  const blob = await artifact.SpreadsheetFile.exportXlsx(workbook);
  await blob.save(outputPath);
}

export function emitJson(payload, { failure = false } = {}) {
  (failure ? process.stderr : process.stdout).write(`${JSON.stringify(payload)}\n`);
}

export function parseCli(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!["--input", "--output"].includes(key) || !args[index + 1]) throw new Error("Usage: --input <batch-plan.json> [--output <certificate.json>]");
    result[key.slice(2)] = path.resolve(args[++index]);
  }
  if (!result.input) throw new Error("--input is required.");
  return result;
}

export async function writeCertificate(filePath, payload) {
  if (!filePath) return;
  const absolute = path.resolve(filePath);
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    await fs.writeFile(absolute, bytes, { flag: "wx" });
  } catch (error) {
    throw new Error(`Unable to create certificate without overwrite: ${cleanError(error)}`);
  }
}
