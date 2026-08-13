#!/usr/bin/env node

import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const WINDOWS_INVALID_BASENAME = /[<>:"/\\|?*\u0000-\u001f]/u;
const REVISION_MARKER = "_修正版";
const PLAN_KEYS = new Set([
  "version",
  "archivePath",
  "historyPath",
  "artifactKind",
  "candidatePath",
  "candidateSha256",
  "candidateRevision",
  "expectedCurrentPath",
  "expectedCurrentSha256",
]);
const LOCK_RECORD_KEYS = new Set([
  "version",
  "kind",
  "pid",
  "processStartIdentity",
  "ownerToken",
  "artifactKind",
  "extension",
  "archivePath",
  "historyPath",
  "candidateRevision",
  "candidateDestinationPath",
  "candidateSha256",
  "expectedCurrentPath",
  "expectedCurrentSha256",
  "expectedHistoryPath",
  "candidateCopyPath",
  "stagingPath",
  "historyStagingPath",
  "oldStagingPath",
  "markerPath",
  "markerTempPath",
]);
const RECOVERY_GUARD_KEYS = new Set([
  "version",
  "kind",
  "pid",
  "processStartIdentity",
  "ownerToken",
  "lockOwnerToken",
  "lockPath",
  "artifactKind",
  "extension",
  "archivePath",
]);
const TRANSACTION_MARKER_KEYS = new Set([
  "version",
  "kind",
  "ownerToken",
  "lockPath",
  "artifactKind",
  "extension",
]);

function fail(message) {
  throw new Error(message);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === "win32") {
      const command = `[Console]::Out.Write(([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks))`;
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10_000,
      });
      const ticks = result.status === 0 ? result.stdout.trim() : "";
      return /^[1-9][0-9]*$/u.test(ticks) ? `windows-ticks-${ticks}` : null;
    }
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).split(" ");
      const startTicks = fields[19];
      return /^[1-9][0-9]*$/u.test(startTicks) ? `linux-start-${startTicks}` : null;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      shell: false,
      timeout: 10_000,
    });
    const start = result.status === 0 ? result.stdout.trim().replace(/\s+/gu, " ") : "";
    return start === "" ? null : `ps-start-${start}`;
  } catch {
    return null;
  }
}

const CURRENT_PROCESS_START_IDENTITY = processStartIdentity(process.pid);
if (CURRENT_PROCESS_START_IDENTITY === null) {
  fail("Could not bind the promotion process to a stable OS process-start identity.");
}

function processIdentityHash(identity) {
  return crypto.createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 20);
}

function cleanAbsolutePath(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string.`);
  if (!path.isAbsolute(value)) fail(`${field} must be an absolute path.`);
  return path.resolve(value);
}

function cleanSha256(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${field} must contain exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function cleanArtifactKind(value) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    fail("artifactKind must be a non-empty, trimmed string.");
  }
  if (
    value === "." ||
    value === ".." ||
    WINDOWS_INVALID_BASENAME.test(value) ||
    /[. ]$/u.test(value) ||
    /_修正版[0-9]+$/u.test(value)
  ) {
    fail("artifactKind is not a safe revision-family basename.");
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function expectedCandidateFilename(plan) {
  return `${plan.artifactKind}${REVISION_MARKER}${plan.candidateRevision}${plan.extension}`;
}

export function parseRevisionFilename(filename, plan) {
  const baseName = `${plan.artifactKind}${plan.extension}`;
  if (filename === baseName) return 0;

  const revisionPattern = new RegExp(
    `^${escapeRegExp(plan.artifactKind)}${escapeRegExp(REVISION_MARKER)}([1-9][0-9]*)${escapeRegExp(plan.extension)}$`,
    "u",
  );
  const match = revisionPattern.exec(filename);
  if (!match) {
    const resemblesFamily =
      filename.startsWith(`${plan.artifactKind}${REVISION_MARKER}`) && filename.endsWith(plan.extension);
    if (resemblesFamily) fail(`Malformed revision filename for ${plan.artifactKind}: ${filename}.`);
    return null;
  }
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail(`Revision number is not a positive safe integer: ${filename}.`);
  }
  return revision;
}

export function normalizePromotionPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    fail("Promotion plan must be a JSON object.");
  }
  for (const key of Object.keys(rawPlan)) {
    if (!PLAN_KEYS.has(key)) fail(`Unknown promotion plan field: ${key}.`);
  }
  for (const key of PLAN_KEYS) {
    if (!Object.hasOwn(rawPlan, key)) fail(`Missing promotion plan field: ${key}.`);
  }
  if (rawPlan.version !== 1) fail("Promotion plan version must be 1.");

  const archivePath = cleanAbsolutePath(rawPlan.archivePath, "archivePath");
  const historyPath = cleanAbsolutePath(rawPlan.historyPath, "historyPath");
  if (samePath(archivePath, historyPath)) fail("archivePath and historyPath must be different directories.");

  const boundRootPath = path.dirname(archivePath);
  if (!samePath(boundRootPath, path.dirname(historyPath))) {
    fail("archivePath and historyPath must be sibling directories under the same bound root.");
  }
  if (samePath(boundRootPath, archivePath) || samePath(boundRootPath, historyPath)) {
    fail("archivePath and historyPath must be strict children of the bound root.");
  }

  const artifactKind = cleanArtifactKind(rawPlan.artifactKind);
  const candidatePath = cleanAbsolutePath(rawPlan.candidatePath, "candidatePath");
  const candidateSha256 = cleanSha256(rawPlan.candidateSha256, "candidateSha256");
  if (!Number.isSafeInteger(rawPlan.candidateRevision) || rawPlan.candidateRevision < 1) {
    fail("candidateRevision must be a positive safe integer.");
  }
  const candidateRevision = rawPlan.candidateRevision;
  const extension = path.extname(candidatePath);
  if (extension === "" || extension === "." || WINDOWS_INVALID_BASENAME.test(extension)) {
    fail("candidatePath must have a safe file extension.");
  }

  const candidateFilename = path.basename(candidatePath);
  const partialPlan = { artifactKind, candidateRevision, extension };
  if (candidateFilename !== expectedCandidateFilename(partialPlan)) {
    fail(
      `candidatePath filename must be ${expectedCandidateFilename(partialPlan)} for candidateRevision ${candidateRevision}.`,
    );
  }

  const expectedPathIsNull = rawPlan.expectedCurrentPath === null;
  const expectedShaIsNull = rawPlan.expectedCurrentSha256 === null;
  if (expectedPathIsNull !== expectedShaIsNull) {
    fail("expectedCurrentPath and expectedCurrentSha256 must both be null or both be populated.");
  }

  let expectedCurrentPath = null;
  let expectedCurrentSha256 = null;
  let expectedCurrentRevision = null;
  if (!expectedPathIsNull) {
    expectedCurrentPath = cleanAbsolutePath(rawPlan.expectedCurrentPath, "expectedCurrentPath");
    expectedCurrentSha256 = cleanSha256(rawPlan.expectedCurrentSha256, "expectedCurrentSha256");
    if (!samePath(path.dirname(expectedCurrentPath), archivePath)) {
      fail("expectedCurrentPath must be a direct file child of archivePath.");
    }
    expectedCurrentRevision = parseRevisionFilename(path.basename(expectedCurrentPath), {
      artifactKind,
      extension,
    });
    if (expectedCurrentRevision === null) {
      fail("expectedCurrentPath filename does not belong to artifactKind.");
    }
  }

  return {
    version: 1,
    archivePath,
    historyPath,
    boundRootPath,
    artifactKind,
    candidatePath,
    candidateSha256,
    candidateRevision,
    candidateFilename,
    candidateDestinationPath: path.join(archivePath, candidateFilename),
    extension,
    expectedCurrentPath,
    expectedCurrentSha256,
    expectedCurrentRevision,
  };
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

async function assertPlainDirectory(directoryPath, field) {
  let stat;
  try {
    stat = await fs.lstat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${field} does not exist: ${directoryPath}.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${field} must be a real directory, not a link or another file type.`);
  }
}

async function assertBoundDirectories(plan, { createHistory = false } = {}) {
  await assertPlainDirectory(plan.boundRootPath, "bound root");
  await assertPlainDirectory(plan.archivePath, "archivePath");
  try {
    await assertPlainDirectory(plan.historyPath, "historyPath");
  } catch (error) {
    if (!createHistory || !String(error?.message).startsWith("historyPath does not exist:")) throw error;
    await fs.mkdir(plan.historyPath, { recursive: false });
    await assertPlainDirectory(plan.historyPath, "historyPath");
  }

  const [rootReal, archiveReal, historyReal] = await Promise.all([
    fs.realpath(plan.boundRootPath),
    fs.realpath(plan.archivePath),
    fs.realpath(plan.historyPath),
  ]);
  if (!samePath(path.dirname(archiveReal), rootReal) || !samePath(path.dirname(historyReal), rootReal)) {
    fail("archivePath and historyPath do not resolve to sibling directories in the bound root.");
  }
  if (samePath(archiveReal, historyReal)) {
    fail("archivePath and historyPath resolve to the same directory.");
  }
}

