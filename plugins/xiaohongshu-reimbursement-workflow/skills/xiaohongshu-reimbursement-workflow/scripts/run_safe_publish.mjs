#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const safePublishScript = path.join(scriptDirectory, "safe_publish.ps1");
const sha256Pattern = /^[0-9a-f]{64}$/i;
const acceptedStatuses = new Set(["created", "replaced", "already_current"]);
const acceptedFailureStatuses = new Set(["publish_failed", "published_cleanup_failed"]);
const standardTargetName = "小红书支出总表.xlsx";
const flagToKey = new Map([
  ["--baseline-path", "baselinePath"],
  ["--candidate-path", "candidatePath"],
  ["--target-path", "targetPath"],
  ["--expected-baseline-sha256", "expectedBaselineSha256"],
  ["--expected-candidate-sha256", "expectedCandidateSha256"],
]);
const requiredKeys = [...flagToKey.values()];

function fail(message) {
  throw new Error(message);
}

class PublishRunnerError extends Error {
  constructor(message, recovery = undefined) {
    super(message);
    this.name = "PublishRunnerError";
    this.recovery = recovery;
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("Publish options must be an object.");
  }

  const normalized = {};
  for (const key of requiredKeys) {
    const value = options[key];
    if (typeof value !== "string" || value.trim() === "") {
      fail(`Missing required publish option: ${key}.`);
    }
    normalized[key] = value.trim();
  }

  for (const key of ["baselinePath", "candidatePath", "targetPath"]) {
    if (!path.isAbsolute(normalized[key])) fail(`${key} must be an absolute path.`);
    normalized[key] = path.resolve(normalized[key]);
    if (path.extname(normalized[key]).toLowerCase() !== ".xlsx") {
      fail(`${key} must use the .xlsx extension.`);
    }
  }
  if (path.basename(normalized.targetPath).toLowerCase() !== standardTargetName.toLowerCase()) {
    fail(`targetPath must use the exact standard filename ${standardTargetName}.`);
  }
  if (!samePath(path.dirname(normalized.baselinePath), path.dirname(normalized.targetPath))) {
    fail("baselinePath and targetPath must be in the same bound root directory.");
  }
  if (samePath(normalized.candidatePath, normalized.targetPath)) {
    fail("candidatePath and targetPath must be different paths.");
  }

  for (const key of ["expectedBaselineSha256", "expectedCandidateSha256"]) {
    if (!sha256Pattern.test(normalized[key])) {
      fail(`${key} must contain exactly 64 hexadecimal characters.`);
    }
    normalized[key] = normalized[key].toLowerCase();
  }

