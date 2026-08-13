import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseCliArguments,
  runSafePublish,
  validatePowerShellResult,
} from "../scripts/run_safe_publish.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerScript = path.join(skillRoot, "scripts", "run_safe_publish.mjs");
const baselineSha256 = "a".repeat(64);
const candidateSha256 = "b".repeat(64);
const optionRoot = path.join(os.tmpdir(), "codex-xhs-publish-runner-options");
const validOptions = {
  baselinePath: path.join(optionRoot, "anonymous-baseline.xlsx"),
  candidatePath: path.join(optionRoot, "anonymous-candidate.xlsx"),
  targetPath: path.join(optionRoot, "小红书支出总表.xlsx"),
  expectedBaselineSha256: baselineSha256,
  expectedCandidateSha256: candidateSha256,
};

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function toCliArguments(options) {
  return [
    "--baseline-path",
    options.baselinePath,
    "--candidate-path",
    options.candidatePath,
    "--target-path",
    options.targetPath,
    "--expected-baseline-sha256",
    options.expectedBaselineSha256,
    "--expected-candidate-sha256",
    options.expectedCandidateSha256,
  ];
}

function runCli(args) {
  return spawnSync(process.execPath, [runnerScript, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}

function readOnlyJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `Expected one JSON line, got ${JSON.stringify(stdout)}.`);
  return JSON.parse(lines[0]);
}

test("CLI rejects missing, duplicate, unknown, and malformed arguments with one JSON failure", () => {
  assert.throws(() => parseCliArguments([]), /Missing required publish option/);
  assert.throws(
    () => parseCliArguments(["--baseline-path", "one", "--baseline-path", "two"]),
    /Duplicate argument/,
  );
  assert.throws(() => parseCliArguments(["--unknown", "value"]), /Unknown argument/);

  const malformed = runCli([
    ...toCliArguments(validOptions).slice(0, -1),
    "not-a-sha256",
  ]);
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr, "");
  const payload = readOnlyJsonLine(malformed.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "runner_failed");
  assert.match(payload.error, /64 hexadecimal/);
});

test("runner fixes the PowerShell executable, flags, script, and shell:false", () => {
  let invocation;
  const payload = runSafePublish(validOptions, {
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: `${JSON.stringify({
          ok: true,
          status: "replaced",
          target: validOptions.targetPath,
          sha256: candidateSha256.toUpperCase(),
        })}\r\n`,
        stderr: "",
      };
    },
  });

  assert.equal(payload.status, "replaced");
  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.match(invocation.args[5], /safe_publish\.ps1$/i);
  assert.deepEqual(invocation.args.slice(6), [
    "-BaselinePath",
    validOptions.baselinePath,
    "-CandidatePath",
    validOptions.candidatePath,
    "-TargetPath",
    validOptions.targetPath,
    "-ExpectedBaselineSha256",
    baselineSha256,
    "-ExpectedCandidateSha256",
    candidateSha256,
  ]);
});

test("exit-zero output is rejected when JSON is absent, blocked, noisy, or accompanied by stderr", async (context) => {
  const successJson = JSON.stringify({
    ok: true,
    status: "created",
    sha256: candidateSha256,
    target: validOptions.targetPath,
  });
  const cases = [
    ["no JSON", { status: 0, signal: null, stdout: "", stderr: "" }, /exactly one JSON/],
    [
      "PSSecurityException on stdout",
      { status: 0, signal: null, stdout: "PSSecurityException\r\n", stderr: "" },
      /not valid JSON/,
    ],
    [
      "noise before JSON",
      { status: 0, signal: null, stdout: `noise\r\n${successJson}\r\n`, stderr: "" },
      /exactly one JSON/,
    ],
    [
      "stderr content",
      { status: 0, signal: null, stdout: `${successJson}\r\n`, stderr: "PSSecurityException" },
      /wrote to stderr/,
    ],
  ];

  for (const [name, result, expected] of cases) {
    await context.test(name, () => {
      assert.throws(() => validatePowerShellResult(result, candidateSha256, validOptions.targetPath), expected);
    });
  }
});

test("success payload must report an accepted status and the expected candidate hash", () => {
  const result = (payload) => ({
    status: 0,
    signal: null,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: "",
  });
  assert.throws(
    () => validatePowerShellResult(result({ ok: false, status: "publish_failed" }), candidateSha256, validOptions.targetPath),
    /ok:true/,
  );
  assert.throws(
    () =>
      validatePowerShellResult(
        result({ ok: true, status: "published_cleanup_failed", sha256: candidateSha256 }),
        candidateSha256,
        validOptions.targetPath,
      ),
    /unsupported success status/,
  );
  assert.throws(
    () =>
      validatePowerShellResult(
        result({ ok: true, status: "created", sha256: "c".repeat(64), target: validOptions.targetPath }),
        candidateSha256,
        validOptions.targetPath,
      ),
    /different from ExpectedCandidateSha256/,
  );
});

