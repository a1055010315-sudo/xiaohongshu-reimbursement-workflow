import crypto from "node:crypto";
import fs from "node:fs/promises";

import { canonicalDigest } from "./workflow_primitives.mjs";

export { canonicalDigest };

const AMOUNT_SCALE = 1000n;
const EXPECTED_PROFILE_IDS = ["xiaohongshu", "company", "residence"];
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "profileOrder", "profiles"]);
const PROFILE_FIELDS = new Set([
  "targetCategory",
  "categoryAliases",
  "canonicalRootWorkbookName",
  "rootWorkbookInputNames",
  "managedRootSheetName",
  "managedRootSheetInputNames",
  "detailSheetName",
  "screenshotMapSheetName",
  "detailTemplateFile",
  "detailTemplateSha256",
  "screenshotTemplateFile",
  "screenshotTemplateSha256",
  "archiveDirectoryName",
  "archiveStem",
  "preserveUnmanagedSheets",
]);
const PROFILE_CONFIG_URL = new URL("../references/ledger-profiles.json", import.meta.url);
const validatedRegistries = new WeakSet();

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

function cleanString(value, field) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a non-empty trimmed string without tabs or newlines.`);
  }
  return value;
}

function cleanUniqueStrings(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
  const result = value.map((entry, index) => cleanString(entry, `${field}[${index}]`));
  const keys = result.map((entry) => entry.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error(`${field} must not contain duplicates.`);
  return result;
}

function cleanFilename(value, field) {
  const result = cleanString(value, field);
  if (
    !/\.xlsx$/iu.test(result) ||
    result === "." ||
    result === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(result) ||
    /[ .]$/u.test(result)
  ) {
    throw new Error(`${field} must be one safe .xlsx filename segment.`);
  }
  return result;
}

function cleanDirectoryName(value, field) {
  const result = cleanString(value, field);
  if (result === "." || result === ".." || /[<>:"/\\|?*\u0000-\u001f]/u.test(result) || /[ .]$/u.test(result)) {
    throw new Error(`${field} must be one safe directory-name segment.`);
  }
  return result;
}

function cleanSha256(value, field) {
  const result = cleanString(value, field);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return result;
}

function registerIdentity(index, rawKey, profileId, label) {
  const key = rawKey.toLowerCase();
  const existing = index.get(key);
  if (existing && existing !== profileId) {
    throw new Error(`${label} ${rawKey} resolves to multiple profiles: ${existing}, ${profileId}.`);
  }
  index.set(key, profileId);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateProfileRegistry(raw, profileConfigDigest) {
  const registry = requireObject(raw, "ledger profile registry");
  rejectUnknownFields(registry, TOP_LEVEL_FIELDS, "ledger profile registry");
  if (registry.schemaVersion !== 1) throw new Error("ledger profile registry schemaVersion must be 1.");
  if (!Array.isArray(registry.profileOrder)) {
    throw new Error("ledger profile registry profileOrder must be an array.");
  }
  if (
    registry.profileOrder.length !== EXPECTED_PROFILE_IDS.length ||
    registry.profileOrder.some((profileId, index) => profileId !== EXPECTED_PROFILE_IDS[index])
  ) {
    throw new Error(`ledger profile registry profileOrder must be ${EXPECTED_PROFILE_IDS.join(", ")}.`);
  }

  const rawProfiles = requireObject(registry.profiles, "ledger profile registry profiles");
  const profileKeys = Object.keys(rawProfiles).sort();
  const expectedKeys = [...EXPECTED_PROFILE_IDS].sort();
  if (profileKeys.length !== expectedKeys.length || profileKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("ledger profile registry profiles must contain exactly xiaohongshu, company, and residence.");
  }

  const categoryIndex = new Map();
  const rootInputIndex = new Map();
  const canonicalRoots = new Set();
  const archiveDirectories = new Set();
  const profiles = {};

  for (const profileId of registry.profileOrder) {
    const field = `ledger profile registry profiles.${profileId}`;
    const rawProfile = requireObject(rawProfiles[profileId], field);
    rejectUnknownFields(rawProfile, PROFILE_FIELDS, field);
    const targetCategory = cleanString(rawProfile.targetCategory, `${field}.targetCategory`);
    const categoryAliases = cleanUniqueStrings(rawProfile.categoryAliases, `${field}.categoryAliases`);
    if (!categoryAliases.includes(targetCategory)) {
      throw new Error(`${field}.categoryAliases must include targetCategory.`);
    }
    const canonicalRootWorkbookName = cleanFilename(
      rawProfile.canonicalRootWorkbookName,
      `${field}.canonicalRootWorkbookName`,
    );
    const rootWorkbookInputNames = cleanUniqueStrings(
      rawProfile.rootWorkbookInputNames,
      `${field}.rootWorkbookInputNames`,
    ).map((value, index) => cleanFilename(value, `${field}.rootWorkbookInputNames[${index}]`));
    if (!rootWorkbookInputNames.includes(canonicalRootWorkbookName)) {
      throw new Error(`${field}.rootWorkbookInputNames must include canonicalRootWorkbookName.`);
    }
    const managedRootSheetName = cleanString(rawProfile.managedRootSheetName, `${field}.managedRootSheetName`);
    const managedRootSheetInputNames = cleanUniqueStrings(
      rawProfile.managedRootSheetInputNames,
      `${field}.managedRootSheetInputNames`,
    );
    if (!managedRootSheetInputNames.includes(managedRootSheetName)) {
      throw new Error(`${field}.managedRootSheetInputNames must include managedRootSheetName.`);
    }
    const detailSheetName = cleanString(rawProfile.detailSheetName, `${field}.detailSheetName`);
    const screenshotMapSheetName = cleanString(
      rawProfile.screenshotMapSheetName,
      `${field}.screenshotMapSheetName`,
    );
    const detailTemplateFile = cleanFilename(rawProfile.detailTemplateFile, `${field}.detailTemplateFile`);
    const detailTemplateSha256 = cleanSha256(rawProfile.detailTemplateSha256, `${field}.detailTemplateSha256`);
    const screenshotTemplateFile = cleanFilename(rawProfile.screenshotTemplateFile, `${field}.screenshotTemplateFile`);
    const screenshotTemplateSha256 = cleanSha256(rawProfile.screenshotTemplateSha256, `${field}.screenshotTemplateSha256`);
    const archiveDirectoryName = cleanDirectoryName(
      rawProfile.archiveDirectoryName,
      `${field}.archiveDirectoryName`,
    );
    const archiveStem = cleanString(rawProfile.archiveStem, `${field}.archiveStem`);
    if (rawProfile.preserveUnmanagedSheets !== true) {
      throw new Error(`${field}.preserveUnmanagedSheets must be true.`);
    }

    const canonicalRootKey = canonicalRootWorkbookName.toLowerCase();
    if (canonicalRoots.has(canonicalRootKey)) {
      throw new Error("Canonical root workbook names must be globally unique.");
    }
    canonicalRoots.add(canonicalRootKey);
    const archiveKey = archiveDirectoryName.toLowerCase();
    if (archiveDirectories.has(archiveKey)) {
      throw new Error("Archive directory names must be globally unique.");
    }
    archiveDirectories.add(archiveKey);

    registerIdentity(categoryIndex, profileId, profileId, "Profile id");
    for (const alias of categoryAliases) registerIdentity(categoryIndex, alias, profileId, "Category alias");
    for (const inputName of rootWorkbookInputNames) {
      registerIdentity(rootInputIndex, inputName, profileId, "Root workbook input");
    }

    profiles[profileId] = {
      profileId,
      targetCategory,
      categoryAliases,
      canonicalRootWorkbookName,
      rootWorkbookInputNames,
      managedRootSheetName,
      managedRootSheetInputNames,
      detailSheetName,
      screenshotMapSheetName,
      detailTemplateFile,
      detailTemplateSha256,
      screenshotTemplateFile,
      screenshotTemplateSha256,
      archiveDirectoryName,
      archiveStem,
      preserveUnmanagedSheets: true,
    };
  }

  const normalized = {
    schemaVersion: 1,
    profileOrder: [...registry.profileOrder],
    profiles,
    profileConfigDigest,
  };
  deepFreeze(normalized);
  validatedRegistries.add(normalized);
  return normalized;
}

export function parseProfileRegistryBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("Profile registry bytes must be a Uint8Array.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Profile registry must be valid UTF-8 JSON.");
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Profile registry must be valid UTF-8 JSON.");
  }
  const canonicalText = `${JSON.stringify(raw, null, 2)}\n`;
  const canonicalCrlfText = canonicalText.replace(/\n/gu, "\r\n");
  if (text !== canonicalText && text !== canonicalCrlfText) {
    throw new Error("Profile registry must use canonical UTF-8 JSON formatting.");
  }
  const profileConfigDigest = crypto.createHash("sha256").update(canonicalText, "utf8").digest("hex");
  return validateProfileRegistry(raw, profileConfigDigest);
}

export async function loadProfileRegistry() {
  return parseProfileRegistryBytes(await fs.readFile(PROFILE_CONFIG_URL));
}

function requireValidatedRegistry(registry) {
  if (!registry || !validatedRegistries.has(registry)) {
    throw new Error("A registry returned by loadProfileRegistry or parseProfileRegistryBytes is required.");
  }
  return registry;
}

function cleanLookup(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/u.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

export function resolveProfile(value, registry) {
  const checked = requireValidatedRegistry(registry);
  const input = cleanLookup(value, "profile");
  const key = input.toLowerCase();
  for (const profileId of checked.profileOrder) {
    const profile = checked.profiles[profileId];
    if (profileId.toLowerCase() === key || profile.categoryAliases.some((alias) => alias.toLowerCase() === key)) {
      return profile;
    }
  }
  throw new Error(`Unknown reimbursement profile: ${input}.`);
}

export function resolveRootWorkbookProfile(value, registry) {
  const checked = requireValidatedRegistry(registry);
  const input = cleanLookup(value, "root workbook input name");
  const key = input.toLowerCase();
  for (const profileId of checked.profileOrder) {
    const profile = checked.profiles[profileId];
    if (profile.rootWorkbookInputNames.some((name) => name.toLowerCase() === key)) return profile;
  }
  throw new Error(`Unknown reimbursement root workbook input: ${input}.`);
}

export function parseMilliunits(value, field, { allowNegative = false } = {}) {
  const expression = allowNegative ? /^-?(0|[1-9]\d*)(\.\d{1,3})?$/u : /^(0|[1-9]\d*)(\.\d{1,3})?$/u;
  if (typeof value !== "string" || !expression.test(value)) {
    const signRule = allowNegative ? "signed" : "non-negative";
    throw new Error(`${field} must be a ${signRule} decimal string with at most three decimal places.`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const parsed = BigInt(whole) * AMOUNT_SCALE + BigInt((fraction + "000").slice(0, 3));
  if (negative && parsed === 0n) throw new Error(`${field} must not use a negative zero representation.`);
  return negative ? -parsed : parsed;
}

export function formatMilliunits(value) {
  if (typeof value !== "bigint") throw new Error("Milliunits value must be a bigint.");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / AMOUNT_SCALE;
  const fraction = absolute % AMOUNT_SCALE;
  const rendered = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/u, "")}`;
  return negative ? `-${rendered}` : rendered;
}
