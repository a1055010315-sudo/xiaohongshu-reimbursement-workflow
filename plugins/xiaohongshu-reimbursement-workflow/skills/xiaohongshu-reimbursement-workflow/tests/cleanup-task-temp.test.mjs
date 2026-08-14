import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const CLEANUP = fileURLToPath(new URL("../scripts/cleanup_task_temp.mjs", import.meta.url));
const MANAGER = fileURLToPath(new URL("../scripts/manage_task_temp.mjs", import.meta.url));

async function request(payload) {
  const requestRoot = await fs.mkdtemp(path.join(os.tmpdir(), "task-temp-request-"));
  const requestPath = path.join(requestRoot, "request.json");
  await fs.writeFile(requestPath, JSON.stringify(payload));
  try {
    return await execFileAsync(process.execPath, [MANAGER, "--input", requestPath], { windowsHide: true });
  } finally {
    await fs.rm(requestRoot, { recursive: true, force: true });
  }
}

async function initialize(token) {
  const { stdout } = await request({ version: 1, operation: "init", token });
  return JSON.parse(stdout).taskRoot;
}

async function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function register(root, token, inventory) {
  return request({ version: 1, operation: "register", taskRoot: root, token, inventory });
}

async function runCleanup(root, token) {
  return execFileAsync(process.execPath, [CLEANUP, root, token], { windowsHide: true });
}

test("normal init, explicit nested registration, and cleanup form a closed loop", async () => {
  const token = "nestedcleanup0001";
  const root = await initialize(token);
  await fs.mkdir(path.join(root, "preview", "page"), { recursive: true });
  await fs.mkdir(path.join(root, "cache"));
  await fs.writeFile(path.join(root, "preview", "page", "one.png"), "preview");
  await fs.writeFile(path.join(root, "cache", "facts.json"), "{}");
  await register(root, token, [
    { path: "cache", kind: "dir" },
    { path: "cache/facts.json", kind: "file", sha256: await sha256("{}") },
    { path: "preview", kind: "dir" },
    { path: "preview/page", kind: "dir" },
    { path: "preview/page/one.png", kind: "file", sha256: await sha256("preview") },
  ]);

  const { stdout } = await runCleanup(root, token);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "removed");
  assert.equal(result.inventoryEntries, 5);
  await assert.rejects(fs.lstat(root), { code: "ENOENT" });
  assert.equal(JSON.parse((await runCleanup(root, token)).stdout).status, "already_absent");
});

test("an initialized empty task root is cleanable", async () => {
  const token = "emptyinventory001";
  const root = await initialize(token);
  assert.equal(JSON.parse((await runCleanup(root, token)).stdout).status, "removed");
});

test("register is explicit and refuses an unlisted file", async (t) => {
  const token = "unknownregister01";
  const root = await initialize(token);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "known.txt"), "known");
  await fs.writeFile(path.join(root, "unknown.txt"), "unknown");
  await assert.rejects(register(root, token, [
    { path: "known.txt", kind: "file", sha256: await sha256("known") },
  ]), /Unregistered task entry/);
  await assert.rejects(runCleanup(root, token), /Unregistered task entry/);
  assert.equal(await fs.readFile(path.join(root, "unknown.txt"), "utf8"), "unknown");
});

test("a registered file content change preserves the task root", async (t) => {
  const token = "changedcontent001";
  const root = await initialize(token);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "facts.json"), "before");
  await register(root, token, [
    { path: "facts.json", kind: "file", sha256: await sha256("before") },
  ]);
  await fs.writeFile(path.join(root, "facts.json"), "after");
  await assert.rejects(runCleanup(root, token), /SHA256 changed/);
  assert.equal(await fs.readFile(path.join(root, "facts.json"), "utf8"), "after");
});

test("a registered entry missing from disk preserves the task root", async (t) => {
  const token = "missingentry0001";
  const root = await initialize(token);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "facts.json"), "facts");
  await register(root, token, [
    { path: "facts.json", kind: "file", sha256: await sha256("facts") },
  ]);
  await fs.unlink(path.join(root, "facts.json"));
  await assert.rejects(runCleanup(root, token), /missing from disk/);
});

test("non-canonical or escaping inventory paths are rejected", async (t) => {
  const token = "escapingpath0001";
  const root = await initialize(token);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(register(root, token, [
    { path: "../outside.txt", kind: "file", sha256: "0".repeat(64) },
  ]), /not a canonical in-root path/);
});

test("legacy flat version-1 task roots require explicit inventory migration", async (t) => {
  const token = "legacyflat000001";
  const root = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".codex-xhs-owner.json"), JSON.stringify({
    kind: "xiaohongshu-reimbursement-temp", version: 1, token,
  }));
  await fs.writeFile(path.join(root, "legacy.json"), "{}");
  await assert.rejects(runCleanup(root, token), /does not match the supplied token or inventory contract/u);
  assert.equal(await fs.readFile(path.join(root, "legacy.json"), "utf8"), "{}");
});

test("legacy version-1 roots cannot silently gain nested cleanup authority", async (t) => {
  const token = "legacynested0001";
  const root = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".codex-xhs-owner.json"), JSON.stringify({
    kind: "xiaohongshu-reimbursement-temp", version: 1, token,
  }));
  await assert.rejects(runCleanup(root, token), /does not match the supplied token or inventory contract/u);
});

test("marker mismatch preserves the entire task root", async (t) => {
  const token = "wrongmarker000001";
  const root = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".codex-xhs-owner.json"), JSON.stringify({
    kind: "xiaohongshu-reimbursement-temp", version: 2, token: "differentmarker0001", inventory: [],
  }));
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  await assert.rejects(runCleanup(root, token), /Ownership marker does not match/);
  assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("a version-2 marker without an exact inventory is never accepted", async (t) => {
  const token = "missinginventory01";
  const root = path.join(os.tmpdir(), `codex-xhs-reimburse-${token}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".codex-xhs-owner.json"), JSON.stringify({
    kind: "xiaohongshu-reimbursement-temp", version: 2, token,
  }));
  await fs.writeFile(path.join(root, "keep.txt"), "keep");
  await assert.rejects(runCleanup(root, token), /requires an inventory array/);
  assert.equal(await fs.readFile(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("active batch publish workspace blocks cleanup even when registered", async (t) => {
  const token = "activejournal0001";
  const root = await initialize(token);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceName = ".codex-batch-publish-12345678";
  await fs.mkdir(path.join(root, workspaceName));
  await fs.writeFile(path.join(root, workspaceName, "journal.json"), "{}");
  await register(root, token, [
    { path: workspaceName, kind: "dir" },
    { path: `${workspaceName}/journal.json`, kind: "file", sha256: await sha256("{}") },
  ]);
  await assert.rejects(runCleanup(root, token), /Active publish\/recovery state/);
});

test("a nested link or junction blocks registration and cleanup without following it", async (t) => {
  const token = "nestedlink0000001";
  const root = await initialize(token);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-outside-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, "untouched.txt"), "untouched");
  await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(register(root, token, [{ path: "linked", kind: "dir" }]), /link, reparse point, or unsupported/);
  await assert.rejects(runCleanup(root, token), /link, reparse point, or unsupported/);
  assert.equal(await fs.readFile(path.join(outside, "untouched.txt"), "utf8"), "untouched");
});
