import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildGateBinding } from "./build_gate_binding.mjs";
import { auditLedgerReorder, loadPlan } from "./ledger_reorder_common.mjs";
import {
  buildLedgerReorderPreviewIndex,
  validateLedgerReorderPreviewCoverage,
} from "./build_ledger_reorder_preview_index.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_INDEX_BYTES = 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_FILES = 100;
const ARTIFACT_KEYS = new Set(["version", "kind", "context", "bindingDigest", "digestPayload"]);
const PREVIEW_INDEX_KEYS = new Set([
  "version",
  "kind",
  "planFileSha256",
  "candidatePath",
  "candidateSha256",
  "files",
]);
const BOUND_PREVIEW_INDEX_KEYS = new Set([
  "path",
  "sha256",
  "planFileSha256",
  "candidatePath",
  "candidateSha256",
  "files",
]);
const COMMON_DIGEST_KEYS = [
  "version",
  "kind",
  "batchId",
  "operationDigest",
  "planFileSha256",
  "candidateRevision",
  "candidatePath",
  "candidateSha256",
  "audit",
];
const GATE1_DIGEST_KEYS = new Set([...COMMON_DIGEST_KEYS, "factsDigest", "previewIndex"]);
const GATE2_DIGEST_KEYS = new Set([...COMMON_DIGEST_KEYS, "baselinePath", "baselineSha256"]);

function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, field) {
  const keys = Object.keys(requireObject(value, field));
  for (const key of keys) {
    if (!expected.has(key)) throw new Error(`${field} contains unknown field ${key}.`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${field}.${key} is required.`);
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function requireSha256(value, field) {
  const normalized = requireString(value, field).toLowerCase();
  if (!SHA256_RE.test(normalized)) {
    throw new Error(`${field} must be 64 lowercase hexadecimal characters.`);
  }
  return normalized;
}

function requireAbsolutePath(value, field) {
  const input = requireString(value, field);
  if (!path.isAbsolute(input)) throw new Error(`${field} must be an absolute path.`);
  return path.resolve(input);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isStrictDescendant(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readStableRegularFile(filePath, field, { maxBytes = MAX_JSON_BYTES } = {}) {
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    throw new Error(`${field} cannot be inspected: ${cleanError(error)}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${field} must be a regular file and must not be a symbolic link.`);
  }
  if (before.size > maxBytes) throw new Error(`${field} exceeds the ${maxBytes}-byte safety limit.`);
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error(`${field} changed while it was being opened.`);
    }
    if (opened.size > maxBytes) throw new Error(`${field} exceeds the ${maxBytes}-byte safety limit.`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${field} became shorter while it was being read.`);
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, bytes.length);
    if (extraBytes !== 0) throw new Error(`${field} became longer while it was being read.`);
    const afterRead = await handle.stat();
    if (!sameFileSnapshot(opened, afterRead)) {
      throw new Error(`${field} changed while it was being read.`);
    }
    await handle.close();
    handle = undefined;
    const afterPath = await fs.lstat(filePath);
    if (afterPath.isSymbolicLink() || !afterPath.isFile() || !sameFileSnapshot(afterRead, afterPath)) {
      throw new Error(`${field} was replaced while it was being read.`);
    }
    return bytes;
  } catch (error) {
    throw new Error(`${field} could not be read safely: ${cleanError(error)}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readStrictJsonFile(filePath, field, options) {
  const bytes = await readStableRegularFile(filePath, field, options);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    return { bytes, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${field} is not valid UTF-8 JSON: ${cleanError(error)}`);
  }
}

async function assertRealDescendant(parentPath, childPath, field) {
  const [realParent, realChild] = await Promise.all([fs.realpath(parentPath), fs.realpath(childPath)]);
  if (!isStrictDescendant(realParent, realChild)) {
    throw new Error(`${field} must resolve strictly inside stagingRoot.`);
  }
}

async function assertOwnedStaging(plan) {
  const markerPath = path.join(plan.stagingRoot, ".codex-xhs-owner.json");
  const { value } = await readStrictJsonFile(markerPath, "staging owner marker", { maxBytes: MAX_MARKER_BYTES });
  const expected = new Set(["kind", "version", "token"]);
  requireExactKeys(value, expected, "staging owner marker");
  if (
    value.kind !== "xiaohongshu-reimbursement-temp" ||
    value.version !== 1 ||
    value.token !== plan.stagingToken
  ) {
    throw new Error("staging owner marker does not match the v2 plan.");
  }
}

