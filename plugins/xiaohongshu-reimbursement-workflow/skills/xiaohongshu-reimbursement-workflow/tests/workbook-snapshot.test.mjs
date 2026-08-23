import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalDigest,
  loadBundledDependency,
  mapSettledLimit,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";
import {
  DEFAULT_WORKBOOK_BUDGETS,
  assertStableFileSnapshotCurrent,
  openWorkbookSnapshot,
  readSnapshotStructuralPart,
  readSnapshotStructuralParts,
  readStableFileSnapshot,
  snapshotMetrics,
} from "../scripts/workbook_snapshot.mjs";

const JSZip = loadBundledDependency("jszip");
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

let tempRoot;

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-workbook-snapshot-"));
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function xml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
}

function workbookParts({ mediaBytes = Buffer.from("deterministic-media", "utf8"), largeSheet = "" } = {}) {
  return {
    "[Content_Types].xml": xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    "_rels/.rels": xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ),
    "xl/workbook.xml": xml(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ),
    "xl/worksheets/sheet1.xml": xml(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/>${largeSheet}</worksheet>`,
    ),
    "xl/media/image1.png": mediaBytes,
  };
}

async function writeZip(name, {
  parts = workbookParts(),
  compression = "DEFLATE",
  compressionOptions = { level: 9 },
} = {}) {
  const zip = new JSZip();
  for (const [partName, bytes] of Object.entries(parts)) {
    zip.file(partName, bytes, { createFolders: false });
  }
  const output = await zip.generateAsync({
    type: "nodebuffer",
    compression,
    compressionOptions,
    platform: "DOS",
  });
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, output, { flag: "wx" });
  return { filePath, bytes: output };
}

function findEocd(bytes) {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    if (offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new Error("EOCD not found in test fixture.");
}

function centralEntries(bytes) {
  const eocdOffset = findEocd(bytes);
  const count = bytes.readUInt16LE(eocdOffset + 10);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), CENTRAL_SIGNATURE);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localOffset = bytes.readUInt32LE(offset + 42);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    entries.push({
      name,
      offset,
      localOffset,
      dataOffset: localOffset + 30 + localNameLength + localExtraLength,
      compressedSize: bytes.readUInt32LE(offset + 20),
      uncompressedSize: bytes.readUInt32LE(offset + 24),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    centralOffset: bytes.readUInt32LE(eocdOffset + 16),
    centralSize: bytes.readUInt32LE(eocdOffset + 12),
    eocdOffset,
    entries,
  };
}

async function writeMutation(name, sourceBytes, mutate) {
  const bytes = Buffer.from(sourceBytes);
  mutate(bytes, centralEntries(bytes));
  const filePath = path.join(tempRoot, name);
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return filePath;
}

async function openWithBudgets(filePath, budgets = {}) {
  const snapshot = await readStableFileSnapshot(filePath, { budgets });
  return openWorkbookSnapshot(snapshot, { budgets });
}

test("shared primitives preserve canonical digest semantics and settled limiter invariants", async () => {
  assert.equal(
    canonicalDigest({ z: [2, { b: true, a: "x" }], a: 1 }),
    canonicalDigest({ a: 1, z: [2, { a: "x", b: true }] }),
  );
  assert.equal(sha256Bytes(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  let active = 0;
  let peak = 0;
  const started = [];
  let peerSettled = false;
  let rejectPrimary;
  let releasePeer;
  const primaryGate = new Promise((_, reject) => { rejectPrimary = reject; });
  const peerGate = new Promise((resolve) => { releasePeer = resolve; });
  const primary = new Error("primary limiter failure");
  const pending = mapSettledLimit([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    active += 1;
    peak = Math.max(peak, active);
    try {
      if (value === 0) await primaryGate;
      if (value === 1) {
        await peerGate;
        peerSettled = true;
      }
      return `done-${value}`;
    } finally {
      active -= 1;
    }
  });

  while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
  rejectPrimary(primary);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1], "no task may be dispatched after the first observed rejection");
  let completed = false;
  pending.catch(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "the limiter must wait for already-started work");
  releasePeer();
  let rejection;
  try {
    await pending;
  } catch (error) {
    rejection = error;
  }

  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(peerSettled, true);
  assert.equal(rejection, primary, "the original primary error must be propagated after settlement");
  assert.equal(primary.settledDetails.startedCount, 2);
  assert.equal(primary.settledDetails.settled[0].status, "rejected");
  assert.equal(primary.settledDetails.settled[1].status, "fulfilled");
  assert.equal(primary.settledDetails.settled[2], undefined);
  assert.equal(primary.settledDetails.settled[3], undefined);

  for (const reason of [undefined, "string rejection"]) {
    let normalized;
    try {
      await mapSettledLimit([0, 1], 1, async () => { throw reason; });
    } catch (error) {
      normalized = error;
    }
    assert.ok(normalized instanceof Error);
    assert.equal(normalized.cause, reason);
    assert.equal(normalized.settledDetails.startedCount, 1);
    assert.equal(normalized.settledDetails.settled[0].status, "rejected");
    assert.equal(normalized.settledDetails.settled[1], undefined);
  }

  const frozenPrimary = Object.freeze(new Error("frozen limiter failure"));
  let frozenRejection;
  try {
    await mapSettledLimit([0, 1], 2, async (value) => {
      if (value === 0) throw frozenPrimary;
      await new Promise((resolve) => setImmediate(resolve));
      return "peer-finished";
    });
  } catch (error) {
    frozenRejection = error;
  }
  assert.ok(frozenRejection instanceof Error);
  assert.notEqual(frozenRejection, frozenPrimary);
  assert.equal(frozenRejection.cause, frozenPrimary);
  assert.match(frozenRejection.message, /frozen limiter failure/u);
  assert.equal(frozenRejection.settledDetails.startedCount, 2);
  assert.equal(frozenRejection.settledDetails.settled[0].reason, frozenPrimary);
  assert.deepEqual(frozenRejection.settledDetails.settled[1], { status: "fulfilled", value: "peer-finished" });
});

test("stable file snapshots hide bytes, bind identity, and close handles on failure", async (context) => {
  const { filePath } = await writeZip("stable.xlsx");
  const snapshot = await readStableFileSnapshot(filePath);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.hasOwn(snapshot, "bytes"), false);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(snapshot.metrics.readCount, 1);
  assert.equal(snapshot.metrics.hashCount, 1);
  await assertStableFileSnapshotCurrent(snapshot);

  const originalPath = `${filePath}.original`;
  await fs.rename(filePath, originalPath);
  await fs.copyFile(originalPath, filePath);
  await assert.rejects(() => assertStableFileSnapshotCurrent(snapshot), /identity|changed|replaced/iu);

  const sameLength = await writeZip("stable-same-length.xlsx");
  const sameLengthSnapshot = await readStableFileSnapshot(sameLength.filePath);
  const changedBytes = Buffer.from(sameLength.bytes);
  changedBytes[Math.floor(changedBytes.length / 2)] ^= 0x01;
  await fs.writeFile(sameLength.filePath, changedBytes);
  await assert.rejects(
    () => assertStableFileSnapshotCurrent(sameLengthSnapshot),
    /bytes|SHA-256|changed/iu,
  );
  assert.equal(snapshotMetrics(sameLengthSnapshot).readCount, 2, "current-check must fresh read from its own handle");
  assert.equal(snapshotMetrics(sameLengthSnapshot).hashCount, 2, "current-check must fresh hash current bytes");

  const raced = await writeZip("stable-race.xlsx");
  const racedBytes = Buffer.from(raced.bytes);
  racedBytes[Math.floor(racedBytes.length / 3)] ^= 0x01;
  await assert.rejects(
    () => readStableFileSnapshot(raced.filePath, {
      coordination: {
        async afterOpen() {
          await fs.writeFile(raced.filePath, racedBytes);
        },
      },
    }),
    /identity|bytes changed/iu,
  );
  await fs.rename(raced.filePath, `${raced.filePath}.closed`);

  const grownDuringRead = await writeZip("stable-growth-race.xlsx");
  const growthBudget = grownDuringRead.bytes.length + 128;
  let growthError;
  await assert.rejects(
    () => readStableFileSnapshot(grownDuringRead.filePath, {
      budgets: { packageCompressedBytes: growthBudget },
      coordination: {
        async afterOpen() {
          const writer = await fs.open(grownDuringRead.filePath, "r+");
          try {
            await writer.truncate(growthBudget + 2 * 1024 * 1024);
          } finally {
            await writer.close();
          }
        },
      },
    }),
    (error) => {
      growthError = error;
      return /bounded|grew|packageCompressedBytes|identity/iu.test(error?.message);
    },
  );
  assert.equal(growthError.boundedReadDetails.limit, grownDuringRead.bytes.length);
  assert.ok(
    growthError.boundedReadDetails.bytesRead <= grownDuringRead.bytes.length + 1,
    "a raced file must never be read beyond its original size plus the EOF probe",
  );
  await fs.rename(grownDuringRead.filePath, `${grownDuringRead.filePath}.closed`);

  const grownBeforeCurrentCheck = await writeZip("stable-current-growth.xlsx");
  const currentSnapshot = await readStableFileSnapshot(grownBeforeCurrentCheck.filePath, {
    budgets: { packageCompressedBytes: grownBeforeCurrentCheck.bytes.length + 128 },
  });
  const currentMetricsBefore = snapshotMetrics(currentSnapshot);
  const currentWriter = await fs.open(grownBeforeCurrentCheck.filePath, "r+");
  try {
    await currentWriter.truncate(grownBeforeCurrentCheck.bytes.length + 2 * 1024 * 1024);
  } finally {
    await currentWriter.close();
  }
  await assert.rejects(
    () => assertStableFileSnapshotCurrent(currentSnapshot),
    /identity|size|changed|replaced/iu,
  );
  const currentMetricsAfter = snapshotMetrics(currentSnapshot);
  assert.equal(currentMetricsAfter.readCount, currentMetricsBefore.readCount);
  assert.equal(currentMetricsAfter.bytesRead, currentMetricsBefore.bytesRead);
  assert.equal(currentMetricsAfter.hashCount, currentMetricsBefore.hashCount);
  await fs.rename(grownBeforeCurrentCheck.filePath, `${grownBeforeCurrentCheck.filePath}.closed`);

  const oversized = await writeZip("stable-too-large.xlsx");
  await assert.rejects(
    () => readStableFileSnapshot(oversized.filePath, {
      budgets: { packageCompressedBytes: oversized.bytes.length - 1 },
    }),
    /packageCompressedBytes/iu,
  );
  await fs.rename(oversized.filePath, `${oversized.filePath}.renamed`);

  await context.test("leaf symlink or reparse point is rejected when supported", async (nested) => {
    const target = path.join(tempRoot, "symlink-target.xlsx");
    const link = path.join(tempRoot, "symlink-input.xlsx");
    await fs.copyFile(originalPath, target);
    try {
      await fs.symlink(target, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        nested.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(() => readStableFileSnapshot(link), /symbolic link|reparse/iu);
  });

  await context.test("reparse ancestor is rejected when supported", async (nested) => {
    const targetDirectory = path.join(tempRoot, "junction-target");
    const linkDirectory = path.join(tempRoot, "junction-input");
    await fs.mkdir(targetDirectory);
    await fs.copyFile(originalPath, path.join(targetDirectory, "inside.xlsx"));
    try {
      await fs.symlink(targetDirectory, linkDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
        nested.skip(`directory link unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readStableFileSnapshot(path.join(linkDirectory, "inside.xlsx")),
      /symbolic link|reparse|canonical path/iu,
    );
  });
});

