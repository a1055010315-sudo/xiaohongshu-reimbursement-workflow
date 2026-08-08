import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SCALE = 1000n;

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}

function parseAmount(value, field) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,3})?$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal string with at most three decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "000").slice(0, 3));
}

function formatAmount(amount) {
  const whole = amount / SCALE;
  const fraction = amount % SCALE;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(3, "0").replace(/0+$/, "")}`;
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
    if (!["--input", "--output", "--expect-sha256"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    const key = arg === "--input" ? "input" : arg === "--output" ? "output" : "expectedSha256";
    if (options[key] !== undefined) throw new Error(`${arg} may only be supplied once.`);
    options[key] = value;
    index += 1;
  }
  if (!options.input) throw new Error("--input is required.");
  if (options.preview) {
    if (options.output || options.expectedSha256) {
      throw new Error("Preview mode accepts --input and --preview only.");
    }
  } else {
    if (!options.output || !options.expectedSha256) {
      throw new Error("Write mode requires --input, --output, and --expect-sha256.");
    }
    if (!SHA256_RE.test(options.expectedSha256)) {
      throw new Error("--expect-sha256 must be 64 lowercase hexadecimal characters.");
    }
  }
  return options;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

try {
  const options = parseCli(process.argv.slice(2));
  const inputPath = options.input;
  const outputPath = options.output;
  if (!options.preview && path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("Input and output paths must be different.");
  }

  const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const period = cleanField(payload.period, "period");
  const targetCategory = cleanField(payload.targetCategory ?? "小红书报销", "targetCategory");
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error("entries must be a non-empty array.");
  }

  const groups = new Map();
  const groupsByCategory = new Map();
  const categoryTotals = new Map();
  let feeTotal = 0n;
  let realTotal = 0n;
  let targetHasNonReimbursable = false;

  for (const [index, entry] of payload.entries.entries()) {
    const label = cleanField(entry?.label, `entries[${index}].label`);
    const category = cleanField(entry?.category ?? targetCategory, `entries[${index}].category`);
    if (typeof entry?.reimbursable !== "boolean") {
      throw new Error(`entries[${index}].reimbursable must be boolean.`);
    }
    const amount = parseAmount(entry.amount, `entries[${index}].amount`);
    const groupKey = JSON.stringify([category, label]);
    const existing = groups.get(groupKey);
    if (existing && existing.reimbursable !== entry.reimbursable) {
      throw new Error(`Category and label have conflicting reimbursable values: ${category} / ${label}`);
    }
    if (existing) {
      existing.amount += amount;
    } else {
      const group = { category, label, amount, reimbursable: entry.reimbursable };
      groups.set(groupKey, group);
      if (!groupsByCategory.has(category)) groupsByCategory.set(category, []);
      groupsByCategory.get(category).push(group);
    }
    categoryTotals.set(category, (categoryTotals.get(category) ?? 0n) + amount);
    if (category === targetCategory) {
      feeTotal += amount;
      if (entry.reimbursable) {
        realTotal += amount;
      } else {
        targetHasNonReimbursable = true;
      }
    }
  }

  if (payload.expectedFeeTotal !== undefined && parseAmount(payload.expectedFeeTotal, "expectedFeeTotal") !== feeTotal) {
    throw new Error("Calculated fee total does not match expectedFeeTotal.");
  }
  if (payload.expectedRealTotal !== undefined && parseAmount(payload.expectedRealTotal, "expectedRealTotal") !== realTotal) {
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
      if (!categoryTotals.has(category) || parseAmount(amount, `expectedCategoryTotals.${category}`) !== categoryTotals.get(category)) {
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
      if (targetHasNonReimbursable) lines.push(`费用合计：${formatAmount(feeTotal)}`);
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
    categoryTotals: Object.fromEntries([...categoryTotals].map(([category, amount]) => [category, formatAmount(amount)])),
    feeTotal: formatAmount(feeTotal),
    realTotal: formatAmount(realTotal),
    textSha256,
  };
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
