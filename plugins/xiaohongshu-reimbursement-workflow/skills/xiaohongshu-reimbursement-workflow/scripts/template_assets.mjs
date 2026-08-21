import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyStableBinaryBytes, loadBundledDependency, readStableBinaryFile, readStableUtf8JsonFile } from "./workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates", "xiaohongshu");
const MANIFEST_PATH = path.join(TEMPLATE_ROOT, "template-manifest.json");
const SHA256_RE = /^[0-9a-f]{64}$/u;
let manifestPromise;
let artifactTemplatesPromise;
const workbookTemplatePromises = new Map();
const textTemplatePromises = new Map();

function fail(message) { throw new Error(`Reimbursement Template Assets ${message}`); }

function cachedPromise(cache, key, loader) {
  if (!cache.has(key)) {
    const pending = Promise.resolve().then(loader);
    cache.set(key, pending);
    pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
  }
  return cache.get(key);
}

function loadTemplateManifest() {
  if (!manifestPromise) {
    const pending = readStableUtf8JsonFile(MANIFEST_PATH);
    manifestPromise = pending;
    pending.catch(() => { if (manifestPromise === pending) manifestPromise = undefined; });
  }
  return manifestPromise;
}

function mergeRefs(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?mergeCell\b[^>]*\bref\s*=\s*"([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)"[^>]*\/>/gu)].map((match) => match[1]).sort();
}

function rowBlocks(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\b[^>]*\br\s*=\s*"([1-9]\d*)"[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?row>/gu)]
    .map((match) => ({ number: Number(match[1]), xml: match[0] }));
}

function validateDefinition(id, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail(`${id} definition is invalid.`);
  if (!SHA256_RE.test(definition.sha256 ?? "")) fail(`${id} sha256 is missing or invalid.`);
  if (!Number.isSafeInteger(definition.dataStartRow) || !Number.isSafeInteger(definition.dataStyleRow)) fail(`${id} row contract is invalid.`);
  if (!definition.styleRoles || typeof definition.styleRoles !== "object") fail(`${id} styleRoles are missing.`);
  const mergePolicy = definition.outputMergePolicy;
  const structuralMergeField = id === "current-detail" ? "description" : id === "supplement-detail" ? "footer" : null;
  const mergeFields = ["personGroup", "sameDate", "expenseGroup", ...(structuralMergeField ? [structuralMergeField] : []), "dataAreaDefault"];
  if (!mergePolicy || typeof mergePolicy !== "object" || Array.isArray(mergePolicy) || JSON.stringify(Object.keys(mergePolicy).sort()) !== JSON.stringify([...mergeFields].sort())) fail(`${id} outputMergePolicy fields are invalid.`);
  for (const field of mergeFields.filter((field) => field !== "dataAreaDefault")) if (typeof mergePolicy[field] !== "boolean") fail(`${id} outputMergePolicy.${field} must be boolean.`);
  if (mergePolicy.dataAreaDefault !== "none") fail(`${id} outputMergePolicy.dataAreaDefault must be none.`);
  if (JSON.stringify(definition.moneyNumberFormats) !== JSON.stringify(["0", "0.0", "0.00", "0.000"])) fail(`${id} moneyNumberFormats must preserve zero through three decimals.`);
  if (!Array.isArray(definition.moneyStyleRoles) || definition.moneyStyleRoles.length === 0 || new Set(definition.moneyStyleRoles).size !== definition.moneyStyleRoles.length) fail(`${id} moneyStyleRoles are missing or duplicated.`);
  for (const role of definition.moneyStyleRoles) {
    if (typeof role !== "string" || !role || role !== role.trim()) fail(`${id} moneyStyleRoles contain an invalid role.`);
    for (let digits = 0; digits <= 3; digits += 1) {
      const style = definition.styleRoles[`${role}${digits}`];
      if (!Number.isSafeInteger(style) || style < 0) fail(`${id} ${role}${digits} style is missing or invalid.`);
    }
  }
  if (id === "screenshot-map") {
    const policy = definition.outputImagePolicy;
    if (!policy || policy.fit !== "contain" || policy.align !== "center" || !Number.isSafeInteger(policy.maxWidthPx) || !Number.isSafeInteger(policy.maxHeightPx) || policy.maxWidthPx < 1 || policy.maxHeightPx < 1) fail(`${id} outputImagePolicy is invalid.`);
  }
}

