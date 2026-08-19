import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { canonicalDigest, sha256Bytes } from "./workflow_primitives.mjs";

export { sha256Bytes };

/**
 * The parser version is part of every cache identity.  Bump it whenever the
 * bytes-to-metadata contract changes; an old parsed entry will then never be
 * returned for a new parser.
 */
export const EVIDENCE_CACHE_PARSER_VERSION = "evidence-cache-v1";
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_RESIDENT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_RETRIES = 1;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function asString(value) {
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || value === null) return null;
  return String(value);
}

function statIdentity(stat) {
  // mtimeNs/ctimeNs/birthtimeNs catch replacements that preserve size and
  // mtime.  dev+ino catch a rename-over replacement.  The fallbacks keep the
  // module usable on filesystems/runtimes without bigint stat fields.
  const mtimeNs = asString(stat.mtimeNs) ?? String(Math.trunc(Number(stat.mtimeMs ?? 0) * 1e6));
  const ctimeNs = asString(stat.ctimeNs) ?? String(Math.trunc(Number(stat.ctimeMs ?? 0) * 1e6));
  const birthtimeNs = asString(stat.birthtimeNs) ?? String(Math.trunc(Number(stat.birthtimeMs ?? 0) * 1e6));
  return Object.freeze({
    dev: asString(stat.dev),
    ino: asString(stat.ino),
    mode: asString(stat.mode),
    nlink: asString(stat.nlink),
    size: asString(stat.size),
    mtimeNs,
    ctimeNs,
    birthtimeNs,
  });
}

function identityKey(identity) {
  return [
    identity.dev,
    identity.ino,
    identity.mode,
    identity.nlink,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
    identity.birthtimeNs,
  ].map((value) => value ?? "").join(":");
}

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Evidence source path must be a non-empty string.");
  return path.resolve(filePath);
}

function syncCanonicalPath(filePath) {
  const resolved = normalizePath(filePath);
  try {
    return comparablePath(fs.realpathSync.native(resolved));
  } catch {
    return comparablePath(resolved);
  }
}

function syncCurrentIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) return null;
    return statIdentity(stat);
  } catch {
    return null;
  }
}

async function canonicalPath(filePath) {
  const resolved = normalizePath(filePath);
  return comparablePath(await fsp.realpath(resolved));
}

function safeSize(stat, maxBytes, label) {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new Error(`${label} exceeds maxBytes (${maxBytes}).`);
  }
  return size;
}

function assertPositiveDimension(width, height, field) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(`${field} image dimensions are invalid.`);
  }
}

/**
 * Parse image kind and dimensions without decoding or changing source bytes.
 * JPEG parsing intentionally accepts streams without an EOI marker because
 * several camera/export tools produce a readable SOF segment without FFD9.
 */
export function parseImageMetadata(bytes, field = "image") {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assertPositiveDimension(width, height, field);
    return { imageKind: "png", extension: "png", width, height };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xda) break;
      if (offset + 1 >= bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (JPEG_SOF_MARKERS.has(marker)) {
        if (segmentLength < 7) break;
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        assertPositiveDimension(width, height, field);
        return { imageKind: "jpeg", extension: "jpg", width, height };
      }
      offset += segmentLength;
    }
  }
  throw new Error(`${field} must be a PNG or JPEG image with readable dimensions.`);
}

function cleanExpectedSha(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw new Error("expectedSha256 must be a 64-character hexadecimal SHA256.");
  }
  return value.toLowerCase();
}

function cleanKind(value) {
  if (value === undefined || value === null) return "image";
  if (typeof value !== "string" || !value.trim()) throw new Error("Evidence kind must be a non-empty string.");
  return value.trim();
}

function cleanParserVersion(value, fallback) {
  const result = value ?? fallback;
  if (typeof result !== "string" || !result.trim()) throw new Error("parserVersion must be non-empty.");
  return result.trim();
}

function cloneIdentity(identity) {
  return identity ? { ...identity } : null;
}

function copyEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    bytes: Buffer.from(entry.bytes),
    identity: cloneIdentity(entry.identity),
    sourceIds: [...(entry.sourceIds ?? [])],
    aliases: [...(entry.aliases ?? [])],
  };
}