async function assertBoundParentsBeforeMutation(plan) {
  await assertPlainDirectory(plan.boundRootPath, "bound root");
  await assertPlainDirectory(plan.archivePath, "archivePath");
  const [rootReal, archiveReal, historyParentReal] = await Promise.all([
    fs.realpath(plan.boundRootPath),
    fs.realpath(plan.archivePath),
    fs.realpath(path.dirname(plan.historyPath)),
  ]);
  if (!samePath(path.dirname(archiveReal), rootReal) || !samePath(historyParentReal, rootReal)) {
    fail("archivePath and historyPath must resolve to sibling locations in the bound root.");
  }
}

async function assertPlainFile(filePath, field) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${field} does not exist: ${filePath}.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${field} must be a regular file, not a link or another file type.`);
  }
  return stat;
}

export async function verifyCandidateSource(plan) {
  await assertPlainFile(plan.candidatePath, "candidatePath");
  const sha256 = await sha256File(plan.candidatePath);
  if (sha256 !== plan.candidateSha256) {
    fail(`candidatePath SHA256 mismatch: expected ${plan.candidateSha256}, got ${sha256}.`);
  }
  return sha256;
}

async function scanRevisionDirectory(directoryPath, plan, location) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const revisions = [];
  for (const entry of entries) {
    const revision = parseRevisionFilename(entry.name, plan);
    if (revision === null) continue;
    const filePath = path.join(directoryPath, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`${location} revision is not a regular file: ${filePath}.`);
    }
    await assertPlainFile(filePath, `${location} revision`);
    revisions.push({
      location,
      path: filePath,
      filename: entry.name,
      revision,
      sha256: await sha256File(filePath),
    });
  }
  revisions.sort((left, right) => left.revision - right.revision || left.filename.localeCompare(right.filename));
  return revisions;
}

export function assertRevisionTopology(active, history, { requireOneActive = false } = {}) {
  if (requireOneActive && active.length !== 1) {
    fail(`artifactKind must have exactly one active current revision; found ${active.length}.`);
  }
  if (!requireOneActive && active.length > 1) {
    fail(`artifactKind has multiple active current revisions; found ${active.length}.`);
  }

  const seenRevisions = new Map();
  for (const entry of [...history, ...active]) {
    const previous = seenRevisions.get(entry.revision);
    if (previous) {
      fail(`Revision ${entry.revision} is duplicated at ${previous.path} and ${entry.path}.`);
    }
    seenRevisions.set(entry.revision, entry);
  }

  if (active.length === 1) {
    const current = active[0];
    const conflictingName = history.find((entry) => entry.filename === current.filename);
    if (conflictingName) {
      fail(`History conflicts with the active current filename: ${current.filename}.`);
    }
    const newestHistory = history.at(-1);
    if (newestHistory && newestHistory.revision >= current.revision) {
      fail("The active current revision must be newer than every historical revision.");
    }
  }
}

export async function inspectRevisionState(plan, { requireOneActive = false } = {}) {
  await assertBoundDirectories(plan, { createHistory: false });
  const [active, history] = await Promise.all([
    scanRevisionDirectory(plan.archivePath, plan, "active"),
    scanRevisionDirectory(plan.historyPath, plan, "history"),
  ]);
  assertRevisionTopology(active, history, { requireOneActive });
  return { active, history };
}

function findByPath(entries, targetPath) {
  return entries.find((entry) => samePath(entry.path, targetPath));
}

function assertIdempotentHistory(plan, state) {
  if (plan.expectedCurrentPath === null) {
    if (state.history.length !== 0) {
      fail("A first-revision plan cannot be idempotent when artifact history already exists.");
    }
    return;
  }

  if (
    samePath(plan.expectedCurrentPath, plan.candidateDestinationPath) &&
    plan.expectedCurrentSha256 === plan.candidateSha256
  ) {
    return;
  }
  const expectedHistoryPath = path.join(plan.historyPath, path.basename(plan.expectedCurrentPath));
  const previous = findByPath(state.history, expectedHistoryPath);
  if (!previous || previous.sha256 !== plan.expectedCurrentSha256) {
    fail("The expected prior current revision is not preserved in history with its bound SHA256.");
  }
}

function validatePrePromotionState(plan, state) {
  if (state.active.length > 1) {
    fail(`artifactKind has multiple active current revisions; found ${state.active.length}.`);
  }

  if (plan.expectedCurrentPath === null) {
    if (state.active.length !== 0 || state.history.length !== 0) {
      fail("Null expectedCurrentPath/expectedCurrentSha256 is valid only for a first revision with no active or historical files.");
    }
    if (plan.candidateRevision !== 1) {
      fail("The first candidate revision must be 1.");
    }
    return null;
  }

  if (state.active.length !== 1) {
    fail(`Expected exactly one bound current revision before replacement; found ${state.active.length}.`);
  }
  const current = state.active[0];
  if (!samePath(current.path, plan.expectedCurrentPath)) {
    fail(`Active current path differs from expectedCurrentPath: ${current.path}.`);
  }
  if (current.sha256 !== plan.expectedCurrentSha256) {
    fail(`Active current SHA256 differs from expectedCurrentSha256: ${current.sha256}.`);
  }
  const newestRevision = Math.max(current.revision, ...state.history.map((entry) => entry.revision));
  if (plan.candidateRevision <= newestRevision) {
    fail(`candidateRevision ${plan.candidateRevision} must be greater than existing revision ${newestRevision}.`);
  }
  const historyTarget = path.join(plan.historyPath, current.filename);
  if (findByPath(state.history, historyTarget)) {
    fail(`History target already exists: ${historyTarget}.`);
  }
  return current;
}

function promotionFamilyHash(plan) {
  return crypto
    .createHash("sha256")
    .update(`${plan.artifactKind}\u0000${plan.extension}`, "utf8")
    .digest("hex")
    .slice(0, 20);
}

export function promotionLockPath(plan) {
  const familyHash = promotionFamilyHash(plan);
  return path.join(plan.archivePath, `.active-revision-${familyHash}.lock`);
}

function promotionMutexName(plan) {
  const archiveIdentity = path.resolve(plan.archivePath);
  const normalizedArchiveIdentity = process.platform === "win32"
    ? archiveIdentity.toLowerCase()
    : archiveIdentity;
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizedArchiveIdentity}\u0000${plan.artifactKind}\u0000${plan.extension}`, "utf8")
    .digest("hex");
  return `Local\\CodexXhsPromotion_${digest}`;
}

function encodePowerShellCommand(source) {
  return Buffer.from(source, "utf16le").toString("base64");
}

