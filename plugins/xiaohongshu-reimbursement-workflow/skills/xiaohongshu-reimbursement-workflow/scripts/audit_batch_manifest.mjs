import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";

const VALIDATOR_VERSION = "4";
const AMOUNT_SCALE = 1000n;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SETTLEMENTS = new Set(["employee_reimbursement", "company_paid_no_reimbursement"]);
const ADJUSTMENT_TYPES = new Set(["refund", "adjustment"]);
const OPERATION_MODES = new Set(["reimbursement-batch", "ledger-reorder-correction"]);

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

function parseAmount(value, field, { allowNegative = false } = {}) {
  const expression = allowNegative ? /^-?(0|[1-9]\d*)(\.\d{1,3})?$/ : /^(0|[1-9]\d*)(\.\d{1,3})?$/;
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

function formatAmount(value) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / AMOUNT_SCALE;
  const fraction = absolute % AMOUNT_SCALE;
  const rendered = fraction === 0n
    ? whole.toString()
    : `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
  return negative ? `-${rendered}` : rendered;
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

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
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

function normalizeOperation(manifest) {
  if (manifest.version === 1) {
    if (manifest.operation !== undefined) {
      throw new Error("manifest.operation is only supported by manifest.version 2 or 3.");
    }
    return { mode: "reimbursement-batch" };
  }
  if (manifest.version !== 2 && manifest.version !== 3) {
    throw new Error("manifest.version must be 1, 2, or 3.");
  }
  const operation = requireObject(manifest.operation, "manifest.operation");
  const mode = cleanString(operation.mode, "manifest.operation.mode");
  if (!OPERATION_MODES.has(mode)) {
    throw new Error("manifest.operation.mode must be reimbursement-batch or ledger-reorder-correction.");
  }
  if (mode === "reimbursement-batch") {
    for (const field of [
      "candidateRevision",
      "supersedes",
      "planFileSha256",
      "correctionPolicy",
      "expectedRecordCount",
      "expectedPhysicalRecordRowCount",
      "expectedScopedRecordCount",
      "expectedScopedRowCount",
      "expectedScopedAmount",
      "expectedAmountDelta",
    ]) {
      if (operation[field] !== undefined) {
        throw new Error(`manifest.operation.${field} is only valid for ledger-reorder-correction.`);
      }
    }
    return { mode };
  }

  if (!Number.isSafeInteger(operation.candidateRevision) || operation.candidateRevision < 1) {
    throw new Error("manifest.operation.candidateRevision must be a positive safe integer.");
  }
  let supersedes = null;
  if (operation.supersedes !== null && operation.supersedes !== undefined) {
    supersedes = cleanString(operation.supersedes, "manifest.operation.supersedes");
  }
  if (operation.candidateRevision === 1 && supersedes !== null) {
    throw new Error("The first correction revision must use supersedes:null.");
  }
  if (operation.candidateRevision > 1 && supersedes === null) {
    throw new Error("Correction revisions after the first must identify the superseded candidate.");
  }
  const planFileSha256 = cleanString(operation.planFileSha256, "manifest.operation.planFileSha256").toLowerCase();
  if (!SHA256_RE.test(planFileSha256)) {
    throw new Error("manifest.operation.planFileSha256 must be 64 lowercase hex characters.");
  }
  const correctionPolicy = requireObject(operation.correctionPolicy, "manifest.operation.correctionPolicy");
  const sheetName = cleanString(correctionPolicy.sheetName, "manifest.operation.correctionPolicy.sheetName");
  const physicalRange = cleanString(
    correctionPolicy.physicalRange,
    "manifest.operation.correctionPolicy.physicalRange",
  );
  if (!/^\$?[A-Z]{1,3}\$?[1-9]\d*:\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(physicalRange)) {
    throw new Error("manifest.operation.correctionPolicy.physicalRange must be a two-cell A1 range without a sheet prefix.");
  }
  const scopeStart = cleanIsoDate(correctionPolicy.scopeStart, "manifest.operation.correctionPolicy.scopeStart");
  const scopeStartInclusive = correctionPolicy.scopeStartInclusive ?? correctionPolicy.inclusive;
  if (typeof scopeStartInclusive !== "boolean") {
    throw new Error(
      "manifest.operation.correctionPolicy.scopeStartInclusive (or legacy inclusive) must be boolean.",
    );
  }
  if (
    correctionPolicy.scopeStartInclusive !== undefined &&
    correctionPolicy.inclusive !== undefined &&
    correctionPolicy.scopeStartInclusive !== correctionPolicy.inclusive
  ) {
    throw new Error("manifest.operation.correctionPolicy inclusive aliases must not conflict.");
  }
  const scopeEnd = cleanIsoDate(correctionPolicy.scopeEnd, "manifest.operation.correctionPolicy.scopeEnd");
  if (scopeEnd < scopeStart) {
    throw new Error("manifest.operation.correctionPolicy.scopeEnd must not precede scopeStart.");
  }
  if (typeof correctionPolicy.scopeEndInclusive !== "boolean") {
    throw new Error("manifest.operation.correctionPolicy.scopeEndInclusive must be boolean.");
  }
  if (!Array.isArray(correctionPolicy.sortKeys) || correctionPolicy.sortKeys.length !== 2) {
    throw new Error("manifest.operation.correctionPolicy.sortKeys must be exactly date:asc then baselineOrder:asc.");
  }
  const sortKeys = correctionPolicy.sortKeys.map((value, index) =>
    cleanString(value, `manifest.operation.correctionPolicy.sortKeys[${index}]`),
  );
  if (sortKeys[0] !== "date:asc" || sortKeys[1] !== "baselineOrder:asc") {
    throw new Error("manifest.operation.correctionPolicy.sortKeys must be ordered as date:asc then baselineOrder:asc.");
  }
  const stableTieBreaker = cleanString(
    correctionPolicy.stableTieBreaker,
    "manifest.operation.correctionPolicy.stableTieBreaker",
  );
  if (stableTieBreaker !== "baselineOrder") {
    throw new Error("manifest.operation.correctionPolicy.stableTieBreaker must be baselineOrder.");
  }
  if (correctionPolicy.blankRowsPolicy !== "preserve-physical") {
    throw new Error(
      'manifest.operation.correctionPolicy.blankRowsPolicy must be the exact string "preserve-physical".',
    );
  }
  if (!Number.isSafeInteger(operation.expectedRecordCount) || operation.expectedRecordCount < 1) {
    throw new Error("manifest.operation.expectedRecordCount must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(operation.expectedPhysicalRecordRowCount) || operation.expectedPhysicalRecordRowCount < 1) {
    throw new Error("manifest.operation.expectedPhysicalRecordRowCount must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(operation.expectedScopedRecordCount) || operation.expectedScopedRecordCount < 0) {
    throw new Error("manifest.operation.expectedScopedRecordCount must be a non-negative safe integer.");
  }
  if (operation.expectedScopedRecordCount > operation.expectedRecordCount) {
    throw new Error("manifest.operation.expectedScopedRecordCount must not exceed expectedRecordCount.");
  }
  if (!Number.isSafeInteger(operation.expectedScopedRowCount) || operation.expectedScopedRowCount < 1) {
    throw new Error("manifest.operation.expectedScopedRowCount must be a positive safe integer.");
  }
  if (operation.expectedScopedRowCount > operation.expectedPhysicalRecordRowCount) {
    throw new Error("manifest.operation.expectedScopedRowCount must not exceed expectedPhysicalRecordRowCount.");
  }
  const expectedScopedAmount = parseAmount(
    operation.expectedScopedAmount,
    "manifest.operation.expectedScopedAmount",
    { allowNegative: true },
  );
  if (operation.expectedAmountDelta !== "0") {
    throw new Error('manifest.operation.expectedAmountDelta must be the exact string "0" for ledger-reorder-correction.');
  }
  return {
    mode,
    candidateRevision: operation.candidateRevision,
    supersedes,
    planFileSha256,
    correctionPolicy: {
      sheetName,
      physicalRange,
      scopeStart,
      scopeStartInclusive,
      scopeEnd,
      scopeEndInclusive: correctionPolicy.scopeEndInclusive,
      sortKeys,
      stableTieBreaker,
      blankRowsPolicy: "preserve-physical",
    },
    expectedRecordCount: operation.expectedRecordCount,
    expectedPhysicalRecordRowCount: operation.expectedPhysicalRecordRowCount,
    expectedScopedRecordCount: operation.expectedScopedRecordCount,
    expectedScopedRowCount: operation.expectedScopedRowCount,
    expectedScopedAmount: formatAmount(expectedScopedAmount),
    expectedAmountDelta: "0",
  };
}

function settlementForTransaction(transaction, index, manifestVersion) {
  if (manifestVersion === 1) {
    if (typeof transaction.reimbursable !== "boolean") {
      throw new Error(`manifest.transactions[${index}].reimbursable must be boolean.`);
    }
    return transaction.reimbursable ? "employee_reimbursement" : "company_paid_no_reimbursement";
  }
  const settlement = cleanString(transaction.settlement, `manifest.transactions[${index}].settlement`);
  if (!SETTLEMENTS.has(settlement)) {
    throw new Error(
      `manifest.transactions[${index}].settlement must be employee_reimbursement or company_paid_no_reimbursement.`,
    );
  }
  if (transaction.reimbursable !== undefined) {
    if (typeof transaction.reimbursable !== "boolean") {
      throw new Error(`manifest.transactions[${index}].reimbursable must be boolean when supplied.`);
    }
    const compatible = settlement === "employee_reimbursement";
    if (transaction.reimbursable !== compatible) {
      throw new Error(`manifest.transactions[${index}] has conflicting settlement and reimbursable values.`);
    }
  }
  return settlement;
}

function normalizeAdjustment(transaction, index, amount, manifestVersion) {
  if (amount >= 0n) {
    if (transaction.adjustment !== undefined) {
      throw new Error(`manifest.transactions[${index}].adjustment is only allowed for a negative amount.`);
    }
    return undefined;
  }
  if (manifestVersion === 1) {
    throw new Error(`manifest.transactions[${index}].amount must be non-negative for manifest.version 1.`);
  }
  const adjustment = requireObject(transaction.adjustment, `manifest.transactions[${index}].adjustment`);
  const type = cleanString(adjustment.type, `manifest.transactions[${index}].adjustment.type`);
  if (!ADJUSTMENT_TYPES.has(type)) {
    throw new Error(`manifest.transactions[${index}].adjustment.type must be refund or adjustment.`);
  }
  return {
    type,
    sourceTransactionId: cleanString(
      adjustment.sourceTransactionId,
      `manifest.transactions[${index}].adjustment.sourceTransactionId`,
    ),
    reason: cleanString(adjustment.reason, `manifest.transactions[${index}].adjustment.reason`),
  };
}

function normalizeV3SourceCoverage(manifest, normalizedOperation, fileById) {
  if (manifest.version !== 3) return undefined;
  if (normalizedOperation.mode !== "reimbursement-batch") {
    throw new Error("manifest.version 3 currently supports only reimbursement-batch operations.");
  }
  if (!Array.isArray(manifest.sourceScopes) || manifest.sourceScopes.length === 0) {
    throw new Error("manifest.sourceScopes must be a non-empty array for manifest.version 3 reimbursement-batch.");
  }
  if (!Array.isArray(manifest.sourceUnits) || manifest.sourceUnits.length === 0) {
    throw new Error("manifest.sourceUnits must be a non-empty array for manifest.version 3 reimbursement-batch.");
  }

  const scopeIds = new Set();
  const normalizedScopes = manifest.sourceScopes.map((rawScope, index) => {
    const scope = requireObject(rawScope, `manifest.sourceScopes[${index}]`);
    const id = cleanString(scope.id, `manifest.sourceScopes[${index}].id`);
    if (scopeIds.has(id)) throw new Error(`Duplicate source scope id: ${id}`);
    scopeIds.add(id);
    const fileId = cleanString(scope.fileId, `manifest.sourceScopes[${index}].fileId`);
    const sourceFile = fileById.get(fileId);
    if (!sourceFile) {
      throw new Error(`Source scope ${id} references missing file id: ${fileId}`);
    }
    if (sourceFile.role !== "material") {
      throw new Error(`Source scope ${id} file ${fileId} is not a material file.`);
    }
    const locator = cleanString(scope.locator, `manifest.sourceScopes[${index}].locator`);
    if (scope.terminalConfirmed !== true) {
      throw new Error(`manifest.sourceScopes[${index}].terminalConfirmed must be true.`);
    }
    if (!Number.isSafeInteger(scope.expectedUnitCount) || scope.expectedUnitCount < 1) {
      throw new Error(`manifest.sourceScopes[${index}].expectedUnitCount must be a positive safe integer.`);
    }
    return { id, fileId, locator, terminalConfirmed: true, expectedUnitCount: scope.expectedUnitCount };
  });
  const scopeById = new Map(normalizedScopes.map((scope) => [scope.id, scope]));
  const unitsPerScope = new Map(normalizedScopes.map((scope) => [scope.id, 0]));
  const unitIds = new Set();
  const normalizedUnits = manifest.sourceUnits.map((rawUnit, index) => {
    const unit = requireObject(rawUnit, `manifest.sourceUnits[${index}]`);
    const id = cleanString(unit.id, `manifest.sourceUnits[${index}].id`);
    if (unitIds.has(id)) throw new Error(`Duplicate source unit id: ${id}`);
    unitIds.add(id);
    const scopeId = cleanString(unit.scopeId, `manifest.sourceUnits[${index}].scopeId`);
    const scope = scopeById.get(scopeId);
    if (!scope) throw new Error(`Source unit ${id} references missing source scope: ${scopeId}`);
    const locator = cleanString(unit.locator, `manifest.sourceUnits[${index}].locator`);
    const disposition = cleanString(unit.disposition, `manifest.sourceUnits[${index}].disposition`);
    if (disposition !== "used" && disposition !== "excluded") {
      throw new Error(`manifest.sourceUnits[${index}].disposition must be used or excluded.`);
    }
    const normalized = { id, scopeId, locator, disposition };
    if (disposition === "excluded") {
      normalized.reason = cleanString(unit.reason, `manifest.sourceUnits[${index}].reason`);
    } else {
      const sourceFile = fileById.get(scope.fileId);
      if (sourceFile.disposition !== "used") {
        throw new Error(`Used source unit ${id} belongs to excluded material file: ${scope.fileId}`);
      }
    }
    unitsPerScope.set(scopeId, unitsPerScope.get(scopeId) + 1);
    return normalized;
  });
  for (const [scopeId, unitCount] of unitsPerScope) {
    const scope = scopeById.get(scopeId);
    if (unitCount !== scope.expectedUnitCount) {
      throw new Error(
        `Source scope ${scopeId} expected ${scope.expectedUnitCount} units but registered ${unitCount}.`,
      );
    }
  }
  return {
    scopes: normalizedScopes,
    scopeById,
    units: normalizedUnits,
    unitById: new Map(normalizedUnits.map((unit) => [unit.id, unit])),
  };
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

  const normalizedOperation = normalizeOperation(manifest);
  const rulesVersion = cleanString(manifest.rulesVersion, "manifest.rulesVersion");
  const batch = requireObject(manifest.batch, "manifest.batch");
  const rootPath = cleanString(batch.rootPath, "manifest.batch.rootPath");
  const archivePath = cleanString(batch.archivePath, "manifest.batch.archivePath");
  const period = cleanString(batch.period, "manifest.batch.period");
  const targetCategory = cleanString(batch.targetCategory, "manifest.batch.targetCategory");
  const batchId = manifest.version >= 2 ? cleanString(batch.batchId, "manifest.batch.batchId") : undefined;
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
  const normalizedBatch = {
    rootPath: path.resolve(rootPath),
    archivePath: path.resolve(archivePath),
    period,
    targetCategory,
    reviewRevision,
  };
  if (batchId !== undefined) normalizedBatch.batchId = batchId;

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
    if (role === "candidate" && file.current !== undefined) {
      if (typeof file.current !== "boolean") {
        throw new Error(`manifest.files[${index}].current must be boolean.`);
      }
      normalized.current = file.current;
    }
    return normalized;
  });
  const baselineFiles = normalizedFiles.filter((file) => file.role === "baseline");
  if (baselineFiles.length !== 1) throw new Error("manifest.files must contain exactly one baseline role.");
  if (!isStrictDescendant(rootPath, baselineFiles[0].path)) {
    throw new Error("The baseline file must be inside manifest.batch.rootPath.");
  }
  const fileById = new Map(normalizedFiles.map((file) => [file.id, file]));
  const sourceCoverage = normalizeV3SourceCoverage(manifest, normalizedOperation, fileById);

  let correctionBindings;
  if (normalizedOperation.mode === "ledger-reorder-correction") {
    const candidateFiles = normalizedFiles.filter((file) => file.role === "candidate");
    for (const candidate of candidateFiles) {
      if (typeof candidate.current !== "boolean") {
        throw new Error(`Correction candidate ${candidate.id} must declare current as boolean.`);
      }
    }
    const currentCandidates = candidateFiles.filter((file) => file.current === true);
    if (currentCandidates.length !== 1) {
      throw new Error("ledger-reorder-correction must contain exactly one current candidate.");
    }
    if (new Set(candidateFiles.map((file) => pathKey(file.path))).size !== candidateFiles.length) {
      throw new Error("Correction candidate files must use distinct absolute paths.");
    }
    const currentCandidate = currentCandidates[0];
    let supersededCandidate = null;
    if (normalizedOperation.supersedes === null) {
      if (candidateFiles.length !== 1) {
        throw new Error("The first correction revision must contain only its one current candidate.");
      }
    } else {
      supersededCandidate = fileById.get(normalizedOperation.supersedes);
      if (!supersededCandidate || supersededCandidate.role !== "candidate" || supersededCandidate.current !== false) {
        throw new Error("manifest.operation.supersedes must reference a non-current candidate file id.");
      }
      if (currentCandidate.id === normalizedOperation.supersedes) {
        throw new Error("The current candidate cannot supersede itself.");
      }
    }
    if (samePath(currentCandidate.path, baselineFiles[0].path)) {
      throw new Error("The current correction candidate path must differ from the baseline path.");
    }
    correctionBindings = {
      baselineId: baselineFiles[0].id,
      currentCandidateId: currentCandidate.id,
      supersedes: supersededCandidate?.id ?? null,
      planFileSha256: normalizedOperation.planFileSha256,
    };
  }

  const verifiedFiles = await mapWithConcurrency(normalizedFiles, 4, async (file) => {
    const stat = await fsp.stat(file.path);
    if (!stat.isFile()) throw new Error(`Manifest file is not a regular file: ${file.id}`);
    const actualSha256 = await sha256File(file.path);
    if (actualSha256 !== file.sha256) {
      throw new Error(`SHA256 mismatch for ${file.id}: expected ${file.sha256}, actual ${actualSha256}`);
    }
    return { ...file, size: stat.size };
  });

  const categoryTotals = new Map();
  const categoryRealTotals = new Map();
  const settlementTotals = new Map();
  const referencedMaterialIds = new Set();
  const referencedSourceUnitIds = new Set();
  let transactionSourceRefCount = 0;
  let normalizedTransactions = [];
  let normalizedExpectedTotals;
  let sourceCoverageCounts;
  if (normalizedOperation.mode === "reimbursement-batch") {
    if (!Array.isArray(manifest.transactions) || manifest.transactions.length === 0) {
      throw new Error("manifest.transactions must be a non-empty array for reimbursement-batch.");
    }
    const transactionIds = new Set();
    const sourceOrders = new Set();
    normalizedTransactions = manifest.transactions.map((rawTransaction, index) => {
      const transaction = requireObject(rawTransaction, `manifest.transactions[${index}]`);
      const id = cleanString(transaction.id, `manifest.transactions[${index}].id`);
      if (transactionIds.has(id)) throw new Error(`Duplicate transaction id: ${id}`);
      transactionIds.add(id);
      let sourceOrder;
      if (manifest.version >= 2) {
        if (!Number.isSafeInteger(transaction.sourceOrder) || transaction.sourceOrder < 1) {
          throw new Error(`manifest.transactions[${index}].sourceOrder must be a positive safe integer.`);
        }
        sourceOrder = transaction.sourceOrder;
        if (sourceOrders.has(sourceOrder)) {
          throw new Error(`Duplicate sourceOrder: ${sourceOrder}`);
        }
        sourceOrders.add(sourceOrder);
      }
      const date = cleanIsoDate(transaction.date, `manifest.transactions[${index}].date`);
      const person = cleanString(transaction.person, `manifest.transactions[${index}].person`);
      const project = cleanString(transaction.project, `manifest.transactions[${index}].project`);
      const label = cleanString(transaction.label, `manifest.transactions[${index}].label`);
      const category = cleanString(transaction.category, `manifest.transactions[${index}].category`);
      const classification = manifest.version === 3
        ? cleanString(transaction.classification, `manifest.transactions[${index}].classification`)
        : undefined;
      const amount = parseAmount(transaction.amount, `manifest.transactions[${index}].amount`, {
        allowNegative: manifest.version >= 2,
      });
      const settlement = settlementForTransaction(transaction, index, manifest.version);
      const adjustment = normalizeAdjustment(transaction, index, amount, manifest.version);
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
      let sourceRefs;
      if (manifest.version === 3) {
        if (!Array.isArray(transaction.sourceRefs) || transaction.sourceRefs.length === 0) {
          throw new Error(`manifest.transactions[${index}].sourceRefs must be a non-empty array.`);
        }
        sourceRefs = transaction.sourceRefs.map((value, sourceRefIndex) =>
          cleanString(value, `manifest.transactions[${index}].sourceRefs[${sourceRefIndex}]`),
        );
        if (new Set(sourceRefs).size !== sourceRefs.length) {
          throw new Error(`manifest.transactions[${index}].sourceRefs contains duplicate ids.`);
        }
        for (const sourceRef of sourceRefs) {
          const sourceUnit = sourceCoverage.unitById.get(sourceRef);
          if (!sourceUnit) {
            throw new Error(`Transaction ${id} references missing source unit: ${sourceRef}`);
          }
          if (sourceUnit.disposition !== "used") {
            throw new Error(`Transaction ${id} references excluded source unit: ${sourceRef}`);
          }
          const sourceScope = sourceCoverage.scopeById.get(sourceUnit.scopeId);
          if (!evidence.includes(sourceScope.fileId)) {
            throw new Error(
              `Transaction ${id} source unit ${sourceRef} requires evidence file ${sourceScope.fileId}.`,
            );
          }
          referencedSourceUnitIds.add(sourceRef);
        }
        transactionSourceRefCount += sourceRefs.length;
      }
      const imageEvidence = evidence.filter((evidenceId) => fileById.get(evidenceId).kind === "image");
      if (imageEvidence.length === 0 && transaction.missingEvidenceConfirmed !== true) {
        throw new Error(`Transaction ${id} has no image evidence and is not marked missingEvidenceConfirmed.`);
      }
      if (imageEvidence.length > 0 && transaction.missingEvidenceConfirmed === true) {
        throw new Error(`Transaction ${id} cannot have image evidence and missingEvidenceConfirmed together.`);
      }
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0n) + amount);
      settlementTotals.set(settlement, (settlementTotals.get(settlement) ?? 0n) + amount);
      if (settlement === "employee_reimbursement") {
        categoryRealTotals.set(category, (categoryRealTotals.get(category) ?? 0n) + amount);
      }
      const normalized = {
        id,
        date,
        person,
        project,
        label,
        amount: formatAmount(amount),
        category,
      };
      if (classification !== undefined) normalized.classification = classification;
      if (manifest.version === 1) {
        normalized.reimbursable = transaction.reimbursable;
      } else {
        normalized.sourceOrder = sourceOrder;
        normalized.settlement = settlement;
        if (adjustment) normalized.adjustment = adjustment;
      }
      normalized.evidence = evidence;
      if (sourceRefs !== undefined) normalized.sourceRefs = sourceRefs;
      normalized.missingEvidenceConfirmed = transaction.missingEvidenceConfirmed === true;
      return normalized;
    });

    const transactionById = new Map(normalizedTransactions.map((transaction) => [transaction.id, transaction]));
    const refundTotalsBySource = new Map();
    for (const transaction of normalizedTransactions) {
      if (!transaction.adjustment) continue;
      const source = transactionById.get(transaction.adjustment.sourceTransactionId);
      if (!source || source.id === transaction.id) {
        throw new Error(`Transaction ${transaction.id} adjustment must reference a different transaction in the same manifest.`);
      }
      const sourceAmount = parseAmount(source.amount, `source transaction ${source.id}.amount`, { allowNegative: true });
      if (sourceAmount <= 0n) {
        throw new Error(`Transaction ${transaction.id} adjustment source must have a positive amount.`);
      }
      if (source.category !== transaction.category || source.settlement !== transaction.settlement) {
        throw new Error(`Transaction ${transaction.id} adjustment source must have the same category and settlement.`);
      }
      if (transaction.adjustment.type === "refund") {
        const refundAmount = -parseAmount(transaction.amount, `transaction ${transaction.id}.amount`, { allowNegative: true });
        refundTotalsBySource.set(source.id, (refundTotalsBySource.get(source.id) ?? 0n) + refundAmount);
      }
    }
    for (const [sourceId, refundTotal] of refundTotalsBySource) {
      const sourceAmount = parseAmount(transactionById.get(sourceId).amount, `source transaction ${sourceId}.amount`, {
        allowNegative: true,
      });
      if (refundTotal > sourceAmount) {
        throw new Error(`Refunds referencing transaction ${sourceId} exceed its positive amount.`);
      }
    }

    if (sourceCoverage) {
      for (const sourceUnit of sourceCoverage.units) {
        const referenced = referencedSourceUnitIds.has(sourceUnit.id);
        if (sourceUnit.disposition === "used" && !referenced) {
          throw new Error(`Used source unit is not referenced by any transaction: ${sourceUnit.id}`);
        }
        if (sourceUnit.disposition === "excluded" && referenced) {
          throw new Error(`Excluded source unit must not be referenced: ${sourceUnit.id}`);
        }
      }
      sourceCoverageCounts = {
        scopes: sourceCoverage.scopes.length,
        units: sourceCoverage.units.length,
        usedUnits: sourceCoverage.units.filter((unit) => unit.disposition === "used").length,
        excludedUnits: sourceCoverage.units.filter((unit) => unit.disposition === "excluded").length,
        referencedUnits: referencedSourceUnitIds.size,
        transactionRefs: transactionSourceRefCount,
      };
    }

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
    const allowNegative = manifest.version >= 2;
    const expectedFeeTotal = parseAmount(manifest.expectedFeeTotal, "manifest.expectedFeeTotal", { allowNegative });
    const expectedRealTotal = parseAmount(manifest.expectedRealTotal, "manifest.expectedRealTotal", { allowNegative });
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
      if (
        !categoryTotals.has(category) ||
        parseAmount(rawAmount, `manifest.expectedCategoryTotals.${category}`, { allowNegative }) !== categoryTotals.get(category)
      ) {
        throw new Error(`Calculated category total does not match manifest.expectedCategoryTotals.${category}.`);
      }
    }
    normalizedExpectedTotals = {
      feeTotal: formatAmount(expectedFeeTotal),
      realTotal: formatAmount(expectedRealTotal),
      categoryTotals: Object.fromEntries(
        [...categoryTotals]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([category, total]) => [category, formatAmount(total)]),
      ),
    };
  } else if (
    manifest.transactions !== undefined ||
    manifest.expectedFeeTotal !== undefined ||
    manifest.expectedRealTotal !== undefined ||
    manifest.expectedCategoryTotals !== undefined
  ) {
    throw new Error("ledger-reorder-correction must not contain reimbursement transactions or reimbursement totals.");
  }

  const filesForDigest = [...verifiedFiles]
    .map(({ id, role, path: filePath, sha256, size, current }) => {
      const result = { id, role, path: filePath, sha256, size };
      if (current !== undefined) result.current = current;
      return result;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const transactionsForDigest = [...normalizedTransactions].sort((a, b) => a.id.localeCompare(b.id));
  const manifestDigest = digest(manifest);
  const filesDigest = digest(filesForDigest);
  const transactionsDigest = digest(transactionsForDigest);
  let factsDigest;
  let evidenceDigest;
  let sourceCoverageDigest;
  if (manifest.version >= 2) {
    const factTransactions = transactionsForDigest.map(({
      evidence,
      missingEvidenceConfirmed,
      sourceRefs,
      ...transaction
    }) => transaction);
    factsDigest = digest({
      batchId,
      targetCategory,
      transactions: factTransactions,
      expectedTotals: normalizedExpectedTotals ?? null,
    });
    const usedMaterials = verifiedFiles
      .filter((file) => file.role === "material" && file.disposition === "used")
      .map(({ id, sha256, kind, disposition }) => ({ id, sha256, kind, disposition }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const transactionEvidence = transactionsForDigest.map(({ id, evidence, missingEvidenceConfirmed }) => ({
      transactionId: id,
      evidence,
      missingEvidenceConfirmed,
    }));
    evidenceDigest = digest({ usedMaterials, transactionEvidence });
  }
  if (manifest.version === 3) {
    const verifiedFileById = new Map(verifiedFiles.map((file) => [file.id, file]));
    const sourceScopesForDigest = sourceCoverage.scopes
      .map(({ id, fileId, locator, terminalConfirmed, expectedUnitCount }) => ({
        id,
        fileId,
        fileSha256: verifiedFileById.get(fileId).sha256,
        locator,
        terminalConfirmed,
        expectedUnitCount,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const sourceUnitsForDigest = sourceCoverage.units
      .map((unit) => ({ ...unit }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const transactionSourceRefs = transactionsForDigest.map(({ id, sourceRefs }) => ({
      transactionId: id,
      sourceRefs: [...sourceRefs].sort((left, right) => left.localeCompare(right)),
    }));
    sourceCoverageDigest = digest({
      sourceScopes: sourceScopesForDigest,
      sourceUnits: sourceUnitsForDigest,
      transactionSourceRefs,
    });
  }
  const operationForDigest = correctionBindings
    ? { ...normalizedOperation, bindings: correctionBindings }
    : normalizedOperation;
  const operationDigest = digest(operationForDigest);
  const configDigest = digest({
    manifestVersion: manifest.version,
    rulesVersion,
    batch: normalizedBatch,
    operation: operationForDigest,
  });
  const cacheKey = manifest.version === 1
    ? digest({ rulesVersion, validatorVersion: VALIDATOR_VERSION, manifestDigest, filesDigest, transactionsDigest })
    : digest({
      rulesVersion,
      validatorVersion: VALIDATOR_VERSION,
      manifestDigest,
      filesDigest,
      transactionsDigest,
      operationDigest,
      configDigest,
      factsDigest,
      evidenceDigest,
      ...(sourceCoverageDigest ? { sourceCoverageDigest } : {}),
    });

  const result = {
    ok: true,
    validatorVersion: VALIDATOR_VERSION,
    manifest: absoluteManifestPath,
    manifestFileSha256: crypto.createHash("sha256").update(rawBytes).digest("hex"),
    manifestDigest,
    filesDigest,
    transactionsDigest,
    operationDigest,
    configDigest,
    cacheKey,
    batch: normalizedBatch,
    operation: operationForDigest,
    files: verifiedFiles.length,
    transactions: normalizedTransactions.length,
  };
  if (manifest.version >= 2) {
    result.factsDigest = factsDigest;
    result.evidenceDigest = evidenceDigest;
    result.normalizedTransactions = normalizedTransactions;
  }
  if (manifest.version === 3) {
    result.sourceCoverageDigest = sourceCoverageDigest;
    result.sourceCoverageCounts = sourceCoverageCounts;
  }
  if (normalizedOperation.mode === "reimbursement-batch") {
    result.categoryTotals = Object.fromEntries(
      [...categoryTotals].map(([category, total]) => [category, formatAmount(total)]),
    );
    result.categoryRealTotals = Object.fromEntries(
      [...categoryRealTotals].map(([category, total]) => [category, formatAmount(total)]),
    );
    result.settlementTotals = Object.fromEntries(
      [...settlementTotals].map(([settlement, total]) => [settlement, formatAmount(total)]),
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 0;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
