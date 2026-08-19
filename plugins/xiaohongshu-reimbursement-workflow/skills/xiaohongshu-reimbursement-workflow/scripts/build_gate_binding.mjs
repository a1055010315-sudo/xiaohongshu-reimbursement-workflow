import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalDigest } from "./workflow_primitives.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/u;
const RANGE_RE = /^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$/u;
const MODES = new Set(["reimbursement-batch", "ledger-reorder-correction"]);
const PREVIEW_PROFILES = new Set(["xiaohongshu", "company", "residence"]);
const PREVIEW_ROLES = new Map([["root", 0], ["detail", 1], ["screenshot", 2]]);
const PREVIEW_SCOPE_KEYS = new Set(["profileId", "role", "sheetName", "rangeAddress", "sourceSha256", "previewSha256"]);
const MAX_ROOT_SCOPES_PER_PROFILE = 10;
const MAX_EXCEL_COLUMN = 16_384;
const MAX_EXCEL_ROW = 1_048_576;

function cleanString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function sha(value, field) {
  const normalized = cleanString(value, field).toLowerCase();
  if (!SHA256_RE.test(normalized)) throw new Error(`${field} must be 64 lowercase hexadecimal characters.`);
  return normalized;
}

function absolute(value, field) {
  const normalized = cleanString(value, field);
  if (!path.isAbsolute(normalized)) throw new Error(`${field} must be an absolute path.`);
  return path.resolve(normalized);
}