async function loadPreviewIndex(previewIndexPath, plan) {
  const absolute = requireAbsolutePath(previewIndexPath, "preview index path");
  if (!isStrictDescendant(plan.stagingRoot, absolute)) {
    throw new Error("preview index path must be strictly inside stagingRoot.");
  }
  await assertRealDescendant(plan.stagingRoot, absolute, "preview index path");
  const { bytes, value } = await readStrictJsonFile(absolute, "preview index", {
    maxBytes: MAX_PREVIEW_INDEX_BYTES,
  });
  requireExactKeys(value, PREVIEW_INDEX_KEYS, "preview index");
  if (value.version !== 2 || value.kind !== "ledger-reorder-preview-index") {
    throw new Error("preview index must use version 2 and kind ledger-reorder-preview-index.");
  }
  const planFileSha256 = requireSha256(value.planFileSha256, "preview index.planFileSha256");
  if (planFileSha256 !== plan.planFileSha256) {
    throw new Error("preview index.planFileSha256 does not match the exact current plan file bytes.");
  }
  const candidatePath = requireAbsolutePath(value.candidatePath, "preview index.candidatePath");
  if (value.candidatePath !== candidatePath) {
    throw new Error("preview index.candidatePath must be normalized.");
  }
  if (!samePath(candidatePath, plan.activeCandidatePath)) {
    throw new Error("preview index.candidatePath does not match the active candidate bound by the plan.");
  }
  const candidateSha256 = requireSha256(value.candidateSha256, "preview index.candidateSha256");
  if (!Array.isArray(value.files) || value.files.length < 1) {
    throw new Error("preview index must contain at least one preview image.");
  }
  if (value.files.length > MAX_PREVIEW_FILES) {
    throw new Error(`preview index must not contain more than ${MAX_PREVIEW_FILES} images.`);
  }

  const seen = new Set();
  const files = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const entry = value.files[index];
    const field = `preview index.files[${index}]`;
    requireExactKeys(entry, new Set(["path", "sha256", "sheetName", "range"]), field);
    const imagePath = requireAbsolutePath(entry.path, `${field}.path`);
    const key = pathKey(imagePath);
    if (seen.has(key)) throw new Error(`${field}.path duplicates another preview path.`);
    seen.add(key);
    if (!isStrictDescendant(plan.stagingRoot, imagePath)) {
      throw new Error(`${field}.path must be strictly inside stagingRoot.`);
    }
    if (!IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
      throw new Error(`${field}.path must use .png, .jpg, or .jpeg.`);
    }
    await assertRealDescendant(plan.stagingRoot, imagePath, `${field}.path`);
    const imageBytes = await readStableRegularFile(imagePath, `${field}.path`, {
      maxBytes: MAX_PREVIEW_IMAGE_BYTES,
    });
    const extension = path.extname(imagePath).toLowerCase();
    const hasExpectedSignature = extension === ".png"
      ? imageBytes.length >= 8 && imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : imageBytes.length >= 3 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff;
    if (!hasExpectedSignature) {
      throw new Error(`${field}.path bytes do not match the ${extension} image signature.`);
    }
    const actualSha256 = sha256Bytes(imageBytes);
    const expectedSha256 = requireSha256(entry.sha256, `${field}.sha256`);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`${field}.sha256 does not match the preview image bytes.`);
    }
    files.push({
      path: imagePath,
      sha256: actualSha256,
      sheetName: requireString(entry.sheetName, `${field}.sheetName`),
      range: requireString(entry.range, `${field}.range`),
    });
  }
  validateLedgerReorderPreviewCoverage(plan, files);
  return {
    path: absolute,
    sha256: sha256Bytes(bytes),
    planFileSha256,
    candidatePath: plan.activeCandidatePath,
    candidateSha256,
    files,
  };
}