async function callHook(testHooks, name, context) {
  const hook = testHooks?.[name];
  if (hook !== undefined && typeof hook !== "function") throw new Error(`Evidence cache test hook ${name} must be a function.`);
  if (hook) await hook(context);
}

/**
 * In-memory evidence registry.  `readStable` performs one bounded read with
 * before/after identity checks.  All subsequent stages can call `get` or
 * `readStable` and receive defensive copies without another disk read.
 */
export class EvidenceCache {
  constructor({
    parserVersion = EVIDENCE_CACHE_PARSER_VERSION,
    maxBytes = DEFAULT_MAX_BYTES,
    maxResidentBytes = DEFAULT_MAX_RESIDENT_BYTES,
    maxRetries = DEFAULT_MAX_RETRIES,
    requireRetention = false,
  } = {}) {
    this.parserVersion = cleanParserVersion(parserVersion, EVIDENCE_CACHE_PARSER_VERSION);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive safe integer.");
    if (!Number.isSafeInteger(maxResidentBytes) || maxResidentBytes < 1) throw new Error("maxResidentBytes must be a positive safe integer.");
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative safe integer.");
    if (typeof requireRetention !== "boolean") throw new Error("requireRetention must be boolean.");
    this.maxBytes = maxBytes;
    this.maxResidentBytes = maxResidentBytes;
    this.maxRetries = maxRetries;
    this.requireRetention = requireRetention;

    // Composite key: realpath + kind + parserVersion + complete file identity.
    this.entries = new Map();
    this.pathIndex = new Map();
    this.pending = new Map();
    this.clock = 0;
    this.metrics = {
      reads: 0,
      bytesRead: 0,
      cacheHits: 0,
      parses: 0,
      retries: 0,
      invalidations: 0,
      evictions: 0,
      misses: 0,
      expectedShaMismatches: 0,
      expectedShaRereads: 0,
      residentBytes: 0,
    };
  }

  _requestKey(canonical, kind, parserVersion, identity) {
    return `${canonical}\u0000${kind}\u0000${parserVersion}\u0000${identityKey(identity)}`;
  }

  _indexEntry(entry) {
    let keys = this.pathIndex.get(entry.sourcePath);
    if (!keys) {
      keys = new Set();
      this.pathIndex.set(entry.sourcePath, keys);
    }
    keys.add(entry.key);
  }

  _unindexEntry(entry) {
    const keys = this.pathIndex.get(entry.sourcePath);
    if (!keys) return;
    keys.delete(entry.key);
    if (keys.size === 0) this.pathIndex.delete(entry.sourcePath);
  }

