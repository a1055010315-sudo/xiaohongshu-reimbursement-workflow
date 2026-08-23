import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { auditActiveRevisions } from "../scripts/audit_active_revisions.mjs";
import { promoteActiveRevision } from "../scripts/promote_active_revision.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promoteScript = path.join(skillRoot, "scripts", "promote_active_revision.mjs");
const auditScript = path.join(skillRoot, "scripts", "audit_active_revisions.mjs");
const artifactKind = "anonymous-artifact";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function candidateName(revision) {
  return `${artifactKind}_修正版${revision}.bin`;
}

async function createFixture({ createHistory = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-revision-test-"));
  const archivePath = path.join(root, "anonymous-archive");
  const historyPath = path.join(root, "anonymous-archive-history");
  const candidatesPath = path.join(root, "anonymous-candidates");
  const directories = [
    fs.mkdir(archivePath),
    fs.mkdir(candidatesPath),
  ];
  if (createHistory) directories.push(fs.mkdir(historyPath));
  await Promise.all(directories);
  return { root, archivePath, historyPath, candidatesPath };
}

async function writeCandidate(fixture, revision, bytes) {
  const candidatePath = path.join(fixture.candidatesPath, candidateName(revision));
  await fs.writeFile(candidatePath, bytes, { flag: "wx" });
  return candidatePath;
}

function makePlan(fixture, candidatePath, candidateBytes, revision, expected = null) {
  return {
    version: 1,
    archivePath: fixture.archivePath,
    historyPath: fixture.historyPath,
    artifactKind,
    candidatePath,
    candidateSha256: sha256(candidateBytes),
    candidateRevision: revision,
    expectedCurrentPath: expected?.path ?? null,
    expectedCurrentSha256: expected?.sha256 ?? null,
  };
}

function readOnlyJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line !== "");
  assert.equal(lines.length, 1, `Expected one JSON line, got ${JSON.stringify(stdout)}.`);
  return JSON.parse(lines[0]);
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