function assertDigestPayload(payload, gate) {
  const expected = gate === "gate-1" ? GATE1_DIGEST_KEYS : GATE2_DIGEST_KEYS;
  requireExactKeys(payload, expected, "gate artifact.digestPayload");
  if (payload.version !== 1) throw new Error("gate artifact.digestPayload.version must be 1.");
  const expectedKind = gate === "gate-1" ? "ledger-reorder-review-package" : "ledger-reorder-final-audit";
  if (payload.kind !== expectedKind) {
    throw new Error(`gate artifact.digestPayload.kind must be ${expectedKind}.`);
  }
  requireString(payload.batchId, "gate artifact.digestPayload.batchId");
  requireSha256(payload.operationDigest, "gate artifact.digestPayload.operationDigest");
  requireSha256(payload.planFileSha256, "gate artifact.digestPayload.planFileSha256");
  if (!Number.isSafeInteger(payload.candidateRevision) || payload.candidateRevision < 1) {
    throw new Error("gate artifact.digestPayload.candidateRevision must be a positive safe integer.");
  }
  const candidatePath = requireAbsolutePath(payload.candidatePath, "gate artifact.digestPayload.candidatePath");
  if (payload.candidatePath !== candidatePath) {
    throw new Error("gate artifact.digestPayload.candidatePath must be normalized.");
  }
  requireSha256(payload.candidateSha256, "gate artifact.digestPayload.candidateSha256");
  requireObject(payload.audit, "gate artifact.digestPayload.audit");
  if (gate === "gate-1") {
    requireSha256(payload.factsDigest, "gate artifact.digestPayload.factsDigest");
    const previewIndex = requireObject(payload.previewIndex, "gate artifact.digestPayload.previewIndex");
    requireExactKeys(previewIndex, BOUND_PREVIEW_INDEX_KEYS, "gate artifact.digestPayload.previewIndex");
    if (!Array.isArray(previewIndex.files) || previewIndex.files.length < 1) {
      throw new Error("gate artifact.digestPayload.previewIndex.files must not be empty.");
    }
    if (previewIndex.files.length > MAX_PREVIEW_FILES) {
      throw new Error(`gate artifact.digestPayload.previewIndex.files must not exceed ${MAX_PREVIEW_FILES} entries.`);
    }
    const previewIndexPath = requireAbsolutePath(
      previewIndex.path,
      "gate artifact.digestPayload.previewIndex.path",
    );
    if (previewIndex.path !== previewIndexPath) {
      throw new Error("gate artifact.digestPayload.previewIndex.path must be normalized.");
    }
    requireSha256(previewIndex.sha256, "gate artifact.digestPayload.previewIndex.sha256");
    requireSha256(
      previewIndex.planFileSha256,
      "gate artifact.digestPayload.previewIndex.planFileSha256",
    );
    const previewCandidatePath = requireAbsolutePath(
      previewIndex.candidatePath,
      "gate artifact.digestPayload.previewIndex.candidatePath",
    );
    if (previewIndex.candidatePath !== previewCandidatePath) {
      throw new Error("gate artifact.digestPayload.previewIndex.candidatePath must be normalized.");
    }
    requireSha256(
      previewIndex.candidateSha256,
      "gate artifact.digestPayload.previewIndex.candidateSha256",
    );
    const seen = new Set();
    for (let index = 0; index < previewIndex.files.length; index += 1) {
      const entry = previewIndex.files[index];
      const field = `gate artifact.digestPayload.previewIndex.files[${index}]`;
      requireExactKeys(entry, new Set(["path", "sha256", "sheetName", "range"]), field);
      const imagePath = requireAbsolutePath(entry.path, `${field}.path`);
      if (entry.path !== imagePath) throw new Error(`${field}.path must be normalized.`);
      if (!IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
        throw new Error(`${field}.path must use .png, .jpg, or .jpeg.`);
      }
      const key = pathKey(imagePath);
      if (seen.has(key)) throw new Error(`${field}.path duplicates another preview path.`);
      seen.add(key);
      requireSha256(entry.sha256, `${field}.sha256`);
      requireString(entry.sheetName, `${field}.sheetName`);
      requireString(entry.range, `${field}.range`);
    }
  } else {
    const baselinePath = requireAbsolutePath(payload.baselinePath, "gate artifact.digestPayload.baselinePath");
    if (payload.baselinePath !== baselinePath) {
      throw new Error("gate artifact.digestPayload.baselinePath must be normalized.");
    }
    requireSha256(payload.baselineSha256, "gate artifact.digestPayload.baselineSha256");
  }
}

