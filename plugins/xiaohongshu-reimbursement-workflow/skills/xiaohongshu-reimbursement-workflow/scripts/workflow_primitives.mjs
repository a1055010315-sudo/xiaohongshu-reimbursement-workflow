import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline as runStreamPipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const BUNDLED_DEPENDENCY_ALLOWLIST = new Set(["jszip", "sax", "sharp"]);
const bundledDependencyCache = new Map();
const BUNDLED_ESM_DEPENDENCY_ALLOWLIST = new Map([
  ["pdfjs-dist", "legacy/build/pdf.mjs"],
]);
const bundledEsmDependencyCache = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function sha256Bytes(bytes) {
  if (typeof bytes !== "string" && !(bytes instanceof Uint8Array)) {
    throw new Error("SHA-256 input must be a string or Uint8Array.");
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value) {
  return sha256Bytes(JSON.stringify(canonicalize(value)));
}

export const DEFAULT_STABLE_JSON_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_STABLE_BINARY_BYTES = 100 * 1024 * 1024;

const DEFAULT_STABLE_JSON_CHUNK_BYTES = 64 * 1024;
const DEFAULT_JSON_MAX_DEPTH = 128;
const JSON_WHITESPACE_CODES = new Set([0x20, 0x09, 0x0a, 0x0d]);
const READ_ONLY_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const stableBinaryBytes = new WeakMap();

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export function parseStrictJson(text, { maxDepth = DEFAULT_JSON_MAX_DEPTH } = {}) {
  if (typeof text !== "string") throw new Error("Strict JSON input must be a string.");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error("Strict JSON maximum nesting depth must be a positive safe integer.");
  }

  let offset = 0;
  const failAt = (message) => {
    throw new Error(`Strict JSON ${message} at offset ${offset}.`);
  };
  const skipWhitespace = () => {
    while (JSON_WHITESPACE_CODES.has(text.charCodeAt(offset))) offset += 1;
  };
  const parseString = () => {
    const start = offset;
    if (text[offset] !== '"') failAt("expected a string");
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset));
        } catch (error) {
          failAt("contains an invalid string");
        }
      }
      if (code < 0x20) failAt("contains an unescaped control character");
      if (code !== 0x5c) {
        offset += 1;
        continue;
      }
      offset += 1;
      const escape = text[offset];
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) {
          failAt("contains an invalid Unicode escape");
        }
        offset += 5;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape ?? "")) failAt("contains an invalid escape");
      offset += 1;
    }
    failAt("contains an unterminated string");
  };
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset));
    if (!match) failAt("contains an invalid value");
    offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) failAt("contains a non-finite number");
    return value;
  };
  const parseValue = (depth = 0) => {
    if (depth > maxDepth) failAt("exceeds the maximum nesting depth");
    skipWhitespace();
    if (text[offset] === '"') return parseString();
    if (text[offset] === "{") {
      offset += 1;
      skipWhitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) failAt(`contains duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") failAt("expected ':' after an object key");
        offset += 1;
        const value = parseValue(depth + 1);
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") failAt("expected ',' or '}' in an object");
        offset += 1;
      }
      failAt("contains an unterminated object");
    }
    if (text[offset] === "[") {
      offset += 1;
      skipWhitespace();
      const result = [];
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        result.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") failAt("expected ',' or ']' in an array");
        offset += 1;
      }
      failAt("contains an unterminated array");
    }
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return value;
      }
    }
    return parseNumber();
  };

  const value = parseValue();
  skipWhitespace();
  if (offset !== text.length) failAt("contains trailing content");
  return value;
}

function statToken(value) {
  return typeof value === "bigint" ? value.toString() : String(value ?? "");
}

function fileFingerprint(stats) {
  return Object.freeze({
    dev: statToken(stats.dev),
    ino: statToken(stats.ino),
    size: statToken(stats.size),
    mode: statToken(stats.mode & 0o170000),
    mtimeNs: statToken(stats.mtimeNs ?? stats.mtimeMs),
    ctimeNs: statToken(stats.ctimeNs ?? stats.ctimeMs),
    birthtimeNs: statToken(stats.birthtimeNs ?? stats.birthtimeMs),
  });
}

function sameFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stableInputError(message, cause, label = "Stable JSON input") {
  return new Error(`${label} ${message}.`, cause ? { cause } : undefined);
}

async function inspectRegularPath(filePath, label) {
  const parsed = path.parse(filePath);
  const relative = path.relative(parsed.root, filePath);
  let current = parsed.root;
  const componentPaths = [];
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    componentPaths.push(current);
  }
  const componentResults = [];
  for (let offset = 0; offset < componentPaths.length; offset += 2) {
    componentResults.push(...await Promise.allSettled(componentPaths.slice(offset, offset + 2).map((componentPath) => fs.lstat(componentPath))));
  }
  const componentFailure = componentResults.find((result) => result.status === "rejected");
  if (componentFailure) throw stableInputError("could not inspect the input path", componentFailure.reason, label);
  for (const result of componentResults) {
    const componentStats = result.value;
    if (componentStats.isSymbolicLink()) {
      throw stableInputError("must not traverse a symbolic link or reparse point", undefined, label);
    }
  }
  const [linkResult, canonicalResult] = await Promise.allSettled([fs.lstat(filePath), fs.realpath(filePath)]);
  if (linkResult.status === "rejected") throw stableInputError("could not inspect the input path", linkResult.reason, label);
  const linkStats = linkResult.value;
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw stableInputError("must be a non-symlink regular file", undefined, label);
  }
  if (canonicalResult.status === "rejected") throw stableInputError("could not resolve the input path", canonicalResult.reason, label);
  const canonicalPath = canonicalResult.value;
  if (comparablePath(canonicalPath) !== comparablePath(filePath)) {
    throw stableInputError("canonical path differs from the requested path", undefined, label);
  }
  return Object.freeze({
    canonicalPath: comparablePath(canonicalPath),
    fingerprint: fileFingerprint(linkStats),
  });
}

function safeSize(stats, maxBytes, label) {
  const rawSize = stats.size;
  const size = typeof rawSize === "bigint" ? Number(rawSize) : rawSize;
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw stableInputError(`exceeds the ${maxBytes}-byte limit`, undefined, label);
  }
  return size;
}

async function callTestHook(testHooks, name, context) {
  const hook = testHooks?.[name];
  if (hook !== undefined && typeof hook !== "function") {
    throw new Error(`Stable JSON test hook ${name} must be a function.`);
  }
  if (hook) await hook(context);
}

async function readBoundedHandle(handle, expectedSize, { maxBytes, chunkSize, testHooks, phase, inputLabel, compareBytes = null }) {
  if (expectedSize > maxBytes) throw stableInputError(`exceeds the ${maxBytes}-byte limit`, undefined, inputLabel);
  if (compareBytes !== null && (!(compareBytes instanceof Uint8Array) || compareBytes.byteLength !== expectedSize)) {
    throw stableInputError("changed between stable reads", undefined, inputLabel);
  }
  const retainedBytes = compareBytes === null ? Buffer.allocUnsafe(expectedSize) : null;
  const scratch = compareBytes === null ? null : Buffer.allocUnsafe(Math.max(1, Math.min(chunkSize, expectedSize || 1)));
  const digest = crypto.createHash("sha256");
  let totalBytes = 0;
  const reportRead = async (bytesRead) => {
    totalBytes += bytesRead;
    if (totalBytes > maxBytes + 1) throw stableInputError("read exceeded its bounded limit", undefined, inputLabel);
    await callTestHook(testHooks, "onRead", { phase, bytesRead, totalBytes });
  };

  while (totalBytes < expectedSize) {
    const requestSize = Math.min(chunkSize, expectedSize - totalBytes, maxBytes + 1 - totalBytes);
    const readOffset = totalBytes;
    const buffer = retainedBytes ?? scratch;
    const bufferOffset = retainedBytes ? readOffset : 0;
    const result = await handle.read(buffer, bufferOffset, requestSize, readOffset);
    if (!result || result.bytesRead <= 0) throw stableInputError("was truncated during read", undefined, inputLabel);
    if (result.bytesRead > requestSize) throw stableInputError("returned an invalid read length", undefined, inputLabel);
    const chunk = buffer.subarray(bufferOffset, bufferOffset + result.bytesRead);
    digest.update(chunk);
    if (compareBytes !== null && !chunk.equals(compareBytes.subarray(readOffset, readOffset + result.bytesRead))) {
      throw stableInputError("changed between stable reads", undefined, inputLabel);
    }
    await reportRead(result.bytesRead);
  }

  const probe = Buffer.allocUnsafe(1);
  const extra = await handle.read(probe, 0, 1, totalBytes);
  if (extra?.bytesRead > 0) {
    await reportRead(extra.bytesRead);
    throw stableInputError("grew during bounded read", undefined, inputLabel);
  }
  return Object.freeze({ bytes: retainedBytes, sha256: digest.digest("hex") });
}

async function readStablePhase(filePath, phase, options) {
  const before = await inspectRegularPath(filePath, options.inputLabel);
  let handle;
  try {
    handle = await fs.open(filePath, READ_ONLY_FLAGS);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw stableInputError("handle is not a regular file", undefined, options.inputLabel);
    const openedFingerprint = fileFingerprint(openedStats);
    if (before.canonicalPath !== comparablePath(await fs.realpath(filePath))
      || !sameFingerprint(before.fingerprint, openedFingerprint)) {
      throw stableInputError("changed while opening", undefined, options.inputLabel);
    }
    const expectedSize = safeSize(openedStats, options.maxBytes, options.inputLabel);
    await callTestHook(options.testHooks, "afterOpen", { phase, filePath });
    const content = await readBoundedHandle(handle, expectedSize, { ...options, phase });
    const afterStats = await handle.stat();
    if (!sameFingerprint(openedFingerprint, fileFingerprint(afterStats))) {
      throw stableInputError("changed while being read", undefined, options.inputLabel);
    }
    return Object.freeze({
      bytes: content.bytes,
      sha256: content.sha256,
      size: expectedSize,
      canonicalPath: before.canonicalPath,
      fingerprint: openedFingerprint,
      inputLabel: options.inputLabel,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${options.inputLabel} `)) throw error;
    throw stableInputError("could not be read", error, options.inputLabel);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertStablePathCurrent(filePath, expected) {
  const label = expected.inputLabel ?? "Stable JSON input";
  const current = await inspectRegularPath(filePath, label);
  if (current.canonicalPath !== expected.canonicalPath || !sameFingerprint(current.fingerprint, expected.fingerprint)) {
    throw stableInputError("path identity changed after read", undefined, label);
  }
}

