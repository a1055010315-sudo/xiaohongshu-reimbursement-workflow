import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_RE = /^[0-9a-f]{64}$/;
const MODES = new Set(["reimbursement-batch", "ledger-reorder-correction"]);

function cleanString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function digest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
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

export function buildGateBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Gate context must be an object.");
  if (![1, 2].includes(raw.version)) throw new Error("Gate context version must be 1 or 2.");
  const gate = cleanString(raw.gate, "gate");
  if (!["gate-1", "gate-2"].includes(gate)) throw new Error("gate must be gate-1 or gate-2.");
  const mode = cleanString(raw.mode, "mode");
  if (!MODES.has(mode)) throw new Error("mode is unsupported.");
  const commonKeys = [
    "version",
    "gate",
    "mode",
    "batchId",
    "operationDigest",
    "candidateRevision",
    "candidatePath",
    "candidateSha256",
  ];
  const gateKeys = gate === "gate-1"
    ? ["factsDigest", "reviewPackageDigest"]
    : ["baselinePath", "baselineSha256", "finalAuditDigest"];
  const correctionKeys = mode === "ledger-reorder-correction" ? ["planFileSha256"] : [];
  const reimbursementV2Keys = raw.version === 2 && mode === "reimbursement-batch"
    ? ["candidatePlanSha256", "sourceCoverageDigest"]
    : [];
  const allowed = new Set([...commonKeys, ...gateKeys, ...correctionKeys, ...reimbursementV2Keys]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`Gate context contains unknown or persisted-authorization field ${key}.`);
  }
  for (const key of allowed) {
    if (!(key in raw)) throw new Error(`Gate context ${key} is required.`);
  }
  if (!Number.isSafeInteger(raw.candidateRevision) || raw.candidateRevision < 1) {
    throw new Error("candidateRevision must be a positive safe integer.");
  }
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
  if (mode === "ledger-reorder-correction") {
    context.planFileSha256 = sha(raw.planFileSha256, "planFileSha256");
  }
  if (raw.version === 2 && mode === "reimbursement-batch") {
    context.candidatePlanSha256 = sha(raw.candidatePlanSha256, "candidatePlanSha256");
    context.sourceCoverageDigest = sha(raw.sourceCoverageDigest, "sourceCoverageDigest");
  }
  if (gate === "gate-1") {
    context.factsDigest = sha(raw.factsDigest, "factsDigest");
    context.reviewPackageDigest = sha(raw.reviewPackageDigest, "reviewPackageDigest");
  } else {
    context.baselinePath = absolute(raw.baselinePath, "baselinePath");
    context.baselineSha256 = sha(raw.baselineSha256, "baselineSha256");
    context.finalAuditDigest = sha(raw.finalAuditDigest, "finalAuditDigest");
  }
  return { context, bindingDigest: digest(context) };
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    throw new Error("Usage: build_gate_binding.mjs --input <gate-context.json>");
  }
  const inputPath = path.resolve(process.argv[3]);
  const bytes = await fs.readFile(inputPath);
  let raw;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
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
