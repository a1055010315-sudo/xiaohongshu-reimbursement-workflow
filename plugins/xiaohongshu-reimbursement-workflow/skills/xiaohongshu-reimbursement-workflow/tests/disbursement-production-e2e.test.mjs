import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DISBURSEMENT_FINAL_ROOT_ENTRIES,
  buildDisbursementArchiveBytes,
} from "../scripts/disbursement_archive.mjs";
import { auditDisbursementManifest } from "../scripts/disbursement_manifest.mjs";
import {
  DISBURSEMENT_ARCHIVE_KIND,
  DISBURSEMENT_RECEIPT_KIND,
  archiveCompactDisbursementWorkflow,
  auditCompactDisbursementCandidate,
} from "../scripts/run_compact_disbursement_workflow.mjs";
import { readStableBinaryFile, sha256Bytes } from "../scripts/workflow_primitives.mjs";
import { createCompactDisbursementProductionFixture } from "./disbursement-production-fixture.mjs";

const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(new URL("../scripts/run_compact_disbursement_workflow.mjs", import.meta.url));

function requestFor(fixture, stagingToken = crypto.randomBytes(32).toString("hex")) {
  return Object.freeze({
    kind: DISBURSEMENT_ARCHIVE_KIND,
    stagingToken,
    manifestPath: fixture.manifestPath,
    manifestSha256: fixture.manifestSha256,
  });
}

function expectedRecord(built) {
  return Object.freeze({
    summaryText: built.summaryText,
    bindings: built.bindings,
    artifactDigest: built.artifactDigest,
  });
}

async function withProductionSandbox(options, action) {
  const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-production-e2e-"));
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = baseRoot;
  process.env.TMP = baseRoot;
  try {
    const fixture = await createCompactDisbursementProductionFixture({ root: path.join(baseRoot, "input"), ...options });
    return await action({ baseRoot, fixture });
  } finally {
    process.env.TEMP = priorTemp;
    process.env.TMP = priorTmp;
    await fs.rm(baseRoot, { recursive: true, force: true });
  }
}

async function assertStrictFinalArchive(fixture, receipt) {
  assert.equal(receipt.kind, DISBURSEMENT_RECEIPT_KIND);
  assert.equal(receipt.finalArchivePath, path.join(fixture.root, fixture.expectedBatchName));
  const rootEntries = await fs.readdir(receipt.finalArchivePath, { withFileTypes: true });
  assert.deepEqual(rootEntries.map((entry) => entry.name).sort(), [...DISBURSEMENT_FINAL_ROOT_ENTRIES].sort());
  assert.equal(rootEntries.some((entry) => entry.isSymbolicLink()), false);
  const freshAudit = await auditDisbursementManifest({
    manifestPath: fixture.manifestPath,
    manifestSha256: fixture.manifestSha256,
  });
  const expected = expectedRecord(await buildDisbursementArchiveBytes(freshAudit));
  const finalAudit = await auditCompactDisbursementCandidate(freshAudit, receipt.finalArchivePath, expected);
  assert.equal(finalAudit.status, "passed");
  assert.equal(finalAudit.reportDigest, receipt.finalAuditDigest);
  assert.equal(receipt.artifactDigest, expected.artifactDigest);
  for (const binding of [receipt.summary, receipt.workbook, ...receipt.vouchers]) {
    const snapshot = await readStableBinaryFile(binding.path);
    assert.equal(snapshot.sha256, binding.sha256);
    assert.equal(snapshot.size, binding.size);
  }
}

