import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const MAX_SEGMENTS = 100;

function cleanError(error) {
  return error instanceof Error ? error.message : String(error);
}

function exactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${field} has an invalid field set.`);
  }
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error(`${field} must be a non-empty string without tabs or newlines.`);
  }
  return value.trim();
}

function absolute(value, field) {
  const input = text(value, field);
  if (!path.isAbsolute(input) || path.resolve(input) !== input) throw new Error(`${field} must be a normalized absolute path.`);
  return input;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function loadRequest(requestPath) {
  const bytes = await fs.readFile(requestPath);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""));
  exactObject(value, new Set(["version", "candidatePath", "outputDir", "sheetName", "segments"]), "request");
  if (value.version !== 1) throw new Error("request.version must be 1.");
  const candidatePath = absolute(value.candidatePath, "request.candidatePath");
  const outputDir = absolute(value.outputDir, "request.outputDir");
  const sheetName = text(value.sheetName, "request.sheetName");
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > MAX_SEGMENTS) {
    throw new Error(`request.segments must contain between 1 and ${MAX_SEGMENTS} entries.`);
  }
  const segments = value.segments.map((entry, index) => {
    exactObject(entry, new Set(["sheetName", "range"]), `request.segments[${index}]`);
    const entrySheetName = text(entry.sheetName, `request.segments[${index}].sheetName`);
    const range = text(entry.range, `request.segments[${index}].range`);
    if (entrySheetName !== sheetName || !/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/.test(range)) {
      throw new Error(`request.segments[${index}] has an invalid sheet or range.`);
    }
    return { sheetName: entrySheetName, range };
  });
  return { candidatePath, outputDir, sheetName, segments };
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: render_ledger_reorder_preview_worker.mjs <request.json>");
  const requestPath = absolute(path.resolve(process.argv[2]), "request path");
  const request = await loadRequest(requestPath);
  const modulePath = require.resolve("@oai/artifact-tool");
  const { FileBlob, SpreadsheetFile } = await import(pathToFileURL(modulePath).href);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(request.candidatePath));
  if (!workbook.worksheets.getItem(request.sheetName)) throw new Error(`Worksheet not found: ${request.sheetName}`);
  const width = Math.max(3, String(request.segments.length).length);
  const files = [];
  for (let index = 0; index < request.segments.length; index += 1) {
    const segment = request.segments[index];
    const blob = await workbook.render({
      sheetName: segment.sheetName,
      range: segment.range,
      scale: 1,
      format: "png",
    });
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (
      bytes.length < 8 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      throw new Error(`Renderer did not return PNG bytes for ${segment.sheetName}!${segment.range}.`);
    }
    const filePath = path.join(request.outputDir, `segment-${String(index + 1).padStart(width, "0")}.png`);
    await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    files.push({ ...segment, path: filePath, sha256: sha256(bytes) });
  }
  fsSync.writeSync(1, `${JSON.stringify({ ok: true, files })}\n`);
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  fsSync.writeSync(2, `${JSON.stringify({ ok: false, error: cleanError(error) })}\n`);
  process.exitCode = 1;
}
