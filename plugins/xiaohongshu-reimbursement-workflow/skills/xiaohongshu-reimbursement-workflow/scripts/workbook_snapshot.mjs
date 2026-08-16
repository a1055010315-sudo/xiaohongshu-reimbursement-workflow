import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflateRaw as inflateRawCallback } from "node:zlib";

import {
  loadBundledDependency,
  mapSettledLimit,
  sha256Bytes,
} from "./workflow_primitives.mjs";

const MIB = 1024 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ALLOWED_FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG | 0x0006;
const BUDGET_FIELDS = Object.freeze([
  "packageCompressedBytes",
  "partCount",
  "partPathLength",
  "partPathDepth",
  "partCompressedBytes",
  "partUncompressedBytes",
  "structuralPartUncompressedBytes",
  "totalStructuralUncompressedBytes",
  "totalUncompressedBytes",
]);
const STRUCTURAL_PART = /(?:\.xml|\.rels)$/iu;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export const DEFAULT_WORKBOOK_BUDGETS = Object.freeze({
  packageCompressedBytes: 100 * MIB,
  partCount: 4096,
  partPathLength: 512,
  partPathDepth: 32,
  partCompressedBytes: 64 * MIB,
  partUncompressedBytes: 128 * MIB,
  structuralPartUncompressedBytes: 16 * MIB,
  totalStructuralUncompressedBytes: 64 * MIB,
  totalUncompressedBytes: 512 * MIB,
});

const stableStates = new WeakMap();
const workbookStates = new WeakMap();
let crcTable;
const inflateRaw = promisify(inflateRawCallback);

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unknown field ${key}.`);
  }
}

function normalizeBudgets(value = {}) {
  requireObject(value, "Workbook budgets");
  rejectUnknownFields(value, new Set(BUDGET_FIELDS), "Workbook budgets");
  const normalized = {};
  for (const field of BUDGET_FIELDS) {
    const selected = value[field] ?? DEFAULT_WORKBOOK_BUDGETS[field];
    if (!Number.isSafeInteger(selected) || selected < 1) {
      throw new Error(`Workbook budget ${field} must be a positive safe integer.`);
    }
    normalized[field] = selected;
  }
  return Object.freeze(normalized);
}

function parseOptions(options, allowed, field) {
  if (options === undefined) return {};
  const value = requireObject(options, field);
  rejectUnknownFields(value, new Set(allowed), field);
  return value;
}

function comparePathValue(value) {
  let resolved = path.resolve(value);
  if (process.platform === "win32") {
    if (resolved.startsWith("\\\\?\\UNC\\")) resolved = `\\\\${resolved.slice(8)}`;
    else if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

function samePath(left, right) {
  return comparePathValue(left) === comparePathValue(right);
}

function nsValue(stat, field) {
  if (typeof stat[field] === "bigint") return stat[field];
  const millisecondsField = field.replace(/Ns$/u, "Ms");
  return BigInt(Math.trunc(Number(stat[millisecondsField]) * 1_000_000));
}

function fingerprint(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: nsValue(stat, "mtimeNs").toString(),
    ctimeNs: nsValue(stat, "ctimeNs").toString(),
    birthtimeNs: nsValue(stat, "birthtimeNs").toString(),
  });
}

function sameFingerprint(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

function sameBoundedReadIdentity(left, right) {
  return ["dev", "ino", "mode", "nlink", "size", "birthtimeNs"]
    .every((field) => left[field] === right[field]);
}

function attachDetails(error, field, details) {
  Object.defineProperty(error, field, {
    configurable: true,
    value: Object.freeze(details),
  });
  return error;
}

async function boundedHandleRead(handle, { expectedSize, maxBytes, field }) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error(`${field} expected size must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`${field} byte limit must be a positive safe integer.`);
  }
  const limit = Math.min(maxBytes, expectedSize);
  let bytesRead = 0;
  let readOperations = 0;
  const details = () => ({ bytesRead, expectedSize, limit, maxBytes, readOperations });
  if (expectedSize > maxBytes) {
    throw attachDetails(
      new Error(`${field} exceeds its bounded read limit ${maxBytes}.`),
      "boundedReadDetails",
      details(),
    );
  }

  const bytes = Buffer.allocUnsafe(limit);
  try {
    while (bytesRead < expectedSize) {
      const requested = Math.min(FILE_READ_CHUNK_BYTES, expectedSize - bytesRead);
      const result = await handle.read(bytes, bytesRead, requested, bytesRead);
      readOperations += 1;
      if (result.bytesRead === 0) {
        throw new Error(`${field} ended before its expected bounded size ${expectedSize}.`);
      }
      bytesRead += result.bytesRead;
    }
    const eofProbe = Buffer.allocUnsafe(1);
    const probe = await handle.read(eofProbe, 0, 1, expectedSize);
    readOperations += 1;
    bytesRead += probe.bytesRead;
    if (probe.bytesRead !== 0) {
      throw new Error(`${field} grew beyond its bounded expected size ${expectedSize} during the read.`);
    }
    return bytes;
  } catch (error) {
    const normalized = error instanceof Error
      ? error
      : new Error(`${field} bounded read failed with a non-Error reason.`, { cause: error });
    throw attachDetails(normalized, "boundedReadDetails", details());
  }
}