test("one explicit archive call performs fresh review, atomic publication, final verification, and cleanup", async () => {
  await withProductionSandbox({
    profileIds: ["xiaohongshu", "company"],
    reimbursementTransactionCount: 47,
    includeSalary: true,
    requestedUniqueVoucherCount: 24,
  }, async ({ baseRoot, fixture }) => {
    const request = requestFor(fixture);
    const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
    const receipt = await archiveCompactDisbursementWorkflow(request);
    await assertStrictFinalArchive(fixture, receipt);
    assert.equal(receipt.cleanup.removed, true);
    assert.equal(receipt.recovered, false);
    assert.match(receipt.candidateAuditDigest, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.prePublishAuditDigest, receipt.candidateAuditDigest);
    assert.match(receipt.publicationInputIdentityDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(receipt.warnings, [{
      code: "DISBURSEMENT_MANIFEST_V1_DEPRECATED",
      message: "Manifest v1 remains supported but is deprecated; use strict manifest v2 for new archive tasks.",
    }]);
    await assert.rejects(fs.access(workflowRoot), /ENOENT/u);
    assert.deepEqual((await fs.readdir(fixture.root)).filter((name) => name.includes(".publishing")), []);
  });
});

test("strict manifest v2 completes reimbursement-only, salary-only, and mixed archives without legacy prerequisites", async (t) => {
  const cases = [
    { name: "reimbursement-only", options: { profileIds: ["xiaohongshu"], reimbursementTransactionCount: 8, includeSalary: false } },
    { name: "salary-only", options: { profileIds: [], reimbursementTransactionCount: 0, includeSalary: true } },
    { name: "mixed", options: { profileIds: ["xiaohongshu"], reimbursementTransactionCount: 8, includeSalary: true } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withProductionSandbox({
        manifestVersion: 2,
        reimbursementMode: "fresh_evidence",
        requestedUniqueVoucherCount: 3,
        ...entry.options,
      }, async ({ fixture }) => {
        const receipt = await archiveCompactDisbursementWorkflow(requestFor(fixture));
        await assertStrictFinalArchive(fixture, receipt);
        assert.equal(receipt.cleanup.removed, true);
        assert.equal(receipt.warnings, undefined);
        assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("salary_certificate_attestation")), false);
        assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("original_manifest_attestation")), false);
        assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("publish_receipt_attestation")), false);
      });
    });
  }
});

test("published_archive manifest v2 completes a full archive without original manifest or publish receipt", async () => {
  await withProductionSandbox({
    manifestVersion: 2,
    reimbursementMode: "published_archive",
    profileIds: ["xiaohongshu"],
    reimbursementTransactionCount: 8,
    includeSalary: false,
    requestedUniqueVoucherCount: 3,
  }, async ({ fixture }) => {
    const receipt = await archiveCompactDisbursementWorkflow(requestFor(fixture));
    await assertStrictFinalArchive(fixture, receipt);
    assert.equal(fixture.manifest.reimbursementSources[0].attestations, undefined);
    assert.equal(receipt.cleanup.removed, true);
  });
});

test("equivalent strict v1 and v2 business inputs generate byte-identical final artifacts", async () => {
  const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-disbursement-v1-v2-equivalence-"));
  const priorTemp = process.env.TEMP;
  const priorTmp = process.env.TMP;
  process.env.TEMP = baseRoot;
  process.env.TMP = baseRoot;
  try {
    const common = {
      profileIds: ["xiaohongshu", "company"],
      reimbursementTransactionCount: 12,
      includeSalary: true,
      requestedUniqueVoucherCount: 6,
    };
    const v1 = await createCompactDisbursementProductionFixture({
      root: path.join(baseRoot, "v1"),
      manifestVersion: 1,
      ...common,
    });
    const v2 = await createCompactDisbursementProductionFixture({
      root: path.join(baseRoot, "v2"),
      manifestVersion: 2,
      reimbursementMode: "fresh_evidence",
      ...common,
    });
    const v1Audit = await auditDisbursementManifest({ manifestPath: v1.manifestPath, manifestSha256: v1.manifestSha256 });
    const v2Audit = await auditDisbursementManifest({ manifestPath: v2.manifestPath, manifestSha256: v2.manifestSha256 });
    const v1Built = await buildDisbursementArchiveBytes(v1Audit);
    const v2Built = await buildDisbursementArchiveBytes(v2Audit);

    assert.deepEqual(v2Built.summaryBytes, v1Built.summaryBytes);
    assert.deepEqual(v2Built.workbookBytes, v1Built.workbookBytes);
    assert.deepEqual(
      v2Built.vouchers.map((entry) => ({ archiveName: entry.archiveName, bytes: entry.bytes })),
      v1Built.vouchers.map((entry) => ({ archiveName: entry.archiveName, bytes: entry.bytes })),
    );
    assert.equal(v2Built.artifactDigest, v1Built.artifactDigest);
    assert.deepEqual(v1Audit.warnings, [{
      code: "DISBURSEMENT_MANIFEST_V1_DEPRECATED",
      message: "Manifest v1 remains supported but is deprecated; use strict manifest v2 for new archive tasks.",
    }]);
    assert.equal(v2Audit.warnings, undefined);
  } finally {
    process.env.TEMP = priorTemp;
    process.env.TMP = priorTmp;
    await fs.rm(baseRoot, { recursive: true, force: true });
  }
});