test("workbook snapshot validates metadata without eagerly inflating media", async () => {
  const mediaBytes = Buffer.alloc(256 * 1024);
  for (let index = 0; index < mediaBytes.length; index += 1) mediaBytes[index] = (index * 131 + 17) & 0xff;
  const { filePath } = await writeZip("lazy-media.xlsx", { parts: workbookParts({ mediaBytes }) });
  const stable = await readStableFileSnapshot(filePath);
  const workbook = await openWorkbookSnapshot(stable);

  assert.equal(Object.isFrozen(workbook), true);
  assert.equal(Object.isFrozen(workbook.parts), true);
  assert.equal(workbook.parts.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(workbook.package), true);
  assert.equal(Object.isFrozen(workbook.budgets), true);
  assert.equal(Object.isFrozen(stable.identity), true);
  assert.equal(Object.isFrozen(stable.metrics), true);
  assert.equal(Object.isFrozen(snapshotMetrics(workbook)), true);
  const firstPartName = workbook.parts[0].name;
  assert.throws(() => { workbook.parts[0].name = "xl/evil.xml"; }, TypeError);
  assert.equal(workbook.parts[0].name, firstPartName);
  assert.equal(workbook.parts.some((part) => part.name === "xl/media/image1.png" && !part.structural), true);
  assert.equal(snapshotMetrics(workbook).structuralDecompressCount, 0);
  assert.equal(snapshotMetrics(workbook).structuralHashCount, 0);

  const first = await readSnapshotStructuralPart(workbook, "xl/workbook.xml");
  const originalFirstByte = first.bytes[0];
  first.bytes[0] ^= 0xff;
  const second = await readSnapshotStructuralPart(workbook, "xl/workbook.xml");
  assert.equal(second.bytes[0], originalFirstByte, "callers must receive copies, not mutable cached bytes");
  assert.equal(first.sha256, second.sha256);
  assert.equal(snapshotMetrics(workbook).structuralDecompressCount, 1);
  assert.equal(snapshotMetrics(workbook).structuralHashCount, 1);
  assert.equal(snapshotMetrics(workbook).structuralCacheHits, 1);
  await assert.rejects(
    () => readSnapshotStructuralPart(workbook, "xl/media/image1.png"),
    /not an allowed structural part/iu,
  );

  const batch = await readSnapshotStructuralParts(workbook, [
    "[Content_Types].xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/workbook.xml",
  ], { concurrency: 2 });
  assert.deepEqual(batch.map((item) => item.name), [
    "[Content_Types].xml",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
  ]);
  assert.ok(snapshotMetrics(workbook).peakStructuralConcurrency <= 2);
});

