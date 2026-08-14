import fs from "node:fs/promises";
import path from "node:path";

import {
  MARKER_NAME,
  assertInventoryMatches,
  assertRealDirectory,
  compareSnapshots,
  readMarker,
  resolveTaskRoot,
  sameIdentity,
  samePath,
  sha256File,
  snapshotTree,
} from "./task_temp_inventory_common.mjs";

const ACTIVE_NAMES = new Set(["journal.json", "recovery.json", "recovery-required.json"]);

function emit(result, isError = false) {
  const line = `${JSON.stringify(result)}\n`;
  (isError ? process.stderr : process.stdout).write(line);
  process.exitCode = isError ? 1 : 0;
}

function isActiveRecoveryPath(relativePath, kind) {
  const name = path.posix.basename(relativePath).toLowerCase();
  if (kind === "dir" && name.startsWith(".codex-batch-publish-")) return true;
  if (name.endsWith(".lock") || name.includes("recovery-required")) return true;
  if (ACTIVE_NAMES.has(name) && relativePath.includes(".codex-batch-publish-")) return true;
  return false;
}

async function verifyEntryUnchanged(entry) {
  const stat = await fs.lstat(entry.absolutePath);
  if (
    !sameIdentity(entry.stat, stat) ||
    stat.isSymbolicLink() ||
    (entry.kind === "file" && !stat.isFile()) ||
    (entry.kind === "dir" && !stat.isDirectory()) ||
    (entry.kind === "file" && stat.size !== entry.stat.size) ||
    (entry.kind === "file" && stat.mtimeMs !== entry.stat.mtimeMs)
  ) {
    throw new Error(`Task entry changed before removal: ${entry.absolutePath}`);
  }
  if (entry.kind === "file" && await sha256File(entry.absolutePath) !== entry.sha256) {
    throw new Error(`Task file SHA256 changed before removal: ${entry.absolutePath}`);
  }
}

const rawTarget = process.argv[2];
const token = process.argv[3];

try {
  if (!rawTarget || !token || process.argv.length !== 4) {
    throw new Error("A temporary directory path and ownership token are required.");
  }
  const { target } = resolveTaskRoot(rawTarget, token);

  let targetExists = true;
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") targetExists = false;
    else throw error;
  }
  if (!targetExists) {
    emit({ ok: true, status: "already_absent", target });
  } else {
    const initialRoot = await assertRealDirectory(target);
    const initialMarker = await readMarker(target, token);
    const initialSnapshot = await snapshotTree(target, initialRoot.realPath);

    const activeEntry = initialSnapshot.find((entry) => isActiveRecoveryPath(entry.path, entry.kind));
    if (activeEntry) throw new Error(`Active publish/recovery state prevents cleanup: ${activeEntry.absolutePath}`);

    assertInventoryMatches(initialMarker.marker.inventory, initialSnapshot);

    const currentRootStat = await fs.lstat(target);
    const currentRealPath = await fs.realpath(target);
    const currentMarkerStat = await fs.lstat(initialMarker.markerPath);
    const currentMarkerRaw = await fs.readFile(initialMarker.markerPath, "utf8");
    if (
      !sameIdentity(initialRoot.stat, currentRootStat) ||
      !samePath(initialRoot.realPath, currentRealPath) ||
      !sameIdentity(initialMarker.stat, currentMarkerStat) ||
      currentMarkerRaw !== initialMarker.raw
    ) {
      throw new Error("Task root or ownership marker changed during cleanup preflight.");
    }

    const currentSnapshot = await snapshotTree(target, currentRealPath);
    compareSnapshots(initialSnapshot, currentSnapshot);
    assertInventoryMatches(initialMarker.marker.inventory, currentSnapshot);
    const markerAgain = await readMarker(target, token);
    if (markerAgain.raw !== initialMarker.raw || !sameIdentity(markerAgain.stat, initialMarker.stat)) {
      throw new Error("Ownership marker changed during cleanup preflight.");
    }

    const files = currentSnapshot.filter((entry) => entry.kind === "file");
    const directories = currentSnapshot
      .filter((entry) => entry.kind === "dir")
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length || right.path.localeCompare(left.path, "en"));

    for (const entry of files) {
      await verifyEntryUnchanged(entry);
      await fs.unlink(entry.absolutePath);
    }
    const markerStat = await fs.lstat(initialMarker.markerPath);
    const markerRaw = await fs.readFile(initialMarker.markerPath, "utf8");
    if (!sameIdentity(initialMarker.stat, markerStat) || markerRaw !== initialMarker.raw) {
      throw new Error("Ownership marker changed before removal.");
    }
    await fs.unlink(path.join(target, MARKER_NAME));
    for (const entry of directories) {
      await verifyEntryUnchanged(entry);
      if ((await fs.readdir(entry.absolutePath)).length !== 0) {
        throw new Error(`Task directory gained an unknown entry before removal: ${entry.absolutePath}`);
      }
      await fs.rmdir(entry.absolutePath);
    }
    await fs.rmdir(target);
    emit({
      ok: true,
      status: "removed",
      target,
      files: files.length + 1,
      directories: directories.length,
      inventoryEntries: currentSnapshot.length,
    });
  }
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
}