test("provided optional v2 attestations are validated and do not restore a startup gate", async () => {
  await withProductionSandbox({
    manifestVersion: 2,
    reimbursementMode: "fresh_evidence",
    profileIds: ["xiaohongshu"],
    reimbursementTransactionCount: 8,
    includeSalary: true,
    requestedUniqueVoucherCount: 3,
    includeReimbursementAttestations: true,
    includeSalaryAttestation: true,
  }, async ({ fixture }) => {
    const receipt = await archiveCompactDisbursementWorkflow(requestFor(fixture));
    await assertStrictFinalArchive(fixture, receipt);
    assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("original_manifest_attestation")), true);
    assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("publish_receipt_attestation")), true);
    assert.equal(fixture.manifest.sourceFiles.some((file) => file.usage.includes("salary_certificate_attestation")), true);
  });
});

test("archive request is exact and old multi-step request kinds are closed", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 6, requestedUniqueVoucherCount: 3 }, async ({ fixture }) => {
    const request = requestFor(fixture);
    const legacyApprovalField = ["approval", "Text"].join("");
    await assert.rejects(
      archiveCompactDisbursementWorkflow({ ...request, [legacyApprovalField]: "unexpected" }),
      /contains unknown field/u,
    );
    const closedKind = ["compact", "disbursement", "prepare", "v1"].join("-");
    await assert.rejects(
      archiveCompactDisbursementWorkflow({ ...request, kind: closedKind }),
      /archive request kind is invalid/u,
    );
  });
});

test("CLI exposes only one --archive operation and returns the verified receipt", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 8, requestedUniqueVoucherCount: 4 }, async ({ fixture }) => {
    const request = requestFor(fixture);
    const requestPath = path.join(fixture.root, "archive-request.json");
    await fs.writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx" });
    const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath, "--archive", requestPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(stderr, "");
    const receipt = JSON.parse(stdout);
    await assertStrictFinalArchive(fixture, receipt);
    const closedOperation = `--${["pre", "pare"].join("")}`;
    await assert.rejects(
      execFileAsync(process.execPath, [runnerPath, closedOperation, requestPath], { encoding: "utf8", windowsHide: true, timeout: 120_000 }),
      /usage: .* --archive/u,
    );
  });
});

test("owner binding rejects staging-token reuse for a different request", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 8, requestedUniqueVoucherCount: 4 }, async ({ fixture }) => {
    const request = requestFor(fixture);
    await assert.rejects(
      archiveCompactDisbursementWorkflow(request, {
        testHooks: { afterOwnerCreated() { throw new Error("simulated owner crash"); } },
      }),
      /simulated owner crash/u,
    );
    const differentManifestPath = path.join(fixture.root, "different-manifest.json");
    await fs.copyFile(fixture.manifestPath, differentManifestPath);
    await assert.rejects(
      archiveCompactDisbursementWorkflow({ ...request, manifestPath: differentManifestPath }),
      /owner marker is invalid or belongs to another archive request/u,
    );
  });
});

