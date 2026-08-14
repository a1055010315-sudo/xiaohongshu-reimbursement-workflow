import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PREFIX = "codex-xhs-reimburse-";
export const MARKER_NAME = ".codex-xhs-owner.json";
export const MARKER_KIND = "xiaohongshu-reimbursement-temp";
export const CURRENT_MARKER_VERSION = 2;
export const MAX_ENTRIES = 50_000;
export const MAX_DEPTH = 32;

export function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

export function validateToken(token) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token ?? "")) {
    throw new Error("Ownership token must contain 16-128 safe characters.");
  }
}

export function resolveTaskRoot(rawTarget, token) {
  validateToken(token);
  const target = path.resolve(rawTarget);
  const tempRoot = path.resolve(os.tmpdir());
  if (!samePath(path.dirname(target), tempRoot)) {
    throw new Error("Refusing a task root outside a direct child of the system temp directory.");
  }
  if (path.basename(target) !== `${PREFIX}${token}`) {
    throw new Error("Temporary directory name does not match the ownership token.");
  }
  return { target, tempRoot };
}

export function entryKind(stat) {
  if (stat.isSymbolicLink()) return "link";
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  return "unsupported";
}

function inventorySort(left, right) {
  return left.path.localeCompare(right.path, "en");
}

function inventoryKey(relativePath) {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

export function normalizeInventory(inventory) {
  if (!Array.isArray(inventory)) throw new Error("Version-2 ownership marker requires an inventory array.");
  if (inventory.length > MAX_ENTRIES) throw new Error(`Inventory contains more than ${MAX_ENTRIES} entries.`);

  const seen = new Set();
  const normalized = inventory.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Inventory entry ${index} must be an object.`);
    }
    const keys = Object.keys(entry).sort();
    const expectedKeys = entry.kind === "file" ? ["kind", "path", "sha256"] : ["kind", "path"];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      throw new Error(`Inventory entry ${index} has unexpected or missing fields.`);
    }
    if (entry.kind !== "file" && entry.kind !== "dir") {
      throw new Error(`Inventory entry ${index} has an unsupported kind.`);
    }
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.includes("\\") || entry.path.includes("\0")) {
      throw new Error(`Inventory entry ${index} has an invalid relative path.`);
    }
    if (
      entry.path.startsWith("/") ||
      entry.path.endsWith("/") ||
      path.posix.isAbsolute(entry.path) ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path === "." ||
      entry.path === ".." ||
      entry.path.startsWith("../")
    ) {
      throw new Error(`Inventory entry ${index} is not a canonical in-root path.`);
    }
    if (entry.path.toLowerCase() === MARKER_NAME.toLowerCase()) {
      throw new Error("The ownership marker is implicit and must not appear in inventory.");
    }
    if (entry.kind === "file" && !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error(`Inventory file ${entry.path} requires a lowercase SHA256.`);
    }
    const key = inventoryKey(entry.path);
    if (seen.has(key)) throw new Error(`Inventory contains a duplicate path: ${entry.path}`);
    seen.add(key);
    return entry.kind === "file"
      ? { path: entry.path, kind: "file", sha256: entry.sha256 }
      : { path: entry.path, kind: "dir" };
  });

  normalized.sort(inventorySort);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index].path !== inventory[index].path) {
      throw new Error("Inventory must be sorted by relative path.");
    }
  }
  return normalized;
}

export function validateMarker(marker, token) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.kind !== MARKER_KIND || marker.token !== token) return false;
  if (marker.version !== CURRENT_MARKER_VERSION) return false;
  normalizeInventory(marker.inventory);
  return true;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function assertRealDirectory(target) {
  const stat = await fsp.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The task root must be a real directory, not a link or reparse point.");
  }
  const realPath = await fsp.realpath(target);
  if (!samePath(target, realPath)) {
    throw new Error("The task root resolves through a link, junction, or reparse point.");
  }
  return { stat, realPath };
}

export async function readMarker(target, token) {
  const markerPath = path.join(target, MARKER_NAME);
  const stat = await fsp.lstat(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Ownership marker must be a regular file.");
  const raw = await fsp.readFile(markerPath, "utf8");
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new Error("Ownership marker is not valid JSON.");
  }
  if (!validateMarker(marker, token)) {
    throw new Error("Ownership marker does not match the supplied token or inventory contract.");
  }
  return { markerPath, marker, raw, stat };
}

async function assertResolvedParentInside(absolutePath, targetRealPath) {
  const resolvedParent = await fsp.realpath(path.dirname(absolutePath));
  if (!samePath(resolvedParent, targetRealPath) && !isInside(targetRealPath, resolvedParent)) {
    throw new Error(`Task entry resolves outside the owned task root: ${absolutePath}`);
  }
  const resolvedEntry = await fsp.realpath(absolutePath);
  if (!samePath(resolvedEntry, absolutePath)) {
    throw new Error(`Task entry resolves through a link, junction, or reparse point: ${absolutePath}`);
  }
}

export async function snapshotTree(target, targetRealPath) {
  const entries = [];
  const stack = [{ absolutePath: target, relativePath: "", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_DEPTH) throw new Error(`Task tree exceeds the maximum supported depth (${MAX_DEPTH}).`);
    const children = await fsp.readdir(current.absolutePath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const name of children) {
      const absolutePath = path.join(current.absolutePath, name);
      const relativeNative = current.relativePath ? path.join(current.relativePath, name) : name;
      const relativePath = relativeNative.split(path.sep).join("/");
      if (current.relativePath === "" && name.toLowerCase() === MARKER_NAME.toLowerCase()) {
        if (name !== MARKER_NAME) throw new Error("Ownership marker filename has non-canonical casing.");
        continue;
      }
      const stat = await fsp.lstat(absolutePath);
      const kind = entryKind(stat);
      if (kind === "link" || kind === "unsupported") {
        throw new Error(`Refusing a link, reparse point, or unsupported task entry: ${absolutePath}`);
      }
      await assertResolvedParentInside(absolutePath, targetRealPath);
      const entry = { absolutePath, path: relativePath, kind, stat };
      if (kind === "file") entry.sha256 = await sha256File(absolutePath);
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) throw new Error(`Task tree contains more than ${MAX_ENTRIES} entries.`);
      if (kind === "dir") {
        stack.push({ absolutePath, relativePath: relativeNative, depth: current.depth + 1 });
      }
    }
  }
  entries.sort(inventorySort);
  return entries;
}

export function inventoryFromSnapshot(snapshot) {
  return snapshot.map((entry) => entry.kind === "file"
    ? { path: entry.path, kind: "file", sha256: entry.sha256 }
    : { path: entry.path, kind: "dir" });
}

export function assertInventoryMatches(inventory, snapshot) {
  const expected = normalizeInventory(inventory);
  const actual = inventoryFromSnapshot(snapshot);
  if (expected.length !== actual.length) {
    const expectedPaths = new Set(expected.map((entry) => inventoryKey(entry.path)));
    const unknown = actual.find((entry) => !expectedPaths.has(inventoryKey(entry.path)));
    if (unknown) throw new Error(`Unregistered task entry prevents cleanup or registration: ${unknown.path}`);
    throw new Error("Task inventory contains an entry that is missing from disk.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const before = expected[index];
    const after = actual[index];
    if (before.path !== after.path || before.kind !== after.kind) {
      throw new Error(`Task inventory differs from disk at: ${before.path}`);
    }
    if (before.kind === "file" && before.sha256 !== after.sha256) {
      throw new Error(`Task file SHA256 changed or was registered incorrectly: ${before.path}`);
    }
  }
}

export function compareSnapshots(initial, current) {
  if (initial.length !== current.length) throw new Error("Task contents changed during preflight.");
  for (let index = 0; index < initial.length; index += 1) {
    const before = initial[index];
    const after = current[index];
    if (
      before.path !== after.path ||
      before.kind !== after.kind ||
      !sameIdentity(before.stat, after.stat) ||
      before.stat.size !== after.stat.size ||
      before.stat.mtimeMs !== after.stat.mtimeMs ||
      before.sha256 !== after.sha256
    ) {
      throw new Error(`Task entry changed during preflight: ${before.absolutePath}`);
    }
  }
}