async function rejectReparseComponents(absolutePath) {
  const parsed = path.parse(absolutePath);
  const relative = path.relative(parsed.root, absolutePath);
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw new Error(`Stable snapshot path contains a symbolic link or reparse point: ${current}`);
    }
  }
}

async function capturePathState(absolutePath) {
  await rejectReparseComponents(absolutePath);
  const [lexical, followed, canonicalPath] = await Promise.all([
    fs.lstat(absolutePath, { bigint: true }),
    fs.stat(absolutePath, { bigint: true }),
    fs.realpath(absolutePath),
  ]);
  if (lexical.isSymbolicLink()) {
    throw new Error("Stable snapshot path must not be a symbolic link or reparse point.");
  }
  if (!lexical.isFile() || !followed.isFile()) {
    throw new Error("Stable snapshot path must identify one regular file.");
  }
  if (!samePath(absolutePath, canonicalPath)) {
    throw new Error("Stable snapshot canonical path differs from the requested path; reparse traversal is forbidden.");
  }
  const lexicalFingerprint = fingerprint(lexical);
  const followedFingerprint = fingerprint(followed);
  if (!sameFingerprint(lexicalFingerprint, followedFingerprint)) {
    throw new Error("Stable snapshot path identity changed while resolving the file.");
  }
  return { canonicalPath, fingerprint: followedFingerprint };
}

function requireStableState(snapshot) {
  const state = stableStates.get(snapshot);
  if (!state) throw new Error("A stable file snapshot created by readStableFileSnapshot is required.");
  return state;
}

function requireWorkbookState(snapshot) {
  const state = workbookStates.get(snapshot);
  if (!state) throw new Error("A workbook snapshot created by openWorkbookSnapshot is required.");
  return state;
}

function publicMetrics(metrics) {
  return Object.freeze({ ...metrics });
}

function createMetrics(size) {
  return {
    readCount: 1,
    bytesRead: size,
    hashCount: 1,
    pathCheckCount: 2,
    zipParseCount: 0,
    structuralDecompressCount: 0,
    structuralHashCount: 0,
    structuralCacheHits: 0,
    structuralBytesInflated: 0,
    activeStructuralDecompressions: 0,
    peakStructuralConcurrency: 0,
  };
}

