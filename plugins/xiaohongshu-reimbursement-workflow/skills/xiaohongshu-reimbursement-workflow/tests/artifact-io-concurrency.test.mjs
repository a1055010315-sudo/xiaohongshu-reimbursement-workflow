import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReimbursementArtifacts } from "../scripts/build_reimbursement_artifacts.mjs";
import { loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestAuditor = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");

async function writeExclusive(filePath, bytes) {
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), size: bytes.length };
}

async function makeFixture(root) {
  const baseline = await writeExclusive(path.join(root, "synthetic-ledger.xlsx"), Buffer.from("synthetic ledger binding", "utf8"));
  const unique = [];
  for (let index = 0; index < 4; index += 1) {
    const bytes = await sharp({
      create: { width: 40 + index, height: 30 + index, channels: 3, background: { r: 40 + index, g: 90 + index, b: 140 + index } },
    }).png().toBuffer();
    unique.push({ id: `IMG-${index + 1}`, ...(await writeExclusive(path.join(root, `source-${index + 1}.png`), bytes)), bytes });
  }
  const duplicate = { id: "IMG-DUP", ...(await writeExclusive(path.join(root, "duplicate-alias.png"), unique[0].bytes)), bytes: unique[0].bytes };
  const materials = [...unique, duplicate];
  const transactions = materials.map((material, index) => ({
    id: `TX-${index + 1}`,
    sourceOrder: index + 1,
    date: `2042-06-${String(index + 10).padStart(2, "0")}`,
    person: `匿名人员${index + 1}`,
    project: `匿名并发事项${index + 1}`,
    label: `匿名标签${index + 1}`,
    classification: "运营开支",
    sourceAmount: `${index + 1}.${String(index + 1).padStart(2, "0")}`,
    reimbursementAmount: `${index + 1}.${String(index + 1).padStart(2, "0")}`,
    reportingKind: "current",
    category: "小红书报销",
    settlement: "employee_reimbursement",
    evidence: [material.id],
    sourceRefs: [`UNIT-${index + 1}`],
  }));
  const manifest = {
    version: 3,
    rulesVersion: "synthetic-artifact-concurrency-v1",
    batch: {
      batchId: "synthetic-artifact-concurrency",
      rootPath: root,
      archivePath: path.join(root, "synthetic-archive"),
      period: "2042.6.10-2042.6.14",
      mainPeriod: { start: "2042-06-10", end: "2042-06-14" },
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "BASELINE", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
      ...materials.map((material) => ({ id: material.id, role: "material", path: material.path, sha256: material.sha256, kind: "image", disposition: "used", usage: "voucher" })),
    ],
    sourceScopes: materials.map((material, index) => ({ id: `SCOPE-${index + 1}`, fileId: material.id, locator: "complete-generated-image", terminalConfirmed: true, expectedUnitCount: 1 })),
    sourceUnits: materials.map((_material, index) => ({ id: `UNIT-${index + 1}`, scopeId: `SCOPE-${index + 1}`, locator: "generated-observation", disposition: "used" })),
    transactions,
    expected: {
      transactionCount: 5,
      feeTotal: "15.15",
      reimbursementTotal: "15.15",
      companyPaidNoReimbursementTotal: "0",
      uniqueMediaCount: 4,
      mediaReferenceCount: 5,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
  const audit = spawnSync(process.execPath, [manifestAuditor, manifestPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(audit.status, 0, audit.stderr || audit.stdout);
  return {
    manifestPath,
    manifestSha256: sha256Bytes(manifestBytes),
    certificate: JSON.parse(audit.stdout.trim()).reimbursementFactsCertificate,
    materials,
    unique,
    duplicate,
  };
}

function buildRequest(fixture, stagingToken) {
  return {
    kind: "reimbursement-artifact-build-request-v1",
    stagingToken,
    manifestPath: fixture.manifestPath,
    manifestSha256: fixture.manifestSha256,
    reimbursementFactsCertificate: fixture.certificate,
  };
}

function isBoundOutputOpen(filePath, flags) {
  if (flags !== "wx") return false;
  const extension = path.extname(String(filePath)).toLowerCase();
  return extension === ".txt" || extension === ".png" || extension === ".jpg";
}

test("artifact I/O reads and decodes each unique SHA once with concurrency three while preserving manifest order", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-io-order-"));
  let stagingRoot;
  const originalOpen = fs.open;
  try {
    const fixture = await makeFixture(root);
    const sourcePaths = new Set(fixture.materials.map((item) => path.resolve(item.path)));
    const openCounts = new Map([...sourcePaths].map((item) => [item, 0]));
    let activeSourceOpens = 0;
    let maxActiveSourceOpens = 0;
    let activeBoundWrites = 0;
    let maxActiveBoundWrites = 0;
    fs.open = async (filePath, flags, ...rest) => {
      const resolved = path.resolve(String(filePath));
      if (sourcePaths.has(resolved)) {
        openCounts.set(resolved, openCounts.get(resolved) + 1);
        activeSourceOpens += 1;
        maxActiveSourceOpens = Math.max(maxActiveSourceOpens, activeSourceOpens);
        try {
          await new Promise((resolve) => setTimeout(resolve, 8));
          return await originalOpen.call(fs, filePath, flags, ...rest);
        } finally {
          activeSourceOpens -= 1;
        }
      }
      if (isBoundOutputOpen(filePath, flags)) {
        activeBoundWrites += 1;
        maxActiveBoundWrites = Math.max(maxActiveBoundWrites, activeBoundWrites);
        try {
          await new Promise((resolve) => setTimeout(resolve, 8));
          return await originalOpen.call(fs, filePath, flags, ...rest);
        } finally {
          activeBoundWrites -= 1;
        }
      }
      return originalOpen.call(fs, filePath, flags, ...rest);
    };
    const result = await buildReimbursementArtifacts(buildRequest(fixture, crypto.randomBytes(32).toString("hex")));
    stagingRoot = result.stagingRoot;
    assert.equal(openCounts.get(path.resolve(fixture.duplicate.path)), 0, "the second path for an already loaded SHA must not be read");
    assert.equal([...openCounts.values()].filter((count) => count > 0).length, 4, "exactly four unique SHA work items must read source bytes");
    assert.ok(maxActiveSourceOpens >= 2 && maxActiveSourceOpens <= 3, `source read concurrency was ${maxActiveSourceOpens}`);
    assert.ok(maxActiveBoundWrites >= 2 && maxActiveBoundWrites <= 3, `bound write concurrency was ${maxActiveBoundWrites}`);
    assert.deepEqual(result.artifacts[0].evidenceArchive.map((item) => item.evidenceId), fixture.unique.map((item) => item.id));
  } finally {
    fs.open = originalOpen;
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a concurrent archive write failure cleans every completed or in-flight owned output", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-io-failure-"));
  const originalOpen = fs.open;
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-artifacts-${stagingToken}`);
  try {
    const fixture = await makeFixture(root);
    let boundAttempt = 0;
    let activeBoundWrites = 0;
    let maxActiveBoundWrites = 0;
    fs.open = async (filePath, flags, ...rest) => {
      if (!isBoundOutputOpen(filePath, flags)) return originalOpen.call(fs, filePath, flags, ...rest);
      boundAttempt += 1;
      const attempt = boundAttempt;
      activeBoundWrites += 1;
      maxActiveBoundWrites = Math.max(maxActiveBoundWrites, activeBoundWrites);
      try {
        await new Promise((resolve) => setTimeout(resolve, attempt === 3 ? 20 : 8));
        if (attempt === 3) throw new Error("synthetic concurrent archive failure");
        return await originalOpen.call(fs, filePath, flags, ...rest);
      } finally {
        activeBoundWrites -= 1;
      }
    };
    await assert.rejects(buildReimbursementArtifacts(buildRequest(fixture, stagingToken)), /synthetic concurrent archive failure/u);
    assert.ok(boundAttempt >= 3, "the failure must occur after concurrent bound writes started");
    assert.ok(maxActiveBoundWrites >= 2 && maxActiveBoundWrites <= 3, `bound write concurrency was ${maxActiveBoundWrites}`);
    let remaining = null;
    try {
      remaining = await fs.readdir(stagingRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    assert.deepEqual(remaining ?? [], [], `the owned staging root retained files: ${JSON.stringify(remaining)}`);
  } finally {
    fs.open = originalOpen;
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial bound-byte write is removed and the same staging token can retry", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-bound-partial-"));
  const originalOpen = fs.open;
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-artifacts-${stagingToken}`);
  let retry;
  try {
    const fixture = await makeFixture(root);
    let injected = false;
    fs.open = async (filePath, flags, ...rest) => {
      const handle = await originalOpen.call(fs, filePath, flags, ...rest);
      if (injected || flags !== "wx" || path.extname(String(filePath)).toLowerCase() !== ".txt") return handle;
      injected = true;
      return {
        writeFile: async () => {
          await handle.writeFile(Buffer.from("owned partial bytes", "utf8"));
          throw new Error("synthetic partial bound-byte failure");
        },
        sync: handle.sync.bind(handle),
        close: handle.close.bind(handle),
      };
    };
    await assert.rejects(buildReimbursementArtifacts(buildRequest(fixture, stagingToken)), /synthetic partial bound-byte failure/u);
    assert.equal(injected, true);
    const remaining = await fs.readdir(stagingRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    assert.equal(remaining, null, `staging root retained ${JSON.stringify(remaining)}`);
    fs.open = originalOpen;
    retry = await buildReimbursementArtifacts(buildRequest(fixture, stagingToken));
    assert.equal(retry.artifacts.length, 1);
  } finally {
    fs.open = originalOpen;
    if (retry?.stagingRoot) await fs.rm(retry.stagingRoot, { recursive: true, force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a workbook failure after exclusive write leaves no staging residue and the same token can retry", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-post-write-"));
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-artifacts-${stagingToken}`);
  let retry;
  try {
    const fixture = await makeFixture(root);
    await assert.rejects(
      buildReimbursementArtifacts(buildRequest(fixture, stagingToken), {
        testHooks: {
          beforeArtifactWorkbookValidation: async ({ role }) => {
            if (role === "detail") throw new Error("synthetic post-write workbook validation failure");
          },
        },
      }),
      /synthetic post-write workbook validation failure/u,
    );
    await assert.rejects(fs.access(stagingRoot), /ENOENT/u);
    retry = await buildReimbursementArtifacts(buildRequest(fixture, stagingToken));
    assert.equal(retry.artifacts.length, 1);
  } finally {
    if (retry?.stagingRoot) await fs.rm(retry.stagingRoot, { recursive: true, force: true });
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("whole-file validation rejects a workbook changed after its durable write and cleans staging", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-post-write-change-"));
  const stagingToken = crypto.randomBytes(32).toString("hex");
  const stagingRoot = path.join(os.tmpdir(), `codex-xhs-artifacts-${stagingToken}`);
  try {
    const fixture = await makeFixture(root);
    await assert.rejects(
      buildReimbursementArtifacts(buildRequest(fixture, stagingToken), {
        testHooks: {
          beforeArtifactWorkbookValidation: async ({ role, path: workbookPath }) => {
            if (role === "detail") await fs.appendFile(workbookPath, Buffer.from("synthetic-change", "utf8"));
          },
        },
      }),
      /changed after exclusive write/u,
    );
    await assert.rejects(fs.access(stagingRoot), /ENOENT/u);
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent source failures report the earliest manifest work item rather than the fastest rejection", { concurrency: false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-artifact-io-errors-"));
  const originalOpen = fs.open;
  try {
    const fixture = await makeFixture(root);
    const firstPath = path.resolve(fixture.unique[0].path);
    const secondPath = path.resolve(fixture.unique[1].path);
    fs.open = async (filePath, flags, ...rest) => {
      const resolved = path.resolve(String(filePath));
      if (resolved === firstPath) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("synthetic-first-manifest-item-failure");
      }
      if (resolved === secondPath) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error("synthetic-second-manifest-item-failure");
      }
      return originalOpen.call(fs, filePath, flags, ...rest);
    };
    await assert.rejects(
      buildReimbursementArtifacts(buildRequest(fixture, crypto.randomBytes(32).toString("hex"))),
      (error) => error?.cause?.message === "synthetic-first-manifest-item-failure",
    );
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
  }
});