test("candidate and source TOCTOU changes stop publication", async (t) => {
  await t.test("candidate mutation before its full audit is rejected", async () => {
    await withProductionSandbox({ reimbursementTransactionCount: 10, requestedUniqueVoucherCount: 5 }, async ({ fixture }) => {
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterCandidateBuilt({ candidate }) {
              await fs.appendFile(candidate.summary.path, "tampered\n");
            },
          },
        }),
        /candidate full correspondence audit failed/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });

  await t.test("source mutation after candidate audit is caught by fresh source verification", async () => {
    await withProductionSandbox({ reimbursementTransactionCount: 10, requestedUniqueVoucherCount: 5 }, async ({ fixture }) => {
      const voucherPath = fixture.manifest.vouchers[0].path;
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterCandidateAudited() {
              await fs.appendFile(voucherPath, Buffer.from([0]));
            },
          },
        }),
        /SHA-256 differs from the manifest binding/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });

  await t.test("candidate mutation after pre-publication audit is caught by fingerprint rebinding", async () => {
    await withProductionSandbox({ reimbursementTransactionCount: 10, requestedUniqueVoucherCount: 5 }, async ({ fixture }) => {
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterPrePublishAudit({ candidate }) {
              await fs.appendFile(candidate.workbook.path, Buffer.from([0]));
            },
          },
        }),
        /publication inputs changed immediately before publication/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });

  await t.test("verified stage mutation is caught before atomic rename", async () => {
    await withProductionSandbox({ reimbursementTransactionCount: 10, requestedUniqueVoucherCount: 5 }, async ({ fixture }) => {
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterPublishStageVerified({ stageRoot }) {
              await fs.appendFile(path.join(stageRoot, "发放情况说明.txt"), "tampered\n");
            },
          },
        }),
        /publish stage changed after its independent audit/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });

  await t.test("bound source mutation after stage verification is caught before atomic rename", async () => {
    await withProductionSandbox({ reimbursementTransactionCount: 10, requestedUniqueVoucherCount: 5 }, async ({ baseRoot, fixture }) => {
      const request = requestFor(fixture);
      const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
      const voucherPath = fixture.manifest.vouchers[0].path;
      await assert.rejects(
        archiveCompactDisbursementWorkflow(request, {
          testHooks: {
            async afterPublishStageVerified() {
              await fs.appendFile(voucherPath, Buffer.from([0]));
            },
          },
        }),
        /publication inputs changed after publish stage verification and before atomic rename/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
      await fs.access(workflowRoot);
      const stageRoot = path.join(fixture.root, `.codex-disbursement-${request.stagingToken.slice(0, 20)}.publishing`);
      await fs.access(stageRoot);
      await fs.access(`${stageRoot}.owner.json`);
    });
  });

  await t.test("v2 source mutation after candidate audit is caught by the fresh audit", async () => {
    await withProductionSandbox({
      manifestVersion: 2,
      reimbursementMode: "fresh_evidence",
      profileIds: ["xiaohongshu"],
      reimbursementTransactionCount: 8,
      includeSalary: true,
      requestedUniqueVoucherCount: 3,
    }, async ({ fixture }) => {
      const source = fixture.manifest.sourceFiles.find((file) => file.usage.includes("fresh_reimbursement_evidence"));
      assert.ok(source);
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterCandidateAudited() {
              await fs.appendFile(source.path, Buffer.from([0]));
            },
          },
        }),
        /SHA-256 differs from its sourceFiles binding/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });

  await t.test("v2 source mutation after stage verification is caught before atomic rename", async () => {
    await withProductionSandbox({
      manifestVersion: 2,
      reimbursementMode: "fresh_evidence",
      profileIds: ["xiaohongshu"],
      reimbursementTransactionCount: 8,
      includeSalary: true,
      requestedUniqueVoucherCount: 3,
    }, async ({ fixture }) => {
      const source = fixture.manifest.sourceFiles.find((file) => file.usage.includes("salary_artifact"));
      assert.ok(source);
      await assert.rejects(
        archiveCompactDisbursementWorkflow(requestFor(fixture), {
          testHooks: {
            async afterPublishStageVerified() {
              await fs.appendFile(source.path, Buffer.from([0]));
            },
          },
        }),
        /publication inputs changed after publish stage verification and before atomic rename/u,
      );
      await assert.rejects(fs.access(path.join(fixture.root, fixture.expectedBatchName)), /ENOENT/u);
    });
  });
});

test("manifest v2 resumes from an audited stage and still cleans its owned temporary state", async () => {
  await withProductionSandbox({
    manifestVersion: 2,
    reimbursementMode: "fresh_evidence",
    profileIds: ["xiaohongshu"],
    reimbursementTransactionCount: 8,
    includeSalary: true,
    requestedUniqueVoucherCount: 3,
  }, async ({ baseRoot, fixture }) => {
    const request = requestFor(fixture);
    const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
    await assert.rejects(
      archiveCompactDisbursementWorkflow(request, {
        testHooks: {
          afterPublishStageVerified() {
            throw new Error("simulated v2 crash after stage audit");
          },
        },
      }),
      /simulated v2 crash after stage audit/u,
    );
    await fs.access(workflowRoot);
    const receipt = await archiveCompactDisbursementWorkflow(request);
    await assertStrictFinalArchive(fixture, receipt);
    assert.equal(receipt.recovered, true);
    assert.equal(receipt.cleanup.removed, true);
    await assert.rejects(fs.access(workflowRoot), /ENOENT/u);
    assert.deepEqual((await fs.readdir(fixture.root)).filter((name) => name.includes(".publishing")), []);
  });
});

