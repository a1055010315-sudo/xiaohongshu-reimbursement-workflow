import {
  buildLedgerReorderCandidate,
  emitResult,
  failurePayload,
  loadPlan,
  parseBuildCli,
} from "./ledger_reorder_common.mjs";

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

try {
  const { planPath } = parseBuildCli(process.argv.slice(2));
  const plan = await loadPlan(planPath);
  const result = await buildLedgerReorderCandidate(plan);
  emitResult(result);
  process.exitCode = 0;
} catch (error) {
  emitResult(failurePayload(error), { failure: true });
  process.exitCode = 1;
} finally {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
}
