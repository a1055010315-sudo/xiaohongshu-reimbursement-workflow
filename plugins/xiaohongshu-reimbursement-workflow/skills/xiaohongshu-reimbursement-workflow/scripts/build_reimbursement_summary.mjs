import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  formatMilliunits as formatAmount,
  loadProfileRegistry,
  parseMilliunits as parseAmount,
} from "./finance_domain.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const SETTLEMENTS = new Set(["employee_reimbursement", "company_paid_no_reimbursement"]);
const ADJUSTMENT_TYPES = new Set(["refund", "adjustment"]);

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value;
}

function cleanField(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const cleaned = value.trim();
  if (!cleaned || /[\t\r\n]/.test(cleaned)) {
    throw new Error(`${field} must be non-empty and contain no tabs or newlines.`);
  }
  return cleaned;
}

function parseCli(args) {
  const options = { preview: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--preview") {
      if (options.preview) throw new Error("--preview may only be supplied once.");
      options.preview = true;
      continue;
    }
    if (!["--input", "--manifest", "--output", "--expect-sha256"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    const key = arg === "--input"
      ? "input"
      : arg === "--manifest"
        ? "manifest"
        : arg === "--output"
          ? "output"
          : "expectedSha256";
    if (options[key] !== undefined) throw new Error(`${arg} may only be supplied once.`);
    options[key] = value;
    index += 1;
  }
  if ((options.input ? 1 : 0) + (options.manifest ? 1 : 0) !== 1) {
    throw new Error("Exactly one of --manifest or --input is required.");
  }
  if (options.preview) {
    if (options.output || options.expectedSha256) {
      throw new Error("Preview mode accepts one source option and --preview only.");
    }
  } else {
    if (!options.output || !options.expectedSha256) {
      throw new Error("Write mode requires one source option, --output, and --expect-sha256.");
    }
    if (!SHA256_RE.test(options.expectedSha256)) {
      throw new Error("--expect-sha256 must be 64 lowercase hexadecimal characters.");
    }
  }
  return options;
}

function parseSingleJsonLine(text, field) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.split(/\r?\n/).length !== 1) {
    throw new Error(`${field} must contain exactly one JSON line.`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${field} must contain valid JSON.`);
  }
}

async function projectAuditedManifest(manifestPath) {
  const absoluteManifestPath = path.resolve(manifestPath);
  const auditScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit_batch_manifest.mjs");
  const audit = spawnSync(process.execPath, [auditScript, absoluteManifestPath], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (audit.error) throw new Error(`Manifest audit could not start: ${audit.error.message}`);
  if (audit.signal) throw new Error(`Manifest audit was terminated by signal ${audit.signal}.`);
  const auditStdout = audit.stdout ?? "";
  const auditStderr = audit.stderr ?? "";
  if (audit.status !== 0) {
    if (auditStdout.trim()) throw new Error("Manifest audit failed with unexpected stdout content.");
    let failure;
    try {
      failure = parseSingleJsonLine(auditStderr, "Manifest audit stderr");
    } catch (error) {
      throw new Error(`Manifest audit failed without a valid failure record: ${error.message}`);
    }
    const detail = failure?.ok === false && typeof failure.error === "string"
      ? failure.error
      : "the auditor did not return an ok:false error record";
    throw new Error(`Manifest audit failed: ${detail}`);
  }
  if (auditStderr.trim()) throw new Error("Manifest audit succeeded with unexpected stderr content.");
  const audited = parseSingleJsonLine(auditStdout, "Manifest audit stdout");
  if (audited?.ok !== true) throw new Error("Manifest audit success record must contain ok:true.");
  if (path.resolve(audited.manifest ?? "") !== absoluteManifestPath) {
    throw new Error("Manifest audit result path does not match --manifest.");
  }
  if (!SHA256_RE.test(audited.manifestFileSha256 ?? "")) {
    throw new Error("Manifest audit result must contain manifestFileSha256.");
  }
  if (!SHA256_RE.test(audited.factsDigest ?? "")) {
    throw new Error("Manifest audit result must contain factsDigest.");
  }
  if (audited.operation?.mode !== "reimbursement-batch") {
    throw new Error("--manifest requires a reimbursement-batch manifest.");
  }
  if (!Array.isArray(audited.normalizedTransactions) || audited.normalizedTransactions.length === 0) {
    throw new Error("Manifest audit result must contain non-empty normalizedTransactions.");
  }
  const rawManifest = await fs.readFile(absoluteManifestPath);
  const currentManifestSha256 = crypto.createHash("sha256").update(rawManifest).digest("hex");
  if (currentManifestSha256 !== audited.manifestFileSha256) {
    throw new Error("Manifest changed after audit.");
  }
  const manifest = JSON.parse(rawManifest.toString("utf8"));
  if (![2, 3].includes(manifest?.version)) throw new Error("--manifest requires manifest.version 2 or 3.");
  const batch = requireObject(audited.batch, "manifest audit batch");
  const profileMetadata = {};
  if (manifest.version === 3) {
    if (!SHA256_RE.test(audited.profileConfigDigest ?? "")) {
      throw new Error("Manifest audit result must contain profileConfigDigest for version 3.");
    }
    const currentProfileRegistry = await loadProfileRegistry();
    if (currentProfileRegistry.profileConfigDigest !== audited.profileConfigDigest) {
      throw new Error("Profile registry changed after manifest audit.");
    }
    if (!Array.isArray(audited.affectedProfileIds) || audited.affectedProfileIds.length === 0) {
      throw new Error("Manifest audit result must contain non-empty affectedProfileIds for version 3.");
    }
    if (new Set(audited.affectedProfileIds).size !== audited.affectedProfileIds.length) {
      throw new Error("Manifest audit affectedProfileIds must be unique.");
    }
    if (!Array.isArray(audited.profileSummaries) || audited.profileSummaries.length !== audited.affectedProfileIds.length) {
      throw new Error("Manifest audit profileSummaries must match affectedProfileIds.");
    }
    for (let index = 0; index < audited.affectedProfileIds.length; index += 1) {
      const profileId = cleanField(audited.affectedProfileIds[index], `manifest audit affectedProfileIds[${index}]`);
      const summary = requireObject(audited.profileSummaries[index], `manifest audit profileSummaries[${index}]`);
      if (summary.profileId !== profileId) {
        throw new Error("Manifest audit profileSummaries order must match affectedProfileIds.");
      }
    }
    if (!audited.affectedProfileIds.includes(batch.targetProfileId)) {
      throw new Error("Manifest audit targetProfileId must be one of affectedProfileIds.");
    }
    profileMetadata.profileConfigDigest = audited.profileConfigDigest;
    profileMetadata.affectedProfileIds = audited.affectedProfileIds;
    profileMetadata.profileSummaries = audited.profileSummaries;
  }
  const targetCategory = cleanField(batch.targetCategory, "manifest audit batch.targetCategory");
  const categoryTotals = requireObject(audited.categoryTotals, "manifest audit categoryTotals");
  const categoryRealTotals = requireObject(audited.categoryRealTotals, "manifest audit categoryRealTotals");
  if (categoryTotals[targetCategory] === undefined) {
    throw new Error("Manifest audit categoryTotals does not contain the target category.");
  }
  const orderedTransactions = [...audited.normalizedTransactions].sort((left, right) => {
    if (!Number.isSafeInteger(left?.sourceOrder) || left.sourceOrder < 1) {
      throw new Error("Manifest audit normalizedTransactions contain an invalid sourceOrder.");
    }
    if (!Number.isSafeInteger(right?.sourceOrder) || right.sourceOrder < 1) {
      throw new Error("Manifest audit normalizedTransactions contain an invalid sourceOrder.");
    }
    return left.sourceOrder - right.sourceOrder;
  });
  const entries = orderedTransactions.map((transaction) => {
    const entry = {
      id: transaction.id,
      label: transaction.label,
      amount: transaction.amount,
      category: transaction.category,
      settlement: transaction.settlement,
    };
    if (transaction.adjustment !== undefined) entry.adjustment = transaction.adjustment;
    return entry;
  });
  return {
    payload: {
      period: batch.period,
      targetCategory,
      entries,
      expectedFeeTotal: categoryTotals[targetCategory],
      expectedRealTotal: categoryRealTotals[targetCategory] ?? "0",
      expectedCategoryTotals: categoryTotals,
    },
    metadata: {
      factsDigest: audited.factsDigest,
      manifestFileSha256: audited.manifestFileSha256,
      ...(audited.sourceCoverageDigest ? { sourceCoverageDigest: audited.sourceCoverageDigest } : {}),
      ...profileMetadata,
    },
  };
}

function resolveSettlement(entry, index) {
  if (entry?.settlement !== undefined) {
    const settlement = cleanField(entry.settlement, `entries[${index}].settlement`);
    if (!SETTLEMENTS.has(settlement)) {
      throw new Error(
        `entries[${index}].settlement must be employee_reimbursement or company_paid_no_reimbursement.`,
      );
    }
    if (entry.reimbursable !== undefined) {
      if (typeof entry.reimbursable !== "boolean") {
        throw new Error(`entries[${index}].reimbursable must be boolean when supplied.`);
      }
      if (entry.reimbursable !== (settlement === "employee_reimbursement")) {
        throw new Error(`entries[${index}] has conflicting settlement and reimbursable values.`);
      }
    }
    return settlement;
  }
  if (typeof entry?.reimbursable !== "boolean") {
    throw new Error(`entries[${index}] must provide settlement, or reimbursable for legacy input.`);
  }
  return entry.reimbursable ? "employee_reimbursement" : "company_paid_no_reimbursement";
}

function normalizeAdjustment(entry, index, amount) {
  if (amount >= 0n) {
    if (entry.adjustment !== undefined) {
      throw new Error(`entries[${index}].adjustment is only allowed for a negative amount.`);
    }
    return undefined;
  }
  const adjustment = requireObject(entry.adjustment, `entries[${index}].adjustment`);
  const type = cleanField(adjustment.type, `entries[${index}].adjustment.type`);
  if (!ADJUSTMENT_TYPES.has(type)) {
    throw new Error(`entries[${index}].adjustment.type must be refund or adjustment.`);
  }
  return {
    type,
    sourceTransactionId: cleanField(
      adjustment.sourceTransactionId,
      `entries[${index}].adjustment.sourceTransactionId`,
    ),
    reason: cleanField(adjustment.reason, `entries[${index}].adjustment.reason`),
  };
}

try {
  const options = parseCli(process.argv.slice(2));
  const sourcePath = options.manifest ?? options.input;
  const outputPath = options.output;
  if (!options.preview && path.resolve(sourcePath) === path.resolve(outputPath)) {
    throw new Error("Input and output paths must be different.");
  }

  let payload;
  let manifestMetadata;
  if (options.manifest) {
    const projected = await projectAuditedManifest(options.manifest);
    payload = projected.payload;
    manifestMetadata = projected.metadata;
  } else {
    payload = JSON.parse(await fs.readFile(options.input, "utf8"));
  }
  const period = cleanField(payload.period, "period");
  const targetCategory = cleanField(payload.targetCategory ?? "小红书报销", "targetCategory");
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error("entries must be a non-empty array.");
  }

  const entryIds = new Set();
  const normalizedEntries = payload.entries.map((entry, index) => {
    const label = cleanField(entry?.label, `entries[${index}].label`);
    const category = cleanField(entry?.category ?? targetCategory, `entries[${index}].category`);
    const settlement = resolveSettlement(entry, index);
    const amount = parseAmount(entry.amount, `entries[${index}].amount`, { allowNegative: true });
    const adjustment = normalizeAdjustment(entry, index, amount);
    let id;
    if (entry.id !== undefined) {
      id = cleanField(entry.id, `entries[${index}].id`);
      if (entryIds.has(id)) throw new Error(`Duplicate entry id: ${id}`);
      entryIds.add(id);
    }
    if (adjustment && !id) {
      throw new Error(`entries[${index}].id is required for a negative adjustment.`);
    }
    return { id, label, category, settlement, amount, adjustment };
  });

  const entryById = new Map(normalizedEntries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const refundTotalsBySource = new Map();
  for (const entry of normalizedEntries) {
    if (!entry.adjustment) continue;
    const source = entryById.get(entry.adjustment.sourceTransactionId);
    if (!source || source.id === entry.id) {
      throw new Error(`Entry ${entry.id} adjustment must reference a different entry in the same input.`);
    }
    if (source.amount <= 0n) {
      throw new Error(`Entry ${entry.id} adjustment source must have a positive amount.`);
    }
    if (source.category !== entry.category || source.settlement !== entry.settlement) {
      throw new Error(`Entry ${entry.id} adjustment source must have the same category and settlement.`);
    }
    if (entry.adjustment.type === "refund") {
      refundTotalsBySource.set(source.id, (refundTotalsBySource.get(source.id) ?? 0n) - entry.amount);
    }
  }
  for (const [sourceId, refundTotal] of refundTotalsBySource) {
    if (refundTotal > entryById.get(sourceId).amount) {
      throw new Error(`Refunds referencing entry ${sourceId} exceed its positive amount.`);
    }
  }

  const groups = new Map();
  const groupsByCategory = new Map();
  const categoryTotals = new Map();
  const settlementTotals = new Map();
  let feeTotal = 0n;
  let realTotal = 0n;
  let targetHasCompanyPaid = false;

  for (const entry of normalizedEntries) {
    const groupKey = JSON.stringify([entry.category, entry.label, entry.settlement]);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.amount += entry.amount;
    } else {
      const group = {
        category: entry.category,
        label: entry.label,
        amount: entry.amount,
        settlement: entry.settlement,
      };
      groups.set(groupKey, group);
      if (!groupsByCategory.has(entry.category)) groupsByCategory.set(entry.category, []);
      groupsByCategory.get(entry.category).push(group);
    }
    categoryTotals.set(entry.category, (categoryTotals.get(entry.category) ?? 0n) + entry.amount);
    settlementTotals.set(entry.settlement, (settlementTotals.get(entry.settlement) ?? 0n) + entry.amount);
    if (entry.category === targetCategory) {
      feeTotal += entry.amount;
      if (entry.settlement === "employee_reimbursement") {
        realTotal += entry.amount;
      } else {
        targetHasCompanyPaid = true;
      }
    }
  }

  if (!categoryTotals.has(targetCategory)) {
    throw new Error("entries must contain at least one target-category record.");
  }

  if (
    payload.expectedFeeTotal !== undefined &&
    parseAmount(payload.expectedFeeTotal, "expectedFeeTotal", { allowNegative: true }) !== feeTotal
  ) {
    throw new Error("Calculated fee total does not match expectedFeeTotal.");
  }
  if (
    payload.expectedRealTotal !== undefined &&
    parseAmount(payload.expectedRealTotal, "expectedRealTotal", { allowNegative: true }) !== realTotal
  ) {
    throw new Error("Calculated real total does not match expectedRealTotal.");
  }
  if (payload.expectedCategoryTotals !== undefined) {
    if (!payload.expectedCategoryTotals || typeof payload.expectedCategoryTotals !== "object" || Array.isArray(payload.expectedCategoryTotals)) {
      throw new Error("expectedCategoryTotals must be an object keyed by category.");
    }
    const expectedEntries = Object.entries(payload.expectedCategoryTotals);
    if (expectedEntries.length !== categoryTotals.size) {
      throw new Error("expectedCategoryTotals categories do not match calculated categories.");
    }
    for (const [rawCategory, amount] of expectedEntries) {
      const category = cleanField(rawCategory, "expectedCategoryTotals category");
      if (
        !categoryTotals.has(category) ||
        parseAmount(amount, `expectedCategoryTotals.${category}`, { allowNegative: true }) !== categoryTotals.get(category)
      ) {
        throw new Error(`Calculated category total does not match expectedCategoryTotals.${category}.`);
      }
    }
  }

  const orderedCategories = [];
  if (categoryTotals.has(targetCategory)) orderedCategories.push(targetCategory);
  for (const category of categoryTotals.keys()) {
    if (category !== targetCategory) orderedCategories.push(category);
  }

  const lines = [];
  for (const category of orderedCategories) {
    if (lines.length > 0) lines.push("");
    lines.push(`${period}${category}`);
    for (const group of groupsByCategory.get(category) ?? []) {
      if (group.amount === 0n && payload.includeZero !== true) continue;
      lines.push(`${group.label}：${formatAmount(group.amount)}`);
    }
    if (category === targetCategory) {
      if (targetHasCompanyPaid) lines.push(`费用合计：${formatAmount(feeTotal)}`);
      lines.push(`实报合计：${formatAmount(realTotal)}`);
    } else {
      lines.push(`合计：${formatAmount(categoryTotals.get(category))}`);
    }
  }
  const output = `${lines.join("\n")}\n`;
  const textSha256 = crypto.createHash("sha256").update(output, "utf8").digest("hex");

  if (!options.preview && textSha256 !== options.expectedSha256) {
    throw new Error(`Rendered summary SHA256 ${textSha256} does not match --expect-sha256.`);
  }
  if (!options.preview) {
    await fs.writeFile(outputPath, output, { encoding: "utf8", flag: "wx" });
    const written = await fs.readFile(outputPath);
    const expectedBytes = Buffer.from(output, "utf8");
    if (!written.equals(expectedBytes)) {
      await fs.unlink(outputPath).catch(() => {});
      throw new Error("Written output bytes do not match the rendered summary.");
    }
  }
  const result = {
    ok: true,
    mode: options.preview ? "preview" : "write",
    targetCategory,
    groups: groups.size,
    categoryTotals: Object.fromEntries(
      [...categoryTotals].map(([category, amount]) => [category, formatAmount(amount)]),
    ),
    settlementTotals: Object.fromEntries(
      [...settlementTotals].map(([settlement, amount]) => [settlement, formatAmount(amount)]),
    ),
    feeTotal: formatAmount(feeTotal),
    realTotal: formatAmount(realTotal),
    textSha256,
  };
  if (manifestMetadata) {
    result.factsDigest = manifestMetadata.factsDigest;
    result.manifestFileSha256 = manifestMetadata.manifestFileSha256;
    if (manifestMetadata.sourceCoverageDigest) {
      result.sourceCoverageDigest = manifestMetadata.sourceCoverageDigest;
    }
    if (manifestMetadata.profileConfigDigest) {
      result.profileConfigDigest = manifestMetadata.profileConfigDigest;
      result.affectedProfileIds = manifestMetadata.affectedProfileIds;
      result.profileSummaries = manifestMetadata.profileSummaries;
    }
  }
  if (options.preview) {
    result.summary = output;
  } else {
    result.output = path.resolve(outputPath);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