function validateTextDefinition(id, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail(`${id} text definition is invalid.`);
  if (!SHA256_RE.test(definition.sha256 ?? "")) fail(`${id} sha256 is missing or invalid.`);
  if (definition.encoding !== "utf-8") fail(`${id} encoding must be utf-8.`);
  if (!Array.isArray(definition.requiredPlaceholders) || definition.requiredPlaceholders.length === 0) fail(`${id} requiredPlaceholders are missing.`);
  if (definition.requiredPlaceholders.some((item) => typeof item !== "string" || !item || item !== item.trim())) fail(`${id} requiredPlaceholders are invalid.`);
}

export async function loadTextTemplateAsset(id) {
  return cachedPromise(textTemplatePromises, id, async () => {
    const snapshot = await loadTemplateManifest();
    const definition = snapshot.value?.textTemplates?.[id];
    validateTextDefinition(id, definition);
    const filePath = path.join(TEMPLATE_ROOT, definition.file);
    const stable = await readStableBinaryFile(filePath);
    if (stable.sha256 !== definition.sha256) fail(`${id} SHA-256 differs from template-manifest.json.`);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(copyStableBinaryBytes(stable));
    } catch (error) {
      throw new Error(`Reimbursement Template Assets ${id} is not valid UTF-8.`, { cause: error });
    }
    if (text.includes("\uFEFF")) fail(`${id} must not contain a UTF-8 BOM.`);
    for (const placeholder of definition.requiredPlaceholders) if (!text.includes(placeholder)) fail(`${id} is missing required placeholder ${placeholder}.`);
    return Object.freeze({ id, definition: structuredClone(definition), filePath, sha256: stable.sha256, text });
  });
}

export async function loadTemplateAsset(id) {
  return cachedPromise(workbookTemplatePromises, id, async () => {
    const snapshot = await loadTemplateManifest();
    const definition = snapshot.value?.templates?.[id];
    validateDefinition(id, definition);
    const filePath = path.join(TEMPLATE_ROOT, definition.file);
    const stable = await readStableBinaryFile(filePath);
    if (stable.sha256 !== definition.sha256) fail(`${id} SHA-256 differs from template-manifest.json.`);
    const zip = await JSZip.loadAsync(copyStableBinaryBytes(stable), { createFolders: false });
    const worksheetEntry = zip.file("xl/worksheets/sheet1.xml");
    const stylesEntry = zip.file("xl/styles.xml");
    if (!worksheetEntry || !stylesEntry) fail(`${id} is missing its worksheet or styles part.`);
    const worksheetXml = await worksheetEntry.async("string");
    const rows = rowBlocks(worksheetXml);
    if (rows.some((row) => row.number > definition.dataStyleRow)) fail(`${id} contains rows after its single standard data row.`);
    if (!rows.some((row) => row.number === definition.dataStyleRow)) fail(`${id} has no standard data row.`);
    const actualMerges = mergeRefs(worksheetXml);
    const expectedMerges = [...definition.staticMerges].sort();
    if (JSON.stringify(actualMerges) !== JSON.stringify(expectedMerges)) fail(`${id} merges differ from its static merge contract.`);
    const dataRow = rows.find((row) => row.number === definition.dataStyleRow).xml;
    if (/<(?:[A-Za-z_][\w.-]*:)?(?:v|f|is)\b/iu.test(dataRow)) fail(`${id} standard data row contains values or formulas.`);
    const columnsXml = /<(?:[A-Za-z_][\w.-]*:)?cols\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?cols>/iu.exec(worksheetXml)?.[0] ?? "";
    const themeXml = zip.file("xl/theme/theme1.xml") ? await zip.file("xl/theme/theme1.xml").async("string") : null;
    return Object.freeze({
      id,
      definition: structuredClone(definition),
      filePath,
      sha256: stable.sha256,
      stylesXml: await stylesEntry.async("string"),
      themeXml,
      columnsXml,
      styleRoles: Object.freeze({ ...definition.styleRoles }),
    });
  });
}

export async function loadArtifactTemplates() {
  if (!artifactTemplatesPromise) {
    const pending = Promise.all([
      loadTemplateAsset("current-detail"),
      loadTemplateAsset("screenshot-map"),
      loadTemplateAsset("supplement-detail"),
      loadTemplateAsset("ledger-batch-preview"),
      loadTextTemplateAsset("summary-text"),
    ]).then(([currentDetail, screenshotMap, supplementDetail, ledgerBatchPreview, summaryText]) => Object.freeze({ currentDetail, screenshotMap, supplementDetail, ledgerBatchPreview, summaryText }));
    artifactTemplatesPromise = pending;
    pending.catch(() => { if (artifactTemplatesPromise === pending) artifactTemplatesPromise = undefined; });
  }
  return artifactTemplatesPromise;
}

export const templateAssetPaths = Object.freeze({ root: TEMPLATE_ROOT, manifest: MANIFEST_PATH });