export async function acquirePromotionFamilyMutex(plan, { timeoutMs = 15_000 } = {}) {
  if (process.platform !== "win32") {
    fail("The promotion family mutex currently requires Windows named-mutex support.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail("promotion family mutex timeoutMs must be an integer from 1 through 120000.");
  }
  const mutexName = promotionMutexName(plan);
  const helperSource = `
$ErrorActionPreference = 'Stop'
$mutex = $null
$held = $false
try {
  $mutex = [System.Threading.Mutex]::new($false, '${mutexName}')
  try {
    $held = $mutex.WaitOne(${timeoutMs})
  } catch [System.Threading.AbandonedMutexException] {
    $held = $true
  }
  if (-not $held) {
    [Console]::Out.WriteLine('TIMEOUT')
    [Console]::Out.Flush()
    exit 73
  }
  [Console]::Out.WriteLine('ACQUIRED')
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 74
} finally {
  if ($held -and $null -ne $mutex) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
`;
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(helperSource)],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const lease = {
    child,
    mutexName,
    acquired: false,
    released: false,
    stderr: "",
    exitCode: null,
    exitSignal: null,
    exitPromise: null,
  };
  lease.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      lease.exitCode = code;
      lease.exitSignal = signal;
      resolve({ code, signal });
    });
  });
  child.stderr.on("data", (chunk) => {
    if (lease.stderr.length < 32_768) lease.stderr += chunk;
  });

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out starting the promotion family mutex helper for ${mutexName}.`));
    }, timeoutMs + 10_000);
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (child.exitCode === null) child.kill();
      reject(error);
    };
    child.once("error", (error) => {
      rejectOnce(new Error(`Could not start the promotion family mutex helper: ${error.message}`));
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) {
        if (stdout.length > 1024) rejectOnce(new Error("Promotion family mutex helper emitted an invalid response."));
        return;
      }
      const response = stdout.slice(0, newline).trim();
      if (response === "ACQUIRED") {
        settled = true;
        clearTimeout(startupTimer);
        lease.acquired = true;
        resolve(lease);
      } else if (response === "TIMEOUT") {
        rejectOnce(new Error(`Timed out acquiring the promotion family mutex ${mutexName}.`));
      } else {
        rejectOnce(new Error(`Promotion family mutex helper emitted an invalid response: ${response}.`));
      }
    });
    lease.exitPromise.then(({ code, signal }) => {
      if (!settled) {
        rejectOnce(
          new Error(
            `Promotion family mutex helper exited before acquisition (code ${code}, signal ${signal}): ${lease.stderr.trim()}.`,
          ),
        );
      }
    });
  });
}

export function assertPromotionFamilyMutexHeld(lease) {
  if (
    !lease ||
    lease.acquired !== true ||
    lease.released === true ||
    lease.child.exitCode !== null ||
    lease.exitCode !== null
  ) {
    fail("Promotion family mutex ownership was lost; refusing to continue.");
  }
}

export async function releasePromotionFamilyMutex(lease) {
  if (!lease || lease.released) return;
  lease.released = true;
  const exitedBeforeRelease = lease.exitCode !== null || lease.child.exitCode !== null;
  if (!exitedBeforeRelease) {
    lease.child.stdin.end();
  }
  let timeoutHandle;
  const releaseTimeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Timed out releasing the promotion family mutex helper.")), 10_000);
  });
  try {
    const { code, signal } = await Promise.race([lease.exitPromise, releaseTimeout]);
    if (code !== 0) {
      fail(
        `Promotion family mutex helper exited abnormally (code ${code}, signal ${signal}): ${lease.stderr.trim()}.`,
      );
    }
  } catch (error) {
    if (lease.child.exitCode === null) lease.child.kill();
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function assertNoPromotionTransactionState(rawPlan) {
  const plan = normalizePromotionPlan(rawPlan);
  await assertPlainDirectory(plan.archivePath, "archivePath");
  const lockPath = promotionLockPath(plan);
  const lockBasename = path.basename(lockPath);
  const markerPrefix = `.revision-transaction-${promotionFamilyHash(plan)}-`;
  const residuals = [];
  for (const entry of await fs.readdir(plan.archivePath, { withFileTypes: true })) {
    if (
      entry.name === lockBasename ||
      entry.name.startsWith(`${lockBasename}.pending-`) ||
      entry.name.startsWith(`${lockBasename}.recovery`) ||
      entry.name.startsWith(markerPrefix)
    ) {
      residuals.push(path.join(plan.archivePath, entry.name));
    }
  }
  if (residuals.length > 0) {
    fail(
      `Unresolved promotion transaction state exists for artifactKind; retry the same promotion plan before audit: ${residuals.join(", ")}.`,
    );
  }
}

async function statIfExists(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function processIsAlive(pid, expectedStartIdentity) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    const actualStartIdentity = processStartIdentity(pid);
    if (actualStartIdentity === null) return true;
    return actualStartIdentity === expectedStartIdentity;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readStrictJsonSnapshot(filePath, field) {
  try {
    const bytes = await fs.readFile(filePath);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    return {
      value: JSON.parse(text),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    fail(`${field} is not valid UTF-8 JSON and was preserved at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readStrictJson(filePath, field) {
  return (await readStrictJsonSnapshot(filePath, field)).value;
}

function makeLockRecord(plan) {
  const ownerToken = crypto.randomBytes(18).toString("hex");
  const transactionToken = crypto.randomBytes(18).toString("hex");
  const expectedHistoryPath = plan.expectedCurrentPath
    ? path.join(plan.historyPath, path.basename(plan.expectedCurrentPath))
    : null;
  const familyHash = promotionFamilyHash(plan);
  return {
    version: 4,
    kind: "xiaohongshu-active-revision-lock",
    pid: process.pid,
    processStartIdentity: CURRENT_PROCESS_START_IDENTITY,
    ownerToken,
    artifactKind: plan.artifactKind,
    extension: plan.extension,
    archivePath: plan.archivePath,
    historyPath: plan.historyPath,
    candidateRevision: plan.candidateRevision,
    candidateDestinationPath: plan.candidateDestinationPath,
    candidateSha256: plan.candidateSha256,
    expectedCurrentPath: plan.expectedCurrentPath,
    expectedCurrentSha256: plan.expectedCurrentSha256,
    expectedHistoryPath,
    candidateCopyPath: path.join(plan.archivePath, `.revision-candidate-copy-${transactionToken}.tmp`),
    stagingPath: path.join(plan.archivePath, `.revision-stage-${transactionToken}.tmp`),
    historyStagingPath: path.join(plan.historyPath, `.revision-history-${transactionToken}.tmp`),
    oldStagingPath: path.join(plan.archivePath, `.revision-old-${transactionToken}.tmp`),
    markerPath: path.join(plan.archivePath, `.revision-transaction-${familyHash}-${transactionToken}.json`),
    markerTempPath: path.join(plan.archivePath, `.revision-transaction-${familyHash}-${transactionToken}.tmp`),
  };
}

function validateLockRecord(record, plan, lockPath) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(`Invalid promotion lock record: ${lockPath}.`);
  for (const key of Object.keys(record)) {
    if (!LOCK_RECORD_KEYS.has(key)) fail(`Unknown promotion lock field ${key}; preserved ${lockPath}.`);
  }
  for (const key of LOCK_RECORD_KEYS) {
    if (!Object.hasOwn(record, key)) fail(`Missing promotion lock field ${key}; preserved ${lockPath}.`);
  }
  if (
    record.version !== 4 ||
    record.kind !== "xiaohongshu-active-revision-lock" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.processStartIdentity !== "string" ||
    record.processStartIdentity.trim() === "" ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{36}$/.test(record.ownerToken) ||
    record.artifactKind !== plan.artifactKind ||
    record.extension !== plan.extension ||
    !samePath(record.archivePath, plan.archivePath) ||
    !samePath(record.historyPath, plan.historyPath) ||
    !Number.isSafeInteger(record.candidateRevision) ||
    record.candidateRevision < 1 ||
    !SHA256_PATTERN.test(record.candidateSha256)
  ) {
    fail(`Promotion lock does not match the bound artifact family and was preserved: ${lockPath}.`);
  }
  const expectedCandidate = path.join(
    plan.archivePath,
    `${plan.artifactKind}${REVISION_MARKER}${record.candidateRevision}${plan.extension}`,
  );
  if (!samePath(record.candidateDestinationPath, expectedCandidate)) {
    fail(`Promotion lock candidate destination is outside the bound revision family: ${lockPath}.`);
  }
  const familyHash = promotionFamilyHash(plan);
  const markerPattern = new RegExp(`^\\.revision-transaction-${familyHash}-([0-9a-f]{36})\\.json$`, "u");
  const markerMatch = markerPattern.exec(path.basename(record.markerPath));
  if (!markerMatch || !samePath(path.dirname(record.markerPath), plan.archivePath)) {
    fail(`Promotion lock markerPath is not a direct owned transaction path: ${lockPath}.`);
  }
  const transactionToken = markerMatch[1];
  for (const [field, value, directory, expectedBasename] of [
    ["candidateCopyPath", record.candidateCopyPath, plan.archivePath, `.revision-candidate-copy-${transactionToken}.tmp`],
    ["stagingPath", record.stagingPath, plan.archivePath, `.revision-stage-${transactionToken}.tmp`],
    ["historyStagingPath", record.historyStagingPath, plan.historyPath, `.revision-history-${transactionToken}.tmp`],
    ["oldStagingPath", record.oldStagingPath, plan.archivePath, `.revision-old-${transactionToken}.tmp`],
    ["markerTempPath", record.markerTempPath, plan.archivePath, `.revision-transaction-${familyHash}-${transactionToken}.tmp`],
  ]) {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      !samePath(path.dirname(value), directory) ||
      path.basename(value) !== expectedBasename
    ) {
      fail(`Promotion lock ${field} is not the exact owned transaction path: ${lockPath}.`);
    }
  }
  const nullPath = record.expectedCurrentPath === null;
  const nullSha = record.expectedCurrentSha256 === null;
  const nullHistory = record.expectedHistoryPath === null;
  if (nullPath !== nullSha || nullPath !== nullHistory) fail(`Promotion lock prior-current fields are inconsistent: ${lockPath}.`);
  if (!nullPath) {
    if (
      !samePath(path.dirname(record.expectedCurrentPath), plan.archivePath) ||
      !samePath(record.expectedHistoryPath, path.join(plan.historyPath, path.basename(record.expectedCurrentPath))) ||
      !SHA256_PATTERN.test(record.expectedCurrentSha256) ||
      parseRevisionFilename(path.basename(record.expectedCurrentPath), {
        artifactKind: record.artifactKind,
        extension: record.extension,
      }) === null
    ) {
      fail(`Promotion lock prior-current binding is invalid: ${lockPath}.`);
    }
  }
  return record;
}

