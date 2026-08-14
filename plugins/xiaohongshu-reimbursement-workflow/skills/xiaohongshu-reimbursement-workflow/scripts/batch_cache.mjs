#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROFILE_ORDER = Object.freeze(["xiaohongshu", "company", "residence"]);
export const PROFILE_TARGET_FILENAMES = Object.freeze({
  xiaohongshu: "小红书支出总表.xlsx",
  company: "公司支出总表.xlsx",
  residence: "驻所支出.xlsx",
});
export const PROFILE_ROOT_DIRECTORY_NAMES = Object.freeze({
  xiaohongshu: "01_小红书专项",
  company: "02_公司专项",
  residence: "03_驻所专项",
});

const PROFILE_ALIASES = new Map([["xhs", "xiaohongshu"]]);
const SHA256_RE = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

export function cleanString(value, field) {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\t]/u.test(value)) {
    fail(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

export function cleanSha256(value, field) {
  const normalized = cleanString(value, field).toLowerCase();
  if (!SHA256_RE.test(normalized)) fail(`${field} must contain exactly 64 lowercase hexadecimal characters.`);
  return normalized;
}

export function cleanAbsolutePath(value, field) {
  const normalized = cleanString(value, field);
  if (!path.isAbsolute(normalized)) fail(`${field} must be an absolute path.`);
  return path.resolve(normalized);
}

export function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function normalizeProfileId(value, field = "profileId") {
  const input = cleanString(value, field);
  const normalized = PROFILE_ALIASES.get(input) ?? input;
  if (!PROFILE_ORDER.includes(normalized)) fail(`${field} is not a supported reimbursement profile.`);
  return normalized;
}

export function normalizeAffectedProfiles(value, field = "affectedProfiles") {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROFILE_ORDER.length) {
    fail(`${field} must contain one to three reimbursement profiles.`);
  }
  const normalized = value.map((item, index) => normalizeProfileId(item, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${field} contains duplicate profiles.`);
  return PROFILE_ORDER.filter((profileId) => normalized.includes(profileId));
}

export function assertExactAffectedProfiles(affectedProfiles, profileObject, field = "profiles") {
  if (!profileObject || typeof profileObject !== "object" || Array.isArray(profileObject)) {
    fail(`${field} must be an object keyed by profile ID.`);
  }
  const canonicalEntries = new Map();
  for (const [rawKey, value] of Object.entries(profileObject)) {
    const key = normalizeProfileId(rawKey, `${field} key`);
    if (canonicalEntries.has(key)) fail(`${field} contains duplicate aliases for ${key}.`);
    canonicalEntries.set(key, value);
  }
  const actual = PROFILE_ORDER.filter((profileId) => canonicalEntries.has(profileId));
  if (actual.length !== affectedProfiles.length || actual.some((item, index) => item !== affectedProfiles[index])) {
    fail(`${field} keys must match affectedProfiles exactly.`);
  }
  return Object.fromEntries(actual.map((profileId) => [profileId, canonicalEntries.get(profileId)]));
}

export function assertProfileTargetPath(profileId, value, field = "targetPath") {
  const canonicalProfile = normalizeProfileId(profileId);
  const targetPath = cleanAbsolutePath(value, field);
  if (path.extname(targetPath).toLowerCase() !== ".xlsx") fail(`${field} must use the .xlsx extension.`);
  const expected = PROFILE_TARGET_FILENAMES[canonicalProfile];
  if (path.basename(targetPath).toLowerCase() !== expected.toLowerCase()) {
    fail(`${field} for ${canonicalProfile} must use the exact filename ${expected}.`);
  }
  const expectedDirectory = PROFILE_ROOT_DIRECTORY_NAMES[canonicalProfile];
  if (path.basename(path.dirname(targetPath)).toLowerCase() !== expectedDirectory.toLowerCase()) {
    fail(`${field} for ${canonicalProfile} must be directly inside ${expectedDirectory}.`);
  }
  return targetPath;
}

export async function assertPlainFile(filePath, field = "file") {
  let stat;
  try {
    stat = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${field} does not exist: ${filePath}.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${field} must be a regular file, not a link: ${filePath}.`);
  return stat;
}

export async function assertPlainDirectory(directoryPath, field = "directory") {
  let stat;
  try {
    stat = await fs.lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${field} does not exist: ${directoryPath}.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${field} must be a real directory, not a link: ${directoryPath}.`);
  return stat;
}

export async function sha256FileFresh(filePath, field = "file") {
  await assertPlainFile(filePath, field);
  const handle = await fs.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function fingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFingerprint(left, right) {
  return left && right && Object.keys(left).every((key) => left[key] === right[key]);
}

export class BatchTaskCache {
  constructor() {
    this.fileHashes = new Map();
    this.values = new Map();
    this.stats = { hashHits: 0, hashMisses: 0, valueHits: 0, valueMisses: 0 };
  }

  async hashFile(filePath, { fresh = false, field = "file" } = {}) {
    const resolved = cleanAbsolutePath(filePath, field);
    const stat = await assertPlainFile(resolved, field);
    const currentFingerprint = fingerprint(stat);
    const cached = this.fileHashes.get(process.platform === "win32" ? resolved.toLowerCase() : resolved);
    if (!fresh && cached && sameFingerprint(cached.fingerprint, currentFingerprint)) {
      this.stats.hashHits += 1;
      return cached.sha256;
    }
    const sha256 = await sha256FileFresh(resolved, field);
    this.fileHashes.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, {
      fingerprint: currentFingerprint,
      sha256,
    });
    this.stats.hashMisses += 1;
    return sha256;
  }

  get(namespace, key, dependencyDigest) {
    const cacheKey = `${cleanString(namespace, "namespace")}:${cleanString(key, "key")}`;
    const entry = this.values.get(cacheKey);
    if (!entry || entry.dependencyDigest !== cleanSha256(dependencyDigest, "dependencyDigest")) {
      this.stats.valueMisses += 1;
      return undefined;
    }
    this.stats.valueHits += 1;
    return structuredClone(entry.value);
  }

  put(namespace, key, dependencyDigest, value) {
    const cacheKey = `${cleanString(namespace, "namespace")}:${cleanString(key, "key")}`;
    this.values.set(cacheKey, {
      dependencyDigest: cleanSha256(dependencyDigest, "dependencyDigest"),
      value: structuredClone(value),
    });
  }
}

export async function readStrictJson(filePath, field = "JSON file") {
  const resolved = cleanAbsolutePath(filePath, field);
  await assertPlainFile(resolved, field);
  const bytes = await fs.readFile(resolved);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail(`${field} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--input") {
    fail("Usage: batch_cache.mjs --input <request.json>.");
  }
  const request = await readStrictJson(path.resolve(process.argv[3]), "cache request");
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("cache request must be an object.");
  if (request.version !== 1) fail("cache request version must be 1.");
  if (request.action === "canonical-digest") {
    const allowed = new Set(["version", "action", "value"]);
    for (const key of Object.keys(request)) if (!allowed.has(key)) fail(`Unknown cache request field: ${key}.`);
    process.stdout.write(`${JSON.stringify({ ok: true, digest: canonicalDigest(request.value) })}\n`);
    return;
  }
  if (request.action === "hash-files") {
    const allowed = new Set(["version", "action", "files"]);
    for (const key of Object.keys(request)) if (!allowed.has(key)) fail(`Unknown cache request field: ${key}.`);
    if (!Array.isArray(request.files) || request.files.length === 0) fail("files must be a non-empty array.");
    const cache = new BatchTaskCache();
    const files = [];
    for (const [index, filePath] of request.files.entries()) {
      const resolved = cleanAbsolutePath(filePath, `files[${index}]`);
      files.push({ path: resolved, sha256: await cache.hashFile(resolved, { field: `files[${index}]` }) });
    }
    process.stdout.write(`${JSON.stringify({ ok: true, files, cacheStats: cache.stats })}\n`);
    return;
  }
  fail("cache request action is unsupported.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
