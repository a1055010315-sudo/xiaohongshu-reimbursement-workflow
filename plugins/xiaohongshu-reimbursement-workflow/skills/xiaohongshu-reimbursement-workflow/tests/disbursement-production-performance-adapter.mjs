import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalDigest,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";
import {
  createCompactDisbursementProductionFixture,
} from "./disbursement-production-fixture.mjs";

export const DISBURSEMENT_PERFORMANCE_ADAPTER_KIND = "compact-disbursement-performance-adapter-v2";

const FIXTURE_KIND = "compact-disbursement-performance-fixture-v2";
const METADATA_KIND = "compact-disbursement-production-performance-fixture-v2";
const ARCHIVE_KIND = "compact-disbursement-archive-v1";
const RECEIPT_KIND = "compact-disbursement-published-v1";
const SUMMARY_NAME = "发放情况说明.txt";
const WORKBOOK_NAME = "发放核对表.xlsx";
const VOUCHER_DIRECTORY_NAME = "发放凭证";
const METADATA_NAME = "production-disbursement-performance-fixture.json";
const SHA_RE = /^[0-9a-f]{64}$/u;
const LOAD_SCALES = Object.freeze({
  small: Object.freeze({
    profileIds: Object.freeze(["xiaohongshu"]),
    reimbursementTransactionCount: 24,
    includeSalary: false,
    requestedUniqueVoucherCount: 12,
    nameRevision: 1,
  }),
  standard: Object.freeze({
    profileIds: Object.freeze(["xiaohongshu", "company"]),
    reimbursementTransactionCount: 47,
    includeSalary: true,
    requestedUniqueVoucherCount: 24,
    nameRevision: 1,
  }),
  large: Object.freeze({
    profileIds: Object.freeze(["xiaohongshu", "company", "residence"]),
    reimbursementTransactionCount: 60,
    includeSalary: true,
    requestedUniqueVoucherCount: 30,
    nameRevision: 1,
  }),
});