test("ZIP paths, flags, methods, and disk formats fail closed before JSZip", async (context) => {
  const source = await writeZip("zip-structure-source.xlsx");
  const cases = [
    {
      name: "absolute part path",
      build: () => writeZip("absolute-path.xlsx", {
        parts: { ...workbookParts(), "/evil-part.xml": "<evil/>" },
      }).then((item) => item.filePath),
      error: /absolute|part path/iu,
    },
    {
      name: "parent traversal part path",
      build: () => writeZip("parent-path.xlsx", {
        parts: { ...workbookParts(), "../evil.xml": "<evil/>" },
      }).then((item) => item.filePath),
      error: /\.\.|part path/iu,
    },
    {
      name: "backslash traversal part path",
      build: () => writeZip("backslash-path.xlsx", {
        parts: { ...workbookParts(), "xl\\..\\evil.xml": "<evil/>" },
      }).then((item) => item.filePath),
      error: /part path|unsafe/iu,
    },
    {
      name: "case-folded duplicate part path",
      build: () => writeZip("duplicate-path.xlsx", {
        parts: { ...workbookParts(), "xl/Workbook.xml": "<duplicate/>" },
      }).then((item) => item.filePath),
      error: /duplicate.*part path/iu,
    },
    {
      name: "encrypted flag",
      build: () => writeMutation("encrypted.xlsx", source.bytes, (bytes, parsed) => {
        const entry = parsed.entries[0];
        bytes.writeUInt16LE(bytes.readUInt16LE(entry.offset + 8) | 1, entry.offset + 8);
        bytes.writeUInt16LE(bytes.readUInt16LE(entry.localOffset + 6) | 1, entry.localOffset + 6);
      }),
      error: /encrypted|flag/iu,
    },
    {
      name: "unsupported compression method",
      build: () => writeMutation("method.xlsx", source.bytes, (bytes, parsed) => {
        const entry = parsed.entries[0];
        bytes.writeUInt16LE(99, entry.offset + 10);
        bytes.writeUInt16LE(99, entry.localOffset + 8);
      }),
      error: /compression method/iu,
    },
    {
      name: "multi-disk archive",
      build: () => writeMutation("multidisk.xlsx", source.bytes, (bytes, parsed) => {
        bytes.writeUInt16LE(1, parsed.eocdOffset + 4);
      }),
      error: /multi-disk/iu,
    },
    {
      name: "ZIP64 sentinel",
      build: () => writeMutation("zip64.xlsx", source.bytes, (bytes, parsed) => {
        bytes.writeUInt16LE(0xffff, parsed.eocdOffset + 10);
      }),
      error: /ZIP64/iu,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const filePath = await item.build();
      const stable = await readStableFileSnapshot(filePath);
      await assert.rejects(() => openWorkbookSnapshot(stable), item.error);
    });
  }
});

