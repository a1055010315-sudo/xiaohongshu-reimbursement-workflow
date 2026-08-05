import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PREFIX = "codex-xhs-reimburse-";
const MARKER_NAME = ".codex-xhs-owner.json";
const MARKER_KIND = "xiaohongshu-reimbursement-temp";

function emit(result, isError = false) {
  const line = `${JSON.stringify(result)}\n`;
  (isError ? process.stderr : process.stdout).write(line);
  process.exitCode = isError ? 1 : 0;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function entryType(stat) {
  if (stat.isSymbolicLink()) return "link";
  if (stat.isFile()) return "file";
  return "unsupported";
}

function validateMarker(marker, token) {
  return marker?.kind === MARKER_KIND && marker?.version === 1 && marker?.token === token;
}

const rawTarget = process.argv[2];
const token = process.argv[3];

try {
  if (!rawTarget || !token) {
    throw new Error("A temporary directory path and ownership token are required.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    throw new Error("Ownership token must contain 16-128 safe characters.");
  }

  const target = path.resolve(rawTarget);
  const tempRoot = path.resolve(os.tmpdir());
  if (!samePath(path.dirname(target), tempRoot)) {
    throw new Error("Refusing cleanup outside a direct child of the system temp directory.");
  }
  if (path.basename(target) !== `${PREFIX}${token}`) {
    throw new Error("Temporary directory name does not match the ownership token.");
  }

  let targetStat;
  try {
    targetStat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      emit({ ok: true, status: "already_absent", target });
      process.exitCode = 0;
    } else {
      throw error;
    }
  }

  if (!targetStat) {
    // The idempotent success result was already emitted.
  } else {
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error("The cleanup target must be a real directory, not a link.");
    }

    const initialRealPath = await fs.realpath(target);
    const markerPath = path.join(target, MARKER_NAME);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("Ownership marker must be a regular file.");
    }
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (!validateMarker(marker, token)) {
      throw new Error("Ownership marker does not match the supplied token.");
    }

    const names = await fs.readdir(target);
    const approved = [];
    for (const name of names) {
      const entryPath = path.join(target, name);
      const stat = await fs.lstat(entryPath);
      const type = entryType(stat);
      if (type === "unsupported") {
        throw new Error(`Refusing non-flat cleanup; unsupported entry: ${entryPath}`);
      }
      approved.push({ name, path: entryPath, type, stat });
    }

    const currentTargetStat = await fs.lstat(target);
    const currentRealPath = await fs.realpath(target);
    if (!sameIdentity(targetStat, currentTargetStat) || !samePath(initialRealPath, currentRealPath)) {
      throw new Error("Cleanup target identity changed during preflight.");
    }

    const currentNames = await fs.readdir(target);
    if (currentNames.length !== names.length || currentNames.some((name) => !names.includes(name))) {
      throw new Error("Cleanup target contents changed during preflight.");
    }
    for (const entry of approved) {
      const current = await fs.lstat(entry.path);
      if (!sameIdentity(entry.stat, current) || entryType(current) !== entry.type) {
        throw new Error(`Cleanup entry identity changed during preflight: ${entry.path}`);
      }
    }
    const markerAgain = JSON.parse(await fs.readFile(markerPath, "utf8"));
    if (!validateMarker(markerAgain, token)) {
      throw new Error("Ownership marker changed during preflight.");
    }

    approved.sort((left, right) => Number(left.name === MARKER_NAME) - Number(right.name === MARKER_NAME));
    for (const entry of approved) {
      await fs.unlink(entry.path);
    }
    await fs.rmdir(target);
    emit({ ok: true, status: "removed", target, entries: approved.length });
  }
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
}
