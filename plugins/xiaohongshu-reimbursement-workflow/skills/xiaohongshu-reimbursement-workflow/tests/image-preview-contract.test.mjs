import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReimbursementArtifacts, inspectEvidenceImage } from "../scripts/build_reimbursement_artifacts.mjs";
import { loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const SharpModule = loadBundledDependency("sharp");
const sharp = SharpModule.default ?? SharpModule;
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestAuditor = path.join(skillRoot, "scripts", "audit_batch_manifest.mjs");

async function syntheticImages() {
  const standardJpeg = await sharp({
    create: { width: 37, height: 29, channels: 3, background: { r: 19, g: 71, b: 131 } },
  }).jpeg({ quality: 73 }).toBuffer();
  assert.deepEqual([...standardJpeg.subarray(-2)], [0xff, 0xd9]);
  const jpegWithoutEoi = standardJpeg.subarray(0, -2);
  const png = await sharp({
    create: { width: 31, height: 23, channels: 4, background: { r: 211, g: 113, b: 41, alpha: 1 } },
  }).png().toBuffer();
  return { standardJpeg, jpegWithoutEoi, png };
}

async function writeBoundFile(root, name, bytes) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, sha256: sha256Bytes(bytes), bytes };
}

function material(id, file) {
  return {
    id,
    role: "material",
    path: file.path,
    sha256: file.sha256,
    kind: "image",
    disposition: "used",
    usage: "voucher",
  };
}

async function auditManifest(manifestPath) {
  const child = spawnSync(process.execPath, [manifestAuditor, manifestPath], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

function syntheticManifest(root, archivePath, baseline, files) {
  const transactions = files.map((file, index) => {
    const sequence = index + 1;
    return {
      id: `SYN-TX-${sequence}`,
      sourceOrder: sequence,
      date: `2099-01-${String(sequence + 9).padStart(2, "0")}`,
      person: `合成主体${sequence}`,
      project: `合成事项${sequence}`,
      label: `合成标签${sequence}`,
      classification: "运营开支",
      sourceAmount: `${sequence}.${String(sequence).padStart(2, "0")}`,
      reimbursementAmount: `${sequence}.${String(sequence).padStart(2, "0")}`,
      reportingKind: "current",
      category: "小红书报销",
      settlement: "employee_reimbursement",
      evidence: [file.id],
      sourceRefs: [`SYN-UNIT-${sequence}`],
    };
  });
  return {
    version: 3,
    rulesVersion: "synthetic-media-contract-v1",
    batch: {
      batchId: "synthetic-media-contract",
      rootPath: root,
      archivePath,
      period: "2099.1.10-2099.1.12",
      mainPeriod: { start: "2099-01-10", end: "2099-01-12" },
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    operation: { mode: "reimbursement-batch" },
    files: [
      { id: "synthetic-baseline", role: "baseline", path: baseline.path, sha256: baseline.sha256 },
      ...files.map((file) => material(file.id, file)),
    ],
    sourceScopes: files.map((file, index) => ({
      id: `SYN-SCOPE-${index + 1}`,
      fileId: file.id,
      locator: "complete-synthetic-image",
      terminalConfirmed: true,
      expectedUnitCount: 1,
    })),
    sourceUnits: files.map((file, index) => ({
      id: `SYN-UNIT-${index + 1}`,
      scopeId: `SYN-SCOPE-${index + 1}`,
      locator: "generated-fixture",
      disposition: "used",
    })),
    transactions,
    expected: {
      transactionCount: transactions.length,
      feeTotal: "6.06",
      reimbursementTotal: "6.06",
      companyPaidNoReimbursementTotal: "0",
      uniqueMediaCount: files.length,
      mediaReferenceCount: files.length,
    },
  };
}

test("synthetic media validation accepts complete JPEG, decodable JPEG without EOI, and PNG", async () => {
  const { standardJpeg, jpegWithoutEoi, png } = await syntheticImages();
  assert.deepEqual(await inspectEvidenceImage(standardJpeg), { extension: "jpg", width: 37, height: 29 });
  assert.deepEqual(await inspectEvidenceImage(jpegWithoutEoi), { extension: "jpg", width: 37, height: 29 });
  assert.deepEqual(await inspectEvidenceImage(png), { extension: "png", width: 31, height: 23 });
});

test("JPEG compatibility is limited to a missing EOI and rejects truncated scan data", async () => {
  const { standardJpeg } = await syntheticImages();
  assert.deepEqual(await inspectEvidenceImage(standardJpeg.subarray(0, -2)), { extension: "jpg", width: 37, height: 29 });
  for (const removedBytes of [5, 10, 20, 40, 80]) {
    await assert.rejects(inspectEvidenceImage(standardJpeg.subarray(0, -removedBytes)), /cannot be decoded safely/u);
  }
});

test("synthetic structurally plausible but undecodable media is rejected", async () => {
  const damaged = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1d, 0x00, 0x25,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  await assert.rejects(inspectEvidenceImage(damaged), /cannot be decoded safely/u);
});

test("artifact build preserves every synthetic source image byte and SHA in archive and workbook media", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-synthetic-media-"));
  let stagingRoot;
  try {
    const { standardJpeg, jpegWithoutEoi, png } = await syntheticImages();
    const baselineBytes = Buffer.from("synthetic baseline binding only", "utf8");
    const baseline = await writeBoundFile(temp, "synthetic-ledger.xlsx", baselineBytes);
    const fixtures = [
      { id: "SYN-IMG-JPEG", ...(await writeBoundFile(temp, "fixture-one.bin", standardJpeg)) },
      { id: "SYN-IMG-JPEG-NO-EOI", ...(await writeBoundFile(temp, "fixture-two.bin", jpegWithoutEoi)) },
      { id: "SYN-IMG-PNG", ...(await writeBoundFile(temp, "fixture-three.bin", png)) },
    ];
    const manifest = syntheticManifest(temp, path.join(temp, "synthetic-archive"), baseline, fixtures);
    const manifestPath = path.join(temp, "synthetic-manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const audited = await auditManifest(manifestPath);
    const result = await buildReimbursementArtifacts({
      kind: "reimbursement-artifact-build-request-v1",
      stagingToken: crypto.randomBytes(32).toString("hex"),
      manifestPath,
      manifestSha256: sha256Bytes(manifestBytes),
      reimbursementFactsCertificate: audited.reimbursementFactsCertificate,
    });
    stagingRoot = result.stagingRoot;

    const product = result.artifacts[0];
    assert.equal(product.evidenceArchive.length, fixtures.length);
    const expectedById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    for (const archived of product.evidenceArchive) {
      const expected = expectedById.get(archived.evidenceId);
      assert.ok(expected, `unexpected archived evidence ${archived.evidenceId}`);
      const archivedBytes = await fs.readFile(archived.path);
      assert.deepEqual(archivedBytes, expected.bytes);
      assert.equal(archived.sha256, expected.sha256);
      assert.equal(sha256Bytes(archivedBytes), expected.sha256);
    }

    const workbook = await JSZip.loadAsync(await fs.readFile(product.screenshot.path));
    const mediaParts = Object.keys(workbook.files).filter((name) => /^xl\/media\/image\d+\.(?:jpg|png)$/u.test(name));
    assert.equal(mediaParts.length, fixtures.length);
    const embeddedHashes = [];
    for (const partName of mediaParts) {
      embeddedHashes.push(sha256Bytes(await workbook.file(partName).async("nodebuffer")));
    }
    assert.deepEqual(embeddedHashes.sort(), fixtures.map((fixture) => fixture.sha256).sort());
  } finally {
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.rm(temp, { recursive: true, force: true });
  }
});