function columnNumber(value) {
  let result = 0;
  for (const character of value) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function parseRange(value, field) {
  const address = cleanString(value, field);
  const match = RANGE_RE.exec(address);
  if (!match) throw new Error(`${field} must be an uppercase rectangular A1 range.`);
  const startColumn = columnNumber(match[1]);
  const startRow = Number(match[2]);
  const endColumn = columnNumber(match[3]);
  const endRow = Number(match[4]);
  if (
    !Number.isSafeInteger(startRow) || !Number.isSafeInteger(endRow)
    || startColumn < 1 || endColumn > MAX_EXCEL_COLUMN
    || startRow < 1 || endRow > MAX_EXCEL_ROW
    || startColumn > endColumn || startRow > endRow
  ) {
    throw new Error(`${field} is outside Excel bounds or has its start after its end.`);
  }
  return { address, startColumn, startRow, endColumn, endRow };
}

function normalizeProfileId(value, field) {
  const profileId = cleanString(value, field);
  if (!PREVIEW_PROFILES.has(profileId) || profileId !== profileId.toLowerCase()) {
    throw new Error(`${field} must use a supported canonical lowercase profile id.`);
  }
  return profileId;
}

function normalizeProfileIds(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > PREVIEW_PROFILES.size) {
    throw new Error(`${field} must contain one to three profile ids.`);
  }
  const result = value.map((item, index) => normalizeProfileId(item, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} must contain unique profile ids.`);
  return result.sort();
}

function normalizePreviewScopes(value, candidateSha256) {
  const maximum = PREVIEW_PROFILES.size * (MAX_ROOT_SCOPES_PER_PROFILE + 2);
  if (!Array.isArray(value) || value.length < 3 || value.length > maximum) {
    throw new Error("previewScopes must contain a bounded complete preview set.");
  }
  const profiles = new Map();
  const identities = new Set();
  const scopes = value.map((raw, index) => {
    const field = `previewScopes[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${field} must be an object.`);
    for (const key of Object.keys(raw)) if (!PREVIEW_SCOPE_KEYS.has(key)) throw new Error(`${field} contains unknown field ${key}.`);
    for (const key of PREVIEW_SCOPE_KEYS) if (!Object.hasOwn(raw, key)) throw new Error(`${field}.${key} is required.`);
    const profileId = normalizeProfileId(raw.profileId, `${field}.profileId`);
    const role = cleanString(raw.role, `${field}.role`);
    if (!PREVIEW_ROLES.has(role)) throw new Error(`${field}.role is unsupported.`);
    const sheetName = cleanString(raw.sheetName, `${field}.sheetName`);
    if (sheetName.length > 31 || /[\\/:?*\[\]]/u.test(sheetName)) throw new Error(`${field}.sheetName is invalid.`);
    const range = parseRange(raw.rangeAddress, `${field}.rangeAddress`);
    if (role === "root" && range.startRow < 2) throw new Error(`${field}.rangeAddress must exclude the root header.`);
    const sourceSha256 = sha(raw.sourceSha256, `${field}.sourceSha256`);
    const previewSha256 = sha(raw.previewSha256, `${field}.previewSha256`);
    if (role === "root" && sourceSha256 !== candidateSha256) {
      throw new Error(`${field}.sourceSha256 must equal the bound candidateSha256.`);
    }
    const identity = JSON.stringify([profileId, role, sheetName, range.address, sourceSha256]);
    if (identities.has(identity)) throw new Error(`${field} duplicates an existing preview identity.`);
    identities.add(identity);
    const profile = profiles.get(profileId) ?? { counts: new Map(), roots: [] };
    profile.counts.set(role, (profile.counts.get(role) ?? 0) + 1);
    if (role === "root") profile.roots.push(range);
    profiles.set(profileId, profile);
    return { profileId, role, sheetName, rangeAddress: range.address, sourceSha256, previewSha256, range };
  });

  for (const [profileId, profile] of profiles) {
    const rootCount = profile.counts.get("root") ?? 0;
    if (rootCount < 1 || rootCount > MAX_ROOT_SCOPES_PER_PROFILE) {
      throw new Error(`previewScopes profile ${profileId} must contain one to ${MAX_ROOT_SCOPES_PER_PROFILE} root scopes.`);
    }
    if (profile.counts.get("detail") !== 1 || profile.counts.get("screenshot") !== 1) {
      throw new Error(`previewScopes profile ${profileId} must contain exactly one detail and one screenshot scope.`);
    }
    const first = profile.roots[0];
    for (let left = 0; left < profile.roots.length; left += 1) {
      const range = profile.roots[left];
      if (range.startColumn !== first.startColumn || range.endColumn !== first.endColumn) {
        throw new Error(`previewScopes profile ${profileId} root scopes must use one column span.`);
      }
      for (let right = left + 1; right < profile.roots.length; right += 1) {
        const other = profile.roots[right];
        if (range.startRow <= other.endRow && other.startRow <= range.endRow) {
          throw new Error(`previewScopes profile ${profileId} contains overlapping root ranges.`);
        }
      }
    }
  }

  scopes.sort((left, right) => left.profileId.localeCompare(right.profileId, "en")
    || PREVIEW_ROLES.get(left.role) - PREVIEW_ROLES.get(right.role)
    || left.range.startRow - right.range.startRow
    || left.range.startColumn - right.range.startColumn
    || left.rangeAddress.localeCompare(right.rangeAddress, "en")
    || left.previewSha256.localeCompare(right.previewSha256, "en"));
  return {
    profileIds: [...profiles.keys()].sort(),
    scopes: scopes.map(({ range: _range, ...scope }) => scope),
  };
}

export function buildGateBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Gate context must be an object.");
  if (![1, 2].includes(raw.version)) throw new Error("Gate context version must be 1 or 2.");
  const gate = cleanString(raw.gate, "gate");
  if (!["gate-1", "gate-2"].includes(gate)) throw new Error("gate must be gate-1 or gate-2.");
  const mode = cleanString(raw.mode, "mode");
  if (!MODES.has(mode)) throw new Error("mode is unsupported.");
  const commonKeys = ["version", "gate", "mode", "batchId", "operationDigest", "candidateRevision", "candidatePath", "candidateSha256"];
  const gateKeys = gate === "gate-1" ? ["factsDigest", "reviewPackageDigest"] : ["baselinePath", "baselineSha256", "finalAuditDigest"];
  const correctionKeys = mode === "ledger-reorder-correction" ? ["planFileSha256"] : [];
  const reimbursementKeys = raw.version === 2 && mode === "reimbursement-batch"
    ? ["candidatePlanSha256", "sourceCoverageDigest", "previewScopes", "affectedProfileIds"]
    : [];
  const allowed = new Set([...commonKeys, ...gateKeys, ...correctionKeys, ...reimbursementKeys]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Gate context contains unknown or persisted-authorization field ${key}.`);
  const required = [...commonKeys, ...gateKeys, ...correctionKeys, ...reimbursementKeys];
  for (const key of required) if (!Object.hasOwn(raw, key)) throw new Error(`Gate context ${key} is required.`);
  if (!Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) throw new Error("candidateRevision must be a positive safe integer.");

  const context = {
    version: raw.version,
    gate,
    mode,
    batchId: cleanString(raw.batchId, "batchId"),
    operationDigest: sha(raw.operationDigest, "operationDigest"),
    candidateRevision: raw.candidateRevision,
    candidatePath: absolute(raw.candidatePath, "candidatePath"),
    candidateSha256: sha(raw.candidateSha256, "candidateSha256"),
  };
  if (mode === "ledger-reorder-correction") context.planFileSha256 = sha(raw.planFileSha256, "planFileSha256");
  if (raw.version === 2 && mode === "reimbursement-batch") {
    context.candidatePlanSha256 = sha(raw.candidatePlanSha256, "candidatePlanSha256");
    context.sourceCoverageDigest = sha(raw.sourceCoverageDigest, "sourceCoverageDigest");
    const previews = normalizePreviewScopes(raw.previewScopes, context.candidateSha256);
    const affectedProfileIds = normalizeProfileIds(raw.affectedProfileIds, "affectedProfileIds");
    if (JSON.stringify(affectedProfileIds) !== JSON.stringify(previews.profileIds)) {
      throw new Error("affectedProfileIds must exactly match previewScopes.");
    }
    context.affectedProfileIds = affectedProfileIds;
    context.previewScopes = previews.scopes;
  }
  if (gate === "gate-1") {
    context.factsDigest = sha(raw.factsDigest, "factsDigest");
    context.reviewPackageDigest = sha(raw.reviewPackageDigest, "reviewPackageDigest");
  } else {
    context.baselinePath = absolute(raw.baselinePath, "baselinePath");
    context.baselineSha256 = sha(raw.baselineSha256, "baselineSha256");
    context.finalAuditDigest = sha(raw.finalAuditDigest, "finalAuditDigest");
  }
  return { context, bindingDigest: canonicalDigest(context) };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") throw new Error("Usage: build_gate_binding.mjs --input <gate-context.json>");
  const inputPath = path.resolve(process.argv[3]);
  const bytes = await fs.readFile(inputPath);
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`Gate context is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = buildGateBinding(raw);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
