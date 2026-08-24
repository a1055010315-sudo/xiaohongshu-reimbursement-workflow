import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyStableBinaryBytes,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "../scripts/workflow_primitives.mjs";

test("stable binary read keeps two complete chunked passes and exposes only copies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-stable-binary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "input.bin");
  const bytes = Buffer.from("bounded-two-pass-read", "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  const totals = { initial: 0, fresh: 0 };
  const snapshot = await readStableBinaryFile(filePath, {
    chunkSize: 3,
    testHooks: {
      onRead: ({ phase, bytesRead }) => { totals[phase] += bytesRead; },
    },
  });
  assert.deepEqual(totals, { initial: bytes.length, fresh: bytes.length });
  assert.equal(snapshot.sha256, sha256Bytes(bytes));
  const firstCopy = copyStableBinaryBytes(snapshot);
  firstCopy[0] ^= 0xff;
  assert.deepEqual(copyStableBinaryBytes(snapshot), bytes, "caller mutation must not reach the private retained bytes");
});

test("stable readers reject a same-length change before the independent fresh pass", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-stable-change-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "input.bin");
  await fs.writeFile(filePath, Buffer.from("original", "utf8"), { flag: "wx" });
  await assert.rejects(
    readStableBinaryFile(filePath, {
      chunkSize: 2,
      testHooks: {
        beforeFreshRead: () => fs.writeFile(filePath, Buffer.from("tampered", "utf8")),
      },
    }),
    /changed/u,
  );
});

test("stable UTF-8 JSON parsing retains the two-pass digest contract", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-stable-json-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "input.json");
  const bytes = Buffer.from('{"nested":{"value":7},"items":[1,2,3]}\n', "utf8");
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  const phases = [];
  const result = await readStableUtf8JsonFile(filePath, {
    chunkSize: 5,
    testHooks: { afterOpen: ({ phase }) => phases.push(phase) },
  });
  assert.deepEqual(phases, ["initial", "fresh"]);
  assert.equal(result.sha256, sha256Bytes(bytes));
  assert.equal(JSON.stringify(result.value), '{"nested":{"value":7},"items":[1,2,3]}');
});
