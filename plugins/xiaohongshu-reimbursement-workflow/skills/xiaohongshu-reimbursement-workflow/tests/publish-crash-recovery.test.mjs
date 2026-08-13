import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { recoverSafePublish } from "../scripts/run_safe_publish.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powerShellScript = path.join(skillRoot, "scripts", "safe_publish.ps1");
const runnerScript = path.join(skillRoot, "scripts", "run_safe_publish.mjs");
const ledgerPublisherScript = path.join(skillRoot, "scripts", "publish_ledger_reorder.mjs");
const standardTargetName = "小红书支出总表.xlsx";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function powerShellArguments(options, pauseMilliseconds = 0) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    powerShellScript,
    "-BaselinePath",
    options.baselinePath,
    "-CandidatePath",
    options.candidatePath,
    "-TargetPath",
    options.targetPath,
    "-ExpectedBaselineSha256",
    options.expectedBaselineSha256,
    "-ExpectedCandidateSha256",
    options.expectedCandidateSha256,
  ];
  if (pauseMilliseconds > 0) {
    args.push("-InternalTestPauseAfterMutationMilliseconds", String(pauseMilliseconds));
  }
  return args;
}

function runnerArguments(options) {
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

function readJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `Expected one JSON line, got ${JSON.stringify(stdout)}.`);
  return JSON.parse(lines[0]);
}

