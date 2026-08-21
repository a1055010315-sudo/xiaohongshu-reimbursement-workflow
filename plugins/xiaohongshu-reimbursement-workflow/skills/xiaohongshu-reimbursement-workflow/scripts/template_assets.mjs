import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyStableBinaryBytes, loadBundledDependency, readStableBinaryFile, readStableUtf8JsonFile } from "./workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates", "xiaohongshu");
const MANIFEST_PATH = path.join(TEMPLATE_ROOT, "template-manifest.json");
const SHA256_RE = /^[0-9a-f]{64}$/u;

function fail(message) { throw new Error(`Reimbursement Template Assets ${message}`); }

function mergeRefs(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*"([A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*)"[^>]*\/>/gu)].map((match) => match[1]).sort();
}

function rowBlocks(worksheetXml) {
  return [...worksheetXml.matchAll(/<(?:\w+:)?row\b[^>]*\br\s*=\s*"([1-9]\d*)"[^>]*>[\s\S]*?<\/(?:\w+:)?row>/gu)]
    .map((match) => ({ number: Number(match[1]), xml: match[0] }));
}

function validateDefinition(id, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail(`${id} definition is invalid.`);
  if (!SHA256_RE.test(definition.sha256 ?? "")) fail(`${id} sha256 is missing or invalid.`);
  if (!Number.isSafeInteger(definition.dataStartRow) || !Number.isSafeInteger(definition.dataStyleRow)) fail(`${id} row contract is invalid.`);
  if (!definition.styleRoles || typeof definition.styleRoles !== "object") fail(`${id} styleRoles are missing.`);
}

export async function loadTemplateAsset(id) {
  const snapshot = await readStableUtf8JsonFile(MANIFEST_PATH);
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
  if (/<(?:\w+:)?(?:v|f|is)\b/iu.test(dataRow)) fail(`${id} standard data row contains values or formulas.`);
  const columnsXml = /<(?:\w+:)?cols\b[^>]*>[\s\S]*?<\/(?:\w+:)?cols>/iu.exec(worksheetXml)?.[0] ?? "";
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
}

export async function loadArtifactTemplates() {
  const [currentDetail, screenshotMap, supplementDetail, ledgerBatchPreview] = await Promise.all([
    loadTemplateAsset("current-detail"),
    loadTemplateAsset("screenshot-map"),
    loadTemplateAsset("supplement-detail"),
    loadTemplateAsset("ledger-batch-preview"),
  ]);
  return Object.freeze({ currentDetail, screenshotMap, supplementDetail, ledgerBatchPreview });
}

export const templateAssetPaths = Object.freeze({ root: TEMPLATE_ROOT, manifest: MANIFEST_PATH });
