import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_VISUAL_CONTRACT_SCHEMA_VERSION,
  getDetailContract,
  getScreenshotContract,
  getSupplementContract,
  getVisualContract,
  summarizeVisualContract,
} from "../scripts/builtin_visual_contracts.mjs";

test("built-in contracts are immutable, stable, and self-identifying", () => {
  const detail = getDetailContract("xiaohongshu");
  const again = getVisualContract("detail", "xiaohongshu");
  assert.strictEqual(detail, again);
  assert.equal(detail.schemaVersion, BUILTIN_VISUAL_CONTRACT_SCHEMA_VERSION);
  assert.equal(detail.contractId, "current-detail-person-grouped");
  assert.equal(detail.version, "1.0.0");
  assert.equal(detail.kind, "detail");
  assert.equal(detail.profileId, "xiaohongshu");
  assert.equal(detail.source, "builtin");
  assert.match(detail.visualContractDigest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(detail));
  assert.ok(Object.isFrozen(detail.roles));
  assert.ok(Object.isFrozen(detail.layout));
  assert.equal(detail.columnWidths.B, 40);
  assert.equal(detail.layout.freezePane.topLeftCell, "A7");
  assert.equal(detail.numberFormats.date, "mm-dd");
  assert.equal(detail.numberFormats.amount, "0.000");
  assert.equal(detail.roles.companyGroupLabel, 4);
  assert.equal(detail.roles.companyGroupTotal, 6);
  assert.match(detail.stylesXml, /numFmtId="165" formatCode="mm-dd"/u);
  assert.deepEqual(summarizeVisualContract(detail), {
    visualContractId: detail.contractId,
    visualContractVersion: detail.version,
    visualContractDigest: detail.visualContractDigest,
    visualContractSource: "builtin",
  });
});

test("screenshot and supplement contracts expose geometry and required fields", () => {
  const screenshot = getScreenshotContract("company");
  assert.equal(screenshot.imageAnchor.widthPx, 260);
  assert.equal(screenshot.imageAnchor.minHeightPx, 72);
  assert.equal(screenshot.imageAnchor.maxHeightPx, 210);
  assert.equal(screenshot.layout.freezePane.topLeftCell, "A2");
  assert.equal(screenshot.layout.columns.at(-1).width, 42);

  const supplement = getSupplementContract("residence");
  assert.equal(supplement.kind, "supplement");
  assert.deepEqual(supplement.supplementFields, ["原始发生日期", "补报原因", "关联原始凭证/来源编号"]);
  assert.deepEqual(supplement.supplementFieldDefinitions.map((field) => field.id), [
    "originalOccurrenceDate",
    "supplementReason",
    "sourceReference",
  ]);
  assert.ok(Object.isFrozen(supplement.supplementFieldDefinitions));
});

test("unknown contract kinds fail closed", () => {
  assert.throws(() => getVisualContract("unknown", "xiaohongshu"), /Unknown built-in visual contract kind/u);
  assert.throws(
    () => summarizeVisualContract({ ...getDetailContract("xiaohongshu") }),
    /fixed contract registry/u,
  );
});

test("fixture contract summaries reject forged metadata or digests", () => {
  const detail = getDetailContract("xiaohongshu");
  assert.throws(
    () => summarizeVisualContract({
      ...detail,
      source: "template-fallback",
      legacyFixtureFile: "xiaohongshu-detail.xlsx",
      legacyFixtureSha256: "0".repeat(64),
      visualContractDigest: "f".repeat(64),
    }),
    /digest|fixed contract registry/u,
  );
});