function fail(message) {
  throw new Error(`Compact disbursement performance adapter ${message}`);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isDirectChild(parent, child) {
  return path.dirname(path.resolve(child)) === path.resolve(parent)
    || (process.platform === "win32" && path.dirname(path.resolve(child)).toLowerCase() === path.resolve(parent).toLowerCase());
}

function assertAbsolute(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${field} must be an absolute path.`);
  return path.resolve(value);
}

function assertSha(value, field) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

async function assertPlainDirectory(directoryPath, field) {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail(`${field} must be a plain directory.`);
}

async function writeExclusiveJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return Object.freeze({ path: filePath, sha256: sha256Bytes(bytes), size: bytes.length });
}

function binding(value, field) {
  const source = assertPlainObject(value, field);
  return Object.freeze({
    sha256: assertSha(source.sha256, `${field}.sha256`),
    size: Number.isSafeInteger(source.size) && source.size >= 0 ? source.size : fail(`${field}.size must be a non-negative safe integer.`),
  });
}

function ordinaryManifestFacts(manifest) {
  if (!manifest) return null;
  return {
    version: manifest.version,
    rulesVersion: manifest.rulesVersion,
    batch: {
      batchId: manifest.batch.batchId,
      period: manifest.batch.period,
      mainPeriod: manifest.batch.mainPeriod,
      targetCategory: manifest.batch.targetCategory,
      reviewRevision: manifest.batch.reviewRevision,
    },
    operation: manifest.operation,
    files: manifest.files.map(({ path: ignoredPath, ...entry }) => entry),
    sourceScopes: manifest.sourceScopes,
    sourceUnits: manifest.sourceUnits,
    transactions: manifest.transactions,
    expected: manifest.expected,
  };
}

function publishedArtifactFacts(artifact, field) {
  return binding(artifact, field);
}

function ordinaryReceiptFacts(receipt) {
  if (!receipt) return null;
  return {
    kind: receipt.kind,
    batchId: receipt.batchId,
    affectedProfileIds: receipt.affectedProfileIds,
    outputs: receipt.outputs.map((output, outputIndex) => ({
      profileId: output.profileId,
      root: publishedArtifactFacts(output.root, `ordinary receipt output[${outputIndex}].root`),
      detail: publishedArtifactFacts(output.detail, `ordinary receipt output[${outputIndex}].detail`),
      screenshot: publishedArtifactFacts(output.screenshot, `ordinary receipt output[${outputIndex}].screenshot`),
      summary: publishedArtifactFacts(output.summary, `ordinary receipt output[${outputIndex}].summary`),
      snapshot: publishedArtifactFacts(output.snapshot, `ordinary receipt output[${outputIndex}].snapshot`),
      supplements: output.supplements.map((entry, index) => publishedArtifactFacts(entry, `ordinary receipt output[${outputIndex}].supplements[${index}]`)),
      evidenceArchive: output.evidenceArchive.map((entry, index) => publishedArtifactFacts(entry, `ordinary receipt output[${outputIndex}].evidenceArchive[${index}]`)),
      publishAuditDigest: output.publishAuditDigest,
    })),
    postPublishAuditDigest: receipt.postPublishAuditDigest,
  };
}

function businessFacts(fixture, loadScale, definition) {
  const manifest = fixture.manifest;
  return Object.freeze({
    kind: "compact-disbursement-production-business-facts-v1",
    loadScale,
    definition,
    expectedBatchName: fixture.expectedBatchName,
    ordinaryManifest: ordinaryManifestFacts(fixture.originalManifest),
    ordinaryReceipt: ordinaryReceiptFacts(fixture.receipt),
    disbursement: {
      batch: {
        batchId: manifest.batch.batchId,
        nameRevision: manifest.batch.nameRevision,
        ...(manifest.batch.reimbursementPeriod ? { reimbursementPeriod: manifest.batch.reimbursementPeriod } : {}),
      },
      reimbursementSources: manifest.reimbursementSources.map(({ id, profileId }) => ({ id, profileId })),
      salaryArtifacts: manifest.salaryArtifacts.map((artifact) => ({
        id: artifact.id,
        month: artifact.month,
        salaryCategoryId: artifact.salaryCategoryId,
        salaryCategoryName: artifact.salaryCategoryName,
        finalArtifactKind: artifact.finalArtifactKind,
        artifactSha256: artifact.sha256,
        storeReference: artifact.storeReference,
        certificateSha256: artifact.certificateSha256,
      })),
      vouchers: manifest.vouchers.map(({ id, sha256 }) => ({ id, sha256 })),
      rows: manifest.rows,
      expected: manifest.expected,
    },
  });
}

function loadScaleDefinition(loadScale) {
  const value = LOAD_SCALES[loadScale];
  if (!value) fail(`loadScale must be one of ${Object.keys(LOAD_SCALES).join(", ")}.`);
  return value;
}

async function buildProductionFixture(root, loadScale, definition) {
  const fixture = await createCompactDisbursementProductionFixture({
    root,
    profileIds: [...definition.profileIds],
    reimbursementTransactionCount: definition.reimbursementTransactionCount,
    includeSalary: definition.includeSalary,
    requestedUniqueVoucherCount: definition.requestedUniqueVoucherCount,
    nameRevision: definition.nameRevision,
  });
  const facts = businessFacts(fixture, loadScale, definition);
  return Object.freeze({ fixture, businessDigest: canonicalDigest(facts) });
}

function validateMetadata(value, fixturePath) {
  const metadata = assertPlainObject(value, "fixture metadata");
  if (metadata.kind !== METADATA_KIND || metadata.adapterKind !== DISBURSEMENT_PERFORMANCE_ADAPTER_KIND) fail("fixture metadata kind is invalid.");
  const benchmarkRoot = assertAbsolute(metadata.benchmarkRoot, "fixture metadata benchmarkRoot");
  if (!isDirectChild(benchmarkRoot, fixturePath) || path.basename(fixturePath) !== METADATA_NAME) fail("fixture metadata path is not bound to its benchmark root.");
  const definition = loadScaleDefinition(metadata.loadScale);
  if (canonicalDigest(metadata.definition) !== canonicalDigest(definition)) fail("fixture metadata load-scale definition changed.");
  assertSha(metadata.businessDigest, "fixture metadata businessDigest");
  if (metadata.productionRepresentative !== true || metadata.outputContractFrozen !== true) fail("fixture metadata is not production-representative and frozen.");
  return Object.freeze({ ...metadata, benchmarkRoot, definition });
}

async function publishedFile(filePath, name, field) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${field} must be a plain regular file.`);
  const snapshot = await readStableBinaryFile(filePath);
  return Object.freeze({ name, type: "file", sha256: snapshot.sha256, size: snapshot.size });
}

