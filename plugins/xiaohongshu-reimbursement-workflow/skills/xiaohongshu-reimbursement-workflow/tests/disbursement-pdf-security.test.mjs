import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { auditDisbursementManifest, validateCompletePdfBytes } from "../scripts/disbursement_manifest.mjs";
import { importBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";
import { createCompactDisbursementProductionFixture } from "./disbursement-production-fixture.mjs";

const execFileAsync = promisify(execFile);
const workflowRunner = fileURLToPath(new URL("../scripts/run_compact_disbursement_workflow.mjs", import.meta.url));

function assemblePdf(objects, trailerEntries = "") {
  let body = "%PDF-1.7\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (const [number, objectBody] of objects) {
    assert.equal(number, offsets.length);
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${number} 0 obj\n${objectBody}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerEntries} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function streamObject(content) {
  const bytes = Buffer.from(content, "latin1");
  return `<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`;
}

function onePagePdf({ content = "q\nQ", encrypted = false } = {}) {
  const objects = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>"],
    [4, streamObject(content)],
  ];
  let trailer = "";
  if (encrypted) {
    objects.push([5, "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff> /U <ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100> /P -4 >>"]);
    trailer = " /Encrypt 5 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]";
  }
  return assemblePdf(objects, trailer);
}

function zeroPagePdf() {
  return assemblePdf([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [] /Count 0 >>"],
  ]);
}

async function bundledPypdfPython() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.XHS_BUNDLED_PYTHON,
    path.resolve(executableDirectory, "..", "..", "python", process.platform === "win32" ? "python.exe" : "bin/python3"),
    path.resolve(executableDirectory, "..", "..", "python", process.platform === "win32" ? "python.exe" : "bin/python"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const { stdout, stderr } = await execFileAsync(candidate, ["-c", "import pypdf; print(pypdf.__version__)"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
      });
      if (!stderr && /^\d+\./u.test(stdout.trim())) return candidate;
    } catch {
      // Try only fixed bundled-runtime locations; never search PATH or the workspace.
    }
  }
  throw new Error("bundled Python with pypdf is unavailable for the real encrypted-PDF fixture");
}

