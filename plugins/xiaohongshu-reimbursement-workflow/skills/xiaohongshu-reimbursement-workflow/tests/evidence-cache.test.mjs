import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditBatchManifest } from "../scripts/audit_batch_manifest.mjs";

import {
  EvidenceCache,
  diffEvidenceDependencies,
  parseImageMetadata,
  sha256Bytes,
} from "../scripts/evidence_cache.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function jpegWithoutEoi(width = 640, height = 480) {
  // SOI + baseline SOF0 segment.  Deliberately omit FFD9; the cache contract
  // accepts readable JPEGs while preserving their exact original bytes.
  const body = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  return body;
}

let root;

test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-evidence-cache-test-"));
});

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("parses PNG and JPEG dimensions, including JPEG without FFD9", () => {
  assert.deepEqual(parseImageMetadata(PNG), { imageKind: "png", extension: "png", width: 1, height: 1 });
  const jpeg = jpegWithoutEoi(640, 480);
  assert.equal(jpeg.at(-2) === 0xff && jpeg.at(-1) === 0xd9, false);
  assert.deepEqual(parseImageMetadata(jpeg), { imageKind: "jpeg", extension: "jpg", width: 640, height: 480 });
});

test("reads one source once across repeated and concurrent stages", async () => {
  const source = path.join(root, "shared.png");
  await fs.writeFile(source, PNG, { flag: "wx" });
  const cache = new EvidenceCache();
  const [first, second, third] = await Promise.all([
    cache.readStable(source, { sourceId: "IMG-1" }),
    cache.readStable(source, { sourceId: "IMG-1" }),
    cache.readStable(source, { sourceId: "IMG-1" }),
  ]);
  assert.equal(first.sourceSha256, sha256Bytes(PNG));
  assert.equal(second.width, 1);
  assert.equal(third.imageKind, "png");
  const stats = cache.stats();
  assert.equal(stats.reads, 1);
  assert.equal(stats.bytesRead, PNG.length);
  assert.equal(stats.cacheHits, 2);
  assert.equal(stats.parses, 1);
  assert.equal(stats.invalidations, 0);
  assert.equal(stats.entries, 1);
  assert.equal(stats.residentBytes, PNG.length);
  // Returned bytes are defensive copies; a consumer cannot poison later stages.
  first.bytes[0] = 0;
  assert.equal(cache.get(source).bytes[0], PNG[0]);
});

test("reuses unchanged metadata and invalidates only changed source", async () => {
  const source = path.join(root, "mutable.png");
  await fs.writeFile(source, PNG, { flag: "wx" });
  const cache = new EvidenceCache();
  await cache.readStable(source, { sourceId: "IMG-2" });
  await cache.readStable(source, { sourceId: "IMG-2", expectedSha256: sha256Bytes(PNG) });
  assert.equal(cache.stats().reads, 1);
  assert.equal(cache.invalidate(source), true);
  assert.equal(cache.get(source), null);
  await cache.readStable(source, { sourceId: "IMG-2" });
  assert.equal(cache.stats().reads, 2);
});

test("detects content changes even when an expected hash is supplied", async () => {
  const source = path.join(root, "changed.png");
  await fs.writeFile(source, PNG, { flag: "wx" });
  const cache = new EvidenceCache();
  const before = await cache.readStable(source);
  await fs.writeFile(source, Buffer.concat([PNG, Buffer.from([0])]), { flag: "w" });
  await assert.rejects(
    cache.readStable(source, { expectedSha256: before.sourceSha256 }),
    /SHA256 does not match expected value/,
  );
  assert.equal(cache.stats().reads, 2);
});

test("rereads a retained identity when its hash disagrees with the expected SHA", async () => {
  const source = path.join(root, "expected-sha-reread.bin");
  const bytes = Buffer.from("cached bytes");
  await fs.writeFile(source, bytes, { flag: "wx" });
  const cache = new EvidenceCache();
  await cache.readStable(source, { kind: "text", parse: false });
  await assert.rejects(
    cache.readStable(source, {
      kind: "text",
      parse: false,
      expectedSha256: sha256Bytes(Buffer.from("different bytes")),
    }),
    /SHA256 does not match expected value/,
  );
  const stats = cache.stats();
  assert.equal(stats.reads, 2);
  assert.equal(stats.expectedShaRereads, 1);
  assert.equal(stats.expectedShaMismatches, 1);
  assert.equal(stats.retries, 0);
  assert.equal(stats.entries, 0);
});

test("reports precise transaction and stage invalidation for a classification-only revision", () => {
  const previous = {
    files: [{ id: "IMG-1", path: "a.png", sha256: "a" }],
    transactions: [{ id: "TX-1", classification: "运营开支", evidence: ["IMG-1"], amount: "1" }],
  };
  const next = {
    files: [{ id: "IMG-1", path: "a.png", sha256: "a" }],
    transactions: [{ id: "TX-1", classification: "日常报销", evidence: ["IMG-1"], amount: "1" }],
  };
  assert.deepEqual(diffEvidenceDependencies(previous, next), {
    changedEvidenceIds: [],
    changedTransactionIds: ["TX-1"],
    invalidatedStages: ["artifact-build", "preview"],
  });
});