test("central directory and local header disagreement, overlap, and bounds fail closed", async (context) => {
  const source = await writeZip("zip-range-source.xlsx");
  const cases = [
    {
      name: "local filename mismatch",
      mutate(bytes, parsed) {
        const entry = parsed.entries[0];
        bytes[entry.localOffset + 30] ^= 1;
      },
      error: /local.*file name|filename/iu,
    },
    {
      name: "local flags mismatch",
      mutate(bytes, parsed) {
        const entry = parsed.entries[0];
        bytes.writeUInt16LE(bytes.readUInt16LE(entry.localOffset + 6) ^ 0x0002, entry.localOffset + 6);
      },
      error: /local.*flags|flags.*mismatch/iu,
    },
    {
      name: "local data out of bounds",
      mutate(bytes, parsed) {
        const entry = parsed.entries[0];
        bytes.writeUInt32LE(parsed.eocdOffset, entry.offset + 42);
      },
      error: /local header|bounds|central directory/iu,
    },
    {
      name: "overlapping local records",
      mutate(bytes, parsed) {
        const ordered = [...parsed.entries].sort((left, right) => left.localOffset - right.localOffset);
        const first = ordered[0];
        const second = ordered[1];
        const overlappingSize = second.localOffset - first.dataOffset + 1;
        bytes.writeUInt32LE(overlappingSize, first.offset + 20);
        bytes.writeUInt32LE(overlappingSize, first.localOffset + 18);
      },
      error: /overlap/iu,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const filePath = await writeMutation(`range-${item.name}.xlsx`, source.bytes, item.mutate);
      const stable = await readStableFileSnapshot(filePath);
      await assert.rejects(() => openWorkbookSnapshot(stable), item.error);
    });
  }

  await context.test("orphan local record omitted from the central directory", async () => {
    const parsed = centralEntries(source.bytes);
    const ordered = [...parsed.entries].sort((left, right) => left.localOffset - right.localOffset);
    const orphan = source.bytes.subarray(ordered[0].localOffset, ordered[1].localOffset);
    const mutated = Buffer.concat([
      source.bytes.subarray(0, parsed.centralOffset),
      orphan,
      source.bytes.subarray(parsed.centralOffset),
    ]);
    const newEocdOffset = findEocd(mutated);
    mutated.writeUInt32LE(parsed.centralOffset + orphan.length, newEocdOffset + 16);
    const filePath = path.join(tempRoot, "orphan-local-record.xlsx");
    await fs.writeFile(filePath, mutated, { flag: "wx" });
    const stable = await readStableFileSnapshot(filePath);
    await assert.rejects(
      () => openWorkbookSnapshot(stable),
      /orphan local record|uncovered gap/iu,
    );
  });
});