export function validateLedgerReorderGateArtifact(raw) {
  requireExactKeys(raw, ARTIFACT_KEYS, "gate artifact");
  if (raw.version !== 1 || raw.kind !== "ledger-reorder-gate-artifact") {
    throw new Error("gate artifact must use version 1 and kind ledger-reorder-gate-artifact.");
  }
  const built = buildGateBinding(raw.context);
  const suppliedBindingDigest = requireSha256(raw.bindingDigest, "gate artifact.bindingDigest");
  if (built.bindingDigest !== suppliedBindingDigest) {
    throw new Error("gate artifact.bindingDigest does not match its context.");
  }
  const gate = built.context.gate;
  assertDigestPayload(raw.digestPayload, gate);
  const digestField = gate === "gate-1" ? "reviewPackageDigest" : "finalAuditDigest";
  if (canonicalDigest(raw.digestPayload) !== built.context[digestField]) {
    throw new Error(`gate artifact.${digestField} does not match digestPayload.`);
  }
  const commonMatches = [
    ["batchId", built.context.batchId],
    ["operationDigest", built.context.operationDigest],
    ["planFileSha256", built.context.planFileSha256],
    ["candidateRevision", built.context.candidateRevision],
    ["candidatePath", built.context.candidatePath],
    ["candidateSha256", built.context.candidateSha256],
  ];
  if (gate === "gate-1") commonMatches.push(["factsDigest", built.context.factsDigest]);
  else {
    commonMatches.push(["baselinePath", built.context.baselinePath]);
    commonMatches.push(["baselineSha256", built.context.baselineSha256]);
  }
  for (const [field, expected] of commonMatches) {
    const actual = raw.digestPayload[field];
    const equal = field.endsWith("Path") ? samePath(actual, expected) : actual === expected;
    if (!equal) throw new Error(`gate artifact.digestPayload.${field} does not match context.`);
  }
  if (gate === "gate-1") {
    const previewIndex = raw.digestPayload.previewIndex;
    if (previewIndex.planFileSha256 !== built.context.planFileSha256) {
      throw new Error("gate artifact preview index planFileSha256 does not match context.");
    }
    if (!samePath(previewIndex.candidatePath, built.context.candidatePath)) {
      throw new Error("gate artifact preview index candidatePath does not match context.");
    }
    if (previewIndex.candidateSha256 !== built.context.candidateSha256) {
      throw new Error("gate artifact preview index candidateSha256 does not match context.");
    }
  }
  if (raw.digestPayload.audit.ok !== true || raw.digestPayload.audit.audit !== "exhaustive") {
    throw new Error("gate artifact.digestPayload.audit must be a successful exhaustive audit.");
  }
  if (gate === "gate-2" && raw.digestPayload.audit.sourceSha256 !== built.context.baselineSha256) {
    throw new Error("gate artifact audit source SHA256 does not match the bound baseline.");
  }
  if (raw.digestPayload.audit.candidateSha256 !== built.context.candidateSha256) {
    throw new Error("gate artifact audit candidate SHA256 does not match the bound candidate.");
  }
  return {
    version: 1,
    kind: "ledger-reorder-gate-artifact",
    context: built.context,
    bindingDigest: built.bindingDigest,
    digestPayload: raw.digestPayload,
  };
}

export async function loadLedgerReorderGateArtifact(artifactPath) {
  const absolute = requireAbsolutePath(artifactPath, "gate artifact path");
  const { value } = await readStrictJsonFile(absolute, "gate artifact");
  return validateLedgerReorderGateArtifact(value);
}

function parseCli(args) {
  const allowed = new Set([
    "--gate",
    "--plan",
    "--batch-id",
    "--operation-digest",
    "--facts-digest",
    "--preview-index",
    "--out",
  ]);
  if (args.length % 2 !== 0) throw new Error("Every command-line flag must have exactly one value.");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag)) throw new Error(`Unknown command-line argument ${flag}.`);
    if (values.has(flag)) throw new Error(`Duplicate command-line argument ${flag}.`);
    if (!value) throw new Error(`${flag} requires a value.`);
    values.set(flag, value);
  }
  const gate = values.get("--gate");
  if (!gate || !["gate-1", "gate-2"].includes(gate)) {
    throw new Error("--gate must be gate-1 or gate-2.");
  }
  const required = new Set(["--gate", "--plan", "--batch-id", "--operation-digest", "--out"]);
  if (gate === "gate-1") {
    required.add("--facts-digest");
    required.add("--preview-index");
  }
  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`${flag} is required for ${gate}.`);
  }
  const gate2Forbidden = ["--facts-digest", "--preview-index"];
  if (gate === "gate-2") {
    for (const flag of gate2Forbidden) {
      if (values.has(flag)) throw new Error(`${flag} is not accepted for gate-2.`);
    }
  }
  if (values.size !== required.size) throw new Error("Command line contains arguments not permitted for this gate.");
  return {
    gate,
    planPath: values.get("--plan"),
    batchId: values.get("--batch-id"),
    operationDigest: values.get("--operation-digest"),
    factsDigest: values.get("--facts-digest"),
    previewIndexPath: values.get("--preview-index"),
    outputPath: values.get("--out"),
  };
}

export function parseLedgerReorderGateArtifactCli(args) {
  return parseCli(args);
}