test("first promotion creates one active current and the read-only auditor validates it", async () => {
  const fixture = await createFixture({ createHistory: false });
  try {
    const candidateBytes = Buffer.from("anonymous revision one\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);

    const result = await promoteActiveRevision(plan);
    assert.equal(result.status, "created");
    assert.equal(result.current.path, path.join(fixture.archivePath, candidateName(1)));
    assert.deepEqual(await fs.readFile(result.current.path), candidateBytes);
    assert.deepEqual(await fs.readFile(candidatePath), candidateBytes, "validated source remains available");
    assert.deepEqual(await fs.readdir(fixture.historyPath), []);

    const audit = await auditActiveRevisions(plan);
    assert.equal(audit.status, "valid");
    assert.equal(audit.current.sha256, sha256(candidateBytes));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("replacement preserves the old current in sibling history and repeat is idempotent", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const firstPlan = makePlan(fixture, firstCandidate, firstBytes, 1);
    const first = await promoteActiveRevision(firstPlan);

    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: first.current.sha256,
    });
    const replaced = await promoteActiveRevision(secondPlan);
    assert.equal(replaced.status, "replaced");
    assert.equal(replaced.history.length, 1);
    const historyPath = path.join(fixture.historyPath, candidateName(1));
    assert.deepEqual(await fs.readFile(historyPath), firstBytes);
    assert.deepEqual(await fs.readFile(replaced.current.path), secondBytes);

    const beforeArchive = await fs.readdir(fixture.archivePath);
    const beforeHistory = await fs.readdir(fixture.historyPath);
    const repeated = await promoteActiveRevision(secondPlan);
    assert.equal(repeated.status, "already_current");
    assert.deepEqual(await fs.readdir(fixture.archivePath), beforeArchive);
    assert.deepEqual(await fs.readdir(fixture.historyPath), beforeHistory);
    assert.equal((await auditActiveRevisions(secondPlan)).status, "valid");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("multiple active currents block promotion without changing either file", async () => {
  const fixture = await createFixture();
  try {
    const baseBytes = Buffer.from("anonymous base\n", "utf8");
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    await Promise.all([
      fs.writeFile(path.join(fixture.archivePath, `${artifactKind}.bin`), baseBytes, { flag: "wx" }),
      fs.writeFile(path.join(fixture.archivePath, candidateName(1)), firstBytes, { flag: "wx" }),
    ]);
    const candidateBytes = Buffer.from("anonymous revision two\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 2, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 2, {
      path: path.join(fixture.archivePath, candidateName(1)),
      sha256: sha256(firstBytes),
    });

    await assert.rejects(() => promoteActiveRevision(plan), /multiple active current revisions/);
    assert.deepEqual(await fs.readFile(path.join(fixture.archivePath, `${artifactKind}.bin`)), baseBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.archivePath, candidateName(1))), firstBytes);
    assert.equal(await pathExists(path.join(fixture.archivePath, candidateName(2))), false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("candidate hash mismatch blocks before any archive mutation", async () => {
  const fixture = await createFixture({ createHistory: false });
  try {
    const candidateBytes = Buffer.from("anonymous candidate\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    plan.candidateSha256 = "0".repeat(64);

    await assert.rejects(() => promoteActiveRevision(plan), /candidatePath SHA256 mismatch/);
    assert.deepEqual(await fs.readdir(fixture.archivePath), []);
    assert.equal(await pathExists(fixture.historyPath), false, "invalid candidate must not create history");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("simulated candidate promotion failure restores the original current", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));

    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: first.current.sha256,
    });
    await assert.rejects(
      () =>
        promoteActiveRevision(secondPlan, {
          hooks: {
            beforeCandidatePromotion() {
              throw new Error("simulated promotion failure");
            },
          },
        }),
      /simulated promotion failure.*Original current state was restored/,
    );

    assert.deepEqual(await fs.readFile(first.current.path), firstBytes);
    assert.equal(await pathExists(path.join(fixture.archivePath, candidateName(2))), false);
    assert.deepEqual(await fs.readdir(fixture.historyPath), []);
    const archiveNames = await fs.readdir(fixture.archivePath);
    assert.deepEqual(archiveNames, [candidateName(1)]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("failure after creating the independent history snapshot removes only that owned copy", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: first.current.sha256,
    });

    await assert.rejects(
      () => promoteActiveRevision(secondPlan, {
        hooks: {
          afterHistoryLinked() {
            throw new Error("simulated failure after history snapshot");
          },
        },
      }),
      /simulated failure after history snapshot.*Original current state was restored/,
    );

    assert.deepEqual(await fs.readFile(first.current.path), firstBytes);
    assert.deepEqual(await fs.readdir(fixture.historyPath), []);
    assert.equal(await pathExists(path.join(fixture.archivePath, candidateName(2))), false);
    assert.deepEqual(
      (await fs.readdir(fixture.archivePath)).filter((name) => name.startsWith(".revision-") || name.endsWith(".lock")),
      [],
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an external atomic current replacement is restored and never deleted", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const externalBytes = Buffer.from("external replacement that must survive\n", "utf8");
    const externalPath = path.join(fixture.candidatesPath, "external-current.bin");
    const displacedPath = path.join(fixture.archivePath, ".external-displaced.tmp");
    await fs.writeFile(externalPath, externalBytes, { flag: "wx" });

    await assert.rejects(
      () => promoteActiveRevision(secondPlan, {
        hooks: {
          async afterHistoryLinked() {
            await fs.rename(first.current.path, displacedPath);
            await fs.rename(externalPath, first.current.path);
            await fs.unlink(displacedPath);
          },
        },
      }),
      /changed during atomic staging|externally replaced/,
    );
    assert.deepEqual(await fs.readFile(first.current.path), externalBytes);
    assert.equal(await pathExists(path.join(fixture.archivePath, candidateName(2))), false);
    const preserved = (await fs.readdir(fixture.historyPath)).filter((name) =>
      name.startsWith(".revision-recovery-preserved-") && name.endsWith(".tmp"),
    );
    assert.equal(preserved.length, 1);
    assert.deepEqual(await fs.readFile(path.join(fixture.historyPath, preserved[0])), firstBytes);
    const archiveNames = await fs.readdir(fixture.archivePath);
    assert.ok(archiveNames.some((name) => name.endsWith(".lock")), "recovery lock must remain fail-closed");
    assert.ok(archiveNames.some((name) => name.startsWith(".revision-transaction-") && name.endsWith(".json")));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a process crash after atomically staging the old current is recovered on retry", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));

    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const crashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterOldCurrentStaged() { process.exit(73); } } });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_TEST_PLAN: Buffer.from(JSON.stringify(secondPlan), "utf8").toString("base64"),
      },
    });
    assert.equal(crashed.status, 73, `${crashed.stdout}\n${crashed.stderr}`);

    const recovered = await promoteActiveRevision(secondPlan);
    assert.equal(recovered.status, "replaced");
    assert.deepEqual(await fs.readFile(recovered.current.path), secondBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.historyPath, candidateName(1))), firstBytes);
    const leftovers = (await fs.readdir(fixture.archivePath)).filter((name) =>
      name.startsWith(".revision-") || name.endsWith(".lock") || name.endsWith(".recovery"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash immediately after atomic recovery-guard installation is mechanically reclaimed on retry", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const stageCrashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterOldCurrentStaged() { process.exit(78); } } });
    `;
    const environment = {
      ...process.env,
      CODEX_TEST_PLAN: Buffer.from(JSON.stringify(secondPlan), "utf8").toString("base64"),
    };
    const stageCrash = spawnSync(process.execPath, ["--input-type=module", "-e", stageCrashCode], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(stageCrash.status, 78, `${stageCrash.stdout}\n${stageCrash.stderr}`);

    const guardCrashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterRecoveryGuardInstalled() { process.exit(79); } } });
    `;
    const guardCrash = spawnSync(process.execPath, ["--input-type=module", "-e", guardCrashCode], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(guardCrash.status, 79, `${guardCrash.stdout}\n${guardCrash.stderr}`);

    const recoveryGuards = (await fs.readdir(fixture.archivePath)).filter((name) => name.endsWith(".lock.recovery"));
    assert.equal(recoveryGuards.length, 1);
    const guardRecord = JSON.parse(await fs.readFile(path.join(fixture.archivePath, recoveryGuards[0]), "utf8"));
    assert.equal(guardRecord.kind, "xiaohongshu-active-revision-recovery-guard");
    assert.match(guardRecord.ownerToken, /^[0-9a-f]{36}$/u);
    assert.ok(Number.isSafeInteger(guardRecord.pid) && guardRecord.pid > 0);

    const recovered = await promoteActiveRevision(secondPlan);
    assert.equal(recovered.status, "replaced");
    assert.deepEqual(await fs.readFile(recovered.current.path), secondBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.historyPath, candidateName(1))), firstBytes);
    const leftovers = (await fs.readdir(fixture.archivePath)).filter((name) =>
      name.startsWith(".revision-") || name.endsWith(".lock") || name.includes(".lock.recovery"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a second crash after atomic old-current recovery remains reentrant", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const environment = {
      ...process.env,
      CODEX_TEST_PLAN: Buffer.from(JSON.stringify(secondPlan), "utf8").toString("base64"),
    };
    const stageCrashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterOldCurrentStaged() { process.exit(80); } } });
    `;
    const stageCrash = spawnSync(process.execPath, ["--input-type=module", "-e", stageCrashCode], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(stageCrash.status, 80, `${stageCrash.stdout}\n${stageCrash.stderr}`);

    const recoveryCrashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterRecoveredCurrentInstalled() { process.exit(81); } } });
    `;
    const recoveryCrash = spawnSync(process.execPath, ["--input-type=module", "-e", recoveryCrashCode], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(recoveryCrash.status, 81, `${recoveryCrash.stdout}\n${recoveryCrash.stderr}`);
    assert.deepEqual(await fs.readFile(first.current.path), firstBytes, "recovery installed the old current atomically");

    const recovered = await promoteActiveRevision(secondPlan);
    assert.equal(recovered.status, "replaced");
    assert.deepEqual(await fs.readFile(recovered.current.path), secondBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.historyPath, candidateName(1))), firstBytes);
    const leftovers = (await fs.readdir(fixture.archivePath)).filter((name) =>
      name.startsWith(".revision-") || name.endsWith(".lock") || name.includes(".lock.recovery"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash after quarantining a dead recovery guard leaves a mechanically recoverable private artifact", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const plan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const environment = {
      ...process.env,
      CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
    };
    for (const [hook, status] of [["afterOldCurrentStaged", 82], ["afterRecoveryGuardInstalled", 83]]) {
      const crashCode = `
        import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
        const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
        await promoteActiveRevision(plan, { hooks: { ${hook}() { process.exit(${status}); } } });
      `;
      const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
        encoding: "utf8",
        env: environment,
      });
      assert.equal(crashed.status, status, `${crashed.stdout}\n${crashed.stderr}`);
    }
    const quarantineCrashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterRecoveryGuardQuarantined() { process.exit(84); } } });
    `;
    const quarantineCrash = spawnSync(process.execPath, ["--input-type=module", "-e", quarantineCrashCode], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(quarantineCrash.status, 84, `${quarantineCrash.stdout}\n${quarantineCrash.stderr}`);
    assert.ok((await fs.readdir(fixture.archivePath)).some((name) => name.includes(".lock.recovery.stale-")));

    const recovered = await promoteActiveRevision(plan);
    assert.equal(recovered.status, "replaced");
    assert.deepEqual(await fs.readFile(recovered.current.path), secondBytes);
    assert.equal((await auditActiveRevisions(plan)).status, "valid");
    assert.deepEqual(
      (await fs.readdir(fixture.archivePath)).filter((name) => name.startsWith(".revision-") || name.includes(".lock")),
      [],
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("three queued recoverers remain serialized across the exact dead-guard reclaim interleaving", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const plan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const environment = {
      ...process.env,
      CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
    };
    for (const [hook, status] of [["afterOldCurrentStaged", 88], ["afterRecoveryGuardInstalled", 89]]) {
      const crashCode = `
        import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
        const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
        await promoteActiveRevision(plan, { hooks: { ${hook}() { process.exit(${status}); } } });
      `;
      const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
        encoding: "utf8",
        env: environment,
      });
      assert.equal(crashed.status, status, `${crashed.stdout}\n${crashed.stderr}`);
    }

    let markFirstReady;
    let releaseFirst;
    const firstReady = new Promise((resolve) => { markFirstReady = resolve; });
    const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
    const firstRecoverer = promoteActiveRevision(plan, {
      hooks: {
        async beforeDeadRecoveryGuardQuarantine() {
          markFirstReady();
          await firstMayContinue;
        },
      },
    });
    await firstReady;

    let followerAcquisitions = 0;
    let markFirstFollowerReady;
    let releaseFirstFollower;
    const firstFollowerReady = new Promise((resolve) => { markFirstFollowerReady = resolve; });
    const firstFollowerMayContinue = new Promise((resolve) => { releaseFirstFollower = resolve; });
    const followerHooks = {
      async afterFamilyMutexAcquired() {
        followerAcquisitions += 1;
        if (followerAcquisitions === 1) {
          markFirstFollowerReady();
          await firstFollowerMayContinue;
        }
      },
    };
    const secondRecoverer = promoteActiveRevision(plan, { hooks: followerHooks });
    const thirdRecoverer = promoteActiveRevision(plan, { hooks: followerHooks });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(followerAcquisitions, 0, "queued recoverers cannot enter while the first owns the family mutex");

    releaseFirst();
    const firstResult = await firstRecoverer;
    assert.equal(firstResult.status, "replaced");
    await firstFollowerReady;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(followerAcquisitions, 1, "only one follower can own the family mutex at a time");
    releaseFirstFollower();
    const followerResults = await Promise.all([secondRecoverer, thirdRecoverer]);
    assert.deepEqual(followerResults.map((result) => result.status).sort(), ["already_current", "already_current"]);
    assert.equal(followerAcquisitions, 2);
    assert.equal((await auditActiveRevisions(plan)).status, "valid");
    assert.deepEqual(
      (await fs.readdir(fixture.archivePath)).filter((name) => name.startsWith(".revision-") || name.includes(".lock")),
      [],
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a process killed while holding the OS family mutex releases it for the next promotion", async () => {
  const fixture = await createFixture();
  try {
    const candidateBytes = Buffer.from("anonymous first revision\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const crashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterFamilyMutexAcquired() { process.exit(90); } } });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
      },
    });
    assert.equal(crashed.status, 90, `${crashed.stdout}\n${crashed.stderr}`);

    const recovered = await promoteActiveRevision(plan);
    assert.equal(recovered.status, "created");
    assert.equal((await auditActiveRevisions(plan)).status, "valid");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("family mutex timeout fails closed before any archive mutation", async () => {
  const fixture = await createFixture();
  try {
    const candidateBytes = Buffer.from("anonymous first revision\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    let markHolderReady;
    let releaseHolder;
    const holderReady = new Promise((resolve) => { markHolderReady = resolve; });
    const holderMayContinue = new Promise((resolve) => { releaseHolder = resolve; });
    const holder = promoteActiveRevision(plan, {
      hooks: {
        async afterFamilyMutexAcquired() {
          markHolderReady();
          await holderMayContinue;
        },
      },
    });
    await holderReady;

    await assert.rejects(
      () => promoteActiveRevision(plan, { mutexTimeoutMs: 100 }),
      /Timed out acquiring the promotion family mutex/u,
    );
    assert.deepEqual(await fs.readdir(fixture.archivePath), []);
    releaseHolder();
    assert.equal((await holder).status, "created");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash after syncing a private lock pending file is reclaimed without an audit residual", async () => {
  const fixture = await createFixture();
  try {
    const candidateBytes = Buffer.from("anonymous first revision\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const crashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterLockPendingSynced() { process.exit(85); } } });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
      },
    });
    assert.equal(crashed.status, 85, `${crashed.stdout}\n${crashed.stderr}`);
    assert.ok((await fs.readdir(fixture.archivePath)).some((name) => name.includes(".lock.pending-")));

    const recovered = await promoteActiveRevision(plan);
    assert.equal(recovered.status, "created");
    assert.equal((await auditActiveRevisions(plan)).status, "valid");
    assert.deepEqual(
      (await fs.readdir(fixture.archivePath)).filter((name) => name.startsWith(".revision-") || name.includes(".lock")),
      [],
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("matching current and old-staging duplicates are cleaned, but mismatched bytes remain fail-closed", async () => {
  for (const mismatch of [false, true]) {
    const fixture = await createFixture();
    try {
      const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
      const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
      const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
      const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
      const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
      const plan = makePlan(fixture, secondCandidate, secondBytes, 2, {
        path: first.current.path,
        sha256: sha256(firstBytes),
      });
      const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
      const crashCode = `
        import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
        const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
        await promoteActiveRevision(plan, { hooks: { afterOldCurrentStaged() { process.exit(86); } } });
      `;
      const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
        },
      });
      assert.equal(crashed.status, 86, `${crashed.stdout}\n${crashed.stderr}`);
      const oldStageName = (await fs.readdir(fixture.archivePath)).find((name) => name.startsWith(".revision-old-"));
      assert.ok(oldStageName);
      const oldStagePath = path.join(fixture.archivePath, oldStageName);
      const currentBytes = mismatch ? Buffer.from("external current bytes\n", "utf8") : firstBytes;
      await fs.writeFile(first.current.path, currentBytes, { flag: "wx" });

      if (mismatch) {
        await assert.rejects(() => promoteActiveRevision(plan), /bytes differ.*preserved/u);
        assert.deepEqual(await fs.readFile(first.current.path), currentBytes);
        assert.deepEqual(await fs.readFile(oldStagePath), firstBytes);
      } else {
        const recovered = await promoteActiveRevision(plan);
        assert.equal(recovered.status, "replaced");
        assert.deepEqual(await fs.readFile(recovered.current.path), secondBytes);
        assert.equal(await pathExists(oldStagePath), false);
      }
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("owned partial candidate and history copies from dead processes are isolated and retried", async () => {
  for (const partialKind of ["candidate", "history"]) {
    const fixture = await createFixture();
    try {
      let plan;
      if (partialKind === "candidate") {
        const candidateBytes = Buffer.from("anonymous first revision\n", "utf8");
        const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
        plan = makePlan(fixture, candidatePath, candidateBytes, 1);
      } else {
        const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
        const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
        const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
        const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
        const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
        plan = makePlan(fixture, secondCandidate, secondBytes, 2, {
          path: first.current.path,
          sha256: sha256(firstBytes),
        });
      }
      const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
      const hook = partialKind === "candidate" ? "beforeCandidatePrivateCopy" : "beforeHistoryPrivateCopy";
      const argument = partialKind === "candidate" ? "copyPath" : "stagingPath";
      const crashCode = `
        import fs from "node:fs/promises";
        import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
        const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
        await promoteActiveRevision(plan, { hooks: { async ${hook}({ ${argument} }) {
          await fs.writeFile(${argument}, Buffer.from("owned partial bytes", "utf8"), { flag: "wx" });
          process.exit(87);
        } } });
      `;
      const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
        },
      });
      assert.equal(crashed.status, 87, `${crashed.stdout}\n${crashed.stderr}`);

      const recovered = await promoteActiveRevision(plan);
      assert.ok(recovered.status === "created" || recovered.status === "replaced");
      assert.equal((await auditActiveRevisions(plan)).status, "valid");
      assert.deepEqual(
        (await fs.readdir(fixture.archivePath)).filter((name) => name.startsWith(".revision-") || name.includes(".lock")),
        [],
      );
      assert.deepEqual(
        (await fs.readdir(fixture.historyPath)).filter((name) => name.startsWith(".revision-")),
        [],
      );
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a crash after syncing the transaction-marker temp is recovered in one retry", async () => {
  const fixture = await createFixture();
  try {
    const candidateBytes = Buffer.from("anonymous first revision\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const crashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterMarkerTempSynced() { process.exit(75); } } });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_TEST_PLAN: Buffer.from(JSON.stringify(plan), "utf8").toString("base64"),
      },
    });
    assert.equal(crashed.status, 75, `${crashed.stdout}\n${crashed.stderr}`);

    const recovered = await promoteActiveRevision(plan);
    assert.equal(recovered.status, "created");
    assert.deepEqual(await fs.readFile(recovered.current.path), candidateBytes);
    const leftovers = (await fs.readdir(fixture.archivePath)).filter((name) =>
      name.startsWith(".revision-") || name.endsWith(".lock") || name.includes(".pending-"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a crash after the durable commit point resumes as already_current and cleans transaction files", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const firstCandidate = await writeCandidate(fixture, 1, firstBytes);
    const first = await promoteActiveRevision(makePlan(fixture, firstCandidate, firstBytes, 1));
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const secondPlan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: first.current.path,
      sha256: sha256(firstBytes),
    });
    const moduleUrl = pathToFileURL(path.join(skillRoot, "scripts", "promote_active_revision.mjs")).href;
    const crashCode = `
      import { promoteActiveRevision } from ${JSON.stringify(moduleUrl)};
      const plan = JSON.parse(Buffer.from(process.env.CODEX_TEST_PLAN, "base64").toString("utf8"));
      await promoteActiveRevision(plan, { hooks: { afterCommitMarkerRemoved() { process.exit(74); } } });
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashCode], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_TEST_PLAN: Buffer.from(JSON.stringify(secondPlan), "utf8").toString("base64"),
      },
    });
    assert.equal(crashed.status, 74, `${crashed.stdout}\n${crashed.stderr}`);

    await assert.rejects(
      () => auditActiveRevisions(secondPlan),
      /Unresolved promotion transaction state.*retry the same promotion plan/u,
    );
    const resumed = await promoteActiveRevision(secondPlan);
    assert.equal(resumed.status, "already_current");
    assert.deepEqual(await fs.readFile(resumed.current.path), secondBytes);
    assert.deepEqual(await fs.readFile(path.join(fixture.historyPath, candidateName(1))), firstBytes);
    const leftovers = (await fs.readdir(fixture.archivePath)).filter((name) =>
      name.startsWith(".revision-") || name.endsWith(".lock") || name.endsWith(".recovery"),
    );
    assert.deepEqual(leftovers, []);
    assert.equal((await auditActiveRevisions(secondPlan)).status, "valid");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a conflicting history filename blocks replacement and preserves all bytes", async () => {
  const fixture = await createFixture();
  try {
    const firstBytes = Buffer.from("anonymous revision one\n", "utf8");
    const conflictBytes = Buffer.from("conflicting historical bytes\n", "utf8");
    const currentPath = path.join(fixture.archivePath, candidateName(1));
    const historyConflictPath = path.join(fixture.historyPath, candidateName(1));
    await Promise.all([
      fs.writeFile(currentPath, firstBytes, { flag: "wx" }),
      fs.writeFile(historyConflictPath, conflictBytes, { flag: "wx" }),
    ]);
    const secondBytes = Buffer.from("anonymous revision two\n", "utf8");
    const secondCandidate = await writeCandidate(fixture, 2, secondBytes);
    const plan = makePlan(fixture, secondCandidate, secondBytes, 2, {
      path: currentPath,
      sha256: sha256(firstBytes),
    });

    await assert.rejects(() => promoteActiveRevision(plan), /duplicated|conflicts/u);
    assert.deepEqual(await fs.readFile(currentPath), firstBytes);
    assert.deepEqual(await fs.readFile(historyConflictPath), conflictBytes);
    assert.equal(await pathExists(path.join(fixture.archivePath, candidateName(2))), false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI promoter and auditor emit exactly one JSON line and failures are nonzero", async () => {
  const fixture = await createFixture();
  try {
    const candidateBytes = Buffer.from("anonymous revision one\n", "utf8");
    const candidatePath = await writeCandidate(fixture, 1, candidateBytes);
    const plan = makePlan(fixture, candidatePath, candidateBytes, 1);
    const planPath = path.join(fixture.root, "anonymous-plan.json");
    await fs.writeFile(planPath, `${JSON.stringify(plan)}\n`, { flag: "wx" });

    const promoted = spawnSync(process.execPath, [promoteScript, "--plan", planPath], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(promoted.status, 0, `${promoted.stdout}\n${promoted.stderr}`);
    assert.equal(promoted.stderr, "");
    assert.equal(readOnlyJsonLine(promoted.stdout).status, "created");

    const audited = spawnSync(process.execPath, [auditScript, "--plan", planPath], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.equal(audited.status, 0, `${audited.stdout}\n${audited.stderr}`);
    assert.equal(audited.stderr, "");
    assert.equal(readOnlyJsonLine(audited.stdout).status, "valid");

    const failed = spawnSync(process.execPath, [auditScript, "--plan", path.join(fixture.root, "missing.json")], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stderr, "");
    assert.equal(readOnlyJsonLine(failed.stdout).ok, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