test("reports evidence changes and affected transactions only", () => {
  const previous = {
    files: [
      { id: "IMG-1", path: "a.png", sha256: "a" },
      { id: "IMG-2", path: "b.png", sha256: "b" },
    ],
    transactions: [
      { id: "TX-1", evidence: ["IMG-1"], amount: "1" },
      { id: "TX-2", evidence: ["IMG-2"], amount: "2" },
    ],
  };
  const next = {
    files: [
      { id: "IMG-1", path: "a.png", sha256: "changed" },
      { id: "IMG-2", path: "b.png", sha256: "b" },
    ],
    transactions: [
      { id: "TX-1", evidence: ["IMG-1"], amount: "1" },
      { id: "TX-2", evidence: ["IMG-2"], amount: "2" },
    ],
  };
  const result = diffEvidenceDependencies(previous, next);
  assert.deepEqual(result.changedEvidenceIds, ["IMG-1"]);
  assert.deepEqual(result.changedTransactionIds, ["TX-1"]);
  assert.deepEqual(result.invalidatedStages, ["evidence-scan", "artifact-build", "archive", "preview"]);
});

test("snapshot contains registry metadata but never serializes source bytes", async () => {
  const source = path.join(root, "snapshot.png");
  await fs.writeFile(source, PNG, { flag: "wx" });
  const cache = new EvidenceCache();
  await cache.readStable(source, { sourceId: "IMG-SNAPSHOT" });
  const snapshot = cache.snapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(Object.hasOwn(snapshot.entries[0], "bytes"), false);
  assert.equal(snapshot.entries[0].sourceSha256, sha256Bytes(PNG));
  snapshot.entries[0].identity.size = "0";
  snapshot.entries[0].aliases.push("mutated");
  const retained = cache.get(source);
  assert.equal(retained.identity.size, String(PNG.length));
  assert.equal(retained.aliases.includes("mutated"), false);
});

test("separates kind and parser identities while deduplicating a realpath alias", async () => {
  const sourceDir = path.join(root, "identity-real");
  await fs.mkdir(sourceDir);
  const source = path.join(sourceDir, "identity.png");
  await fs.writeFile(source, PNG, { flag: "wx" });
  const cache = new EvidenceCache();
  let alias;
  try {
    alias = path.join(root, "identity-alias.png");
    await fs.symlink(source, alias);
  } catch (error) {
    // A directory junction normally remains available on Windows when file
    // symlinks require developer mode or elevated privileges.
    try {
      const aliasDir = path.join(root, "identity-junction");
      await fs.symlink(sourceDir, aliasDir, "junction");
      alias = path.join(aliasDir, "identity.png");
    } catch {
      alias = path.join(sourceDir, ".", "identity.png");
    }
  }
  await cache.readStable(source, { kind: "image", parse: false });
  await cache.readStable(alias, { kind: "image", parse: false });
  await cache.readStable(alias, { kind: "text", parse: false });
  assert.equal(cache.stats().reads, 2);
  assert.equal(cache.stats().entries, 2);
  assert.ok(cache.stats().aliases >= 2);
  assert.equal(cache.get(alias, { kind: "image", parse: false }).kind, "image");
  assert.equal(cache.invalidate(alias, { kind: "image" }), true);
  assert.equal(cache.get(source, { kind: "image", parse: false }), null);
});

test("does not hit a same-size replacement that restores the original mtime", async () => {
  const source = path.join(root, "same-stat.bin");
  const original = Buffer.from("AAAA");
  const replacement = Buffer.from("BBBB");
  await fs.writeFile(source, original, { flag: "wx" });
  const cache = new EvidenceCache();
  const initial = await cache.readStable(source, { kind: "text", parse: false });
  assert.equal(typeof initial.identity.ino, "string");
  const bigintStat = await fs.stat(source, { bigint: true });
  assert.equal(initial.identity.ino, bigintStat.ino.toString());
  const stat = await fs.stat(source);
  const staged = path.join(root, "same-stat-replacement.bin");
  await fs.writeFile(staged, replacement, { flag: "wx" });
  await fs.rm(source);
  await fs.rename(staged, source);
  await fs.utimes(source, stat.atime, stat.mtime);
  const refreshed = await cache.readStable(source, { kind: "text", parse: false });
  assert.equal(refreshed.sourceSha256, sha256Bytes(replacement));
  assert.equal(cache.stats().reads, 2);
  assert.equal(cache.stats().cacheHits, 0);
});