export async function buildLedgerReorderGateArtifact(options) {
  const gate = requireString(options?.gate, "gate");
  if (!["gate-1", "gate-2"].includes(gate)) throw new Error("gate must be gate-1 or gate-2.");
  const plan = await loadPlan(options.planPath);
  if (plan.version !== 2) throw new Error("Correction gate artifacts require a mechanically generated v2 plan.");
  await assertOwnedStaging(plan);
  const outputPath = requireAbsolutePath(options.outputPath, "output path");
  if (!isStrictDescendant(plan.stagingRoot, outputPath)) {
    throw new Error("output path must be strictly inside stagingRoot.");
  }
  const outputParent = path.dirname(outputPath);
  const [realStagingRoot, realOutputParent] = await Promise.all([
    fs.realpath(plan.stagingRoot),
    fs.realpath(outputParent),
  ]);
  if (!samePath(realStagingRoot, realOutputParent) && !isStrictDescendant(realStagingRoot, realOutputParent)) {
    throw new Error("output path parent must resolve inside stagingRoot.");
  }
  try {
    await fs.lstat(outputPath);
    throw new Error("output path already exists; refusing to overwrite it.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const batchId = requireString(options.batchId, "batchId");
  const operationDigest = requireSha256(options.operationDigest, "operationDigest");
  let factsDigest;
  let previewIndexOutputPath;
  if (gate === "gate-1") {
    factsDigest = requireSha256(options.factsDigest, "factsDigest");
    previewIndexOutputPath = requireAbsolutePath(options.previewIndexPath, "preview index output path");
    if (samePath(previewIndexOutputPath, outputPath)) {
      throw new Error("preview index output path and gate artifact output path must be different.");
    }
  } else if (options.factsDigest !== undefined || options.previewIndexPath !== undefined) {
    throw new Error("factsDigest and previewIndexPath are not accepted for gate-2.");
  }
  const audit = await auditLedgerReorder(plan, plan.activeCandidatePath);
  if (audit.ok !== true || audit.audit !== "exhaustive") {
    throw new Error("Active candidate did not produce a successful exhaustive audit.");
  }
  let previewIndex;
  if (gate === "gate-1") {
    await buildLedgerReorderPreviewIndex({
      planPath: plan.planPath,
      candidatePath: plan.activeCandidatePath,
      outputPath: previewIndexOutputPath,
      expectedCandidateSha256: audit.candidateSha256,
    });
    previewIndex = await loadPreviewIndex(previewIndexOutputPath, plan);
    if (previewIndex.candidateSha256 !== audit.candidateSha256) {
      throw new Error("preview index.candidateSha256 does not match the current audited candidate bytes.");
    }
  }
  const common = {
    version: 1,
    batchId,
    operationDigest,
    planFileSha256: plan.planFileSha256,
    candidateRevision: plan.candidateRevision,
    candidatePath: plan.activeCandidatePath,
    candidateSha256: audit.candidateSha256,
  };

  let digestPayload;
  let context;
  if (gate === "gate-1") {
    digestPayload = {
      ...common,
      kind: "ledger-reorder-review-package",
      factsDigest,
      audit,
      previewIndex,
    };
    context = {
      ...common,
      gate,
      mode: "ledger-reorder-correction",
      factsDigest,
      reviewPackageDigest: canonicalDigest(digestPayload),
    };
  } else {
    digestPayload = {
      ...common,
      kind: "ledger-reorder-final-audit",
      baselinePath: plan.sourcePath,
      baselineSha256: audit.sourceSha256,
      audit,
    };
    context = {
      ...common,
      gate,
      mode: "ledger-reorder-correction",
      baselinePath: plan.sourcePath,
      baselineSha256: audit.sourceSha256,
      finalAuditDigest: canonicalDigest(digestPayload),
    };
  }

  const binding = buildGateBinding(context);
  const artifact = validateLedgerReorderGateArtifact({
    version: 1,
    kind: "ledger-reorder-gate-artifact",
    context: binding.context,
    bindingDigest: binding.bindingDigest,
    digestPayload,
  });
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const handle = await fs.open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const written = await readStableRegularFile(outputPath, "written gate artifact");
  if (!written.equals(bytes)) throw new Error("Written gate artifact bytes differ from the validated artifact.");
  return {
    artifact,
    artifactPath: outputPath,
    artifactSha256: sha256Bytes(written),
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const result = await buildLedgerReorderGateArtifact(options);
  const response = {
    ok: true,
    status: "gate_artifact_created",
    gate: result.artifact.context.gate,
    artifactPath: result.artifactPath,
    artifactSha256: result.artifactSha256,
    bindingDigest: result.artifact.bindingDigest,
    context: result.artifact.context,
  };
  if (result.artifact.context.gate === "gate-1") {
    response.previewIndex = result.artifact.digestPayload.previewIndex;
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    await main();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: cleanError(error) })}\n`);
    process.exitCode = 1;
  } finally {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  }
}
