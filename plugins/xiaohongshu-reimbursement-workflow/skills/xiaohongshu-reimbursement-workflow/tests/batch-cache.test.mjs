import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BatchTaskCache,
  canonicalDigest,
  normalizeAffectedProfiles,
  normalizeProfileId,
} from "../scripts/batch_cache.mjs";

test("profile aliases normalize into the one fixed batch order", () => {
  assert.equal(normalizeProfileId("xhs"), "xiaohongshu");
  assert.deepEqual(
    normalizeAffectedProfiles(["residence", "xhs", "company"]),
    ["xiaohongshu", "company", "residence"],
  );
  assert.throws(() => normalizeAffectedProfiles(["xhs", "xiaohongshu"]), /duplicate/);
  assert.throws(() => normalizeAffectedProfiles([]), /one to three/);
});

test("canonical digests ignore object insertion order but bind arrays", () => {
  assert.equal(canonicalDigest({ b: 2, a: 1 }), canonicalDigest({ a: 1, b: 2 }));
  assert.notEqual(canonicalDigest(["a", "b"]), canonicalDigest(["b", "a"]));
});

test("task cache memoizes unchanged file hashes and invalidates changed bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "batch-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "evidence.bin");
  await fs.writeFile(filePath, "first");
  const cache = new BatchTaskCache();
  const first = await cache.hashFile(filePath);
  const second = await cache.hashFile(filePath);
  assert.equal(first, second);
  assert.deepEqual(cache.stats, { hashHits: 1, hashMisses: 1, valueHits: 0, valueMisses: 0 });
  await fs.writeFile(filePath, "changed");
  const third = await cache.hashFile(filePath);
  assert.notEqual(third, first);
  assert.equal(cache.stats.hashMisses, 2);
});

test("value cache binds values to dependency digests", () => {
  const cache = new BatchTaskCache();
  const firstDigest = "a".repeat(64);
  const nextDigest = "b".repeat(64);
  cache.put("ocr", "evidence-1", firstDigest, { amount: "100" });
  assert.deepEqual(cache.get("ocr", "evidence-1", firstDigest), { amount: "100" });
  assert.equal(cache.get("ocr", "evidence-1", nextDigest), undefined);
});