export async function readStableUtf8JsonFile(filePath, {
  maxBytes = DEFAULT_STABLE_JSON_MAX_BYTES,
  maxDepth = DEFAULT_JSON_MAX_DEPTH,
  chunkSize = DEFAULT_STABLE_JSON_CHUNK_BYTES,
  testHooks,
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Stable JSON file path must be a non-empty string.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Stable JSON maximum byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Stable JSON chunk size must be a positive safe integer.");
  }
  const absolutePath = path.resolve(filePath);
  const options = { maxBytes, maxDepth, chunkSize, testHooks, inputLabel: "Stable JSON input" };
  const initial = await readStablePhase(absolutePath, "initial", options);
  await callTestHook(testHooks, "afterInitialRead", { filePath: absolutePath, size: initial.size });
  await assertStablePathCurrent(absolutePath, initial);
  await callTestHook(testHooks, "beforeFreshRead", { filePath: absolutePath });
  const fresh = await readStablePhase(absolutePath, "fresh", { ...options, compareBytes: initial.bytes });
  if (
    fresh.canonicalPath !== initial.canonicalPath
    || !sameFingerprint(fresh.fingerprint, initial.fingerprint)
    || fresh.size !== initial.size
    || fresh.sha256 !== initial.sha256
  ) {
    throw stableInputError("changed between stable reads");
  }
  await assertStablePathCurrent(absolutePath, initial);

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(initial.bytes);
  } catch (error) {
    throw stableInputError("must be valid UTF-8", error);
  }
  const value = deepFreeze(parseStrictJson(text, { maxDepth }));
  return Object.freeze({
    value,
    size: initial.size,
    sha256: initial.sha256,
  });
}