  _removeEntryByKey(key, { invalidation = true, eviction = false } = {}) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this._unindexEntry(entry);
    this.metrics.residentBytes -= entry.size;
    if (invalidation) this.metrics.invalidations += 1;
    if (eviction) this.metrics.evictions += 1;
    return true;
  }

  _removePathVariants(canonical, kind, parserVersion, keepKey = null) {
    const keys = [...(this.pathIndex.get(canonical) ?? [])];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || entry.kind !== kind || entry.parserVersion !== parserVersion || key === keepKey) continue;
      this._removeEntryByKey(key);
    }
  }

  _removeStaleIdentityVariants(canonical, identity) {
    const currentKey = identityKey(identity);
    const keys = [...(this.pathIndex.get(canonical) ?? [])];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry && identityKey(entry.identity) !== currentKey) this._removeEntryByKey(key);
    }
  }

  _touch(entry) {
    entry.lastUsed = ++this.clock;
  }

  _evictIfNeeded(protectedKey) {
    while (this.metrics.residentBytes > this.maxResidentBytes) {
      let oldest = null;
      for (const entry of this.entries.values()) {
        if (entry.key === protectedKey) continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (!oldest) break;
      this._removeEntryByKey(oldest.key, { invalidation: false, eviction: true });
    }
  }

  _storeEntry({
    sourcePath,
    requestedPath,
    identity,
    bytes,
    sourceSha256,
    sourceId = null,
    kind,
    parserVersion,
    image = null,
    parsed = false,
  }) {
    if (bytes.length > this.maxBytes) throw new Error(`Evidence source exceeds maxBytes (${this.maxBytes}): ${sourcePath}`);
    if (bytes.length > this.maxResidentBytes) {
      throw new Error(`Evidence cache resident byte limit exceeded (${this.maxResidentBytes}).`);
    }
    const key = this._requestKey(sourcePath, kind, parserVersion, identity);
    const old = this.entries.get(key);
    if (old) this._removeEntryByKey(key, { invalidation: false });
    // A path can only have one retained identity per parser/kind.  Removing
    // stale variants prevents a rename/replacement from pinning old bytes.
    this._removePathVariants(sourcePath, kind, parserVersion, key);
    if (this.requireRetention && this.metrics.residentBytes + bytes.length > this.maxResidentBytes) {
      throw new Error(`Evidence cache cannot retain all stage-shared bytes within maxResidentBytes (${this.maxResidentBytes}).`);
    }
    const oldAliases = old?.aliases ?? [];
    const aliases = new Set(oldAliases);
    aliases.add(requestedPath ?? sourcePath);
    aliases.add(sourcePath);
    const entry = {
      key,
      sourceId,
      sourceIds: sourceId === null || sourceId === undefined ? [] : [sourceId],
      sourcePath,
      sourceSha256,
      bytes,
      size: bytes.length,
      imageKind: image?.imageKind ?? null,
      extension: image?.extension ?? null,
      width: image?.width ?? null,
      height: image?.height ?? null,
      parsed: Boolean(parsed),
      parserVersion,
      kind,
      identity: { ...identity },
      aliases: [...aliases],
      lastUsed: ++this.clock,
    };
    this.entries.set(key, entry);
    this._indexEntry(entry);
    this.metrics.residentBytes += entry.size;
    this._evictIfNeeded(key);
    return entry;
  }

  _parseEntry(entry, sourceId = null) {
    if (entry.kind !== "image" || entry.parsed) return entry;
    const image = parseImageMetadata(entry.bytes, sourceId ?? entry.sourceId ?? path.basename(entry.sourcePath));
    entry.imageKind = image.imageKind;
    entry.extension = image.extension;
    entry.width = image.width;
    entry.height = image.height;
    entry.parsed = true;
    this.metrics.parses += 1;
    return entry;
  }

  async _inspect(canonical, label = "Evidence source") {
    const stat = await fsp.stat(canonical, { bigint: true });
    if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${canonical}`);
    const size = safeSize(stat, this.maxBytes, label);
    return { stat, size, identity: statIdentity(stat) };
  }

  async _readAttempt(canonical, requestedPath, kind, parserVersion, expectedSha256, options, before) {
    let handle;
    let bytes;
    let opened;
    try {
      handle = await fsp.open(canonical, "r");
      opened = await handle.stat({ bigint: true });
      const openedIdentity = statIdentity(opened);
      if (identityKey(openedIdentity) !== identityKey(before.identity)) {
        throw new Error(`Evidence source changed while being opened: ${canonical}`);
      }
      const expectedSize = safeSize(opened, options.maxBytes, "Evidence source");
      await callHook(options.testHooks, "afterOpen", { filePath: canonical, requestedPath, size: expectedSize });
      await callHook(options.testHooks, "beforeRead", { filePath: canonical, requestedPath, size: expectedSize });
      bytes = Buffer.allocUnsafe(expectedSize);
      let offset = 0;
      while (offset < expectedSize) {
        const result = await handle.read(bytes, offset, expectedSize - offset, offset);
        if (!result || result.bytesRead <= 0) throw new Error(`Evidence source was truncated while being read: ${canonical}`);
        offset += result.bytesRead;
        await callHook(options.testHooks, "onRead", {
          filePath: canonical,
          requestedPath,
          bytesRead: result.bytesRead,
          totalBytes: offset,
        });
      }
      // Probe one byte so growth during the bounded read is rejected without
      // allocating an unbounded buffer.
      const probe = Buffer.allocUnsafe(1);
      const extra = await handle.read(probe, 0, 1, expectedSize);
      if (extra?.bytesRead > 0) throw new Error(`Evidence source grew while being read: ${canonical}`);
      // The bounded byte read itself is a physical read even if the
      // subsequent identity check rejects the snapshot and triggers a retry.
      this.metrics.reads += 1;
      this.metrics.bytesRead += bytes.length;
      await callHook(options.testHooks, "afterRead", {
        filePath: canonical,
        requestedPath,
        size: bytes.length,
        bytes: Buffer.from(bytes),
      });
      const afterHandle = await handle.stat({ bigint: true });
      const afterIdentity = statIdentity(afterHandle);
      if (identityKey(afterIdentity) !== identityKey(openedIdentity) || bytes.length !== Number(afterIdentity.size)) {
        throw new Error(`Evidence source changed while being read: ${canonical}`);
      }
      await callHook(options.testHooks, "beforePathCheck", { filePath: canonical, requestedPath });
      let afterCanonical;
      try {
        afterCanonical = await canonicalPath(requestedPath);
      } catch {
        throw new Error(`Evidence source realpath changed after read: ${requestedPath}`);
      }
      if (afterCanonical !== canonical) {
        throw new Error(`Evidence source realpath changed after read: ${canonical}`);
      }
      const afterPath = await this._inspect(canonical);
      if (identityKey(afterPath.identity) !== identityKey(before.identity)) {
        throw new Error(`Evidence source path identity changed after read: ${canonical}`);
      }
      const hash = sha256Bytes(bytes);
      if (expectedSha256 && hash !== expectedSha256) {
        this.metrics.expectedShaMismatches += 1;
        throw new Error(`SHA256 mismatch for ${canonical}: expected ${expectedSha256}, actual ${hash}; SHA256 does not match expected value.`);
      }
      const parseRequested = options.parse !== false && kind === "image";
      const image = parseRequested
        ? parseImageMetadata(bytes, options.sourceId ?? path.basename(requestedPath ?? canonical))
        : null;
      if (image) this.metrics.parses += 1;
      return this._storeEntry({
        sourcePath: canonical,
        requestedPath,
        identity: before.identity,
        bytes,
        sourceSha256: hash,
        sourceId: options.sourceId ?? null,
        kind,
        parserVersion,
        image,
        parsed: Boolean(image),
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  /**
   * Read one source with pre/post stability checks.  A cache hit trusts the
   * complete file identity (including ctime/birthtime), so normal repeated
   * stages do not touch the source again while same-size/same-mtime replaces
   * are detected by inode/ctime changes.
   */
  async readStable(filePath, {
    sourceId = null,
    kind = "image",
    parserVersion = this.parserVersion,
    expectedSha256 = null,
    maxBytes = this.maxBytes,
    maxRetries = this.maxRetries,
    parse = true,
    forceRead = false,
    keepExistingOnFailure = false,
    testHooks,
  } = {}) {
    const requestedPath = normalizePath(filePath);
    const canonical = await canonicalPath(requestedPath);
    kind = cleanKind(kind);
    parserVersion = cleanParserVersion(parserVersion, this.parserVersion);
    expectedSha256 = cleanExpectedSha(expectedSha256);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive safe integer.");
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative safe integer.");
    const before = await this._inspect(canonical);
    this._removeStaleIdentityVariants(canonical, before.identity);
    let candidate = this.entries.get(this._requestKey(canonical, kind, parserVersion, before.identity));
    if (candidate && !forceRead) {
      if (expectedSha256 && candidate.sourceSha256 !== expectedSha256) {
        if (!keepExistingOnFailure) this._removeEntryByKey(candidate.key);
        this.metrics.expectedShaRereads += 1;
        candidate = null;
      } else {
        if (parse && kind === "image") this._parseEntry(candidate, sourceId);
        if (sourceId !== null && sourceId !== undefined && !candidate.sourceIds?.includes(sourceId)) {
          candidate.sourceIds = [...(candidate.sourceIds ?? []), sourceId];
        }
        candidate.aliases = [...new Set([...(candidate.aliases ?? []), requestedPath])];
        this._touch(candidate);
        this.metrics.cacheHits += 1;
        const hit = copyEntry(candidate);
        if (sourceId !== null && sourceId !== undefined) hit.sourceId = sourceId;
        return hit;
      }
    }
    // Do not leave an old identity addressable through get() while a
    // replacement is being read.  This is important when a same-size file is
    // swapped in between stages and the replacement read later fails its
    // expected SHA check.
    if (!keepExistingOnFailure) this._removePathVariants(canonical, kind, parserVersion);
    const pendingKey = this._requestKey(canonical, kind, parserVersion, before.identity);
    const pending = this.pending.get(pendingKey);
    if (pending && !forceRead) {
      let entry;
      try {
        entry = await pending;
      } catch (error) {
        if (expectedSha256 && /SHA256 mismatch/iu.test(error?.message ?? "")) {
          this.metrics.expectedShaRereads += 1;
          return this.readStable(requestedPath, {
            sourceId,
            kind,
            parserVersion,
            expectedSha256,
            maxBytes,
            maxRetries: Math.max(0, maxRetries - 1),
            parse,
            forceRead: true,
            keepExistingOnFailure: true,
            testHooks,
          });
        }
        throw error;
      }
      if (expectedSha256 && entry.sourceSha256 !== expectedSha256) {
        // A concurrent read may have been made for a different manifest
        // revision.  Do not poison that caller's promise; refresh this
        // caller independently so an expected-SHA miss always performs a
        // real reread before failing.
        this.metrics.expectedShaRereads += 1;
        return this.readStable(requestedPath, {
          sourceId,
          kind,
          parserVersion,
          expectedSha256,
          maxBytes,
          maxRetries: Math.max(0, maxRetries - 1),
          parse,
          forceRead: true,
          keepExistingOnFailure: true,
          testHooks,
        });
      }
      if (parse && kind === "image") this._parseEntry(entry, sourceId);
      if (sourceId !== null && sourceId !== undefined && !entry.sourceIds?.includes(sourceId)) {
        entry.sourceIds = [...(entry.sourceIds ?? []), sourceId];
      }
      this._touch(entry);
      this.metrics.cacheHits += 1;
      const hit = copyEntry(entry);
      if (sourceId !== null && sourceId !== undefined) hit.sourceId = sourceId;
      return hit;
    }
    this.metrics.misses += 1;

    const options = { sourceId, maxBytes, maxRetries, parse, testHooks };
    const operation = (async () => {
      let attempt = 0;
      while (true) {
        try {
          // Re-stat before each retry.  This both refreshes identity and makes
          // a replacement during a prior attempt start from the new file.
          const attemptCanonical = attempt === 0 ? canonical : await canonicalPath(requestedPath);
          const freshBefore = attempt === 0 ? before : await this._inspect(attemptCanonical);
          return await this._readAttempt(attemptCanonical, requestedPath, kind, parserVersion, expectedSha256, options, freshBefore);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const unstable = /changed while|grew while|truncated while|path identity changed|realpath changed/iu.test(message);
          if (!unstable || attempt >= maxRetries) throw error;
          attempt += 1;
          this.metrics.retries += 1;
        }
      }
    })();
    this.pending.set(pendingKey, operation);
    try {
      return copyEntry(await operation);
    } finally {
      if (this.pending.get(pendingKey) === operation) this.pending.delete(pendingKey);
    }
  }

  get(filePath, { kind, parserVersion = this.parserVersion, parse = true, sourceId = null } = {}) {
    const requestedPath = normalizePath(filePath);
    const canonical = syncCanonicalPath(filePath);
    const currentIdentity = syncCurrentIdentity(canonical);
    const candidates = [...(this.pathIndex.get(canonical) ?? [])]
      .map((key) => this.entries.get(key))
      .filter(Boolean)
      .filter((entry) => kind === undefined || kind === null || entry.kind === kind)
      .filter((entry) => parserVersion === undefined || parserVersion === null || entry.parserVersion === parserVersion)
      .filter((entry) => sourceId === null || sourceId === undefined || entry.sourceId === sourceId || (entry.sourceIds ?? []).includes(sourceId))
      .filter((entry) => !currentIdentity || identityKey(entry.identity) === identityKey(currentIdentity))
      .sort((left, right) => right.lastUsed - left.lastUsed);
    let entry = candidates[0] ?? null;
    if (!entry && sourceId !== null && sourceId !== undefined) {
      entry = [...this.entries.values()].find((item) => (item.sourceId === sourceId || (item.sourceIds ?? []).includes(sourceId))
        && (kind === undefined || item.kind === kind)
        && (parserVersion === undefined || parserVersion === null || item.parserVersion === parserVersion)
        && (!currentIdentity || identityKey(item.identity) === identityKey(currentIdentity))) ?? null;
    }
    if (!entry) return null;
    if (parse && entry.kind === "image") this._parseEntry(entry, sourceId);
    if (!entry.aliases?.includes(requestedPath)) entry.aliases = [...(entry.aliases ?? []), requestedPath];
    this._touch(entry);
    return copyEntry(entry);
  }

  invalidate(filePath, { kind, parserVersion, sourceId } = {}) {
    const canonical = syncCanonicalPath(filePath);
    const keys = [...(this.pathIndex.get(canonical) ?? [])];
    let removed = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (kind !== undefined && kind !== null && entry.kind !== kind) continue;
      if (parserVersion !== undefined && parserVersion !== null && entry.parserVersion !== parserVersion) continue;
      if (sourceId !== undefined && entry.sourceId !== sourceId && !(entry.sourceIds ?? []).includes(sourceId)) continue;
      if (this._removeEntryByKey(key)) removed += 1;
    }
    return removed > 0;
  }

  stats() {
    return {
      ...this.metrics,
      entries: this.entries.size,
      pending: this.pending.size,
      aliases: [...this.entries.values()].reduce((total, entry) => total + (entry.aliases?.length ?? 0), 0),
      maxBytes: this.maxBytes,
      maxResidentBytes: this.maxResidentBytes,
      maxRetries: this.maxRetries,
      requireRetention: this.requireRetention,
    };
  }

  /** Metadata-only, JSON-safe snapshot.  Source bytes are intentionally omitted. */
  snapshot() {
    return {
      parserVersion: this.parserVersion,
      maxBytes: this.maxBytes,
      maxResidentBytes: this.maxResidentBytes,
      maxRetries: this.maxRetries,
      entries: [...this.entries.values()].sort((left, right) => left.key.localeCompare(right.key)).map((entry) => {
        const { bytes, ...metadata } = entry;
        return {
          ...metadata,
          identity: cloneIdentity(entry.identity),
          sourceIds: [...(entry.sourceIds ?? [])].sort(),
          aliases: [...(entry.aliases ?? [])].sort(),
        };
      }),
      metrics: this.stats(),
    };
  }
}

/**
 * Compute precise downstream invalidation after a manifest revision.  A
 * changed source file invalidates only transactions that reference it; a
 * changed transaction fact invalidates that transaction even when evidence is
 * unchanged (for example, a user classification correction).
 */
export function diffEvidenceDependencies(previousManifest, nextManifest) {
  const previousFiles = new Map((previousManifest?.files ?? []).map((item) => [item.id, item]));
  const nextFiles = new Map((nextManifest?.files ?? []).map((item) => [item.id, item]));
  const changedEvidenceIds = new Set();
  for (const id of new Set([...previousFiles.keys(), ...nextFiles.keys()])) {
    const before = previousFiles.get(id);
    const after = nextFiles.get(id);
    if (!before || !after || canonicalDigest(before) !== canonicalDigest(after)) changedEvidenceIds.add(id);
  }
  const previousTransactions = new Map((previousManifest?.transactions ?? []).map((item) => [item.id, item]));
  const nextTransactions = new Map((nextManifest?.transactions ?? []).map((item) => [item.id, item]));
  const changedTransactionIds = new Set();
  for (const id of new Set([...previousTransactions.keys(), ...nextTransactions.keys()])) {
    const before = previousTransactions.get(id);
    const after = nextTransactions.get(id);
    if (!before || !after) {
      changedTransactionIds.add(id);
      continue;
    }
    const beforeFacts = { ...before, evidence: [...(before.evidence ?? [])].sort() };
    const afterFacts = { ...after, evidence: [...(after.evidence ?? [])].sort() };
    if (canonicalDigest(beforeFacts) !== canonicalDigest(afterFacts)) changedTransactionIds.add(id);
    if ((after.evidence ?? []).some((evidenceId) => changedEvidenceIds.has(evidenceId))) changedTransactionIds.add(id);
  }
  const stages = new Set();
  if (changedEvidenceIds.size > 0) {
    stages.add("evidence-scan");
    stages.add("artifact-build");
    stages.add("archive");
    stages.add("preview");
  } else if (changedTransactionIds.size > 0) {
    stages.add("artifact-build");
    stages.add("preview");
  }
  return {
    changedEvidenceIds: [...changedEvidenceIds].sort(),
    changedTransactionIds: [...changedTransactionIds].sort(),
    invalidatedStages: [...stages],
  };
}
