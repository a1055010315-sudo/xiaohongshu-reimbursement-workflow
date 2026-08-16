import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPackage,
  sha256,
  sha256File,
  validatePngBytes,
} from "./benchmark-helpers.mjs";

const goldenRoot = process.env.XHS_APPROVED_30_ROOT;
const APPROVED_REPORT_SHA256 = "3448904317359fe6df3dd568b87f4492106ce93ebebab07dfd16b805d6803660";
const APPROVED_DIGESTS = Object.freeze({
  verificationDigest: "13de44f40cc5be24e41d8cce2884965430da656851ec8b46cc13b8c42d1fd204",
  templateBundleDigest: "daf845e8dfb6746273d37dd8222c0504f643b122ab1c773cf00a4f75fc64fc0b",
  renderBaselineDigest: "066d2d6e9d42c863f02bcfb174692bb2c0e892b2e53f0ce20c2acc891195543b",
  visualContractDigest: "8df0a85eb95693286eaace2e54e4a69b611a99bae245b11242e22271a5a8fb53",
});
const expectedTotals = {
  xiaohongshu: "1388.800",
  company: "705.100",
  residence: "461.600",
};
const canonicalRootNames = {
  xiaohongshu: "小红书支出总表.xlsx",
  company: "公司支出总表.xlsx",
  residence: "驻所支出.xlsx",
};

function parseAnchoredApprovedReport(bytes) {
  assert.equal(sha256(bytes), APPROVED_REPORT_SHA256, "Approved verification report SHA-256 drifted.");
  const report = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assert.equal(report.verificationDigest, APPROVED_DIGESTS.verificationDigest);
  assert.equal(report.approvedTemplateBundle?.templateBundleDigest, APPROVED_DIGESTS.templateBundleDigest);
  assert.equal(report.approvedTemplateBundle?.renderBaselineDigest, APPROVED_DIGESTS.renderBaselineDigest);
  assert.equal(report.approvedTemplateBundle?.visualContractDigest, APPROVED_DIGESTS.visualContractDigest);
  return report;
}

function originalReportRoot(report) {
  const rootWorkbook = report.files.find((entry) => entry.role === "rootWorkbook");
  if (!rootWorkbook) throw new Error("Verification report has no root workbook.");
  return path.dirname(path.dirname(rootWorkbook.path));
}

function localPath(entryPath, reportRoot) {
  const relative = path.relative(reportRoot, entryPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Report path escapes its delivery root: ${entryPath}`);
  }
  return path.join(goldenRoot, relative);
}

test("approved 30-entry package remains a visual and semantic golden, not a media benchmark", {
  skip: !goldenRoot,
}, async () => {
  const reportPath = path.join(goldenRoot, "00_验收证据", "verification-report.json");
  const report = parseAnchoredApprovedReport(await fs.readFile(reportPath));
  const reportRoot = originalReportRoot(report);
  assert.equal(report.status, "verified-test-delivery-not-published");
  assert.equal(report.transactionCount, 30);
  assert.equal(report.missingEvidenceCount, 30);
  assert.equal(report.safety.realExpenseData, false);
  assert.equal(report.safety.actualImageEvidenceIncluded, false);
  assert.equal(report.safety.placeholdersRemaining, false);
  assert.deepEqual(report.affectedProfiles, ["xiaohongshu", "company", "residence"]);
  for (const [profileId, total] of Object.entries(expectedTotals)) {
    assert.equal(report.totals[profileId].transactionCount, 10);
    assert.equal(report.totals[profileId].amount, total);
  }

  const allEntries = [...report.files, ...report.visualEvidence.files];
  for (const entry of allEntries) {
    const filePath = localPath(entry.path, reportRoot);
    const stat = await fs.stat(filePath);
    assert.equal(stat.size, entry.size, `${filePath} size drifted.`);
    assert.equal(await sha256File(filePath), entry.sha256, `${filePath} SHA-256 drifted.`);
    if (entry.path.toLowerCase().endsWith(".png")) {
      const png = validatePngBytes(await fs.readFile(filePath));
      assert.equal(png.width, entry.width);
      assert.equal(png.height, entry.height);
    }
  }

  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  for (const entry of report.files.filter((item) => item.path.toLowerCase().endsWith(".xlsx"))) {
    const filePath = localPath(entry.path, reportRoot);
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    assert.ok(zip.file("[Content_Types].xml"), `${filePath} is not a valid XLSX package.`);
    assert.ok(zip.file("xl/workbook.xml"), `${filePath} has no workbook part.`);
    const xmlParts = Object.values(zip.files).filter((item) => !item.dir && item.name.endsWith(".xml"));
    const xmlText = (await Promise.all(xmlParts.map((item) => item.async("string")))).join("\n");
    assert.equal(xmlText.includes("{{"), false, `${filePath} contains a prototype placeholder.`);
  }

  const residenceGolden = path.basename(
    report.files.find((entry) => entry.role === "rootWorkbook" && entry.profileId === "residence").path,
  );
  assert.equal(residenceGolden, "住所支出.xlsx");
  assert.equal(canonicalRootNames.residence, "驻所支出.xlsx");
  assert.notEqual(residenceGolden, canonicalRootNames.residence);
  console.log(JSON.stringify({
    kind: "approved-layout-golden",
    reportSha256: APPROVED_REPORT_SHA256,
    verificationDigest: report.verificationDigest,
    renderBaselineDigest: report.approvedTemplateBundle.renderBaselineDigest,
    profiles: report.affectedProfiles,
    mediaPerformanceRepresentative: false,
    canonicalRootNames,
  }));
});

test("approved golden rejects a report synchronized to replacement file bytes", {
  skip: !goldenRoot,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-golden-anchor-"));
  try {
    const reportPath = path.join(goldenRoot, "00_验收证据", "verification-report.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const replacementBytes = Buffer.from("co-mutated-approved-file\n", "utf8");
    const replacementPath = path.join(tempRoot, "replacement.xlsx");
    await fs.writeFile(replacementPath, replacementBytes, { flag: "wx" });
    report.files[0] = {
      ...report.files[0],
      path: replacementPath,
      size: replacementBytes.length,
      sha256: sha256(replacementBytes),
    };
    const alteredReportPath = path.join(tempRoot, "verification-report.json");
    await fs.writeFile(alteredReportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await assert.rejects(
      async () => parseAnchoredApprovedReport(await fs.readFile(alteredReportPath)),
      /Approved verification report SHA-256 drifted/u,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
  await assert.rejects(fs.stat(tempRoot), { code: "ENOENT" });
});