export async function readStableBinaryFile(filePath, {
  maxBytes = MAX_STABLE_BINARY_BYTES,
  chunkSize = DEFAULT_STABLE_JSON_CHUNK_BYTES,
  testHooks,
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new Error("Stable binary file path must be a non-empty string.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STABLE_BINARY_BYTES) {
    throw new Error("Stable binary maximum byte limit must be a positive safe integer at most 100 MiB.");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Stable binary chunk size must be a positive safe integer.");
  }
  const absolutePath = path.resolve(filePath);
  const options = { maxBytes, chunkSize, testHooks, inputLabel: "Stable binary input" };
  const initial = await readStablePhase(absolutePath, "initial", options);
  await callTestHook(testHooks, "afterInitialRead", { filePath: absolutePath, size: initial.size });
  await assertStablePathCurrent(absolutePath, initial);
  await callTestHook(testHooks, "beforeFreshRead", { filePath: absolutePath });
  const fresh = await readStablePhase(absolutePath, "fresh", { ...options, compareBytes: initial.bytes });
  const initialSha256 = initial.sha256;
  if (
    fresh.canonicalPath !== initial.canonicalPath
    || !sameFingerprint(fresh.fingerprint, initial.fingerprint)
    || fresh.size !== initial.size
    || fresh.sha256 !== initialSha256
  ) {
    throw stableInputError("changed between stable reads", undefined, options.inputLabel);
  }
  await assertStablePathCurrent(absolutePath, initial);
  const snapshot = Object.freeze({
    kind: "stable-binary-file-v1",
    size: initial.size,
    sha256: initialSha256,
  });
  stableBinaryBytes.set(snapshot, initial.bytes);
  return snapshot;
}

export function copyStableBinaryBytes(snapshot) {
  const bytes = snapshot && stableBinaryBytes.get(snapshot);
  if (!bytes) throw new Error("A branded stable binary file snapshot is required.");
  return Buffer.from(bytes);
}

export function loadBundledDependency(packageName) {
  if (!BUNDLED_DEPENDENCY_ALLOWLIST.has(packageName)) {
    throw new Error(`Bundled dependency is not allowlisted: ${packageName}`);
  }
  if (bundledDependencyCache.has(packageName)) return bundledDependencyCache.get(packageName);

  const runtimeRoot = path.resolve(path.dirname(process.execPath), "..");
  let runtimeModules;
  try {
    runtimeModules = realpathSync(path.join(runtimeRoot, "node_modules"));
  } catch (error) {
    throw new Error("Bundled runtime dependency root is unavailable.", { cause: error });
  }
  const require = createRequire(path.join(runtimeRoot, "__codex_bundled_runtime__.cjs"));
  let resolved;
  try {
    resolved = realpathSync(require.resolve(packageName));
  } catch (error) {
    throw new Error(
      `${packageName} is unavailable; run with the bundled Node runtime and workspace dependencies.`,
      { cause: error },
    );
  }
  const relative = path.relative(runtimeModules, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${packageName} did not resolve from the fixed bundled runtime dependency root.`);
  }
  const loaded = require(resolved);
  bundledDependencyCache.set(packageName, loaded);
  return loaded;
}

export async function inspectFullyDecodedImageBytes(bytes, {
  failOn = "error",
  limitInputPixels = 100_000_000,
  autoOrient = false,
} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw new Error("Full image decode requires non-empty bytes.");
  }
  if (!new Set(["none", "truncated", "error", "warning"]).has(failOn)) {
    throw new Error("Full image decode failOn mode is invalid.");
  }
  if (!Number.isSafeInteger(limitInputPixels) || limitInputPixels < 1) {
    throw new Error("Full image decode pixel limit must be a positive safe integer.");
  }
  const SharpModule = loadBundledDependency("sharp");
  const sharp = SharpModule.default ?? SharpModule;
  const input = sharp(bytes, { failOn, limitInputPixels });
  const decoder = (autoOrient ? input.rotate() : input).raw();
  let info;
  let decodedBytes = 0;
  const captureInfo = (value) => { info = value; };
  decoder.once("info", captureInfo);
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      decodedBytes += chunk.length;
      callback();
    },
  });
  // Node's pipeline owns teardown of both the Sharp decoder and the sink on
  // error or premature close, so a damaged image cannot leave a native
  // decoder or dangling listener behind before the next validation.
  try {
    await runStreamPipeline(decoder, sink);
  } finally {
    decoder.off("info", captureInfo);
  }
  const width = info?.width;
  const height = info?.height;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || !Number.isSafeInteger(info?.channels)
    || info.channels < 1
    || !Number.isSafeInteger(info?.size)
    || info.size < 1
    || decodedBytes !== info.size
  ) {
    throw new Error("Full image decode did not stream complete pixels and dimensions.");
  }
  return Object.freeze({ width, height });
}

function bundledRuntimeDependencyRoots() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.resolve(executableDirectory, "..", "node_modules"),
    path.resolve(executableDirectory, "node_modules"),
  ];
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let canonical;
    try {
      canonical = realpathSync(candidate);
    } catch {
      continue;
    }
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(canonical);
    }
  }
  if (roots.length === 0) throw new Error("Bundled runtime dependency root is unavailable.");
  return roots;
}

function resolveBundledEsmDependency(packageName, moduleRelativePath) {
  const failures = [];
  for (const modulesRoot of bundledRuntimeDependencyRoots()) {
    const require = createRequire(path.join(path.dirname(modulesRoot), "__codex_bundled_runtime__.cjs"));
    try {
      const packageJson = realpathSync(require.resolve(`${packageName}/package.json`));
      const packageRelative = path.relative(modulesRoot, packageJson);
      if (!packageRelative || packageRelative === ".." || packageRelative.startsWith(`..${path.sep}`) || path.isAbsolute(packageRelative)) {
        throw new Error(`${packageName} package metadata escaped the fixed bundled runtime dependency root.`);
      }
      const packageRoot = realpathSync(path.dirname(packageJson));
      const resolvedModule = realpathSync(path.join(packageRoot, ...moduleRelativePath.split("/")));
      const moduleRelative = path.relative(packageRoot, resolvedModule);
      if (!moduleRelative || moduleRelative === ".." || moduleRelative.startsWith(`..${path.sep}`) || path.isAbsolute(moduleRelative)) {
        throw new Error(`${packageName} module escaped its bundled package root.`);
      }
      if (moduleRelative.split(path.sep).join("/") !== moduleRelativePath) {
        throw new Error(`${packageName} module did not resolve to its allowlisted bundled path.`);
      }
      return resolvedModule;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new Error(
    `${packageName} is unavailable; run with a bundled Node runtime that provides the allowlisted workspace dependency.`,
    { cause: failures.at(-1) },
  );
}

export async function importBundledDependency(packageName) {
  const moduleRelativePath = BUNDLED_ESM_DEPENDENCY_ALLOWLIST.get(packageName);
  if (!moduleRelativePath) throw new Error(`Bundled ESM dependency is not allowlisted: ${packageName}`);
  if (bundledEsmDependencyCache.has(packageName)) return bundledEsmDependencyCache.get(packageName);
  const loading = (async () => {
    const resolvedModule = resolveBundledEsmDependency(packageName, moduleRelativePath);
    return import(pathToFileURL(resolvedModule).href);
  })();
  bundledEsmDependencyCache.set(packageName, loading);
  try {
    return await loading;
  } catch (error) {
    bundledEsmDependencyCache.delete(packageName);
    throw error;
  }
}

export async function mapSettledLimit(items, limit, worker) {
  if (!Array.isArray(items)) throw new Error("mapSettledLimit items must be an array.");
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("mapSettledLimit limit must be a positive safe integer.");
  }
  if (typeof worker !== "function") throw new Error("mapSettledLimit worker must be a function.");

  const settled = new Array(items.length);
  let nextIndex = 0;
  let startedCount = 0;
  let stopped = false;
  let hasFailure = false;
  let primaryError;

  async function runner() {
    while (!stopped) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      startedCount += 1;
      try {
        const value = await worker(items[index], index);
        settled[index] = Object.freeze({ status: "fulfilled", value });
      } catch (reason) {
        settled[index] = Object.freeze({ status: "rejected", reason });
        if (!hasFailure) {
          hasFailure = true;
          primaryError = reason;
          stopped = true;
        }
        return;
      }
    }
  }

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    () => runner(),
  );
  await Promise.all(runners);
  const details = Object.freeze({
    settled: Object.freeze(settled),
    startedCount,
  });
  if (hasFailure) {
    let propagatedError = primaryError instanceof Error
      ? primaryError
      : new Error("Limited worker rejected with a non-Error reason.", { cause: primaryError });
    try {
      Object.defineProperty(propagatedError, "settledDetails", {
        configurable: true,
        value: details,
      });
    } catch {
      // Frozen, sealed, or conflicting Error objects must not discard the
      // settlement inventory that callers need to clean already-finished work.
      propagatedError = new Error(propagatedError.message || "Limited worker failed.", {
        cause: propagatedError,
      });
      Object.defineProperty(propagatedError, "settledDetails", {
        configurable: true,
        value: details,
      });
    }
    throw propagatedError;
  }
  return details;
}