async function quarantineAndRemove(filePath, expectedSha256, label) {
  const quarantinePath = path.join(
    path.dirname(filePath),
    `.revision-recovery-${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  try {
    await fs.rename(filePath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const actual = await sha256File(quarantinePath);
  if (actual !== expectedSha256) {
    fail(`${label} changed externally and was preserved at ${quarantinePath} with SHA256 ${actual}.`);
  }
  await fs.unlink(quarantinePath);
}

async function removeOwnedPrivateFile(filePath, label) {
  const originalStat = await statIfExists(filePath);
  if (!originalStat) return;
  if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
    fail(`${label} is not a regular owned private file and was preserved: ${filePath}.`);
  }
  const quarantinePath = path.join(
    path.dirname(filePath),
    `.revision-owned-cleanup-${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  await fs.rename(filePath, quarantinePath);
  const quarantinedStat = await fs.lstat(quarantinePath);
  if (!sameFileIdentity(originalStat, quarantinedStat)) {
    fail(`${label} changed identity during cleanup and was preserved at ${quarantinePath}.`);
  }
  await fs.unlink(quarantinePath);
}

async function preserveForRecovery(filePath, expectedSha256, label) {
  const recoveryPath = path.join(
    path.dirname(filePath),
    `.revision-recovery-preserved-${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  await fs.rename(filePath, recoveryPath);
  const actual = await sha256File(recoveryPath);
  if (actual !== expectedSha256) {
    fail(`${label} changed externally and was preserved at ${recoveryPath} with SHA256 ${actual}.`);
  }
  return recoveryPath;
}

async function installVerifiedPrivateCopy(sourcePath, copyPath, stagingPath, expectedSha256, label) {
  await fs.copyFile(sourcePath, copyPath, fsConstants.COPYFILE_EXCL);
  await assertHash(copyPath, expectedSha256, `${label} private copy`);
  await fs.link(copyPath, stagingPath);
  const [copyStat, stagingStat] = await Promise.all([fs.lstat(copyPath), fs.lstat(stagingPath)]);
  if (!sameFileIdentity(copyStat, stagingStat)) {
    fail(`${label} staging does not identify its verified private copy.`);
  }
  await fs.unlink(copyPath);
  await assertHash(stagingPath, expectedSha256, `${label} staging`);
}

async function inspectOwnedHistorySnapshot(historyStagingPath, historyTarget, expectedSha256, label) {
  const [stagingStat, targetStat] = await Promise.all([
    statIfExists(historyStagingPath),
    statIfExists(historyTarget),
  ]);
  if (targetStat) {
    if (!stagingStat || !sameFileIdentity(stagingStat, targetStat)) {
      fail(`${label} ownership is ambiguous; preserved ${historyTarget}.`);
    }
    await assertHash(historyTarget, expectedSha256, label);
    await assertHash(historyStagingPath, expectedSha256, `${label} private staging`);
  }
  return { stagingStat, targetStat };
}

async function discardOwnedHistorySnapshot(historyStagingPath, historyTarget, expectedSha256, label) {
  const { stagingStat, targetStat } = await inspectOwnedHistorySnapshot(
    historyStagingPath,
    historyTarget,
    expectedSha256,
    label,
  );
  if (targetStat) {
    await quarantineAndRemove(historyTarget, expectedSha256, label);
  }
  if (stagingStat) {
    if (targetStat) {
      await quarantineAndRemove(historyStagingPath, expectedSha256, `${label} private staging`);
    } else {
      await removeOwnedPrivateFile(historyStagingPath, `${label} incomplete private staging`);
    }
  }
}

async function preserveOwnedHistorySnapshot(historyStagingPath, historyTarget, expectedSha256, label) {
  const { stagingStat, targetStat } = await inspectOwnedHistorySnapshot(
    historyStagingPath,
    historyTarget,
    expectedSha256,
    label,
  );
  if (!targetStat) {
    if (stagingStat) {
      const recoveryPath = await preserveForRecovery(historyStagingPath, expectedSha256, `${label} private staging`);
      return recoveryPath;
    }
    fail(`${label} disappeared before it could be preserved.`);
  }
  const recoveryPath = await preserveForRecovery(historyTarget, expectedSha256, label);
  if (stagingStat) {
    await quarantineAndRemove(historyStagingPath, expectedSha256, `${label} private staging`);
  }
  return recoveryPath;
}

async function cleanupStaleCandidateState(record) {
  const [copyStat, stagingStat, candidateStat] = await Promise.all([
    statIfExists(record.candidateCopyPath),
    statIfExists(record.stagingPath),
    statIfExists(record.candidateDestinationPath),
  ]);
  if (copyStat && stagingStat && !sameFileIdentity(copyStat, stagingStat)) {
    fail(`Candidate private copy and staging identities differ; preserved both transaction files.`);
  }
  if (candidateStat) {
    if (!stagingStat || !sameFileIdentity(stagingStat, candidateStat)) {
      fail(`Cannot prove stale candidate ownership; preserved ${record.candidateDestinationPath}.`);
    }
    await assertHash(record.candidateDestinationPath, record.candidateSha256, "stale promoted candidate");
    await quarantineAndRemove(record.candidateDestinationPath, record.candidateSha256, "Stale promoted candidate");
  }
  if (stagingStat) {
    await assertHash(record.stagingPath, record.candidateSha256, "stale candidate staging");
    await quarantineAndRemove(record.stagingPath, record.candidateSha256, "Stale candidate staging file");
  }
  if (copyStat) {
    await removeOwnedPrivateFile(record.candidateCopyPath, "Stale candidate private copy");
  }
}

function validateTransactionMarker(marker, record) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    fail(`Promotion transaction marker is not a JSON object: ${record.markerPath}.`);
  }
  for (const key of Object.keys(marker)) {
    if (!TRANSACTION_MARKER_KEYS.has(key)) {
      fail(`Unknown promotion transaction marker field ${key}; preserved ${record.markerPath}.`);
    }
  }
  for (const key of TRANSACTION_MARKER_KEYS) {
    if (!Object.hasOwn(marker, key)) {
      fail(`Missing promotion transaction marker field ${key}; preserved ${record.markerPath}.`);
    }
  }
  if (
    marker.version !== 2 ||
    marker.kind !== "xiaohongshu-active-revision-transaction" ||
    marker.ownerToken !== record.ownerToken ||
    marker.artifactKind !== record.artifactKind ||
    marker.extension !== record.extension ||
    typeof marker.lockPath !== "string" ||
    !path.isAbsolute(marker.lockPath) ||
    !samePath(marker.lockPath, promotionLockPath(record))
  ) {
    fail(`Promotion transaction marker does not match its lock and was preserved: ${record.markerPath}.`);
  }
  return marker;
}

async function recoverArmedTransaction(record, hooks = {}) {
  const marker = validateTransactionMarker(
    await readStrictJson(record.markerPath, "Promotion transaction marker"),
    record,
  );
  await cleanupStaleCandidateState(record);

  if (record.expectedCurrentPath !== null) {
    const currentStat = await statIfExists(record.expectedCurrentPath);
    const oldStageStat = await statIfExists(record.oldStagingPath);
    if (currentStat && oldStageStat) {
      const [currentHash, oldStageHash] = await Promise.all([
        sha256File(record.expectedCurrentPath),
        sha256File(record.oldStagingPath),
      ]);
      if (currentHash !== oldStageHash || currentHash !== record.expectedCurrentSha256) {
        fail(
          `Current and owned old staging bytes differ from the bound prior current; preserved ${record.expectedCurrentPath} and ${record.oldStagingPath}.`,
        );
      }
      await quarantineAndRemove(record.oldStagingPath, oldStageHash, "Recovered duplicate old staging file");
    } else if (!currentStat && oldStageStat) {
      await assertHash(record.oldStagingPath, record.expectedCurrentSha256, "recoverable old staging file");
      await fs.rename(record.oldStagingPath, record.expectedCurrentPath);
      await assertHash(record.expectedCurrentPath, record.expectedCurrentSha256, "atomically restored current");
      if (typeof hooks.afterRecoveredCurrentInstalled === "function") {
        await hooks.afterRecoveredCurrentInstalled({
          currentPath: record.expectedCurrentPath,
          oldStagingPath: record.oldStagingPath,
        });
      }
    } else if (!currentStat && !oldStageStat) {
      fail(`Stale transaction has neither current nor recoverable old staging file: ${record.expectedCurrentPath}.`);
    }
    const restoredHash = await sha256File(record.expectedCurrentPath);
    if (restoredHash !== record.expectedCurrentSha256) {
      fail(`Current SHA256 ${restoredHash} differs from the bound prior current; transaction files were preserved.`);
    }
    await discardOwnedHistorySnapshot(
      record.historyStagingPath,
      record.expectedHistoryPath,
      record.expectedCurrentSha256,
      "Stale history snapshot",
    );
  } else if (await statIfExists(record.historyStagingPath)) {
    fail(`A first-revision transaction unexpectedly owns history staging; preserved ${record.historyStagingPath}.`);
  }

  await quarantineAndRemove(
    record.markerPath,
    crypto.createHash("sha256").update(`${JSON.stringify(marker)}\n`, "utf8").digest("hex"),
    "Stale transaction marker",
  );
}

async function recoverCommittedCleanup(record) {
  const markerTempStat = await statIfExists(record.markerTempPath);
  if (markerTempStat) {
    const [candidateCopyStat, stagingStat, historyStagingStat, oldStageStat, candidateStat, historyStat] = await Promise.all([
      statIfExists(record.candidateCopyPath),
      statIfExists(record.stagingPath),
      statIfExists(record.historyStagingPath),
      statIfExists(record.oldStagingPath),
      statIfExists(record.candidateDestinationPath),
      record.expectedHistoryPath ? statIfExists(record.expectedHistoryPath) : Promise.resolve(null),
    ]);
    if (candidateCopyStat || stagingStat || historyStagingStat || oldStageStat || candidateStat || historyStat) {
      fail(`Incomplete transaction-marker write coexists with other transaction state and was preserved: ${record.markerTempPath}.`);
    }
    await removeOwnedPrivateFile(record.markerTempPath, "Incomplete transaction-marker private file");
  }
  const candidateCopyStat = await statIfExists(record.candidateCopyPath);
  const stagingStat = await statIfExists(record.stagingPath);
  const candidateStat = await statIfExists(record.candidateDestinationPath);
  if (candidateStat) {
    await assertHash(record.candidateDestinationPath, record.candidateSha256, "committed candidate");
  }
  if (candidateCopyStat) {
    if (!stagingStat || !sameFileIdentity(candidateCopyStat, stagingStat)) {
      fail(`Committed candidate private-copy identity is ambiguous; preserved ${record.candidateCopyPath}.`);
    }
  }
  if (stagingStat) {
    if (!candidateStat) {
      fail(`Committed candidate disappeared; preserved its staging bytes at ${record.stagingPath}.`);
    }
    if (!sameFileIdentity(stagingStat, candidateStat)) {
      fail(`Committed candidate staging identity is ambiguous; preserved ${record.stagingPath}.`);
    }
    await assertHash(record.candidateDestinationPath, record.candidateSha256, "committed candidate");
    await quarantineAndRemove(record.stagingPath, record.candidateSha256, "Committed candidate staging file");
  }
  if (candidateCopyStat) {
    await removeOwnedPrivateFile(record.candidateCopyPath, "Committed candidate private copy");
  }

  const historyStagingStat = await statIfExists(record.historyStagingPath);
  if (historyStagingStat) {
    if (!record.expectedHistoryPath) {
      fail(`Committed first-revision transaction unexpectedly owns history staging; preserved ${record.historyStagingPath}.`);
    }
    const historyStat = await statIfExists(record.expectedHistoryPath);
    if (!historyStat || !sameFileIdentity(historyStagingStat, historyStat)) {
      fail(`Committed historical private-staging identity is ambiguous; preserved ${record.historyStagingPath}.`);
    }
    await assertHash(record.historyStagingPath, record.expectedCurrentSha256, "committed historical private staging");
    await assertHash(record.expectedHistoryPath, record.expectedCurrentSha256, "committed historical snapshot");
    await quarantineAndRemove(
      record.historyStagingPath,
      record.expectedCurrentSha256,
      "Committed historical private staging",
    );
  }
  const oldStageStat = await statIfExists(record.oldStagingPath);
  if (oldStageStat) {
    const historyStat = record.expectedHistoryPath ? await statIfExists(record.expectedHistoryPath) : null;
    if (!historyStat) {
      fail(`Committed historical snapshot disappeared; preserved ${record.oldStagingPath}.`);
    }
    await assertHash(record.oldStagingPath, record.expectedCurrentSha256, "committed old staging file");
    await assertHash(record.expectedHistoryPath, record.expectedCurrentSha256, "committed historical snapshot");
    await quarantineAndRemove(record.oldStagingPath, record.expectedCurrentSha256, "Committed old staging file");
  }
}

async function removeOwnedPendingLockLinks(plan, lockPath) {
  const lockStat = await fs.lstat(lockPath);
  const prefix = `${path.basename(lockPath)}.pending-`;
  for (const entry of await fs.readdir(plan.archivePath, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const pendingPath = path.join(plan.archivePath, entry.name);
    const pendingStat = await fs.lstat(pendingPath);
    if (entry.isFile() && !entry.isSymbolicLink() && sameFileIdentity(lockStat, pendingStat)) {
      await fs.unlink(pendingPath);
    }
  }
}

function makeRecoveryGuardRecord(plan, lockPath, lockOwnerToken) {
  return {
    version: 2,
    kind: "xiaohongshu-active-revision-recovery-guard",
    pid: process.pid,
    processStartIdentity: CURRENT_PROCESS_START_IDENTITY,
    ownerToken: crypto.randomBytes(18).toString("hex"),
    lockOwnerToken,
    lockPath,
    artifactKind: plan.artifactKind,
    extension: plan.extension,
    archivePath: plan.archivePath,
  };
}

function validateRecoveryGuardRecord(record, plan, lockPath, recoveryPath) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail(`Invalid recovery guard record; preserved ${recoveryPath}.`);
  }
  for (const key of Object.keys(record)) {
    if (!RECOVERY_GUARD_KEYS.has(key)) fail(`Unknown recovery guard field ${key}; preserved ${recoveryPath}.`);
  }
  for (const key of RECOVERY_GUARD_KEYS) {
    if (!Object.hasOwn(record, key)) fail(`Missing recovery guard field ${key}; preserved ${recoveryPath}.`);
  }
  if (
    record.version !== 2 ||
    record.kind !== "xiaohongshu-active-revision-recovery-guard" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.processStartIdentity !== "string" ||
    record.processStartIdentity.trim() === "" ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{36}$/u.test(record.ownerToken) ||
    typeof record.lockOwnerToken !== "string" ||
    !/^[0-9a-f]{36}$/u.test(record.lockOwnerToken) ||
    record.artifactKind !== plan.artifactKind ||
    record.extension !== plan.extension ||
    !samePath(record.archivePath, plan.archivePath) ||
    !samePath(record.lockPath, lockPath) ||
    !samePath(path.dirname(recoveryPath), plan.archivePath) ||
    path.basename(recoveryPath) !== `${path.basename(lockPath)}.recovery`
  ) {
    fail(`Recovery guard does not match the bound artifact family; preserved ${recoveryPath}.`);
  }
  return record;
}

function recoveryPendingPath(recoveryPath, record) {
  return `${recoveryPath}.pending-${record.ownerToken}-${record.pid}-${processIdentityHash(record.processStartIdentity)}`;
}

function processMatchesStartHash(pid, expectedStartHash) {
  const actualStartIdentity = processStartIdentity(pid);
  if (actualStartIdentity !== null) {
    return processIdentityHash(actualStartIdentity) === expectedStartHash;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function removeStaleRecoveryPendingFiles(plan, lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const prefix = `${path.basename(recoveryPath)}.pending-`;
  for (const entry of await fs.readdir(plan.archivePath, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    const match = /^([0-9a-f]{36})-([1-9][0-9]*)-([0-9a-f]{20})$/u.exec(suffix);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`Unrecognized recovery-guard pending artifact was preserved: ${path.join(plan.archivePath, entry.name)}.`);
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid)) {
      fail(`Recovery-guard pending PID is invalid and was preserved: ${path.join(plan.archivePath, entry.name)}.`);
    }
    if (processMatchesStartHash(pid, match[3])) {
      fail(`Another process is installing a recovery guard: ${path.join(plan.archivePath, entry.name)}.`);
    }
    await removeOwnedPrivateFile(path.join(plan.archivePath, entry.name), "Stale recovery-guard pending file");
  }
}

async function restoreQuarantinedRecoveryGuard(plan, lockPath, stalePath) {
  const recoveryPath = `${lockPath}.recovery`;
  const snapshot = await readStrictJsonSnapshot(stalePath, "Quarantined promotion recovery guard");
  validateRecoveryGuardRecord(snapshot.value, plan, lockPath, recoveryPath);
  try {
    await fs.link(stalePath, recoveryPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const [staleStat, currentStat] = await Promise.all([fs.lstat(stalePath), statIfExists(recoveryPath)]);
  if (!currentStat || !sameFileIdentity(staleStat, currentStat)) {
    fail(`Could not restore a raced recovery guard; preserved ${stalePath}.`);
  }
  await fs.unlink(stalePath);
}

async function removeStaleRecoveryQuarantines(plan, lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const prefix = `${path.basename(recoveryPath)}.stale-`;
  for (const entry of await fs.readdir(plan.archivePath, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    const stalePath = path.join(plan.archivePath, entry.name);
    if (!/^[0-9a-f]{36}\.tmp$/u.test(suffix) || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`Unrecognized recovery-guard quarantine was preserved: ${stalePath}.`);
    }
    const snapshot = await readStrictJsonSnapshot(stalePath, "Quarantined promotion recovery guard");
    const record = validateRecoveryGuardRecord(snapshot.value, plan, lockPath, recoveryPath);
    if (processIsAlive(record.pid, record.processStartIdentity)) {
      await restoreQuarantinedRecoveryGuard(plan, lockPath, stalePath);
      fail(`A live recovery guard was restored after an ownership race: ${recoveryPath}.`);
    }
    const staleStat = await fs.lstat(stalePath);
    const pendingPath = recoveryPendingPath(recoveryPath, record);
    const pendingStat = await statIfExists(pendingPath);
    if (pendingStat) {
      if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || !sameFileIdentity(staleStat, pendingStat)) {
        fail(`Recovery guard pending link is ambiguous and was preserved: ${pendingPath}.`);
      }
      await fs.unlink(pendingPath);
    }
    const verifiedStat = await fs.lstat(stalePath);
    if (!sameFileIdentity(staleStat, verifiedStat) || await sha256File(stalePath) !== snapshot.sha256) {
      fail(`Stale recovery-guard quarantine changed during cleanup and was preserved: ${stalePath}.`);
    }
    await fs.unlink(stalePath);
  }
}

async function reclaimDeadRecoveryGuard(plan, lockPath, hooks = {}) {
  const recoveryPath = `${lockPath}.recovery`;
  await removeStaleRecoveryQuarantines(plan, lockPath);
  let snapshot;
  try {
    snapshot = await readStrictJsonSnapshot(recoveryPath, "Promotion recovery guard");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const record = validateRecoveryGuardRecord(snapshot.value, plan, lockPath, recoveryPath);
  if (processIsAlive(record.pid, record.processStartIdentity)) {
    fail(`Another process is recovering the promotion lock: ${recoveryPath}.`);
  }
  const originalStat = await fs.lstat(recoveryPath);
  const stalePath = `${recoveryPath}.stale-${crypto.randomBytes(18).toString("hex")}.tmp`;
  if (typeof hooks.beforeDeadRecoveryGuardQuarantine === "function") {
    await hooks.beforeDeadRecoveryGuardQuarantine({ recoveryPath, stalePath });
  }
  try {
    await fs.rename(recoveryPath, stalePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (typeof hooks.afterRecoveryGuardQuarantined === "function") {
    await hooks.afterRecoveryGuardQuarantined({ recoveryPath, stalePath });
  }
  const staleStat = await fs.lstat(stalePath);
  if (!staleStat.isFile() || staleStat.isSymbolicLink() || !sameFileIdentity(originalStat, staleStat)) {
    await restoreQuarantinedRecoveryGuard(plan, lockPath, stalePath);
    fail(`Recovery guard changed identity during reclaim and was restored at ${recoveryPath}.`);
  }
  const staleSha256 = await sha256File(stalePath);
  if (staleSha256 !== snapshot.sha256) {
    await restoreQuarantinedRecoveryGuard(plan, lockPath, stalePath);
    fail(`Recovery guard changed bytes during reclaim and was restored at ${recoveryPath}.`);
  }
  const pendingPath = recoveryPendingPath(recoveryPath, record);
  const pendingStat = await statIfExists(pendingPath);
  if (pendingStat) {
    if (!pendingStat.isFile() || pendingStat.isSymbolicLink() || !sameFileIdentity(staleStat, pendingStat)) {
      fail(`Recovery guard pending link is ambiguous and was preserved: ${pendingPath}.`);
    }
    await fs.unlink(pendingPath);
  }
  await fs.unlink(stalePath);
  return true;
}

async function installRecoveryGuard(plan, lockPath, lockOwnerToken, hooks = {}) {
  const recoveryPath = `${lockPath}.recovery`;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await removeStaleRecoveryPendingFiles(plan, lockPath);
    await removeStaleRecoveryQuarantines(plan, lockPath);
    const record = makeRecoveryGuardRecord(plan, lockPath, lockOwnerToken);
    const pendingPath = recoveryPendingPath(recoveryPath, record);
    let handle;
    let pendingOwned = false;
    try {
      handle = await fs.open(pendingPath, "wx");
      pendingOwned = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await fs.link(pendingPath, recoveryPath);
      await unlinkIfExists(pendingPath).catch(() => {});
      return { path: recoveryPath, pendingPath, handle, record };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (pendingOwned) await unlinkIfExists(pendingPath).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      await reclaimDeadRecoveryGuard(plan, lockPath, hooks);
    }
  }
  fail(`Could not install the recovery guard after repeated ownership races: ${recoveryPath}.`);
}

async function releaseRecoveryGuard(guard) {
  try {
    const snapshot = await readStrictJsonSnapshot(guard.path, "Promotion recovery guard");
    if (snapshot.value.ownerToken !== guard.record.ownerToken) {
      fail(`Recovery guard ownership changed; refusing to remove ${guard.path}.`);
    }
    const [guardStat, handleStat] = await Promise.all([fs.lstat(guard.path), guard.handle.stat()]);
    if (!sameFileIdentity(guardStat, handleStat)) {
      fail(`Recovery guard identity changed; refusing to remove ${guard.path}.`);
    }
    const pendingStat = await statIfExists(guard.pendingPath);
    if (pendingStat) {
      if (!sameFileIdentity(guardStat, pendingStat)) {
        fail(`Recovery guard pending identity changed; preserved ${guard.pendingPath}.`);
      }
      await fs.unlink(guard.pendingPath);
    }
    await fs.unlink(guard.path);
  } finally {
    await guard.handle.close();
  }
}

async function recoverStaleLock(plan, lockPath, hooks = {}) {
  let priorRecord;
  try {
    priorRecord = validateLockRecord(await readStrictJson(lockPath, "Promotion lock"), plan, lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (processIsAlive(priorRecord.pid, priorRecord.processStartIdentity)) {
    fail(`Another promotion still owns the artifact lock: ${lockPath}.`);
  }

  const guard = await installRecoveryGuard(plan, lockPath, priorRecord.ownerToken, hooks);
  try {
    if (typeof hooks.afterRecoveryGuardInstalled === "function") {
      await hooks.afterRecoveryGuardInstalled({ lockPath, recoveryPath: guard.path });
    }
    let record;
    try {
      record = validateLockRecord(await readStrictJson(lockPath, "Promotion lock"), plan, lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (record.ownerToken !== priorRecord.ownerToken) {
      fail(`Promotion lock ownership changed during recovery and was preserved: ${lockPath}.`);
    }
    if (processIsAlive(record.pid, record.processStartIdentity)) {
      fail(`Another promotion still owns the artifact lock: ${lockPath}.`);
    }
    if (await statIfExists(record.markerPath)) {
      await recoverArmedTransaction(record, hooks);
    } else {
      await recoverCommittedCleanup(record);
    }
    const currentRecord = await readStrictJson(lockPath, "Promotion lock");
    if (currentRecord.ownerToken !== record.ownerToken) {
      fail(`Promotion lock ownership changed during recovery and was preserved: ${lockPath}.`);
    }
    await removeOwnedPendingLockLinks(plan, lockPath);
    await fs.unlink(lockPath);
    return true;
  } finally {
    await releaseRecoveryGuard(guard);
  }
}

function lockPendingPath(lockPath, record) {
  return `${lockPath}.pending-${record.ownerToken}-${record.pid}-${processIdentityHash(record.processStartIdentity)}`;
}

async function removeStaleLockPendingFiles(plan, lockPath) {
  const prefix = `${path.basename(lockPath)}.pending-`;
  for (const entry of await fs.readdir(plan.archivePath, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const pendingPath = path.join(plan.archivePath, entry.name);
    const suffix = entry.name.slice(prefix.length);
    const match = /^([0-9a-f]{36})-([1-9][0-9]*)-([0-9a-f]{20})$/u.exec(suffix);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`Unrecognized promotion-lock pending artifact was preserved: ${pendingPath}.`);
    }
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid)) {
      fail(`Promotion-lock pending PID is invalid and was preserved: ${pendingPath}.`);
    }
    if (processMatchesStartHash(pid, match[3])) {
      fail(`Another process is installing the promotion lock: ${pendingPath}.`);
    }
    let record = null;
    try {
      record = validateLockRecord(await readStrictJson(pendingPath, "Promotion-lock pending file"), plan, lockPath);
    } catch (error) {
      if (!String(error?.message).includes("is not valid UTF-8 JSON")) throw error;
    }
    if (record) {
      if (
        record.ownerToken !== match[1] ||
        record.pid !== pid ||
        processIdentityHash(record.processStartIdentity) !== match[3]
      ) {
        fail(`Promotion-lock pending filename does not match its record and was preserved: ${pendingPath}.`);
      }
    }
    await removeOwnedPrivateFile(pendingPath, "Stale promotion-lock pending file");
  }
}

async function createLock(plan, hooks = {}) {
  const lockPath = promotionLockPath(plan);
  const record = makeLockRecord(plan);
  const pendingPath = lockPendingPath(lockPath, record);
  let handle;
  let pendingOwned = false;
  try {
    handle = await fs.open(pendingPath, "wx");
    pendingOwned = true;
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    if (typeof hooks.afterLockPendingSynced === "function") {
      await hooks.afterLockPendingSynced({ lockPath, pendingPath });
    }
    await fs.link(pendingPath, lockPath);
    await unlinkIfExists(pendingPath).catch(() => {});
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (pendingOwned) await unlinkIfExists(pendingPath).catch(() => {});
    throw error;
  }
  return { path: lockPath, handle, record };
}

async function acquireLock(plan, hooks = {}) {
  const lockPath = promotionLockPath(plan);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await removeStaleLockPendingFiles(plan, lockPath);
    await removeStaleRecoveryPendingFiles(plan, lockPath);
    await removeStaleRecoveryQuarantines(plan, lockPath);
    await reclaimDeadRecoveryGuard(plan, lockPath, hooks);
    try {
      return await createLock(plan, hooks);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await recoverStaleLock(plan, lockPath, hooks);
    }
  }
  fail(`Could not acquire the promotion lock after repeated ownership races: ${lockPath}.`);
}

async function armTransaction(lock, hooks = {}) {
  const marker = {
    version: 2,
    kind: "xiaohongshu-active-revision-transaction",
    ownerToken: lock.record.ownerToken,
    lockPath: lock.path,
    artifactKind: lock.record.artifactKind,
    extension: lock.record.extension,
  };
  const handle = await fs.open(lock.record.markerTempPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (typeof hooks.afterMarkerTempSynced === "function") {
    await hooks.afterMarkerTempSynced({ lockPath: lock.path, markerTempPath: lock.record.markerTempPath });
  }
  await fs.rename(lock.record.markerTempPath, lock.record.markerPath);
  return {
    marker,
    sha256: crypto.createHash("sha256").update(`${JSON.stringify(marker)}\n`, "utf8").digest("hex"),
  };
}

async function releaseOwnedLock(lock) {
  try {
    const record = await readStrictJson(lock.path, "Promotion lock");
    if (record.ownerToken !== lock.record.ownerToken) {
      fail(`Promotion lock ownership changed; refusing to remove ${lock.path}.`);
    }
    await removeOwnedPendingLockLinks({ archivePath: path.dirname(lock.path) }, lock.path);
    await fs.unlink(lock.path);
  } finally {
    await lock.handle.close();
  }
}

async function unlinkIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertHash(filePath, expectedSha256, field) {
  await assertPlainFile(filePath, field);
  const actual = await sha256File(filePath);
  if (actual !== expectedSha256) fail(`${field} SHA256 mismatch: expected ${expectedSha256}, got ${actual}.`);
  return actual;
}

async function rollbackTransaction(plan, transaction) {
  const errors = [];

  if (transaction.candidateCreated && await pathExists(plan.candidateDestinationPath)) {
    try {
      const [candidateStat, stagingStat] = await Promise.all([
        fs.lstat(plan.candidateDestinationPath),
        statIfExists(transaction.stagingPath),
      ]);
      if (!stagingStat || !sameFileIdentity(candidateStat, stagingStat)) {
        fail(`newly promoted candidate identity changed and was preserved: ${plan.candidateDestinationPath}.`);
      }
      await quarantineAndRemove(plan.candidateDestinationPath, plan.candidateSha256, "Newly promoted candidate");
    } catch (error) {
      errors.push(`candidate cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (transaction.oldRemoved && transaction.oldCurrent && transaction.historyTarget) {
    try {
      const movedHash = transaction.movedCurrentSha256 ?? await sha256File(transaction.oldStagingPath);
      const currentStat = await statIfExists(transaction.oldCurrent.path);
      if (currentStat) {
        const currentHash = await sha256File(transaction.oldCurrent.path);
        if (currentHash !== movedHash) {
          fail(`current and owned old staging bytes differ; preserved ${transaction.oldCurrent.path} and ${transaction.oldStagingPath}`);
        }
        await quarantineAndRemove(transaction.oldStagingPath, movedHash, "Rollback duplicate old staging file");
      } else {
        await fs.rename(transaction.oldStagingPath, transaction.oldCurrent.path);
        await assertHash(transaction.oldCurrent.path, movedHash, "atomically restored original current");
      }
      if (movedHash === transaction.oldCurrent.sha256) {
        await discardOwnedHistorySnapshot(
          transaction.historyStagingPath,
          transaction.historyTarget,
          transaction.oldCurrent.sha256,
          "Rollback history snapshot",
        );
      } else {
        const recoveryPath = await preserveOwnedHistorySnapshot(
          transaction.historyStagingPath,
          transaction.historyTarget,
          transaction.oldCurrent.sha256,
          "Bound prior-current snapshot",
        );
        errors.push(
          `external current SHA256 ${movedHash} was restored; bound prior-current snapshot preserved at ${recoveryPath}`,
        );
      }
    } catch (error) {
      errors.push(`current restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (transaction.oldCurrent && transaction.historyTarget) {
    try {
      await assertHash(transaction.oldCurrent.path, transaction.oldCurrent.sha256, "unchanged current");
      await discardOwnedHistorySnapshot(
        transaction.historyStagingPath,
        transaction.historyTarget,
        transaction.oldCurrent.sha256,
        "Failed history snapshot",
      );
    } catch (error) {
      errors.push(`failed history-copy cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (transaction.stagingPath) {
    try {
      await quarantineAndRemove(transaction.stagingPath, plan.candidateSha256, "Candidate staging file");
    } catch (error) {
      errors.push(`staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (transaction.candidateCopyPath) {
    try {
      await removeOwnedPrivateFile(transaction.candidateCopyPath, "Candidate private copy");
    } catch (error) {
      errors.push(`candidate-copy cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (transaction.markerArmed && errors.length === 0) {
    try {
      await quarantineAndRemove(transaction.markerPath, transaction.markerSha256, "Transaction marker");
      transaction.markerArmed = false;
    } catch (error) {
      errors.push(`transaction marker cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function serializeEntries(entries) {
  return entries.map((entry) => ({
    revision: entry.revision,
    path: entry.path,
    sha256: entry.sha256,
  }));
}

async function promoteActiveRevisionUnderFamilyMutex(plan, { hooks = {}, familyMutexLease } = {}) {
  assertPromotionFamilyMutexHeld(familyMutexLease);
  // Validate every existing bound directory and the candidate before creating
  // the history directory. Invalid plans must remain completely read-only.
  await assertBoundParentsBeforeMutation(plan);
  await verifyCandidateSource(plan);
  await assertBoundDirectories(plan, { createHistory: true });

  if (
    samePath(path.dirname(plan.candidatePath), plan.archivePath) ||
    samePath(path.dirname(plan.candidatePath), plan.historyPath)
  ) {
    if (!samePath(plan.candidatePath, plan.candidateDestinationPath)) {
      fail("candidatePath must be outside archivePath and historyPath before promotion.");
    }
  }

  assertPromotionFamilyMutexHeld(familyMutexLease);
  const lock = await acquireLock(plan, hooks);
  let lockOwned = true;
  const transaction = {
    candidateCopyPath: lock.record.candidateCopyPath,
    stagingPath: lock.record.stagingPath,
    historyStagingPath: lock.record.historyStagingPath,
    oldStagingPath: lock.record.oldStagingPath,
    markerPath: lock.record.markerPath,
    markerSha256: null,
    markerArmed: false,
    committed: false,
    oldCurrent: null,
    historyTarget: null,
    historyCreated: false,
    oldRemoved: false,
    movedCurrentSha256: null,
    candidateCreated: false,
  };

  try {
    const state = await inspectRevisionState(plan);
    if (state.active.length > 1) {
      fail(`artifactKind has multiple active current revisions; found ${state.active.length}.`);
    }
    const activeCurrent = state.active[0] ?? null;
    if (
      activeCurrent &&
      samePath(activeCurrent.path, plan.candidateDestinationPath) &&
      activeCurrent.revision === plan.candidateRevision &&
      activeCurrent.sha256 === plan.candidateSha256
    ) {
      assertIdempotentHistory(plan, state);
      await releaseOwnedLock(lock);
      lockOwned = false;
      return {
        ok: true,
        status: "already_current",
        artifactKind: plan.artifactKind,
        candidateRevision: plan.candidateRevision,
        current: { path: activeCurrent.path, sha256: activeCurrent.sha256 },
        history: serializeEntries(state.history),
      };
    }

    const oldCurrent = validatePrePromotionState(plan, state);
    transaction.oldCurrent = oldCurrent;
    if (state.active.some((entry) => samePath(entry.path, plan.candidateDestinationPath))) {
      fail(`Candidate destination already exists: ${plan.candidateDestinationPath}.`);
    }

    assertPromotionFamilyMutexHeld(familyMutexLease);
    const armed = await armTransaction(lock, hooks);
    transaction.markerSha256 = armed.sha256;
    transaction.markerArmed = true;
    if (typeof hooks.beforeCandidatePrivateCopy === "function") {
      await hooks.beforeCandidatePrivateCopy({ copyPath: transaction.candidateCopyPath });
    }
    assertPromotionFamilyMutexHeld(familyMutexLease);
    await installVerifiedPrivateCopy(
      plan.candidatePath,
      transaction.candidateCopyPath,
      transaction.stagingPath,
      plan.candidateSha256,
      "candidate",
    );

    if (oldCurrent) {
      transaction.historyTarget = path.join(plan.historyPath, oldCurrent.filename);
      if (typeof hooks.beforeHistoryPrivateCopy === "function") {
        await hooks.beforeHistoryPrivateCopy({ stagingPath: transaction.historyStagingPath, oldCurrent });
      }
      assertPromotionFamilyMutexHeld(familyMutexLease);
      await fs.copyFile(oldCurrent.path, transaction.historyStagingPath, fsConstants.COPYFILE_EXCL);
      await assertHash(transaction.historyStagingPath, oldCurrent.sha256, "historical private staging");
      try {
        await fs.link(transaction.historyStagingPath, transaction.historyTarget);
        transaction.historyCreated = true;
      } catch (error) {
        throw error;
      }
      const [historyStagingStat, historyTargetStat] = await Promise.all([
        fs.lstat(transaction.historyStagingPath),
        fs.lstat(transaction.historyTarget),
      ]);
      if (!sameFileIdentity(historyStagingStat, historyTargetStat)) {
        fail("Historical snapshot does not identify its verified private staging bytes.");
      }
      await assertHash(transaction.historyTarget, oldCurrent.sha256, "historical current snapshot");
      if (typeof hooks.afterHistoryLinked === "function") {
        await hooks.afterHistoryLinked({ plan, oldCurrent });
      }
      assertPromotionFamilyMutexHeld(familyMutexLease);
      await fs.rename(oldCurrent.path, transaction.oldStagingPath);
      transaction.oldRemoved = true;
      transaction.movedCurrentSha256 = await sha256File(transaction.oldStagingPath);
      if (transaction.movedCurrentSha256 !== oldCurrent.sha256) {
        fail(`Current changed during atomic staging; moved bytes were preserved with SHA256 ${transaction.movedCurrentSha256}.`);
      }
      await assertHash(transaction.historyTarget, oldCurrent.sha256, "historical current snapshot after atomic staging");
      await assertHash(transaction.historyStagingPath, oldCurrent.sha256, "historical private staging after atomic staging");
      if (typeof hooks.afterOldCurrentStaged === "function") {
        await hooks.afterOldCurrentStaged({ plan, oldCurrent });
      }
    }

    if (typeof hooks.beforeCandidatePromotion === "function") {
      await hooks.beforeCandidatePromotion({ plan, oldCurrent });
    }

    assertPromotionFamilyMutexHeld(familyMutexLease);
    transaction.candidateCreated = true;
    try {
      await fs.link(transaction.stagingPath, plan.candidateDestinationPath);
    } catch (error) {
      if (error?.code === "EEXIST") transaction.candidateCreated = false;
      throw error;
    }
    const [stagedCandidateStat, promotedCandidateStat] = await Promise.all([
      fs.lstat(transaction.stagingPath),
      fs.lstat(plan.candidateDestinationPath),
    ]);
    if (!sameFileIdentity(stagedCandidateStat, promotedCandidateStat)) {
      fail("Promoted candidate does not identify the staged candidate bytes.");
    }
    await assertHash(plan.candidateDestinationPath, plan.candidateSha256, "promoted candidate");

    if (typeof hooks.afterCandidatePromotion === "function") {
      await hooks.afterCandidatePromotion({ plan, oldCurrent });
    }

    const postState = await inspectRevisionState(plan, { requireOneActive: true });
    const current = postState.active[0];
    if (
      !samePath(current.path, plan.candidateDestinationPath) ||
      current.revision !== plan.candidateRevision ||
      current.sha256 !== plan.candidateSha256
    ) {
      fail("Post-promotion active current does not match the bound candidate path, revision, and SHA256.");
    }
    if (oldCurrent) {
      const historical = findByPath(postState.history, transaction.historyTarget);
      if (!historical || historical.sha256 !== oldCurrent.sha256) {
        fail("The replaced current revision was not preserved in history with its original SHA256.");
      }
    }

    assertPromotionFamilyMutexHeld(familyMutexLease);
    await quarantineAndRemove(transaction.markerPath, transaction.markerSha256, "Committed transaction marker");
    transaction.markerArmed = false;
    transaction.committed = true;
    if (typeof hooks.afterCommitMarkerRemoved === "function") {
      await hooks.afterCommitMarkerRemoved({ plan, oldCurrent });
    }
    if (oldCurrent) {
      await quarantineAndRemove(transaction.oldStagingPath, oldCurrent.sha256, "Committed old staging file");
      await quarantineAndRemove(
        transaction.historyStagingPath,
        oldCurrent.sha256,
        "Committed historical private staging",
      );
    }
    await quarantineAndRemove(transaction.stagingPath, plan.candidateSha256, "Committed candidate staging file");
    transaction.stagingPath = null;
    await releaseOwnedLock(lock);
    lockOwned = false;

    return {
      ok: true,
      status: oldCurrent ? "replaced" : "created",
      artifactKind: plan.artifactKind,
      candidateRevision: plan.candidateRevision,
      current: { path: current.path, sha256: current.sha256 },
      history: serializeEntries(postState.history),
    };
  } catch (error) {
    const rollbackErrors = transaction.committed
      ? []
      : await rollbackTransaction(plan, transaction);
    if (transaction.committed) {
      try {
        await recoverCommittedCleanup(lock.record);
      } catch (cleanupError) {
        rollbackErrors.push(`committed cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    if (lockOwned && rollbackErrors.length === 0) {
      try {
        await releaseOwnedLock(lock);
        lockOwned = false;
      } catch (lockError) {
        rollbackErrors.push(`lock cleanup failed: ${lockError instanceof Error ? lockError.message : String(lockError)}`);
      }
    } else if (lockOwned) {
      try {
        await lock.handle.close();
      } catch (lockError) {
        rollbackErrors.push(`lock-handle close failed: ${lockError instanceof Error ? lockError.message : String(lockError)}`);
      }
      rollbackErrors.push(`recovery journal preserved at ${lock.path}`);
    }
    const original = error instanceof Error ? error.message : String(error);
    if (transaction.committed) {
      fail(`${original} Promotion was already committed; inspect the current revision. ${rollbackErrors.join("; ")}`.trim());
    }
    if (rollbackErrors.length > 0) {
      fail(`${original} Rollback incomplete: ${rollbackErrors.join("; ")}`);
    }
    fail(`${original} Original current state was restored.`);
  }
}

export async function promoteActiveRevision(rawPlan, { hooks = {}, mutexTimeoutMs = 15_000 } = {}) {
  const plan = normalizePromotionPlan(rawPlan);
  const familyMutexLease = await acquirePromotionFamilyMutex(plan, { timeoutMs: mutexTimeoutMs });
  let operationError = null;
  try {
    if (typeof hooks.afterFamilyMutexAcquired === "function") {
      await hooks.afterFamilyMutexAcquired({
        archivePath: plan.archivePath,
        artifactKind: plan.artifactKind,
      });
    }
    assertPromotionFamilyMutexHeld(familyMutexLease);
    return await promoteActiveRevisionUnderFamilyMutex(plan, { hooks, familyMutexLease });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await releasePromotionFamilyMutex(familyMutexLease);
    } catch (releaseError) {
      if (operationError === null) throw releaseError;
    }
  }
}

export function parsePlanCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--plan") {
    fail("Usage: promote_active_revision.mjs --plan <absolute-plan.json>.");
  }
  return cleanAbsolutePath(argv[1], "--plan");
}

export async function readPromotionPlan(planPath) {
  await assertPlainFile(planPath, "promotion plan");
  let parsed;
  try {
    parsed = JSON.parse((await fs.readFile(planPath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`Could not parse promotion plan JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  normalizePromotionPlan(parsed);
  return parsed;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  try {
    const planPath = parsePlanCli(process.argv.slice(2));
    const plan = await readPromotionPlan(planPath);
    emit(await promoteActiveRevision(plan));
    process.exitCode = 0;
  } catch (error) {
    emit({
      ok: false,
      status: "promotion_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
