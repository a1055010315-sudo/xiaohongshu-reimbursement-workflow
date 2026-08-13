import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPlan } from "./ledger_reorder_common.mjs";

const MAX_MARKER_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_FILES = 100;
const TARGET_ROWS_PER_PREVIEW = 40;
const PREVIEW_FILE_KEYS = new Set(["path", "sha256", "sheetName", "range"]);
const RENDER_WORKER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "render_ledger_reorder_preview_worker.mjs",
);
const WINDOWS_ARTIFACT_RENDER_TEARDOWN_EXIT = 0xc0000409;

function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function requireCanonicalAbsolutePath(value, field) {
  const input = requireString(value, field);
  if (!path.isAbsolute(input)) throw new Error(`${field} must be an absolute path.`);
  const resolved = path.resolve(input);
  if (input !== resolved) throw new Error(`${field} must be normalized.`);
  return resolved;
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

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function numberToColumn(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function columnToNumber(column) {
  let result = 0;
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function requireExactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!expected.has(key)) throw new Error(`${field} contains unknown field ${key}.`);
  }
  for (const key of expected) {
    if (!(key in value)) throw new Error(`${field}.${key} is required.`);
  }
}

function parsePreviewRange(value, field) {
  const normalized = requireString(value, field).toUpperCase();
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(normalized);
  if (!match) throw new Error(`${field} must be a normalized rectangular A1 range.`);
  const parsed = {
    startCol: columnToNumber(match[1]),
    startRow: Number(match[2]),
    endCol: columnToNumber(match[3]),
    endRow: Number(match[4]),
  };
  if (
    normalized !== value || parsed.startCol < 1 || parsed.endCol > 16_384 ||
    parsed.startRow < 1 || parsed.endRow > 1_048_576 ||
    parsed.startCol > parsed.endCol || parsed.startRow > parsed.endRow
  ) {
    throw new Error(`${field} must be a normalized in-grid rectangular A1 range.`);
  }
  return parsed;
}

async function readStableRegularFile(filePath, field, maxBytes) {
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
    if (!sameFileSnapshot(opened, afterRead)) throw new Error(`${field} changed while it was being read.`);
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

async function stableFileSha256(filePath, field, maxBytes = MAX_CANDIDATE_BYTES) {
  return sha256Bytes(await readStableRegularFile(filePath, field, maxBytes));
}

async function assertOwnedStaging(plan) {
  const markerPath = path.join(plan.stagingRoot, ".codex-xhs-owner.json");
  const bytes = await readStableRegularFile(markerPath, "staging owner marker", MAX_MARKER_BYTES);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`staging owner marker is not valid UTF-8 JSON: ${cleanError(error)}`);
  }
  requireExactKeys(value, new Set(["kind", "version", "token"]), "staging owner marker");
  if (
    value.kind !== "xiaohongshu-reimbursement-temp" || value.version !== 1 || value.token !== plan.stagingToken
  ) {
    throw new Error("staging owner marker does not match the v2 plan.");
  }
}

function previewSegments(plan) {
  const rowCount = plan.physical.endRow - plan.physical.startRow + 1;
  const rowsPerPreview = Math.max(TARGET_ROWS_PER_PREVIEW, Math.ceil(rowCount / MAX_PREVIEW_FILES));
  const startColumn = numberToColumn(plan.physical.startCol);
  const endColumn = numberToColumn(plan.physical.endCol);
  const segments = [];
  for (let startRow = plan.physical.startRow; startRow <= plan.physical.endRow; startRow += rowsPerPreview) {
    const endRow = Math.min(plan.physical.endRow, startRow + rowsPerPreview - 1);
    segments.push({
      sheetName: plan.sheetName,
      range: `${startColumn}${startRow}:${endColumn}${endRow}`,
    });
  }
  return segments;
}