export async function readStableFileSnapshot(filePath, options) {
  const parsedOptions = parseOptions(options, ["budgets", "coordination"], "Stable snapshot options");
  const budgets = normalizeBudgets(parsedOptions.budgets);
  const coordination = parsedOptions.coordination === undefined
    ? {}
    : requireObject(parsedOptions.coordination, "Stable snapshot coordination");
  rejectUnknownFields(coordination, new Set(["afterOpen", "afterRead"]), "Stable snapshot coordination");
  for (const [name, hook] of Object.entries(coordination)) {
    if (typeof hook !== "function") throw new Error(`Stable snapshot coordination ${name} must be a function.`);
  }
  if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) {
    throw new Error("Stable snapshot path must be an absolute path.");
  }
  const absolutePath = path.resolve(filePath);
  const beforePath = await capturePathState(absolutePath);
  let handle;
  let failure;
  let result;
  try {
    handle = await fs.open(absolutePath, "r");
    const beforeHandle = await handle.stat({ bigint: true });
    const beforeHandleFingerprint = fingerprint(beforeHandle);
    if (!beforeHandle.isFile() || !sameFingerprint(beforePath.fingerprint, beforeHandleFingerprint)) {
      throw new Error("Stable snapshot path was replaced before its file handle was bound.");
    }
    const size = Number(beforeHandle.size);
    if (!Number.isSafeInteger(size) || size > budgets.packageCompressedBytes) {
      throw new Error(`Workbook package exceeds packageCompressedBytes budget ${budgets.packageCompressedBytes}.`);
    }

    if (coordination.afterOpen) await coordination.afterOpen(Object.freeze({ path: absolutePath, size }));
    const bytes = await boundedHandleRead(handle, {
      expectedSize: size,
      field: "Workbook package",
      maxBytes: budgets.packageCompressedBytes,
    });
    if (coordination.afterRead) await coordination.afterRead(Object.freeze({ path: absolutePath, size: bytes.length }));
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await capturePathState(absolutePath);
    const afterHandleFingerprint = fingerprint(afterHandle);
    if (
      bytes.length !== size ||
      !sameFingerprint(beforeHandleFingerprint, afterHandleFingerprint) ||
      !sameFingerprint(beforeHandleFingerprint, afterPath.fingerprint) ||
      !samePath(beforePath.canonicalPath, afterPath.canonicalPath)
    ) {
      throw new Error("Stable snapshot file identity or bytes changed during the handle read.");
    }

    const metrics = createMetrics(bytes.length);
    const snapshot = Object.freeze({
      kind: "stable-file-snapshot-v1",
      path: absolutePath,
      canonicalPath: afterPath.canonicalPath,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      identity: beforeHandleFingerprint,
      metrics: publicMetrics(metrics),
    });
    stableStates.set(snapshot, {
      budgets,
      bytes,
      canonicalPath: afterPath.canonicalPath,
      fingerprint: beforeHandleFingerprint,
      metrics,
      path: absolutePath,
    });
    result = snapshot;
  } catch (error) {
    failure = error;
  }

  if (handle) {
    try {
      await handle.close();
    } catch (closeError) {
      if (failure && typeof failure === "object") failure.closeError = closeError;
      else failure = closeError;
    }
  }
  if (failure) throw failure;
  return result;
}

export async function assertStableFileSnapshotCurrent(snapshot) {
  const state = requireStableState(snapshot);
  let handle;
  let failure;
  try {
    const beforePath = await capturePathState(state.path);
    state.metrics.pathCheckCount += 1;
    if (
      !sameBoundedReadIdentity(state.fingerprint, beforePath.fingerprint) ||
      !samePath(state.canonicalPath, beforePath.canonicalPath)
    ) {
      throw new Error("Stable snapshot path identity or size changed before the bounded current read.");
    }
    handle = await fs.open(state.path, "r");
    const beforeHandle = await handle.stat({ bigint: true });
    const beforeHandleFingerprint = fingerprint(beforeHandle);
    if (!beforeHandle.isFile() || !sameBoundedReadIdentity(state.fingerprint, beforeHandleFingerprint)) {
      throw new Error("Stable snapshot handle identity or size changed before the bounded current read.");
    }
    const bytes = await boundedHandleRead(handle, {
      expectedSize: snapshot.size,
      field: "Stable snapshot current file",
      maxBytes: state.budgets.packageCompressedBytes,
    });
    const afterHandleFingerprint = fingerprint(await handle.stat({ bigint: true }));
    const afterPath = await capturePathState(state.path);
    state.metrics.pathCheckCount += 1;
    const currentSha256 = sha256Bytes(bytes);
    state.metrics.readCount += 1;
    state.metrics.bytesRead += bytes.length;
    state.metrics.hashCount += 1;
    if (
      !sameFingerprint(state.fingerprint, beforePath.fingerprint) ||
      !sameFingerprint(state.fingerprint, beforeHandleFingerprint) ||
      !sameFingerprint(state.fingerprint, afterHandleFingerprint) ||
      !sameFingerprint(state.fingerprint, afterPath.fingerprint) ||
      !samePath(state.canonicalPath, beforePath.canonicalPath) ||
      !samePath(state.canonicalPath, afterPath.canonicalPath) ||
      bytes.length !== snapshot.size ||
      currentSha256 !== snapshot.sha256
    ) {
      throw new Error("Stable snapshot path identity, bytes, or SHA-256 changed or was replaced.");
    }
  } catch (error) {
    failure = error;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (closeError) {
      if (failure && typeof failure === "object") failure.closeError = closeError;
      else failure = closeError;
    }
  }
  if (failure) throw failure;
  return true;
}