test("neighboring fake jszip and sax packages cannot shadow fixed bundled dependencies", async () => {
  const isolatedRoot = path.join(tempRoot, "shadow-runtime-check");
  const isolatedScripts = path.join(isolatedRoot, "scripts");
  const fakeJsZipPackage = path.join(isolatedRoot, "node_modules", "jszip");
  const fakeSaxPackage = path.join(isolatedRoot, "node_modules", "sax");
  await fs.mkdir(isolatedScripts, { recursive: true });
  await Promise.all([
    fs.mkdir(fakeJsZipPackage, { recursive: true }),
    fs.mkdir(fakeSaxPackage, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(path.join(skillRoot, "scripts", "workflow_primitives.mjs"), path.join(isolatedScripts, "workflow_primitives.mjs")),
    fs.copyFile(path.join(skillRoot, "scripts", "workbook_snapshot.mjs"), path.join(isolatedScripts, "workbook_snapshot.mjs")),
    fs.writeFile(
      path.join(fakeJsZipPackage, "package.json"),
      `${JSON.stringify({ name: "jszip", version: "0.0.0-shadow", main: "index.cjs" })}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
    fs.writeFile(
      path.join(fakeJsZipPackage, "index.cjs"),
      'throw new Error("neighboring fake jszip was loaded");\n',
      { encoding: "utf8", flag: "wx" },
    ),
    fs.writeFile(
      path.join(fakeSaxPackage, "package.json"),
      `${JSON.stringify({ name: "sax", version: "0.0.0-shadow", main: "index.cjs" })}\n`,
      { encoding: "utf8", flag: "wx" },
    ),
    fs.writeFile(
      path.join(fakeSaxPackage, "index.cjs"),
      'throw new Error("neighboring fake sax was loaded");\n',
      { encoding: "utf8", flag: "wx" },
    ),
  ]);
  const isolated = await import(`${pathToFileURL(path.join(isolatedScripts, "workbook_snapshot.mjs")).href}?shadow=1`);
  const isolatedPrimitives = await import(`${pathToFileURL(path.join(isolatedScripts, "workflow_primitives.mjs")).href}?shadow=1`);
  const { filePath } = await writeZip("shadow-runtime-source.xlsx");
  const stable = await isolated.readStableFileSnapshot(filePath);
  const workbook = await isolated.openWorkbookSnapshot(stable);
  assert.equal(workbook.kind, "workbook-snapshot-v1");
  assert.equal(typeof isolatedPrimitives.loadBundledDependency("sax").parser, "function");
});

test("every workbook package budget rejects just-over-limit metadata before inflation", async (context) => {
  const { filePath, bytes } = await writeZip("budget-source.xlsx");
  const baseline = await openWithBudgets(filePath);
  const files = baseline.parts.filter((part) => !part.directory);
  const maxima = {
    partCount: baseline.package.partCount,
    partPathLength: Math.max(...baseline.parts.map((part) => part.name.length)),
    partPathDepth: Math.max(...baseline.parts.map((part) => part.pathDepth)),
    partCompressedBytes: Math.max(...files.map((part) => part.compressedSize)),
    partUncompressedBytes: Math.max(...files.map((part) => part.uncompressedSize)),
    structuralPartUncompressedBytes: Math.max(
      ...files.filter((part) => part.structural).map((part) => part.uncompressedSize),
    ),
    totalStructuralUncompressedBytes: baseline.package.totalStructuralUncompressedBytes,
    totalUncompressedBytes: baseline.package.totalUncompressedBytes,
  };

  await context.test("packageCompressedBytes", async () => {
    await assert.rejects(
      () => readStableFileSnapshot(filePath, { budgets: { packageCompressedBytes: bytes.length - 1 } }),
      /packageCompressedBytes/iu,
    );
  });
  for (const [budget, observed] of Object.entries(maxima)) {
    await context.test(budget, async () => {
      assert.ok(observed > 1, `${budget} fixture must support a just-over-limit check`);
      const stable = await readStableFileSnapshot(filePath, {
        budgets: { [budget]: observed - 1 },
      });
      await assert.rejects(
        () => openWorkbookSnapshot(stable, { budgets: { [budget]: observed - 1 } }),
        new RegExp(budget, "iu"),
      );
      assert.equal(snapshotMetrics(stable).structuralDecompressCount, 0);
    });
  }
});

test("high-compression structural data is rejected from central metadata before decompression", async () => {
  const largeSheet = `<ext>${"A".repeat(2 * 1024 * 1024)}</ext>`;
  const { filePath, bytes } = await writeZip("compression-bomb.xlsx", {
    parts: workbookParts({ largeSheet }),
  });
  assert.ok(bytes.length < 32 * 1024, "fixture must be highly compressible");
  const budgets = {
    structuralPartUncompressedBytes: 1024 * 1024,
    totalStructuralUncompressedBytes: 4 * 1024 * 1024,
    totalUncompressedBytes: 8 * 1024 * 1024,
  };
  const stable = await readStableFileSnapshot(filePath, { budgets });
  await assert.rejects(
    () => openWorkbookSnapshot(stable, { budgets }),
    /structuralPartUncompressedBytes/iu,
  );
  assert.equal(snapshotMetrics(stable).structuralDecompressCount, 0);
});

test("falsified structural size metadata cannot trigger unbounded DEFLATE output", async () => {
  const largeSheet = `<ext>${"A".repeat(2 * 1024 * 1024)}</ext>`;
  const source = await writeZip("falsified-size-source.xlsx", {
    parts: workbookParts({ largeSheet }),
  });
  assert.ok(source.bytes.length < 32 * 1024, "fixture must be highly compressible");
  const falsifiedPath = await writeMutation("falsified-size.xlsx", source.bytes, (bytes, parsed) => {
    const entry = parsed.entries.find((item) => item.name === "xl/worksheets/sheet1.xml");
    assert.ok(entry.uncompressedSize > 2 * 1024 * 1024);
    assert.equal(bytes.readUInt16LE(entry.offset + 8) & 0x0008, 0, "fixture must use fixed local metadata");
    bytes.writeUInt32LE(1024, entry.offset + 24);
    bytes.writeUInt32LE(1024, entry.localOffset + 22);
  });
  const stable = await readStableFileSnapshot(falsifiedPath);
  const workbook = await openWorkbookSnapshot(stable);
  let inflateError;
  await assert.rejects(
    () => readSnapshotStructuralPart(workbook, "xl/worksheets/sheet1.xml"),
    (error) => {
      inflateError = error;
      return /bounded|length|decompress|output/iu.test(error?.message);
    },
  );
  assert.equal(inflateError.boundedInflateDetails.expectedUncompressedBytes, 1024);
  assert.ok(inflateError.boundedInflateDetails.maxOutputLength <= 1025);
  assert.equal(snapshotMetrics(workbook).structuralBytesInflated, 0);
});

test("structural reads verify CRC and cache a single failure without unhandled work", async () => {
  const source = await writeZip("crc-source.xlsx", { compression: "STORE" });
  const corruptedPath = await writeMutation("crc-corrupt.xlsx", source.bytes, (bytes, parsed) => {
    const entry = parsed.entries.find((item) => item.name === "xl/workbook.xml");
    bytes[entry.dataOffset + Math.floor(entry.uncompressedSize / 2)] ^= 0x01;
  });
  const workbook = await openWithBudgets(corruptedPath);
  const reads = await Promise.allSettled([
    readSnapshotStructuralPart(workbook, "xl/workbook.xml"),
    readSnapshotStructuralPart(workbook, "xl/workbook.xml"),
  ]);
  assert.deepEqual(reads.map((item) => item.status), ["rejected", "rejected"]);
  assert.match(reads[0].reason.message, /CRC|corrupt/iu);
  assert.equal(reads[1].reason, reads[0].reason);
  assert.equal(snapshotMetrics(workbook).structuralDecompressCount, 1);
});

test("corrupt media remains lazy while verified structural parts stay readable", async () => {
  const source = await writeZip("lazy-corrupt-media-source.xlsx", { compression: "STORE" });
  const corruptedPath = await writeMutation("lazy-corrupt-media.xlsx", source.bytes, (bytes, parsed) => {
    const entry = parsed.entries.find((item) => item.name === "xl/media/image1.png");
    bytes[entry.dataOffset + Math.floor(entry.uncompressedSize / 2)] ^= 0x01;
  });
  const stable = await readStableFileSnapshot(corruptedPath);
  const workbook = await openWorkbookSnapshot(stable);
  assert.equal(snapshotMetrics(workbook).structuralDecompressCount, 0);
  const structural = await readSnapshotStructuralPart(workbook, "xl/workbook.xml");
  assert.match(structural.bytes.toString("utf8"), /<workbook\b/u);
  assert.equal(snapshotMetrics(workbook).structuralDecompressCount, 1);
  await assert.rejects(
    () => readSnapshotStructuralPart(workbook, "xl/media/image1.png"),
    /not an allowed structural part/iu,
  );
});

test("measured approved and representative-media maxima retain explicit bounded headroom", () => {
  const approvedMaxima = {
    packageCompressedBytes: 5_863,
    partCount: 12,
    partPathLength: 26,
    partPathDepth: 3,
    partUncompressedBytes: 21_526,
    totalStructuralUncompressedBytes: 33_529,
    totalUncompressedBytes: 33_529,
  };
  for (const [field, observed] of Object.entries(approvedMaxima)) {
    assert.ok(DEFAULT_WORKBOOK_BUDGETS[field] >= observed * 8, `${field} lacks measured headroom`);
    assert.ok(Number.isSafeInteger(DEFAULT_WORKBOOK_BUDGETS[field]));
  }
  const representativeMediaMaxima = {
    packageCompressedBytes: 13_614_902,
    partCount: 21,
    partPathLength: 35,
    partPathDepth: 4,
    partCompressedBytes: 4_928_897,
    partUncompressedBytes: 4_927_392,
    structuralPartUncompressedBytes: 8_770,
    totalStructuralUncompressedBytes: 28_780,
    totalUncompressedBytes: 13_631_884,
  };
  for (const [field, observed] of Object.entries(representativeMediaMaxima)) {
    assert.ok(DEFAULT_WORKBOOK_BUDGETS[field] >= observed * 4, `${field} lacks representative-media headroom`);
    assert.ok(Number.isSafeInteger(DEFAULT_WORKBOOK_BUDGETS[field]));
  }
  assert.ok(DEFAULT_WORKBOOK_BUDGETS.packageCompressedBytes <= 100 * 1024 * 1024);
  assert.ok(DEFAULT_WORKBOOK_BUDGETS.totalUncompressedBytes <= 512 * 1024 * 1024);
});