test("nonzero PowerShell failure preserves structured recovery details", () => {
  const preservedBackup = path.join(optionRoot, ".codex-xhs-backup-test.tmp");
  const payload = {
    ok: false,
    status: "publish_failed",
    error: "simulated failure",
    rollback_error: "manual recovery required",
    preserved_backup: preservedBackup,
    preserved_target: null,
    cleanup_errors: ["locked temporary file"],
    target: validOptions.targetPath,
  };
  assert.throws(
    () => validatePowerShellResult(
      { status: 1, signal: null, stdout: `${JSON.stringify(payload)}\n`, stderr: "" },
      candidateSha256,
      validOptions.targetPath,
    ),
    (error) => {
      assert.match(error.message, /simulated failure/);
      assert.equal(error.recovery.preservedBackup, preservedBackup);
      assert.deepEqual(error.recovery.cleanupErrors, ["locked temporary file"]);
      return true;
    },
  );
});

test(
  "Windows integration publishes anonymous bytes and a wrong candidate hash leaves the target unchanged",
  { skip: process.platform !== "win32" },
  async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-publish-runner-test-"));
    try {
      const baselineBytes = Buffer.from("anonymous baseline\n", "utf8");
      const candidateBytes = Buffer.from("anonymous candidate\n", "utf8");
      const baselinePath = path.join(tempDir, "baseline.xlsx");
      const candidatePath = path.join(tempDir, "candidate.xlsx");
      const createdTargetPath = path.join(tempDir, "小红书支出总表.xlsx");
      await Promise.all([
        fs.writeFile(baselinePath, baselineBytes, { flag: "wx" }),
        fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
      ]);

      const created = runCli(
        toCliArguments({
          baselinePath,
          candidatePath,
          targetPath: createdTargetPath,
          expectedBaselineSha256: sha256(baselineBytes),
          expectedCandidateSha256: sha256(candidateBytes),
        }),
      );
      assert.equal(created.status, 0, `${created.stdout}\n${created.stderr}`);
      assert.equal(created.stderr, "");
      const createdPayload = readOnlyJsonLine(created.stdout);
      assert.equal(createdPayload.ok, true);
      assert.equal(createdPayload.status, "created");
      assert.equal(createdPayload.sha256.toLowerCase(), sha256(candidateBytes));
      assert.deepEqual(await fs.readFile(createdTargetPath), candidateBytes);

      const replaceRoot = path.join(tempDir, "replace-success");
      await fs.mkdir(replaceRoot);
      const replacedTargetPath = path.join(replaceRoot, "小红书支出总表.xlsx");
      await fs.writeFile(replacedTargetPath, baselineBytes, { flag: "wx" });
      const replaced = runCli(
        toCliArguments({
          baselinePath: replacedTargetPath,
          candidatePath,
          targetPath: replacedTargetPath,
          expectedBaselineSha256: sha256(baselineBytes),
          expectedCandidateSha256: sha256(candidateBytes),
        }),
      );
      assert.equal(replaced.status, 0, `${replaced.stdout}\n${replaced.stderr}`);
      assert.equal(replaced.stderr, "");
      const replacedPayload = readOnlyJsonLine(replaced.stdout);
      assert.equal(replacedPayload.ok, true);
      assert.equal(replacedPayload.status, "replaced");
      assert.deepEqual(await fs.readFile(replacedTargetPath), candidateBytes);
      assert.deepEqual(
        (await fs.readdir(replaceRoot)).filter((name) => name.startsWith(".codex-xhs-backup-")),
        [],
      );

      const protectedRoot = path.join(tempDir, "replace-case");
      await fs.mkdir(protectedRoot);
      const protectedTargetPath = path.join(protectedRoot, "小红书支出总表.xlsx");
      await fs.writeFile(protectedTargetPath, baselineBytes, { flag: "wx" });
      const before = await fs.readFile(protectedTargetPath);
      const rejected = runCli(
        toCliArguments({
          baselinePath: protectedTargetPath,
          candidatePath,
          targetPath: protectedTargetPath,
          expectedBaselineSha256: sha256(baselineBytes),
          expectedCandidateSha256: "0".repeat(64),
        }),
      );
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stderr, "");
      const rejectedPayload = readOnlyJsonLine(rejected.stdout);
      assert.equal(rejectedPayload.ok, false);
      assert.equal(rejectedPayload.status, "runner_failed");
      assert.deepEqual(await fs.readFile(protectedTargetPath), before);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
