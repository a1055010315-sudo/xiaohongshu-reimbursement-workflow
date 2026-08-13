import {
  emitResult,
  failurePayload,
  generateLedgerReorderPlan,
  loadPlanRequest,
  parseGenerateCli,
  writeGeneratedPlan,
} from "./ledger_reorder_common.mjs";

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
  const { requestPath, outputPath } = parseGenerateCli(process.argv.slice(2));
  const request = await loadPlanRequest(requestPath);
  const generated = await generateLedgerReorderPlan(request);
  const persisted = await writeGeneratedPlan(outputPath, generated.plan);
  emitResult({
    ok: true,
    mode: "ledger-reorder-correction",
    status: "plan_created",
    requestFileSha256: request.requestFileSha256,
    planPath: persisted.path,
    planFileSha256: persisted.sha256,
    stagingCandidatePath: generated.plan.outputPath,
    activeCandidatePath: generated.plan.activeCandidatePath,
    sourceSha256: generated.sourceSha256,
    expectedRecordCount: generated.plan.expectedRecordCount,
    expectedPhysicalRecordRowCount: generated.plan.expectedPhysicalRecordRowCount,
    expectedScopedRecordCount: generated.plan.expectedScopedRecordCount,
    expectedScopedRowCount: generated.plan.expectedScopedRowCount,
    expectedScopedAmount: generated.plan.expectedScopedAmount,
    expectedAmountDelta: generated.plan.expectedAmountDelta,
  });
  process.exitCode = 0;
} catch (error) {
  emitResult(failurePayload(error), { failure: true });
  process.exitCode = 1;
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}