async function waitFor(predicate, label, timeoutMilliseconds = 15_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function listTransactionFiles(root) {
  return (await fs.readdir(root)).filter((name) => name.startsWith(".codex-xhs-"));
}

async function readOnlyJournal(root) {
  const names = (await fs.readdir(root)).filter((name) => /^\.codex-xhs-publish-[0-9a-f]{32}\.journal$/.test(name));
  assert.equal(names.length, 1, `Expected one journal, got ${JSON.stringify(names)}.`);
  return {
    name: names[0],
    value: JSON.parse(await fs.readFile(path.join(root, names[0]), "utf8")),
  };
}

async function startAndKillAfterMutation(options, root, expectedPhase) {
  const child = spawn("powershell.exe", powerShellArguments(options, 30_000), {
    encoding: "utf8",
    env: { ...process.env, CODEX_XHS_PUBLISH_TEST_MODE: "1" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  await waitFor(async () => {
    const journal = await readOnlyJournal(root);
    if (journal.value.phase !== expectedPhase) return false;
    try {
      return sha256(await fs.readFile(options.targetPath)) === options.expectedCandidateSha256;
    } catch {
      return false;
    }
  }, `${expectedPhase} with candidate bytes installed`);

  assert.equal(child.kill(), true, "Expected to terminate the paused publisher process.");
  const crash = await closed;
  assert.ok(crash.code !== 0 || crash.signal !== null, `Publisher unexpectedly exited cleanly: ${JSON.stringify(crash)}.`);
  await waitFor(async () => {
    try {
      process.kill(child.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "terminated publisher process");
  return crash;
}

async function startAndKillAfterMetadataStage(options, root, metadataPhase) {
  const child = spawn(
    "powershell.exe",
    [
      ...powerShellArguments(options),
      "-InternalTestPauseAfterMetadataPhase",
      metadataPhase,
      "-InternalTestPauseAfterMetadataMilliseconds",
      "30000",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_XHS_PUBLISH_TEST_MODE: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  await waitFor(async () => {
    const names = await fs.readdir(root);
    if (metadataPhase.startsWith("lock_")) {
      const pending = names.find((name) => /^\.codex-xhs-publish\.lock\.pending-[0-9a-f]{32}$/.test(name));
      if (!pending || names.includes(".codex-xhs-publish.lock")) return false;
      if (metadataPhase === "lock_partial") {
        return (await fs.stat(path.join(root, pending))).size === 1;
      }
      try {
        return JSON.parse(await fs.readFile(path.join(root, pending), "utf8")).kind === "codex-xhs-publish-lock";
      } catch {
        return false;
      }
    }
    const pending = names.find((name) => /^\.codex-xhs-publish-[0-9a-f]{32}\.journal\.pending-[0-9a-f]{32}$/.test(name));
    if (!names.includes(".codex-xhs-publish.lock") || !pending ||
        names.some((name) => /^\.codex-xhs-publish-[0-9a-f]{32}\.journal$/.test(name))) return false;
    if (metadataPhase === "journal_partial") {
      return (await fs.stat(path.join(root, pending))).size === 1;
    }
    try {
      return JSON.parse(await fs.readFile(path.join(root, pending), "utf8")).kind === "codex-xhs-publish-journal";
    } catch {
      return false;
    }
  }, `${metadataPhase} atomically staged metadata`);

  assert.equal(child.kill(), true);
  const crash = await closed;
  assert.ok(crash.code !== 0 || crash.signal !== null, `Publisher unexpectedly exited cleanly: ${JSON.stringify(crash)}.`);
}

async function startAndKillDuringTempCopy(options, root, expectedPhase, expectedInitialTargetSha256 = null) {
  const child = spawn(
    "powershell.exe",
    [
      ...powerShellArguments(options),
      "-InternalTestPauseDuringTempCopyMilliseconds",
      "30000",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_XHS_PUBLISH_TEST_MODE: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  let partialTempPath;
  await waitFor(async () => {
    const journal = await readOnlyJournal(root);
    if (journal.value.phase !== expectedPhase) return false;
    const tempName = (await fs.readdir(root)).find((name) => /^\.codex-xhs-publish-[0-9a-f]{32}\.tmp$/.test(name));
    if (!tempName) return false;
    partialTempPath = path.join(root, tempName);
    if ((await fs.stat(partialTempPath)).size !== 1) return false;
    if (expectedInitialTargetSha256 === null) {
      try {
        await fs.access(options.targetPath);
        return false;
      } catch {
        return true;
      }
    }
    return sha256(await fs.readFile(options.targetPath)) === expectedInitialTargetSha256;
  }, `${expectedPhase} with a one-byte partial publish copy`);

  assert.equal(child.kill(), true);
  const crash = await closed;
  assert.ok(crash.code !== 0 || crash.signal !== null, `Publisher unexpectedly exited cleanly: ${JSON.stringify(crash)}.`);
  assert.equal((await fs.stat(partialTempPath)).size, 1);
  return partialTempPath;
}

function recoverWithRunner(options) {
  return spawnSync(process.execPath, [runnerScript, ...runnerArguments(options)], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
}

test(
  "a killed first publish is recovered from create_armed and exact transaction files are cleaned",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-publish-crash-create-"));
    try {
      const baselineBytes = Buffer.from("anonymous create baseline\n", "utf8");
      const candidateBytes = Buffer.from("anonymous create candidate\n", "utf8");
      const baselinePath = path.join(root, "anonymous-baseline.xlsx");
      const candidatePath = path.join(root, "anonymous-candidate.xlsx");
      const targetPath = path.join(root, standardTargetName);
      await Promise.all([
        fs.writeFile(baselinePath, baselineBytes, { flag: "wx" }),
        fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
      ]);
      const options = {
        baselinePath,
        candidatePath,
        targetPath,
        expectedBaselineSha256: sha256(baselineBytes),
        expectedCandidateSha256: sha256(candidateBytes),
      };

      await startAndKillAfterMutation(options, root, "create_armed");
      assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
      assert.ok((await listTransactionFiles(root)).some((name) => name.endsWith(".journal")));

      const recovered = recoverWithRunner(options);
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
      assert.equal(recovered.stderr, "");
      const payload = readJsonLine(recovered.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.status, "created");
      assert.equal(payload.sha256.toLowerCase(), options.expectedCandidateSha256);
      assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
      assert.deepEqual(await listTransactionFiles(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("ledger publisher probes durable recovery before re-auditing the replaced source path", async () => {
  const source = await fs.readFile(ledgerPublisherScript, "utf8");
  const recoveryCall = source.indexOf("const recoveryResult = recoverSafePublish(publishOptions)");
  const idempotentResult = source.indexOf('status: "already_current"', recoveryCall);
  const guardedAudit = source.indexOf("await auditLedgerReorder(plan, plan.activeCandidatePath)", recoveryCall);
  const freshPublish = source.indexOf("runSafePublish(publishOptions)", guardedAudit);
  assert.ok(recoveryCall >= 0, "Expected the correction publisher to invoke recoverSafePublish.");
  assert.ok(idempotentResult > recoveryCall && idempotentResult < guardedAudit,
    "An already-published target must return before the source-dependent audit and fresh publisher.");
  assert.ok(guardedAudit > recoveryCall, "Recovery must run before the source-dependent audit.");
  assert.ok(freshPublish > guardedAudit, "Fresh publication must remain after the exhaustive audit.");
});

for (const metadataPhase of ["lock_pending", "journal_pending", "journal_partial"]) {
  test(
    `a kill at ${metadataPhase} never exposes partial canonical metadata and the next run succeeds`,
    { skip: process.platform !== "win32" },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-publish-crash-${metadataPhase}-`));
      try {
        const baselineBytes = Buffer.from(`anonymous ${metadataPhase} baseline\n`, "utf8");
        const candidateBytes = Buffer.from(`anonymous ${metadataPhase} candidate\n`, "utf8");
        const baselinePath = path.join(root, "anonymous-baseline.xlsx");
        const candidatePath = path.join(root, "anonymous-candidate.xlsx");
        const targetPath = path.join(root, standardTargetName);
        await Promise.all([
          fs.writeFile(baselinePath, baselineBytes, { flag: "wx" }),
          fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
        ]);
        const options = {
          baselinePath,
          candidatePath,
          targetPath,
          expectedBaselineSha256: sha256(baselineBytes),
          expectedCandidateSha256: sha256(candidateBytes),
        };

        await startAndKillAfterMetadataStage(options, root, metadataPhase);
        await assert.rejects(fs.access(targetPath));
        const canonicalMetadata = (await fs.readdir(root)).filter((name) =>
          name === ".codex-xhs-publish.lock" || /^\.codex-xhs-publish-[0-9a-f]{32}\.journal$/.test(name));
        assert.deepEqual(
          canonicalMetadata,
          metadataPhase.startsWith("journal_") ? [".codex-xhs-publish.lock"] : [],
        );

        const recovered = recoverWithRunner(options);
        assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
        assert.equal(readJsonLine(recovered.stdout).status, "created");
        assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
        assert.deepEqual(await listTransactionFiles(root), []);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}

for (const publishMode of ["create", "replace"]) {
  test(
    `a killed ${publishMode} temp copy discards only its owner-bound partial bytes and resumes`,
    { skip: process.platform !== "win32" },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `codex-xhs-publish-temp-partial-${publishMode}-`));
      try {
        const baselineBytes = Buffer.from(`anonymous temp partial ${publishMode} baseline\n`, "utf8");
        const candidateBytes = Buffer.from(`anonymous temp partial ${publishMode} candidate `.repeat(32), "utf8");
        const targetPath = path.join(root, standardTargetName);
        const baselinePath = publishMode === "replace" ? targetPath : path.join(root, "anonymous-baseline.xlsx");
        const candidatePath = path.join(root, "anonymous-candidate.xlsx");
        await fs.writeFile(baselinePath, baselineBytes, { flag: "wx" });
        await fs.writeFile(candidatePath, candidateBytes, { flag: "wx" });
        const options = {
          baselinePath,
          candidatePath,
          targetPath,
          expectedBaselineSha256: sha256(baselineBytes),
          expectedCandidateSha256: sha256(candidateBytes),
        };

        const partialTempPath = await startAndKillDuringTempCopy(
          options,
          root,
          publishMode === "replace" ? "replace_armed" : "create_armed",
          publishMode === "replace" ? options.expectedBaselineSha256 : null,
        );
        assert.notEqual(sha256(await fs.readFile(partialTempPath)), options.expectedCandidateSha256);

        let payload;
        if (publishMode === "replace") {
          payload = recoverSafePublish(options);
        } else {
          const recovered = recoverWithRunner(options);
          assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
          assert.equal(recovered.stderr, "");
          payload = readJsonLine(recovered.stdout);
        }
        assert.equal(payload.ok, true);
        assert.equal(payload.status, publishMode === "replace" ? "replaced" : "created");
        assert.equal(payload.sha256.toLowerCase(), options.expectedCandidateSha256);
        assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
        assert.deepEqual(await listTransactionFiles(root), []);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "recovery-only reports no_recovery without publishing when no durable transaction exists",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-publish-recovery-only-"));
    try {
      const baselineBytes = Buffer.from("anonymous recovery probe baseline\n", "utf8");
      const candidateBytes = Buffer.from("anonymous recovery probe candidate\n", "utf8");
      const baselinePath = path.join(root, "anonymous-baseline.xlsx");
      const candidatePath = path.join(root, "anonymous-candidate.xlsx");
      const targetPath = path.join(root, standardTargetName);
      await Promise.all([
        fs.writeFile(baselinePath, baselineBytes, { flag: "wx" }),
        fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
      ]);
      const options = {
        baselinePath,
        candidatePath,
        targetPath,
        expectedBaselineSha256: sha256(baselineBytes),
        expectedCandidateSha256: sha256(candidateBytes),
      };

      const result = recoverSafePublish(options);
      assert.equal(result.ok, true);
      assert.equal(result.status, "no_recovery");
      assert.equal(result.sha256, null);
      await assert.rejects(fs.access(targetPath));
      assert.deepEqual(await listTransactionFiles(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a killed replace is recovered from replace_armed using the bound baseline backup",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-publish-crash-replace-"));
    try {
      const baselineBytes = Buffer.from("anonymous replace baseline\n", "utf8");
      const candidateBytes = Buffer.from("anonymous replace candidate\n", "utf8");
      const targetPath = path.join(root, standardTargetName);
      const candidatePath = path.join(root, "anonymous-candidate.xlsx");
      await Promise.all([
        fs.writeFile(targetPath, baselineBytes, { flag: "wx" }),
        fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
      ]);
      const options = {
        baselinePath: targetPath,
        candidatePath,
        targetPath,
        expectedBaselineSha256: sha256(baselineBytes),
        expectedCandidateSha256: sha256(candidateBytes),
      };

      await startAndKillAfterMutation(options, root, "replace_armed");
      const transactionFiles = await listTransactionFiles(root);
      const backupName = transactionFiles.find((name) => /^\.codex-xhs-backup-[0-9a-f]{32}\.tmp$/.test(name));
      assert.ok(backupName, `Expected a bound backup, got ${JSON.stringify(transactionFiles)}.`);
      assert.deepEqual(await fs.readFile(path.join(root, backupName)), baselineBytes);
      assert.deepEqual(await fs.readFile(targetPath), candidateBytes);

      const payload = recoverSafePublish(options);
      assert.equal(payload.ok, true);
      assert.equal(payload.status, "replaced");
      assert.equal(payload.sha256.toLowerCase(), options.expectedCandidateSha256);
      assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
      assert.deepEqual(await listTransactionFiles(root), []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "recovery preserves an altered backup and journal instead of deleting unproven bytes",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-publish-crash-tamper-"));
    try {
      const baselineBytes = Buffer.from("anonymous tamper baseline\n", "utf8");
      const candidateBytes = Buffer.from("anonymous tamper candidate\n", "utf8");
      const foreignBytes = Buffer.from("foreign bytes must survive\n", "utf8");
      const targetPath = path.join(root, standardTargetName);
      const candidatePath = path.join(root, "anonymous-candidate.xlsx");
      await Promise.all([
        fs.writeFile(targetPath, baselineBytes, { flag: "wx" }),
        fs.writeFile(candidatePath, candidateBytes, { flag: "wx" }),
      ]);
      const options = {
        baselinePath: targetPath,
        candidatePath,
        targetPath,
        expectedBaselineSha256: sha256(baselineBytes),
        expectedCandidateSha256: sha256(candidateBytes),
      };

      await startAndKillAfterMutation(options, root, "replace_armed");
      const backupName = (await listTransactionFiles(root)).find((name) => /^\.codex-xhs-backup-[0-9a-f]{32}\.tmp$/.test(name));
      assert.ok(backupName);
      const backupPath = path.join(root, backupName);
      await fs.writeFile(backupPath, foreignBytes);

      const rejected = recoverWithRunner(options);
      assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
      assert.equal(rejected.stderr, "");
      const payload = readJsonLine(rejected.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.status, "runner_failed");
      assert.equal(payload.recovery.recoveryLock, path.join(root, ".codex-xhs-publish.lock"));
      assert.match(payload.recovery.recoveryJournal, /\.journal$/);
      assert.deepEqual(await fs.readFile(backupPath), foreignBytes);
      assert.deepEqual(await fs.readFile(targetPath), candidateBytes);
      const preserved = await listTransactionFiles(root);
      assert.ok(preserved.includes(".codex-xhs-publish.lock"));
      assert.ok(preserved.some((name) => name.endsWith(".journal")));
      assert.ok(preserved.includes(backupName));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
