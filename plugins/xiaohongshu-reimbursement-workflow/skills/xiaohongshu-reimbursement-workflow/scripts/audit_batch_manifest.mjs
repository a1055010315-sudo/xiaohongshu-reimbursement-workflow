import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";

const VALIDATOR_VERSION = "2";
const AMOUNT_SCALE = 1000n;
const SHA256_RE = /^[0-9a-f]{64}$/;

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

function cleanString(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const result = value.trim();
  if (!result || /[\r\n\t]/.test(result)) {
    throw new Error(`${field} must be non-empty and contain no tabs or newlines.`);
  }
  return result;
}

function cleanIsoDate(value, field) {
  const result = cleanString(value, field);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  if (!match) throw new Error(`${field} must be a valid ISO date in YYYY-MM-DD form.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new Error(`${field} must be a valid ISO date in YYYY-MM-DD form.`);
  }
  return result;
}

function parseAmount(value, field) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal string with at most three decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * AMOUNT_SCALE + BigInt((fraction + "000").slice(0, 3));
}

function formatAmount(value) {
  const whole = value / AMOUNT_SCALE;
  const fraction = value % AMOUNT_SCALE;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

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

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function isStrictDescendant(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function rejectAuthorizationState(value, field = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectAuthorizationState(entry, `${field}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
    if (
      /(^|_)(gate|gates|approval|approvals|approve|approved|authorization|authorized)(_|$)/.test(normalizedKey) ||
      /门禁|授权|审批|批准/.test(key)
    ) {
      throw new Error(`${field}.${key} must not persist user gates or authorization.`);
    }
    rejectAuthorizationState(child, `${field}.${key}`);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const manifestPath = process.argv[2];

try {
  if (!manifestPath || process.argv[3] !== undefined) {
    throw new Error("Use audit_batch_manifest.mjs <manifest.json>.");
  }
  const absoluteManifestPath = path.resolve(manifestPath);
  const rawBytes = await fsp.readFile(absoluteManifestPath);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  const manifest = JSON.parse(raw);
  requireObject(manifest, "manifest");
  rejectAuthorizationState(manifest);
  if (manifest.audits !== undefined || manifest.auditCertificates !== undefined || manifest.certificates !== undefined) {
    throw new Error("Audit certificates must be stored beside the manifest, not inside it.");
  }

  if (manifest.version !== 1) throw new Error("manifest.version must be 1.");
  const rulesVersion = cleanString(manifest.rulesVersion, "manifest.rulesVersion");
  const batch = requireObject(manifest.batch, "manifest.batch");
  const rootPath = cleanString(batch.rootPath, "manifest.batch.rootPath");
  const archivePath = cleanString(batch.archivePath, "manifest.batch.archivePath");
  const period = cleanString(batch.period, "manifest.batch.period");
  const targetCategory = cleanString(batch.targetCategory, "manifest.batch.targetCategory");
  if (!Number.isSafeInteger(batch.reviewRevision) || batch.reviewRevision < 1) {
    throw new Error("manifest.batch.reviewRevision must be a positive safe integer.");
  }
  const reviewRevision = batch.reviewRevision;
  if (!path.isAbsolute(rootPath) || !path.isAbsolute(archivePath)) {
    throw new Error("manifest batch rootPath and archivePath must be absolute paths.");
  }
  if (!isStrictDescendant(rootPath, archivePath)) {
    throw new Error("manifest.batch.archivePath must be inside manifest.batch.rootPath.");
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("manifest.files must be a non-empty array.");
  }
  const fileIds = new Set();
  const normalizedFiles = manifest.files.map((rawFile, index) => {
    const file = requireObject(rawFile, `manifest.files[${index}]`);
    const id = cleanString(file.id, `manifest.files[${index}].id`);
    const role = cleanString(file.role, `manifest.files[${index}].role`);
    const filePath = cleanString(file.path, `manifest.files[${index}].path`);
    const sha256 = cleanString(file.sha256, `manifest.files[${index}].sha256`).toLowerCase();
    if (fileIds.has(id)) throw new Error(`Duplicate file id: ${id}`);
    fileIds.add(id);
    if (!path.isAbsolute(filePath)) throw new Error(`manifest.files[${index}].path must be absolute.`);
    if (!SHA256_RE.test(sha256)) throw new Error(`manifest.files[${index}].sha256 must be 64 lowercase hex characters.`);
    const normalized = { id, role, path: path.resolve(filePath), sha256 };
    if (role === "material") {
      const kind = cleanString(file.kind, `manifest.files[${index}].kind`);
      const disposition = cleanString(file.disposition, `manifest.files[${index}].disposition`);
      if (!["image", "text", "attachment"].includes(kind)) {
        throw new Error(`manifest.files[${index}].kind must be image, text, or attachment.`);
      }
      if (!["used", "excluded"].includes(disposition)) {
        throw new Error(`manifest.files[${index}].disposition must be used or excluded.`);
      }
      normalized.kind = kind;
      normalized.disposition = disposition;
      if (disposition === "excluded") {
        normalized.reason = cleanString(file.reason, `manifest.files[${index}].reason`);
      }
    }
    return normalized;
  });
  const baselineFiles = normalizedFiles.filter((file) => file.role === "baseline");
  if (baselineFiles.length !== 1) throw new Error("manifest.files must contain exactly one baseline role.");
  if (!isStrictDescendant(rootPath, baselineFiles[0].path)) {
    throw new Error("The baseline file must be inside manifest.batch.rootPath.");
  }
  const fileById = new Map(normalizedFiles.map((file) => [file.id, file]));

  const verifiedFiles = await mapWithConcurrency(normalizedFiles, 4, async (file) => {
    const stat = await fsp.stat(file.path);
    if (!stat.isFile()) throw new Error(`Manifest file is not a regular file: ${file.id}`);
    const actualSha256 = await sha256File(file.path);
    if (actualSha256 !== file.sha256) {
      throw new Error(`SHA256 mismatch for ${file.id}: expected ${file.sha256}, actual ${actualSha256}`);
    }
    return { ...file, size: stat.size };
  });

  if (!Array.isArray(manifest.transactions) || manifest.transactions.length === 0) {
    throw new Error("manifest.transactions must be a non-empty array.");
  }
  const transactionIds = new Set();
  const categoryTotals = new Map();
  const categoryRealTotals = new Map();
  const groupReimbursable = new Map();
  const referencedMaterialIds = new Set();
  const normalizedTransactions = manifest.transactions.map((rawTransaction, index) => {
    const transaction = requireObject(rawTransaction, `manifest.transactions[${index}]`);
    const id = cleanString(transaction.id, `manifest.transactions[${index}].id`);
    if (transactionIds.has(id)) throw new Error(`Duplicate transaction id: ${id}`);
    transactionIds.add(id);
    const date = cleanIsoDate(transaction.date, `manifest.transactions[${index}].date`);
    const person = cleanString(transaction.person, `manifest.transactions[${index}].person`);
    const project = cleanString(transaction.project, `manifest.transactions[${index}].project`);
    const label = cleanString(transaction.label, `manifest.transactions[${index}].label`);
    const category = cleanString(transaction.category, `manifest.transactions[${index}].category`);
    const amount = parseAmount(transaction.amount, `manifest.transactions[${index}].amount`);
    if (typeof transaction.reimbursable !== "boolean") {
      throw new Error(`manifest.transactions[${index}].reimbursable must be boolean.`);
    }
    if (!Array.isArray(transaction.evidence)) {
      throw new Error(`manifest.transactions[${index}].evidence must be an array.`);
    }
    const evidence = transaction.evidence.map((value, evidenceIndex) =>
      cleanString(value, `manifest.transactions[${index}].evidence[${evidenceIndex}]`),
    );
    if (new Set(evidence).size !== evidence.length) {
      throw new Error(`manifest.transactions[${index}].evidence contains duplicate ids.`);
    }
    for (const evidenceId of evidence) {
      if (!fileIds.has(evidenceId)) {
        throw new Error(`Transaction ${id} references missing evidence file id: ${evidenceId}`);
      }
      const evidenceFile = fileById.get(evidenceId);
      if (evidenceFile.role !== "material") {
        throw new Error(`Transaction ${id} evidence ${evidenceId} is not a material file.`);
      }
      if (evidenceFile.disposition !== "used") {
        throw new Error(`Transaction ${id} references excluded material: ${evidenceId}`);
      }
      referencedMaterialIds.add(evidenceId);
    }
    const imageEvidence = evidence.filter((evidenceId) => fileById.get(evidenceId).kind === "image");
    if (imageEvidence.length === 0 && transaction.missingEvidenceConfirmed !== true) {
      throw new Error(`Transaction ${id} has no image evidence and is not marked missingEvidenceConfirmed.`);
    }
    if (imageEvidence.length > 0 && transaction.missingEvidenceConfirmed === true) {
      throw new Error(`Transaction ${id} cannot have image evidence and missingEvidenceConfirmed together.`);
    }
    const groupKey = JSON.stringify([category, label]);
    if (groupReimbursable.has(groupKey) && groupReimbursable.get(groupKey) !== transaction.reimbursable) {
      throw new Error(`Category and label have conflicting reimbursable values: ${category} / ${label}`);
    }
    groupReimbursable.set(groupKey, transaction.reimbursable);
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0n) + amount);
    if (transaction.reimbursable) {
      categoryRealTotals.set(category, (categoryRealTotals.get(category) ?? 0n) + amount);
    }
    return {
      id,
      date,
      person,
      project,
      label,
      amount: formatAmount(amount),
      category,
      reimbursable: transaction.reimbursable,
      evidence,
      missingEvidenceConfirmed: transaction.missingEvidenceConfirmed === true,
    };
  });

  for (const file of normalizedFiles) {
    if (file.role !== "material") continue;
    if (file.disposition === "used" && !referencedMaterialIds.has(file.id)) {
      throw new Error(`Used material is not referenced by any transaction: ${file.id}`);
    }
    if (file.disposition === "excluded" && referencedMaterialIds.has(file.id)) {
      throw new Error(`Excluded material must not be referenced: ${file.id}`);
    }
  }
  if (!categoryTotals.has(targetCategory)) {
    throw new Error("manifest.transactions must contain at least one target-category transaction.");
  }
  const expectedFeeTotal = parseAmount(manifest.expectedFeeTotal, "manifest.expectedFeeTotal");
  const expectedRealTotal = parseAmount(manifest.expectedRealTotal, "manifest.expectedRealTotal");
  if (expectedFeeTotal !== categoryTotals.get(targetCategory)) {
    throw new Error("Calculated target-category fee total does not match manifest.expectedFeeTotal.");
  }
  if (expectedRealTotal !== (categoryRealTotals.get(targetCategory) ?? 0n)) {
    throw new Error("Calculated target-category real total does not match manifest.expectedRealTotal.");
  }
  const expectedCategoryTotals = requireObject(manifest.expectedCategoryTotals, "manifest.expectedCategoryTotals");
  if (Object.keys(expectedCategoryTotals).length !== categoryTotals.size) {
    throw new Error("manifest.expectedCategoryTotals categories do not match calculated categories.");
  }
  for (const [rawCategory, rawAmount] of Object.entries(expectedCategoryTotals)) {
    const category = cleanString(rawCategory, "manifest.expectedCategoryTotals category");
    if (!categoryTotals.has(category) || parseAmount(rawAmount, `manifest.expectedCategoryTotals.${category}`) !== categoryTotals.get(category)) {
      throw new Error(`Calculated category total does not match manifest.expectedCategoryTotals.${category}.`);
    }
  }

  const filesForDigest = [...verifiedFiles]
    .map(({ id, role, path: filePath, sha256, size }) => ({ id, role, path: filePath, sha256, size }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const transactionsForDigest = [...normalizedTransactions].sort((a, b) => a.id.localeCompare(b.id));
  const manifestDigest = digest(manifest);
  const filesDigest = digest(filesForDigest);
  const transactionsDigest = digest(transactionsForDigest);
  const cacheKey = digest({ rulesVersion, validatorVersion: VALIDATOR_VERSION, manifestDigest, filesDigest, transactionsDigest });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    validatorVersion: VALIDATOR_VERSION,
    manifest: absoluteManifestPath,
    manifestFileSha256: crypto.createHash("sha256").update(rawBytes).digest("hex"),
    manifestDigest,
    filesDigest,
    transactionsDigest,
    cacheKey,
    batch: { rootPath: path.resolve(rootPath), archivePath: path.resolve(archivePath), period, targetCategory, reviewRevision },
    files: verifiedFiles.length,
    transactions: normalizedTransactions.length,
    categoryTotals: Object.fromEntries([...categoryTotals].map(([category, total]) => [category, formatAmount(total)])),
    categoryRealTotals: Object.fromEntries([...categoryRealTotals].map(([category, total]) => [category, formatAmount(total)])),
  })}\n`);
  process.exitCode = 0;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