test("owned crashes resume at owner, candidate, stage, and post-rename boundaries", async (t) => {
  const cases = [
    {
      name: "owner",
      hook: "afterOwnerCreated",
      message: "simulated crash after owner",
    },
    {
      name: "candidate",
      hook: "afterCandidateAudited",
      message: "simulated crash after candidate audit",
    },
    {
      name: "stage",
      hook: "afterPublishStageVerified",
      message: "simulated crash after stage audit",
    },
    {
      name: "rename",
      hook: "afterPublishRename",
      message: "simulated crash after rename",
    },
  ];
  for (const crash of cases) {
    await t.test(crash.name, async () => {
      await withProductionSandbox({ reimbursementTransactionCount: 12, requestedUniqueVoucherCount: 6 }, async ({ baseRoot, fixture }) => {
        const request = requestFor(fixture);
        const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
        await assert.rejects(
          archiveCompactDisbursementWorkflow(request, {
            testHooks: {
              [crash.hook]() {
                throw new Error(crash.message);
              },
            },
          }),
          new RegExp(crash.message, "u"),
        );
        await fs.access(workflowRoot);
        const receipt = await archiveCompactDisbursementWorkflow(request);
        await assertStrictFinalArchive(fixture, receipt);
        assert.equal(receipt.recovered, true);
        assert.equal(receipt.cleanup.removed, true);
        await assert.rejects(fs.access(workflowRoot), /ENOENT/u);
        assert.deepEqual((await fs.readdir(fixture.root)).filter((name) => name.includes(".publishing")), []);
      });
    });
  }
});

test("an identical existing final archive is an idempotent recovery, never an overwrite", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 12, requestedUniqueVoucherCount: 6 }, async ({ fixture }) => {
    const request = requestFor(fixture);
    const first = await archiveCompactDisbursementWorkflow(request);
    const before = await readStableBinaryFile(first.workbook.path);
    const second = await archiveCompactDisbursementWorkflow(request);
    const after = await readStableBinaryFile(second.workbook.path);
    assert.equal(second.recovered, true);
    assert.equal(second.cleanup.removed, true);
    assert.equal(after.sha256, before.sha256);
    assert.equal(second.finalAuditDigest, first.finalAuditDigest);
  });
});

test("a colliding different final archive is preserved and publication refuses to overwrite", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 12, requestedUniqueVoucherCount: 6 }, async ({ fixture }) => {
    const target = path.join(fixture.root, fixture.expectedBatchName);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "foreign.txt"), "preserve\n", { flag: "wx" });
    await assert.rejects(
      archiveCompactDisbursementWorkflow(requestFor(fixture)),
      /final archive path already exists with different content/u,
    );
    assert.equal(await fs.readFile(path.join(target, "foreign.txt"), "utf8"), "preserve\n");
  });
});

test("verified publication with incomplete cleanup is reported as an error", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 12, requestedUniqueVoucherCount: 6 }, async ({ baseRoot, fixture }) => {
    const request = requestFor(fixture);
    const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
    const foreignPath = path.join(workflowRoot, "foreign-review-note.txt");
    await assert.rejects(
      archiveCompactDisbursementWorkflow(request, {
        testHooks: {
          async afterPublishRename() {
            await fs.writeFile(foreignPath, "must be preserved\n", { flag: "wx" });
          },
        },
      }),
      /published archive .* was verified, but workflow cleanup is incomplete/u,
    );
    await fs.access(path.join(fixture.root, fixture.expectedBatchName));
    assert.equal(await fs.readFile(foreignPath, "utf8"), "must be preserved\n");
    await fs.access(workflowRoot);
  });
});

test("cleanup preserves a same-path candidate summary replacement made after publish rename", async () => {
  await withProductionSandbox({ reimbursementTransactionCount: 12, requestedUniqueVoucherCount: 6 }, async ({ baseRoot, fixture }) => {
    const request = requestFor(fixture);
    const workflowRoot = path.join(baseRoot, `codex-xhs-disbursement-${request.stagingToken}`);
    let candidateSummaryPath;
    let replacementBytes;
    await assert.rejects(
      archiveCompactDisbursementWorkflow(request, {
        testHooks: {
          async afterPublishRename({ candidate }) {
            candidateSummaryPath = candidate.summary.path;
            replacementBytes = await fs.readFile(candidateSummaryPath);
            const replacementPath = path.join(baseRoot, "same-bytes-summary-replacement.txt");
            await fs.writeFile(replacementPath, replacementBytes, { flag: "wx" });
            await fs.unlink(candidateSummaryPath);
            await fs.rename(replacementPath, candidateSummaryPath);
          },
        },
      }),
      /published archive .* was verified, but workflow cleanup is incomplete/u,
    );
    await fs.access(path.join(fixture.root, fixture.expectedBatchName));
    await fs.access(workflowRoot);
    assert.ok(candidateSummaryPath);
    assert.deepEqual(await fs.readFile(candidateSummaryPath), replacementBytes);
  });
});
