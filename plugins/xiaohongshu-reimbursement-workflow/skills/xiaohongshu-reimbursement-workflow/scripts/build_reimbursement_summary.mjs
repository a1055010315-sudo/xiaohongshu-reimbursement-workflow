import fs from "node:fs/promises";
import path from "node:path";

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
}

function parseCents(value, field) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal string with at most two decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function formatCents(cents) {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  if (fraction === 0n) return whole.toString();
  if (fraction % 10n === 0n) return `${whole}.${fraction / 10n}`;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

function cleanField(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const cleaned = value.trim();
  if (!cleaned || /[\t\r\n]/.test(cleaned)) {
    throw new Error(`${field} must be non-empty and contain no tabs or newlines.`);
  }
  return cleaned;
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];

try {
  if (!inputPath || !outputPath) {
    throw new Error("Input JSON path and new output TXT path are required.");
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error("Input and output paths must be different.");
  }

  const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const period = cleanField(payload.period, "period");
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error("entries must be a non-empty array.");
  }

  const groups = new Map();
  let feeTotal = 0n;
  let realTotal = 0n;

  for (const [index, entry] of payload.entries.entries()) {
    const label = cleanField(entry?.label, `entries[${index}].label`);
    if (typeof entry?.reimbursable !== "boolean") {
      throw new Error(`entries[${index}].reimbursable must be boolean.`);
    }
    const cents = parseCents(entry.amount, `entries[${index}].amount`);
    const existing = groups.get(label);
    if (existing && existing.reimbursable !== entry.reimbursable) {
      throw new Error(`Label has conflicting reimbursable values: ${label}`);
    }
    if (existing) {
      existing.cents += cents;
    } else {
      groups.set(label, { cents, reimbursable: entry.reimbursable });
    }
    feeTotal += cents;
    if (entry.reimbursable) realTotal += cents;
  }

  if (payload.expectedFeeTotal !== undefined && parseCents(payload.expectedFeeTotal, "expectedFeeTotal") !== feeTotal) {
    throw new Error("Calculated fee total does not match expectedFeeTotal.");
  }
  if (payload.expectedRealTotal !== undefined && parseCents(payload.expectedRealTotal, "expectedRealTotal") !== realTotal) {
    throw new Error("Calculated real total does not match expectedRealTotal.");
  }

  const lines = [`${period}\t小红书报销`];
  for (const [label, group] of groups) {
    if (group.cents === 0n && payload.includeZero !== true) continue;
    lines.push(`${label}\t${formatCents(group.cents)}`);
  }
  lines.push(`费用合计\t${formatCents(feeTotal)}`);
  lines.push(`实报合计\t${formatCents(realTotal)}`);
  const output = `${lines.join("\n")}\n`;

  await fs.writeFile(outputPath, output, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: path.resolve(outputPath),
    groups: lines.length - 3,
    feeTotal: formatCents(feeTotal),
    realTotal: formatCents(realTotal),
  })}\n`);
  process.exitCode = 0;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