async function extractFinalArchive(finalArchivePath) {
  await assertPlainDirectory(finalArchivePath, "published final archive");
  const rootEntries = await fs.readdir(finalArchivePath, { withFileTypes: true });
  if (rootEntries.length !== 3) fail("published final archive must contain exactly three root entries.");
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  for (const expected of [SUMMARY_NAME, WORKBOOK_NAME, VOUCHER_DIRECTORY_NAME]) {
    if (!rootNames.has(expected)) fail(`published final archive is missing ${expected}.`);
  }
  if (rootEntries.some((entry) => entry.isSymbolicLink())) fail("published final archive must not contain symbolic links.");
  const voucherDirectory = path.join(finalArchivePath, VOUCHER_DIRECTORY_NAME);
  await assertPlainDirectory(voucherDirectory, "published voucher directory");
  const voucherEntries = await fs.readdir(voucherDirectory, { withFileTypes: true });
  const names = new Set();
  const vouchers = [];
  for (const entry of voucherEntries) {
    const normalizedName = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    if (!entry.isFile() || entry.isSymbolicLink() || names.has(normalizedName)) fail("published voucher directory contains an invalid entry.");
    names.add(normalizedName);
    vouchers.push(await publishedFile(path.join(voucherDirectory, entry.name), entry.name, `published voucher ${entry.name}`));
  }
  vouchers.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    entries: Object.freeze([
      await publishedFile(path.join(finalArchivePath, SUMMARY_NAME), SUMMARY_NAME, "published summary"),
      await publishedFile(path.join(finalArchivePath, WORKBOOK_NAME), WORKBOOK_NAME, "published workbook"),
      Object.freeze({ name: VOUCHER_DIRECTORY_NAME, type: "directory", entries: Object.freeze(vouchers) }),
    ]),
  });
}