export function validateLedgerReorderPreviewCoverage(plan, files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PREVIEW_FILES) {
    throw new Error(`preview files must contain between 1 and ${MAX_PREVIEW_FILES} entries.`);
  }
  let nextRow = plan.physical.startRow;
  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index];
    const field = `preview files[${index}]`;
    requireExactKeys(entry, PREVIEW_FILE_KEYS, field);
    if (entry.sheetName !== plan.sheetName) throw new Error(`${field}.sheetName must equal the plan worksheet.`);
    const range = parsePreviewRange(entry.range, `${field}.range`);
    if (range.startCol !== plan.physical.startCol || range.endCol !== plan.physical.endCol) {
      throw new Error(`${field}.range must cover every column in plan.physicalRange.`);
    }
    if (range.startRow !== nextRow) {
      throw new Error(`${field}.range leaves a gap or overlap in plan.physicalRange row coverage.`);
    }
    if (range.endRow > plan.physical.endRow) {
      throw new Error(`${field}.range extends past plan.physicalRange.`);
    }
    nextRow = range.endRow + 1;
  }
  if (nextRow !== plan.physical.endRow + 1) {
    throw new Error("preview files do not cover the final row of plan.physicalRange.");
  }
  return true;
}

async function writeExclusiveSynced(filePath, bytes) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safelyRemoveCreated(filePath, expectedSha256, maxBytes) {
  try {
    const actualSha256 = await stableFileSha256(filePath, "created temporary artifact", maxBytes);
    if (actualSha256 === expectedSha256) await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") return cleanError(error);
  }
  return null;
}