test("bounds resident bytes with deterministic LRU eviction", async () => {
  const first = path.join(root, "resident-a.bin");
  const second = path.join(root, "resident-b.bin");
  await fs.writeFile(first, Buffer.from("1111"), { flag: "wx" });
  await fs.writeFile(second, Buffer.from("2222"), { flag: "wx" });
  const cache = new EvidenceCache({ maxBytes: 16, maxResidentBytes: 5 });
  await cache.readStable(first, { kind: "text", parse: false });
  await cache.readStable(second, { kind: "text", parse: false });
  const stats = cache.stats();
  assert.ok(stats.residentBytes <= 5);
  assert.equal(stats.entries, 1);
  assert.equal(stats.evictions, 1);
  assert.equal(cache.get(first, { kind: "text", parse: false }), null);
});

test("strict stage sharing rejects capacity overflow instead of rereading an evicted source", async () => {
  const first = path.join(root, "retained-a.bin");
  const second = path.join(root, "retained-b.bin");
  await fs.writeFile(first, Buffer.from("1111"), { flag: "wx" });
  await fs.writeFile(second, Buffer.from("2222"), { flag: "wx" });
  const cache = new EvidenceCache({ maxBytes: 16, maxResidentBytes: 5, requireRetention: true });
  await cache.readStable(first, { kind: "text", parse: false });
  await assert.rejects(
    () => cache.readStable(second, { kind: "text", parse: false }),
    /cannot retain all stage-shared bytes/iu,
  );
  assert.equal(cache.get(first, { kind: "text", parse: false })?.sourceSha256, sha256Bytes(Buffer.from("1111")));
  assert.equal(cache.stats().evictions, 0);
});

test("retries a source that changes between the handle read and path check", async () => {
  const source = path.join(root, "unstable.bin");
  const staged = path.join(root, "unstable-replacement.bin");
  await fs.writeFile(source, Buffer.from("old!"), { flag: "wx" });
  const cache = new EvidenceCache({ maxRetries: 1 });
  let replaced = false;
  const refreshed = await cache.readStable(source, {
    kind: "text",
    parse: false,
    testHooks: {
      afterOpen: async () => {
        if (replaced) return;
        replaced = true;
        await fs.writeFile(staged, Buffer.from("new!"), { flag: "wx" });
        await fs.rm(source);
        await fs.rename(staged, source);
      },
    },
  });
  assert.equal(refreshed.bytes.toString(), "new!");
  assert.equal(cache.stats().retries, 1);
  assert.equal(cache.stats().reads, 2);
});

test("auditBatchManifest accepts only the evidenceCache option and reuses retained evidence", async () => {
  const baseline = path.join(root, "audit-baseline.bin");
  const image = path.join(root, "audit-image.png");
  const manifestPath = path.join(root, "audit-manifest.json");
  await fs.writeFile(baseline, Buffer.from("baseline"), { flag: "wx" });
  await fs.writeFile(image, PNG, { flag: "wx" });
  const manifest = {
    version: 1,
    rulesVersion: "evidence-cache-test",
    batch: {
      rootPath: root,
      archivePath: path.join(root, "audit-archive"),
      period: "2026-08-01—2026-08-02",
      targetCategory: "小红书报销",
      reviewRevision: 1,
    },
    files: [
      { id: "BASE", role: "baseline", path: baseline, sha256: sha256Bytes(Buffer.from("baseline")) },
      { id: "IMG", role: "material", kind: "image", disposition: "used", path: image, sha256: sha256Bytes(PNG) },
    ],
    transactions: [{
      id: "TX-1",
      date: "2026-08-01",
      person: "匿名甲",
      project: "匿名项目",
      label: "匿名甲",
      amount: "1",
      category: "小红书报销",
      reimbursable: true,
      evidence: ["IMG"],
    }],
    expectedFeeTotal: "1",
    expectedRealTotal: "1",
    expectedCategoryTotals: { "小红书报销": "1" },
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx" });
  const cache = new EvidenceCache();
  assert.equal((await auditBatchManifest(manifestPath, { evidenceCache: cache })).ok, true);
  assert.equal((await auditBatchManifest(manifestPath, { evidenceCache: cache })).ok, true);
  assert.equal(cache.stats().reads, 1);
  assert.equal(cache.stats().cacheHits, 1);
  assert.equal(cache.get(image, { kind: "image", parse: true }).width, 1);
  await assert.rejects(auditBatchManifest(manifestPath, { cache }), /unsupported field cache/iu);
  await assert.rejects(auditBatchManifest(manifestPath, cache), /unsupported field/iu);
  await assert.rejects(
    auditBatchManifest(manifestPath, {
      evidenceCache: {
        async readStable() {
          return { sourceSha256: "0".repeat(64), size: PNG.length };
        },
      },
    }),
    /Manifest file SHA256 does not match: IMG/,
  );
});