function digestJson(value) {
  return sha256Bytes(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function buildAdapterOutputContract(businessDigest, finalArchive) {
  assertSha(businessDigest, "output contract businessDigest");
  const [summary, workbook, voucherDirectory] = finalArchive.entries;
  const artifacts = { summary, workbook, vouchers: voucherDirectory.entries };
  const shape = {
    rootEntries: finalArchive.entries.map((entry) => entry.type === "directory"
      ? { name: entry.name, type: entry.type, entries: entry.entries.map((child) => ({ name: child.name, type: child.type })) }
      : { name: entry.name, type: entry.type }),
  };
  return Object.freeze({
    businessDigest,
    publishedArtifactDigest: digestJson({ kind: "compact-disbursement-published-artifacts-v1", artifacts }),
    finalShapeDigest: digestJson({ kind: "compact-disbursement-final-three-shape-v1", shape }),
    finalArchive,
  });
}

export async function createDisbursementPerformanceFixture({ benchmarkRoot, loadScale } = {}) {
  const safeBenchmarkRoot = assertAbsolute(benchmarkRoot, "benchmarkRoot");
  await assertPlainDirectory(safeBenchmarkRoot, "benchmarkRoot");
  const definition = loadScaleDefinition(loadScale);
  const referenceRoot = path.join(safeBenchmarkRoot, "production-reference-input");
  if (!isDirectChild(safeBenchmarkRoot, referenceRoot)) fail("reference input root is unsafe.");
  const reference = await buildProductionFixture(referenceRoot, loadScale, definition);
  const metadata = Object.freeze({
    kind: METADATA_KIND,
    adapterKind: DISBURSEMENT_PERFORMANCE_ADAPTER_KIND,
    benchmarkRoot: safeBenchmarkRoot,
    loadScale,
    definition,
    businessDigest: reference.businessDigest,
    expectedBatchName: reference.fixture.expectedBatchName,
    productionRepresentative: true,
    outputContractFrozen: true,
    finalRootEntries: Object.freeze([SUMMARY_NAME, WORKBOOK_NAME, VOUCHER_DIRECTORY_NAME]),
    inputIsolation: "one direct child input root per side and sample",
  });
  const metadataFile = await writeExclusiveJson(path.join(safeBenchmarkRoot, METADATA_NAME), metadata);
  return Object.freeze({
    kind: FIXTURE_KIND,
    loadScale,
    productionRepresentative: true,
    outputContractFrozen: true,
    metadataPath: metadataFile.path,
    metadataSha256: metadataFile.sha256,
    businessDigest: reference.businessDigest,
  });
}

export async function openDisbursementPerformanceSample({ fixturePath, runRoot, side, root, round, temperature } = {}) {
  const safeFixturePath = assertAbsolute(fixturePath, "fixturePath");
  const safeRunRoot = assertAbsolute(runRoot, "runRoot");
  assertAbsolute(root, "runner root");
  if (!new Set(["baseline", "candidate"]).has(side)) fail("side must be baseline or candidate.");
  if (!new Set(["cold", "hot"]).has(temperature)) fail("temperature must be cold or hot.");
  if (!Number.isSafeInteger(round)) fail("round must be a safe integer.");
  await assertPlainDirectory(safeRunRoot, "runRoot");
  const metadataSnapshot = await readStableUtf8JsonFile(safeFixturePath);
  const metadata = validateMetadata(metadataSnapshot.value, safeFixturePath);
  if (!isDirectChild(metadata.benchmarkRoot, safeRunRoot) || !path.basename(safeRunRoot).startsWith("run-")) fail("runRoot is not an owned direct child of the benchmark root.");
  const inputRoot = path.join(safeRunRoot, `input-${side}`);
  if (!isDirectChild(safeRunRoot, inputRoot)) fail("sample input root is unsafe.");
  const sample = await buildProductionFixture(inputRoot, metadata.loadScale, metadata.definition);
  if (sample.businessDigest !== metadata.businessDigest || sample.fixture.expectedBatchName !== metadata.expectedBatchName) {
    fail("sample business facts differ from the frozen production fixture.");
  }
  const stagingToken = crypto.createHash("sha256")
    .update(`${metadata.businessDigest}:${temperature}:${round}`)
    .digest("hex");
  const archiveRequest = Object.freeze({
    kind: ARCHIVE_KIND,
    stagingToken,
    manifestPath: sample.fixture.manifestPath,
    manifestSha256: sample.fixture.manifestSha256,
  });
  let cleaned = false;
  return Object.freeze({
    archiveRequest,
    async extractOutputContract({ receipt }) {
      const published = assertPlainObject(receipt, "publish receipt");
      if (published.kind !== RECEIPT_KIND) fail("publish receipt kind is invalid.");
      const finalArchivePath = assertAbsolute(published.finalArchivePath, "publish receipt finalArchivePath");
      const expectedArchivePath = path.join(inputRoot, metadata.expectedBatchName);
      if (!samePath(finalArchivePath, expectedArchivePath) || !isDirectChild(inputRoot, finalArchivePath)) fail("publish receipt archive path is outside the isolated sample input root.");
      return buildAdapterOutputContract(metadata.businessDigest, await extractFinalArchive(finalArchivePath));
    },
    async cleanup() {
      if (cleaned) return;
      if (!isDirectChild(safeRunRoot, inputRoot) || path.basename(inputRoot) !== `input-${side}`) fail("refusing to clean an unowned sample input root.");
      cleaned = true;
      await fs.rm(inputRoot, { recursive: true, force: true });
    },
  });
}