  return normalized;
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) fail("CLI arguments must be an array.");

  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flagToKey.get(flag);
    if (!key) fail(`Unknown argument: ${String(flag)}.`);
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${flag}.`);
    if (index + 1 >= argv.length || typeof argv[index + 1] !== "string" || argv[index + 1] === "") {
      fail(`Missing value for argument: ${flag}.`);
    }
    values[key] = argv[index + 1];
  }

  return validateOptions(values);
}

function parseSingleJsonLine(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    fail("safe_publish.ps1 stdout must contain exactly one JSON line.");
  }

  let line = stdout;
  if (line.endsWith("\r\n")) line = line.slice(0, -2);
  else if (line.endsWith("\n")) line = line.slice(0, -1);

  if (line.length === 0 || line.includes("\r") || line.includes("\n")) {
    fail("safe_publish.ps1 stdout must contain exactly one JSON line.");
  }

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    fail("safe_publish.ps1 stdout is not valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("safe_publish.ps1 JSON payload must be an object.");
  }
  return payload;
}

function validateFailurePayload(payload, expectedTargetPath, exitCode) {
  if (payload.ok !== false || !acceptedFailureStatuses.has(payload.status)) {
    fail("safe_publish.ps1 did not report a supported failure payload.");
  }
  if (typeof payload.error !== "string" || payload.error.trim() === "") {
    fail("safe_publish.ps1 failure payload did not include an error message.");
  }
  if (typeof payload.target !== "string" || !path.isAbsolute(payload.target) || !samePath(payload.target, expectedTargetPath)) {
    fail("safe_publish.ps1 failure payload target does not match TargetPath.");
  }
  for (const key of [
    "rollback_error",
    "preserved_backup",
    "preserved_target",
    "recovery_lock",
    "recovery_journal",
  ]) {
    if (payload[key] !== null && payload[key] !== undefined && typeof payload[key] !== "string") {
      fail(`safe_publish.ps1 failure payload ${key} must be a string or null.`);
    }
  }
  for (const key of ["preserved_backup", "preserved_target", "recovery_lock", "recovery_journal"]) {
    if (typeof payload[key] === "string" && !path.isAbsolute(payload[key])) {
      fail(`safe_publish.ps1 failure payload ${key} must be an absolute path.`);
    }
  }
  if (!Array.isArray(payload.cleanup_errors) || payload.cleanup_errors.some((item) => typeof item !== "string")) {
    fail("safe_publish.ps1 failure payload cleanup_errors must be an array of strings.");
  }
  if (payload.sha256 !== undefined && payload.sha256 !== null && !sha256Pattern.test(payload.sha256)) {
    fail("safe_publish.ps1 failure payload sha256 is invalid.");
  }
  const recovery = {
    powershellStatus: exitCode,
    publishStatus: payload.status,
    publishError: payload.error,
    rollbackError: payload.rollback_error ?? null,
    preservedBackup: payload.preserved_backup ?? null,
    preservedTarget: payload.preserved_target ?? null,
    recoveryLock: payload.recovery_lock ?? null,
    recoveryJournal: payload.recovery_journal ?? null,
    cleanupErrors: payload.cleanup_errors,
    target: path.resolve(payload.target),
  };
  if (payload.sha256) recovery.sha256 = payload.sha256.toLowerCase();
  throw new PublishRunnerError(`safe_publish.ps1 failed: ${payload.error}`, recovery);
}

export function validatePowerShellResult(
  result,
  expectedCandidateSha256,
  expectedTargetPath,
  { allowNoRecovery = false } = {},
) {
  if (!sha256Pattern.test(expectedCandidateSha256)) {
    fail("expectedCandidateSha256 must contain exactly 64 hexadecimal characters.");
  }
  if (typeof expectedTargetPath !== "string" || !path.isAbsolute(expectedTargetPath)) {
    fail("expectedTargetPath must be an absolute path.");
  }
  if (!result || typeof result !== "object") fail("PowerShell did not return a process result.");
  if (result.error) fail(`Could not start powershell.exe: ${result.error.message ?? String(result.error)}.`);
  if (result.signal !== null && result.signal !== undefined) {
    fail(`safe_publish.ps1 was terminated by signal ${String(result.signal)}.`);
  }
  if (result.stderr !== "") {
    fail("safe_publish.ps1 wrote to stderr.");
  }

  const payload = parseSingleJsonLine(result.stdout);
  if (result.status !== 0) validateFailurePayload(payload, expectedTargetPath, result.status);
  if (payload.ok !== true) fail("safe_publish.ps1 did not report ok:true.");
  if (payload.status === "no_recovery") {
    if (!allowNoRecovery) fail("safe_publish.ps1 reported no_recovery outside recovery-only mode.");
    if (payload.sha256 !== null && payload.sha256 !== undefined) {
      fail("safe_publish.ps1 no_recovery payload must not report a SHA256.");
    }
    if (typeof payload.target !== "string" || !path.isAbsolute(payload.target) || !samePath(payload.target, expectedTargetPath)) {
      fail("safe_publish.ps1 reported a target different from TargetPath.");
    }
    return payload;
  }
  if (!acceptedStatuses.has(payload.status)) {
    fail("safe_publish.ps1 reported an unsupported success status.");
  }
  if (typeof payload.sha256 !== "string" || !sha256Pattern.test(payload.sha256)) {
    fail("safe_publish.ps1 did not report a valid SHA256.");
  }
  if (payload.sha256.toLowerCase() !== expectedCandidateSha256.toLowerCase()) {
    fail("safe_publish.ps1 reported a SHA256 different from ExpectedCandidateSha256.");
  }
  if (typeof payload.target !== "string" || !path.isAbsolute(payload.target) || !samePath(payload.target, expectedTargetPath)) {
    fail("safe_publish.ps1 reported a target different from TargetPath.");
  }
  return payload;
}

export function runSafePublish(options, { spawnImpl = spawnSync } = {}) {
  const values = validateOptions(options);
  const powerShellArguments = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    safePublishScript,
    "-BaselinePath",
    values.baselinePath,
    "-CandidatePath",
    values.candidatePath,
    "-TargetPath",
    values.targetPath,
    "-ExpectedBaselineSha256",
    values.expectedBaselineSha256,
    "-ExpectedCandidateSha256",
    values.expectedCandidateSha256,
  ];
  const result = spawnImpl("powershell.exe", powerShellArguments, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return validatePowerShellResult(result, values.expectedCandidateSha256, values.targetPath);
}

export function recoverSafePublish(options, { spawnImpl = spawnSync } = {}) {
  const values = validateOptions(options);
  const powerShellArguments = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    safePublishScript,
    "-BaselinePath",
    values.baselinePath,
    "-CandidatePath",
    values.candidatePath,
    "-TargetPath",
    values.targetPath,
    "-ExpectedBaselineSha256",
    values.expectedBaselineSha256,
    "-ExpectedCandidateSha256",
    values.expectedCandidateSha256,
    "-RecoveryOnly",
  ];
  const result = spawnImpl("powershell.exe", powerShellArguments, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  return validatePowerShellResult(result, values.expectedCandidateSha256, values.targetPath, {
    allowNoRecovery: true,
  });
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main() {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    emit(runSafePublish(options));
    process.exitCode = 0;
  } catch (error) {
    const payload = {
      ok: false,
      status: "runner_failed",
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof PublishRunnerError && error.recovery) payload.recovery = error.recovery;
    emit(payload);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