async function createRealEmptyUserPasswordPdf(filePath) {
  const python = await bundledPypdfPython();
  const script = [
    "import json, sys",
    "from pypdf import PdfReader, PdfWriter",
    "writer = PdfWriter()",
    "writer.add_blank_page(width=200, height=200)",
    "writer.encrypt(user_password='', owner_password='fixture-owner-password', algorithm='AES-256')",
    "with open(sys.argv[1], 'wb') as target:",
    "    writer.write(target)",
    "reader = PdfReader(sys.argv[1])",
    "print(json.dumps({'is_encrypted': reader.is_encrypted, 'pages_after_empty_password': len(reader.pages)}))",
  ].join("\n");
  const { stdout, stderr } = await execFileAsync(python, ["-c", script, filePath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { is_encrypted: true, pages_after_empty_password: 1 });
  return fs.readFile(filePath);
}

test("bundled pdfjs-dist is available through the exact ESM allowlist", async () => {
  const pdfjs = await importBundledDependency("pdfjs-dist");
  assert.equal(typeof pdfjs.getDocument, "function");
  assert.match(pdfjs.version, /^5\./u);
  await assert.rejects(importBundledDependency("not-allowlisted"), /not allowlisted/u);
});

test("neighboring fake pdfjs-dist cannot shadow the fixed bundled dependency", async () => {
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-fake-pdfjs-"));
  try {
    const fakeRoot = path.join(isolatedRoot, "node_modules", "pdfjs-dist");
    await fs.mkdir(fakeRoot, { recursive: true });
    await fs.writeFile(path.join(fakeRoot, "package.json"), `${JSON.stringify({ name: "pdfjs-dist", version: "0.0.0-shadow", main: "index.mjs" })}\n`, { flag: "wx" });
    await fs.writeFile(path.join(fakeRoot, "index.mjs"), "throw new Error('neighboring fake pdfjs-dist was loaded');\n", { flag: "wx" });
    const primitivesUrl = pathToFileURL(fileURLToPath(new URL("../scripts/workflow_primitives.mjs", import.meta.url))).href;
    const program = `const m=await import(${JSON.stringify(primitivesUrl)});const pdf=await m.importBundledDependency('pdfjs-dist');process.stdout.write(pdf.version);`;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: isolatedRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(stderr, "");
    assert.match(stdout, /^5\./u);
  } finally {
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
});

test("strict PDF validator accepts a complete one-page voucher", async () => {
  const result = await validateCompletePdfBytes(onePagePdf(), "valid fixture");
  assert.deepEqual(result, { pageCount: 1, totalOperators: 2 });
});

test("valid PDF validation works when imported from --input-type=module eval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-pdf-eval-import-"));
  try {
    const pdfPath = path.join(root, "valid.pdf");
    await fs.writeFile(pdfPath, onePagePdf(), { flag: "wx" });
    const manifestUrl = pathToFileURL(fileURLToPath(new URL("../scripts/disbursement_manifest.mjs", import.meta.url))).href;
    const program = [
      "import fs from 'node:fs/promises'",
      `const manifest = await import(${JSON.stringify(manifestUrl)})`,
      `const bytes = new Uint8Array(await fs.readFile(${JSON.stringify(pdfPath)}))`,
      "const result = await manifest.validateCompletePdfBytes(bytes, 'eval-import fixture')",
      "process.stdout.write(JSON.stringify(result))",
    ].join(";");
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { pageCount: 1, totalOperators: 2 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("manifest audit and real archive CLI preserve valid PDF voucher capability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-valid-pdf-"));
  try {
    const fixture = await createCompactDisbursementProductionFixture({
      root,
      reimbursementTransactionCount: 10,
      requestedUniqueVoucherCount: 4,
    });
    const pdfBytes = onePagePdf();
    const pdfPath = path.join(root, "payout-valid.pdf");
    await fs.writeFile(pdfPath, pdfBytes, { flag: "wx" });
    const pdfSha256 = sha256Bytes(pdfBytes);
    const manifest = structuredClone(fixture.manifest);
    for (const voucher of manifest.vouchers) {
      if (voucher.id === "voucher-001" || voucher.id === "voucher-duplicate-alias") {
        voucher.path = pdfPath;
        voucher.sha256 = pdfSha256;
      }
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    const manifestPath = path.join(root, "disbursement-valid-pdf-manifest.json");
    await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const audit = await auditDisbursementManifest({
      manifestPath,
      manifestSha256: sha256Bytes(manifestBytes),
    });
    const pdfVoucher = audit.voucherArchive.find((entry) => entry.sha256 === pdfSha256);
    assert.equal(pdfVoucher?.mediaKind, "pdf");
    assert.match(pdfVoucher?.archiveName ?? "", /\.pdf$/u);
    const request = {
      kind: "compact-disbursement-archive-v1",
      stagingToken: crypto.randomBytes(32).toString("hex"),
      manifestPath,
      manifestSha256: sha256Bytes(manifestBytes),
    };
    const requestPath = path.join(root, "valid-pdf-archive-request.json");
    await fs.writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx" });
    const { stdout, stderr } = await execFileAsync(process.execPath, [workflowRunner, "--archive", requestPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(stderr, "");
    const receipt = JSON.parse(stdout);
    const publishedPdf = receipt.vouchers.find((entry) => entry.sha256 === pdfSha256);
    assert.match(publishedPdf?.path ?? "", /\.pdf$/u);
    assert.deepEqual(await fs.readFile(publishedPdf.path), pdfBytes);
    assert.equal(receipt.cleanup.removed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parallel valid PDF validation stays isolated from worker diagnostics", async () => {
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => (
    validateCompletePdfBytes(onePagePdf({ content: `q\n${index} ${index} m\nQ` }), `parallel fixture ${index}`)
  )));
  assert.deepEqual(results.map((entry) => entry.pageCount), [1, 1, 1, 1]);
});

test("PDF-looking header and EOF bytes without a catalog are rejected", async () => {
  const fake = Buffer.from("%PDF-1.7\nthis is not a PDF object graph\n%%EOF\n", "latin1");
  await assert.rejects(validateCompletePdfBytes(fake, "fake header fixture"), /PDF full parse failed|parser emitted a warning/u);
});

test("encrypted PDF is rejected instead of requesting or guessing a password", async () => {
  await assert.rejects(validateCompletePdfBytes(onePagePdf({ encrypted: true }), "encrypted fixture"), /PDF full parse failed|parser emitted a warning/u);
});

test("real pypdf AES-256 PDF with empty user password is rejected by the real archive CLI", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-real-encrypted-pdf-"));
  try {
    const fixture = await createCompactDisbursementProductionFixture({
      root,
      reimbursementTransactionCount: 10,
      requestedUniqueVoucherCount: 4,
    });
    const encryptedPath = path.join(root, "pypdf-empty-user-password.pdf");
    const encryptedBytes = await createRealEmptyUserPasswordPdf(encryptedPath);
    const encryptedSha256 = sha256Bytes(encryptedBytes);
    const manifest = structuredClone(fixture.manifest);
    for (const voucher of manifest.vouchers) {
      if (voucher.id === "voucher-001" || voucher.id === "voucher-duplicate-alias") {
        voucher.path = encryptedPath;
        voucher.sha256 = encryptedSha256;
      }
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    const manifestPath = path.join(root, "disbursement-real-encrypted-pdf-manifest.json");
    await fs.writeFile(manifestPath, manifestBytes, { flag: "wx" });
    const stagingToken = crypto.randomBytes(32).toString("hex");
    const requestPath = path.join(root, "real-encrypted-pdf-archive-request.json");
    await fs.writeFile(requestPath, `${JSON.stringify({
      kind: "compact-disbursement-archive-v1",
      stagingToken,
      manifestPath,
      manifestSha256: sha256Bytes(manifestBytes),
    })}\n`, { flag: "wx" });
    await assert.rejects(
      execFileAsync(process.execPath, [workflowRunner, "--archive", requestPath], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, TEMP: root, TMP: root },
      }),
      (error) => {
        assert.match(error.stderr ?? "", /encrypted PDFs are not allowed/u);
        return true;
      },
    );
    await assert.rejects(fs.access(path.join(root, fixture.expectedBatchName)), /ENOENT/u);
    await assert.rejects(fs.access(path.join(root, `codex-xhs-disbursement-${stagingToken}`)), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("zero-page page tree is rejected", async () => {
  await assert.rejects(validateCompletePdfBytes(zeroPagePdf(), "zero-page fixture"), /allowed range is 1-1000|PDF full parse failed/u);
});

test("recoverable broken xref is rejected when pdfjs emits a warning", async () => {
  const broken = Buffer.from(onePagePdf().toString("latin1").replace(/startxref\n\d+/u, "startxref\n1"), "latin1");
  await assert.rejects(validateCompletePdfBytes(broken, "broken xref fixture"), /parser emitted a warning|PDF full parse failed/u);
});

test("broken content stream is rejected during full operator-list parsing", async () => {
  const broken = onePagePdf({ content: "BT\n(unterminated text literal\nET" });
  await assert.rejects(validateCompletePdfBytes(broken, "broken content fixture"), /parser emitted a warning|PDF full parse failed/u);
});

test("per-page operator limit rejects parser resource abuse", { timeout: 30_000 }, async () => {
  const content = "q\nQ\n".repeat(50_001);
  await assert.rejects(validateCompletePdfBytes(onePagePdf({ content }), "operator bomb fixture"), /operator limit|PDF full parse failed/u);
});