function findEocd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("Workbook ZIP EOCD record is missing or has trailing bytes.");
}

function assertRange(bytes, offset, length, field) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`Workbook ZIP ${field} is outside package bounds.`);
  }
}

function containsSignature(bytes, start, end, signature) {
  for (let offset = start; offset + 4 <= end; offset += 1) {
    if (bytes.readUInt32LE(offset) === signature) return true;
  }
  return false;
}

function rejectZip64Extra(bytes, offset, length, field) {
  const end = offset + length;
  assertRange(bytes, offset, length, field);
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error(`Workbook ZIP ${field} extra data is malformed.`);
    const headerId = bytes.readUInt16LE(cursor);
    const dataSize = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + dataSize > end) throw new Error(`Workbook ZIP ${field} extra data is malformed.`);
    if (headerId === 0x0001) throw new Error("Workbook ZIP64 extra data is forbidden.");
    cursor += dataSize;
  }
}

function decodePartName(bytes, flags) {
  if (!(flags & UTF8_FLAG) && bytes.some((value) => value >= 0x80)) {
    throw new Error("Workbook ZIP part names must be ASCII or explicitly UTF-8.");
  }
  try {
    return new TextDecoder(flags & UTF8_FLAG ? "utf-8" : "ascii", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Workbook ZIP part name is not valid text.");
  }
}

function validatePartName(rawName, budgets) {
  if (
    !rawName ||
    rawName !== rawName.normalize("NFC") ||
    rawName.includes("\\") ||
    rawName.startsWith("/") ||
    /^[A-Za-z]:/u.test(rawName) ||
    /[\u0000-\u001f\u007f]/u.test(rawName)
  ) {
    throw new Error(`Workbook ZIP part path is unsafe: ${rawName}`);
  }
  const directory = rawName.endsWith("/");
  const pathValue = directory ? rawName.slice(0, -1) : rawName;
  const segments = pathValue.split("/");
  if (
    !pathValue ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase()))
  ) {
    throw new Error(`Workbook ZIP part path is unsafe or contains .. traversal: ${rawName}`);
  }
  if (Array.from(rawName).length > budgets.partPathLength) {
    throw new Error(`Workbook ZIP part exceeds partPathLength budget ${budgets.partPathLength}: ${rawName}`);
  }
  if (segments.length > budgets.partPathDepth) {
    throw new Error(`Workbook ZIP part exceeds partPathDepth budget ${budgets.partPathDepth}: ${rawName}`);
  }
  return { directory, name: rawName, pathDepth: segments.length };
}

function isStructuralPart(name, directory) {
  return !directory && (name === "[Content_Types].xml" || STRUCTURAL_PART.test(name));
}

