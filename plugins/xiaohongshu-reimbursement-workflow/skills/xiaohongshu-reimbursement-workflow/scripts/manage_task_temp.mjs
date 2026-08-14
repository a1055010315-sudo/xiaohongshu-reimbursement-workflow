import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CURRENT_MARKER_VERSION,
  MARKER_KIND,
  MARKER_NAME,
  PREFIX,
  assertInventoryMatches,
  assertRealDirectory,
  compareSnapshots,
  normalizeInventory,
  readMarker,
  resolveTaskRoot,
  sameIdentity,
  samePath,
  snapshotTree,
  validateToken,
} from "./task_temp_inventory_common.mjs";

function emit(result, isError = false) {
  const line = `${JSON.stringify(result)}\n`;
  (isError ? process.stderr : process.stdout).write(line);
  process.exitCode = isError ? 1 : 0;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

async function readRequest() {
  const flagIndex = process.argv.indexOf("--input");
  if (flagIndex === -1 || !process.argv[flagIndex + 1] || process.argv.length !== 4) {
    throw new Error("Usage: manage_task_temp.mjs --input <request.json>");
  }
  const requestPath = path.resolve(process.argv[flagIndex + 1]);
  const stat = await fs.lstat(requestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Task-temp request must be a regular JSON file.");
  return JSON.parse(await fs.readFile(requestPath, "utf8"));
}

async function initialize(request) {
  exactKeys(request, ["version", "operation", "token"], "Initialize request");
  validateToken(request.token);
  const target = path.join(path.resolve(os.tmpdir()), `${PREFIX}${request.token}`);
  resolveTaskRoot(target, request.token);
  await fs.mkdir(target, { recursive: false });
  try {
    const marker = {
      kind: MARKER_KIND,
      version: CURRENT_MARKER_VERSION,
      token: request.token,
      inventory: [],
    };
    await fs.writeFile(path.join(target, MARKER_NAME), `${JSON.stringify(marker)}\n`, { flag: "wx" });
    return { ok: true, status: "initialized", taskRoot: target, inventoryEntries: 0 };
  } catch (error) {
    try {
      await fs.rmdir(target);
    } catch {
      // Preserve anything unexpected rather than broadening rollback authority.
    }
    throw error;
  }
}

async function register(request) {
  exactKeys(request, ["version", "operation", "taskRoot", "token", "inventory"], "Register request");
  if (typeof request.taskRoot !== "string") throw new Error("Register request taskRoot must be a string.");
  const inventory = normalizeInventory(request.inventory);
  const { target } = resolveTaskRoot(request.taskRoot, request.token);
  const initialRoot = await assertRealDirectory(target);
  const initialMarker = await readMarker(target, request.token);
  if (initialMarker.marker.version !== CURRENT_MARKER_VERSION) {
    throw new Error("Only version-2 task roots support inventory registration.");
  }

  const snapshot = await snapshotTree(target, initialRoot.realPath);
  assertInventoryMatches(inventory, snapshot);

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
    throw new Error("Task root or ownership marker changed during inventory registration.");
  }

  const currentSnapshot = await snapshotTree(target, currentRealPath);
  compareSnapshots(snapshot, currentSnapshot);
  assertInventoryMatches(inventory, currentSnapshot);
  const marker = {
    kind: MARKER_KIND,
    version: CURRENT_MARKER_VERSION,
    token: request.token,
    inventory,
  };
  await fs.writeFile(initialMarker.markerPath, `${JSON.stringify(marker)}\n`, { flag: "w" });
  const verified = await readMarker(target, request.token);
  if (JSON.stringify(verified.marker.inventory) !== JSON.stringify(inventory)) {
    throw new Error("Inventory marker write did not verify.");
  }
  return { ok: true, status: "registered", taskRoot: target, inventoryEntries: inventory.length };
}

try {
  const request = await readRequest();
  if (request.version !== 1) throw new Error("Task-temp request version must be 1.");
  if (request.operation === "init") {
    emit(await initialize(request));
  } else if (request.operation === "register") {
    emit(await register(request));
  } else {
    throw new Error("Task-temp operation must be init or register.");
  }
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, true);
}