export async function renderLedgerReorderPreviewSet(plan) {
  await assertOwnedStaging(plan);
  const candidateBytes = await readStableRegularFile(
    plan.activeCandidatePath,
    "active candidate",
    MAX_CANDIDATE_BYTES,
  );
  const candidateSha256 = sha256Bytes(candidateBytes);
  const segments = previewSegments(plan);
  const jobRoot = await fs.mkdtemp(path.join(plan.stagingRoot, ".codex-preview-render-"));
  const snapshotPath = path.join(jobRoot, "candidate.xlsx");
  const requestPath = path.join(jobRoot, "request.json");
  const outputDir = path.join(jobRoot, "rendered");
  let primaryError;
  let result;
  const renderNameWidth = Math.max(3, String(segments.length).length);
  const expectedRenderNames = segments.map(
    (_, index) => `segment-${String(index + 1).padStart(renderNameWidth, "0")}.png`,
  );
  try {
    await fs.mkdir(outputDir);
    await writeExclusiveSynced(snapshotPath, candidateBytes);
    const requestBytes = Buffer.from(`${JSON.stringify({
      version: 1,
      candidatePath: snapshotPath,
      outputDir,
      sheetName: plan.sheetName,
      segments,
    }, null, 2)}\n`, "utf8");
    await writeExclusiveSynced(requestPath, requestBytes);
    const worker = spawnSync(process.execPath, [RENDER_WORKER, requestPath], {
      encoding: "utf8",
      env: process.env,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (worker.error) throw worker.error;
    const payloads = `${worker.stdout}\n${worker.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const payload = payloads.findLast((value) => value && typeof value === "object" && "ok" in value);
    if (!payload) throw new Error("Controlled renderer returned no machine-readable result.");
    if (payload.ok !== true) throw new Error(`Controlled renderer failed: ${requireString(payload.error, "renderer error")}`);
    const acceptedExit =
      worker.status === 0 ||
      (process.platform === "win32" && worker.status === WINDOWS_ARTIFACT_RENDER_TEARDOWN_EXIT);
    if (!acceptedExit) {
      throw new Error(`Controlled renderer exited unexpectedly with status ${worker.status} and signal ${worker.signal}.`);
    }
    if (!Array.isArray(payload.files) || payload.files.length !== segments.length) {
      throw new Error("Controlled renderer returned the wrong segment count.");
    }
    const rendered = [];
    for (let index = 0; index < segments.length; index += 1) {
      const expectedPath = path.join(outputDir, expectedRenderNames[index]);
      const reported = payload.files[index];
      requireExactKeys(reported, PREVIEW_FILE_KEYS, `renderer files[${index}]`);
      if (
        reported.path !== expectedPath ||
        reported.sheetName !== segments[index].sheetName ||
        reported.range !== segments[index].range
      ) {
        throw new Error(`Controlled renderer segment ${index} metadata is not canonical.`);
      }
      const bytes = await readStableRegularFile(expectedPath, `rendered segment ${index}`, MAX_PREVIEW_IMAGE_BYTES);
      if (
        bytes.length < 8 ||
        !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ) {
        throw new Error(`Controlled renderer segment ${index} is not a PNG.`);
      }
      const actualSha256 = sha256Bytes(bytes);
      if (reported.sha256 !== actualSha256) {
        throw new Error(`Controlled renderer segment ${index} SHA256 is incorrect.`);
      }
      rendered.push({ ...segments[index], bytes, sha256: actualSha256 });
    }
    const candidateSha256After = await stableFileSha256(plan.activeCandidatePath, "active candidate after render");
    if (candidateSha256After !== candidateSha256) {
      throw new Error("Active candidate changed while its bound previews were being rendered.");
    }
    result = { candidateSha256, rendered };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    const [realStagingRoot, realJobRoot] = await Promise.all([
      fs.realpath(plan.stagingRoot),
      fs.realpath(jobRoot),
    ]);
    if (!isStrictDescendant(realStagingRoot, realJobRoot)) {
      throw new Error("render job directory escaped stagingRoot");
    }
    const rootNames = (await fs.readdir(jobRoot)).sort();
    const expectedRootNames = ["candidate.xlsx", "rendered", "request.json"].sort();
    const renderNames = (await fs.readdir(outputDir)).sort();
    if (
      rootNames.join("\0") !== expectedRootNames.join("\0") ||
      renderNames.join("\0") !== [...expectedRenderNames].sort().join("\0")
    ) {
      throw new Error("render job directory contains unexpected files and was preserved");
    }
    await fs.rm(jobRoot, { recursive: true });
  } catch (error) {
    cleanupError = cleanError(error);
  }
  if (cleanupError) {
    throw new Error(`${primaryError ? `${cleanError(primaryError)} ` : ""}Render job cleanup failed at ${jobRoot}: ${cleanupError}`);
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function verifyLedgerReorderPreviewRerender(plan, previewIndex) {
  validateLedgerReorderPreviewCoverage(plan, previewIndex.files);
  const rerendered = await renderLedgerReorderPreviewSet(plan);
  if (rerendered.candidateSha256 !== previewIndex.candidateSha256) {
    throw new Error("Preview index candidateSha256 does not match the rerendered active candidate bytes.");
  }
  if (rerendered.rendered.length !== previewIndex.files.length) {
    throw new Error("Preview index segment count does not match a fresh controlled rerender.");
  }
  for (let index = 0; index < rerendered.rendered.length; index += 1) {
    const expected = previewIndex.files[index];
    const actual = rerendered.rendered[index];
    if (
      expected.sheetName !== actual.sheetName || expected.range !== actual.range || expected.sha256 !== actual.sha256
    ) {
      throw new Error(`Preview index segment ${index} does not match a fresh controlled rerender.`);
    }
  }
  return { candidateSha256: rerendered.candidateSha256, previewCount: rerendered.rendered.length };
}

export function parseLedgerReorderPreviewIndexCli(args) {
  if (args.length !== 6 || args.length % 2 !== 0) {
    throw new Error(
      "Usage: build_ledger_reorder_preview_index.mjs --plan <plan.json> --candidate <active.xlsx> --out <new-index.json>",
    );
  }
  const values = new Map();
  const allowed = new Set(["--plan", "--candidate", "--out"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag)) throw new Error(`Unknown command-line argument ${flag}.`);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (values.has(flag)) throw new Error(`Duplicate command-line argument ${flag}.`);
    values.set(flag, value);
  }
  for (const flag of allowed) {
    if (!values.has(flag)) throw new Error(`${flag} is required.`);
  }
  return {
    planPath: values.get("--plan"),
    candidatePath: values.get("--candidate"),
    outputPath: values.get("--out"),
  };
}

export async function buildLedgerReorderPreviewIndex(options) {
  const plan = await loadPlan(options?.planPath);
  if (plan.version !== 2) throw new Error("Preview indexes require a mechanically generated v2 plan.");
  await assertOwnedStaging(plan);
  const candidatePath = requireCanonicalAbsolutePath(options?.candidatePath, "candidate path");
  if (!samePath(candidatePath, plan.activeCandidatePath)) {
    throw new Error("candidate path must be the active candidate bound by the current plan.");
  }
  const outputPath = requireCanonicalAbsolutePath(options?.outputPath, "output path");
  if (!isStrictDescendant(plan.stagingRoot, outputPath)) {
    throw new Error("output path must be strictly inside stagingRoot.");
  }
  const [realRoot, realOutputParent] = await Promise.all([
    fs.realpath(plan.stagingRoot),
    fs.realpath(path.dirname(outputPath)),
  ]);
  if (!samePath(realRoot, realOutputParent) && !isStrictDescendant(realRoot, realOutputParent)) {
    throw new Error("output path parent must resolve inside stagingRoot.");
  }
  try {
    await fs.lstat(outputPath);
    throw new Error("output path already exists; refusing to overwrite it.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const previewSet = await renderLedgerReorderPreviewSet(plan);
  if (options?.expectedCandidateSha256 !== undefined) {
    const expectedCandidateSha256 = requireString(
      options.expectedCandidateSha256,
      "expectedCandidateSha256",
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedCandidateSha256)) {
      throw new Error("expectedCandidateSha256 must be 64 lowercase hexadecimal characters.");
    }
    if (previewSet.candidateSha256 !== expectedCandidateSha256) {
      throw new Error("Active candidate bytes changed after the exhaustive audit and before controlled rendering.");
    }
  }
  const outputExtension = path.extname(outputPath);
  if (outputExtension.toLowerCase() !== ".json") throw new Error("output path must use a .json extension.");
  const stem = path.basename(outputPath, outputExtension);
  const width = Math.max(3, String(previewSet.rendered.length).length);
  const files = previewSet.rendered.map((entry, index) => ({
    path: path.join(
      path.dirname(outputPath),
      `${stem}.preview-${String(index + 1).padStart(width, "0")}-of-${String(previewSet.rendered.length).padStart(width, "0")}.png`,
    ),
    sha256: entry.sha256,
    sheetName: entry.sheetName,
    range: entry.range,
  }));
  validateLedgerReorderPreviewCoverage(plan, files);
  for (const entry of files) {
    if (!isStrictDescendant(plan.stagingRoot, entry.path)) {
      throw new Error("derived preview output must stay strictly inside stagingRoot.");
    }
    try {
      await fs.lstat(entry.path);
      throw new Error(`preview output already exists; refusing to overwrite it: ${entry.path}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const index = {
    version: 2,
    kind: "ledger-reorder-preview-index",
    planFileSha256: plan.planFileSha256,
    candidatePath: plan.activeCandidatePath,
    candidateSha256: previewSet.candidateSha256,
    files,
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  const created = [];
  try {
    for (let indexNumber = 0; indexNumber < files.length; indexNumber += 1) {
      const file = files[indexNumber];
      const bytes = previewSet.rendered[indexNumber].bytes;
      await writeExclusiveSynced(file.path, bytes);
      created.push({ path: file.path, sha256: file.sha256, maxBytes: MAX_PREVIEW_IMAGE_BYTES });
    }
    await writeExclusiveSynced(outputPath, indexBytes);
    created.push({ path: outputPath, sha256: sha256Bytes(indexBytes), maxBytes: 1024 * 1024 });
    const written = await readStableRegularFile(outputPath, "written preview index", 1024 * 1024);
    if (!written.equals(indexBytes)) throw new Error("Written preview index bytes differ from the validated index.");
    return { index, indexPath: outputPath, indexSha256: sha256Bytes(written) };
  } catch (error) {
    const cleanupErrors = [];
    for (const entry of created.reverse()) {
      const cleanupError = await safelyRemoveCreated(entry.path, entry.sha256, entry.maxBytes);
      if (cleanupError) cleanupErrors.push(`${entry.path}: ${cleanupError}`);
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`${cleanError(error)} Cleanup failed: ${cleanupErrors.join(" | ")}`);
    }
    throw error;
  }
}

async function main() {
  const options = parseLedgerReorderPreviewIndexCli(process.argv.slice(2));
  const result = await buildLedgerReorderPreviewIndex(options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "preview_index_created",
    indexPath: result.indexPath,
    indexSha256: result.indexSha256,
    planFileSha256: result.index.planFileSha256,
    candidatePath: result.index.candidatePath,
    candidateSha256: result.index.candidateSha256,
    previewCount: result.index.files.length,
  })}\n`);
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