function parseCentralDirectory(bytes, budgets) {
  if (bytes.length > budgets.packageCompressedBytes) {
    throw new Error(`Workbook package exceeds packageCompressedBytes budget ${budgets.packageCompressedBytes}.`);
  }
  const eocdOffset = findEocd(bytes);
  const tailStart = Math.max(0, eocdOffset - 64);
  if (
    containsSignature(bytes, tailStart, eocdOffset, ZIP64_EOCD_SIGNATURE) ||
    containsSignature(bytes, tailStart, eocdOffset, ZIP64_LOCATOR_SIGNATURE)
  ) {
    throw new Error("Workbook ZIP64 records are forbidden.");
  }
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Workbook ZIP64 metadata is forbidden.");
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Workbook ZIP multi-disk archives are forbidden.");
  }
  if (entryCount < 1 || entryCount > budgets.partCount) {
    throw new Error(`Workbook ZIP exceeds partCount budget ${budgets.partCount}.`);
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error("Workbook ZIP central directory range is inconsistent with EOCD.");
  }
  assertRange(bytes, centralOffset, centralSize, "central directory");

  const entries = [];
  const pathKeys = new Set();
  let cursor = centralOffset;
  let totalUncompressedBytes = 0;
  let totalStructuralUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(bytes, cursor, 46, "central directory entry");
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("Workbook ZIP central directory entry signature is invalid.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, cursor, recordLength, "central directory entry");
    if (flags & ~ALLOWED_FLAGS || flags & 0x0001 || flags & 0x0040 || flags & 0x2000) {
      throw new Error("Workbook ZIP entry uses encrypted or unsupported flags.");
    }
    if (![0, 8].includes(method)) throw new Error(`Workbook ZIP compression method ${method} is unsupported.`);
    if (startDisk !== 0) throw new Error("Workbook ZIP multi-disk entries are forbidden.");
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error("Workbook ZIP64 entry metadata is forbidden.");
    }
    rejectZip64Extra(bytes, cursor + 46 + nameLength, extraLength, "central entry");
    const rawName = decodePartName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    const pathMetadata = validatePartName(rawName, budgets);
    const pathKey = rawName.toLowerCase();
    if (pathKeys.has(pathKey)) throw new Error(`Workbook ZIP contains a duplicate normalized part path: ${rawName}`);
    pathKeys.add(pathKey);
    if (compressedSize > budgets.partCompressedBytes) {
      throw new Error(`Workbook ZIP part exceeds partCompressedBytes budget ${budgets.partCompressedBytes}: ${rawName}`);
    }
    if (uncompressedSize > budgets.partUncompressedBytes) {
      throw new Error(`Workbook ZIP part exceeds partUncompressedBytes budget ${budgets.partUncompressedBytes}: ${rawName}`);
    }
    if (pathMetadata.directory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new Error(`Workbook ZIP directory entry must be empty: ${rawName}`);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`Workbook ZIP stored part has inconsistent sizes: ${rawName}`);
    }
    const structural = isStructuralPart(rawName, pathMetadata.directory);
    if (structural && uncompressedSize > budgets.structuralPartUncompressedBytes) {
      throw new Error(
        `Workbook ZIP part exceeds structuralPartUncompressedBytes budget ${budgets.structuralPartUncompressedBytes}: ${rawName}`,
      );
    }
    totalUncompressedBytes += uncompressedSize;
    if (structural) totalStructuralUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > budgets.totalUncompressedBytes) {
      throw new Error(`Workbook ZIP exceeds totalUncompressedBytes budget ${budgets.totalUncompressedBytes}.`);
    }
    if (totalStructuralUncompressedBytes > budgets.totalStructuralUncompressedBytes) {
      throw new Error(
        `Workbook ZIP exceeds totalStructuralUncompressedBytes budget ${budgets.totalStructuralUncompressedBytes}.`,
      );
    }
    entries.push({
      ...pathMetadata,
      compressedSize,
      crc32,
      flags,
      localOffset,
      method,
      structural,
      uncompressedSize,
    });
    cursor += recordLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error("Workbook ZIP central directory size does not match its entries.");
  }

  const localRanges = [];
  for (const entry of entries) {
    assertRange(bytes, entry.localOffset, 30, `local header for ${entry.name}`);
    if (bytes.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Workbook ZIP local header is invalid or outside bounds: ${entry.name}`);
    }
    const localFlags = bytes.readUInt16LE(entry.localOffset + 6);
    const localMethod = bytes.readUInt16LE(entry.localOffset + 8);
    const localCrc32 = bytes.readUInt32LE(entry.localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(entry.localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(entry.localOffset + 22);
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const localRecordLength = 30 + localNameLength + localExtraLength;
    assertRange(bytes, entry.localOffset, localRecordLength, `local header for ${entry.name}`);
    if (localFlags !== entry.flags) throw new Error(`Workbook ZIP local flags mismatch: ${entry.name}`);
    if (localMethod !== entry.method) throw new Error(`Workbook ZIP local compression method mismatch: ${entry.name}`);
    const localNameBytes = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
    const localName = decodePartName(localNameBytes, localFlags);
    if (localName !== entry.name) throw new Error(`Workbook ZIP local filename mismatch: ${entry.name}`);
    rejectZip64Extra(
      bytes,
      entry.localOffset + 30 + localNameLength,
      localExtraLength,
      `local header for ${entry.name}`,
    );
    if (localCrc32 === 0xffffffff || localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
      throw new Error("Workbook ZIP64 local metadata is forbidden.");
    }
    if (!(entry.flags & DATA_DESCRIPTOR_FLAG)) {
      if (
        localCrc32 !== entry.crc32 ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize
      ) {
        throw new Error(`Workbook ZIP local size or CRC metadata mismatch: ${entry.name}`);
      }
    } else if (
      ![0, entry.crc32].includes(localCrc32) ||
      ![0, entry.compressedSize].includes(localCompressedSize) ||
      ![0, entry.uncompressedSize].includes(localUncompressedSize)
    ) {
      throw new Error(`Workbook ZIP local descriptor placeholders are inconsistent: ${entry.name}`);
    }
    const dataOffset = entry.localOffset + localRecordLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > centralOffset) throw new Error(`Workbook ZIP local data is outside central directory bounds: ${entry.name}`);
    let rangeEnd = dataEnd;
    if (entry.flags & DATA_DESCRIPTOR_FLAG) {
      assertRange(bytes, dataEnd, 12, `data descriptor for ${entry.name}`);
      const hasSignature = bytes.readUInt32LE(dataEnd) === DATA_DESCRIPTOR_SIGNATURE;
      const descriptorOffset = dataEnd + (hasSignature ? 4 : 0);
      assertRange(bytes, descriptorOffset, 12, `data descriptor for ${entry.name}`);
      if (
        bytes.readUInt32LE(descriptorOffset) !== entry.crc32 ||
        bytes.readUInt32LE(descriptorOffset + 4) !== entry.compressedSize ||
        bytes.readUInt32LE(descriptorOffset + 8) !== entry.uncompressedSize
      ) {
        throw new Error(`Workbook ZIP data descriptor mismatch: ${entry.name}`);
      }
      rangeEnd = descriptorOffset + 12;
      if (rangeEnd > centralOffset) throw new Error(`Workbook ZIP data descriptor is out of bounds: ${entry.name}`);
    }
    entry.dataOffset = dataOffset;
    localRanges.push({ end: rangeEnd, name: entry.name, start: entry.localOffset });
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new Error(
        `Workbook ZIP local records overlap: ${localRanges[index - 1].name}, ${localRanges[index].name}`,
      );
    }
  }
  let expectedLocalOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedLocalOffset) {
      throw new Error(`Workbook ZIP has an uncovered preamble, gap, or orphan local record before: ${range.name}`);
    }
    expectedLocalOffset = range.end;
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new Error("Workbook ZIP has an uncovered gap or orphan local record before the central directory.");
  }

  return {
    centralOffset,
    centralSize,
    entries,
    totalStructuralUncompressedBytes,
    totalUncompressedBytes,
  };
}

function loadJSZip() {
  const loaded = loadBundledDependency("jszip");
  return loaded.default ?? loaded;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  crcTable ??= makeCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export async function openWorkbookSnapshot(stableSnapshot, options) {
  const stableState = requireStableState(stableSnapshot);
  const parsedOptions = parseOptions(options, ["budgets"], "Workbook snapshot options");
  const budgets = normalizeBudgets(parsedOptions.budgets);
  const packageMetadata = parseCentralDirectory(stableState.bytes, budgets);
  const JSZip = loadJSZip();
  let zip;
  try {
    zip = await JSZip.loadAsync(stableState.bytes, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new Error(`Workbook ZIP parser rejected the package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entryByName = new Map();
  for (const metadata of packageMetadata.entries) {
    const entry = zip.files[metadata.name];
    if (!entry || entry.name !== metadata.name || (entry.unsafeOriginalName && entry.unsafeOriginalName !== metadata.name)) {
      throw new Error(`Workbook ZIP parser changed or lost part identity: ${metadata.name}`);
    }
    entryByName.set(metadata.name, entry);
  }
  const expectedNames = new Set(packageMetadata.entries.map((entry) => entry.name));
  for (const name of Object.keys(zip.files)) {
    if (!expectedNames.has(name)) throw new Error(`Workbook ZIP parser exposed an unverified part: ${name}`);
  }

  const parts = Object.freeze(packageMetadata.entries.map((entry) => Object.freeze({
    name: entry.name,
    directory: entry.directory,
    pathDepth: entry.pathDepth,
    compressionMethod: entry.method,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    crc32: entry.crc32.toString(16).padStart(8, "0"),
    structural: entry.structural,
  })));
  const publicSnapshot = Object.freeze({
    kind: "workbook-snapshot-v1",
    path: stableSnapshot.path,
    canonicalPath: stableSnapshot.canonicalPath,
    size: stableSnapshot.size,
    sha256: stableSnapshot.sha256,
    budgets,
    package: Object.freeze({
      partCount: packageMetadata.entries.length,
      totalStructuralUncompressedBytes: packageMetadata.totalStructuralUncompressedBytes,
      totalUncompressedBytes: packageMetadata.totalUncompressedBytes,
    }),
    parts,
  });
  stableState.metrics.zipParseCount += 1;
  workbookStates.set(publicSnapshot, {
    budgets,
    cache: new Map(),
    metadataByName: new Map(packageMetadata.entries.map((entry) => [entry.name, entry])),
    metrics: stableState.metrics,
    packageBytes: stableState.bytes,
    promises: new Map(),
  });
  return publicSnapshot;
}

function publicStructuralPart(part) {
  return Object.freeze({
    name: part.name,
    bytes: Buffer.from(part.bytes),
    sha256: part.sha256,
  });
}

function boundedInflateError(partName, metadata, maxOutputLength, cause) {
  const error = new Error(
    `Workbook structural part is corrupt or exceeds its bounded decompression output: ${partName}`,
    { cause },
  );
  return attachDetails(error, "boundedInflateDetails", {
    compressedBytes: metadata.compressedSize,
    expectedUncompressedBytes: metadata.uncompressedSize,
    maxOutputLength,
    method: metadata.method,
    partName,
  });
}

async function inflateStructuralPart(state, metadata) {
  const remainingTotal = Math.max(
    0,
    state.budgets.totalStructuralUncompressedBytes - state.metrics.structuralBytesInflated,
  );
  const outputLimit = Math.min(
    metadata.uncompressedSize,
    state.budgets.structuralPartUncompressedBytes,
    remainingTotal,
  );
  const maxOutputLength = outputLimit + 1;
  const compressedBytes = state.packageBytes.subarray(
    metadata.dataOffset,
    metadata.dataOffset + metadata.compressedSize,
  );
  if (metadata.method === 0) {
    if (compressedBytes.length > outputLimit) {
      throw boundedInflateError(metadata.name, metadata, maxOutputLength);
    }
    return Buffer.from(compressedBytes);
  }
  try {
    return await inflateRaw(compressedBytes, { maxOutputLength });
  } catch (error) {
    throw boundedInflateError(metadata.name, metadata, maxOutputLength, error);
  }
}

export async function readSnapshotStructuralPart(workbookSnapshot, partName) {
  const state = requireWorkbookState(workbookSnapshot);
  if (typeof partName !== "string" || !partName) throw new Error("Structural part name must be a non-empty string.");
  const metadata = state.metadataByName.get(partName);
  if (!metadata || !metadata.structural) {
    throw new Error(`Workbook package part is not an allowed structural part: ${partName}`);
  }
  if (state.cache.has(partName)) {
    state.metrics.structuralCacheHits += 1;
    return publicStructuralPart(state.cache.get(partName));
  }
  if (state.promises.has(partName)) {
    state.metrics.structuralCacheHits += 1;
    return publicStructuralPart(await state.promises.get(partName));
  }

  const pending = (async () => {
    state.metrics.structuralDecompressCount += 1;
    state.metrics.activeStructuralDecompressions += 1;
    state.metrics.peakStructuralConcurrency = Math.max(
      state.metrics.peakStructuralConcurrency,
      state.metrics.activeStructuralDecompressions,
    );
    try {
      const bytes = await inflateStructuralPart(state, metadata);
      if (bytes.length !== metadata.uncompressedSize) {
        throw boundedInflateError(partName, metadata, Math.min(
          metadata.uncompressedSize,
          state.budgets.structuralPartUncompressedBytes,
          Math.max(0, state.budgets.totalStructuralUncompressedBytes - state.metrics.structuralBytesInflated),
        ) + 1);
      }
      if (bytes.length > state.budgets.structuralPartUncompressedBytes) {
        throw new Error(`Workbook structural part exceeds structuralPartUncompressedBytes after decompression: ${partName}`);
      }
      if (crc32(bytes) !== metadata.crc32) {
        throw new Error(`Workbook structural part CRC mismatch; package is corrupt: ${partName}`);
      }
      if (state.metrics.structuralBytesInflated + bytes.length > state.budgets.totalStructuralUncompressedBytes) {
        throw new Error("Workbook structural reads exceed totalStructuralUncompressedBytes after decompression.");
      }
      const part = Object.freeze({ name: partName, bytes, sha256: sha256Bytes(bytes) });
      state.metrics.hashCount += 1;
      state.metrics.structuralHashCount += 1;
      state.metrics.structuralBytesInflated += bytes.length;
      state.cache.set(partName, part);
      return part;
    } finally {
      state.metrics.activeStructuralDecompressions -= 1;
    }
  })();
  state.promises.set(partName, pending);
  return publicStructuralPart(await pending);
}

export async function readSnapshotStructuralParts(workbookSnapshot, partNames, options) {
  requireWorkbookState(workbookSnapshot);
  const parsedOptions = parseOptions(options, ["concurrency"], "Structural part read options");
  const concurrency = parsedOptions.concurrency ?? 3;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error("Structural part read concurrency must be an integer from 1 through 16.");
  }
  if (!Array.isArray(partNames) || partNames.length === 0) {
    throw new Error("Structural part names must be a non-empty array.");
  }
  const uniqueNames = [];
  const seen = new Set();
  for (const name of partNames) {
    if (typeof name !== "string" || !name) throw new Error("Structural part names must be non-empty strings.");
    if (!seen.has(name)) {
      seen.add(name);
      uniqueNames.push(name);
    }
  }
  const state = requireWorkbookState(workbookSnapshot);
  for (const name of uniqueNames) {
    if (!state.metadataByName.get(name)?.structural) {
      throw new Error(`Workbook package part is not an allowed structural part: ${name}`);
    }
  }
  const result = await mapSettledLimit(
    uniqueNames,
    concurrency,
    (name) => readSnapshotStructuralPart(workbookSnapshot, name),
  );
  return Object.freeze(result.settled.map((item) => item.value));
}

export function snapshotMetrics(snapshot) {
  const state = stableStates.get(snapshot) ?? workbookStates.get(snapshot);
  if (!state) throw new Error("A stable file or workbook snapshot is required for metrics.");
  return publicMetrics(state.metrics);
}
