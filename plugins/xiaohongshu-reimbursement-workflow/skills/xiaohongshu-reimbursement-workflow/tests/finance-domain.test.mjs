import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalDigest,
  formatMilliunits,
  loadProfileRegistry,
  parseMilliunits,
  parseProfileRegistryBytes,
  resolveProfile,
  resolveRootWorkbookProfile,
} from "../scripts/finance_domain.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileConfigPath = path.join(skillRoot, "references", "ledger-profiles.json");

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mutableProfileConfig() {
  return JSON.parse(await fs.readFile(profileConfigPath, "utf8"));
}

test("the fixed profile registry separates canonical runtime identity from input aliases", async () => {
  assert.equal(loadProfileRegistry.length, 0, "the production loader must not accept a path override");
  const registry = await loadProfileRegistry();

  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.profileOrder, ["xiaohongshu", "company", "residence"]);
  assert.match(registry.profileConfigDigest, /^[0-9a-f]{64}$/u);

  const xiaohongshu = resolveProfile("小红书", registry);
  const company = resolveProfile("company", registry);
  const residence = resolveProfile("住所报销", registry);
  assert.equal(xiaohongshu.profileId, "xiaohongshu");
  assert.deepEqual(xiaohongshu.managedRootSheetInputNames, ["Sheet1"]);
  assert.equal(company.profileId, "company");
  assert.equal(residence.profileId, "residence");
  assert.equal(residence.targetCategory, "驻所报销");
  assert.equal(residence.canonicalRootWorkbookName, "驻所支出.xlsx");
  assert.equal(residence.managedRootSheetName, "驻所支出");
  assert.equal(residence.detailSheetName, "本次报销明细");
  assert.equal(residence.screenshotMapSheetName, "住所报销");
  assert.equal(residence.archiveDirectoryName, "03_住所专项");
  assert.equal(residence.preserveUnmanagedSheets, true);

  const residenceInput = resolveRootWorkbookProfile("住所支出.xlsx", registry);
  assert.equal(residenceInput.profileId, "residence");
  assert.equal(residenceInput.canonicalRootWorkbookName, "驻所支出.xlsx");
  assert.notEqual(residenceInput.canonicalRootWorkbookName, "住所支出.xlsx");
});

test("profile registry parsing is strict and aliases are globally unambiguous", async (context) => {
  const cases = [
    {
      name: "unknown top-level key",
      mutate(config) {
        config.unexpected = true;
      },
      error: /unknown field.*unexpected/iu,
    },
    {
      name: "unknown profile key",
      mutate(config) {
        config.profiles.company.unexpected = true;
      },
      error: /unknown field.*unexpected/iu,
    },
    {
      name: "category alias collision",
      mutate(config) {
        config.profiles.company.categoryAliases.push("住所");
      },
      error: /category alias.*住所.*multiple profiles/iu,
    },
    {
      name: "root input alias collision",
      mutate(config) {
        config.profiles.company.rootWorkbookInputNames.push("住所支出.xlsx");
      },
      error: /root workbook input.*住所支出\.xlsx.*multiple profiles/iu,
    },
    {
      name: "canonical root collision",
      mutate(config) {
        config.profiles.company.canonicalRootWorkbookName = "小红书支出总表.xlsx";
        config.profiles.company.rootWorkbookInputNames = ["小红书支出总表.xlsx"];
      },
      error: /canonical root workbook names must be globally unique/iu,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      const config = await mutableProfileConfig();
      item.mutate(config);
      assert.throws(() => parseProfileRegistryBytes(canonicalBytes(config)), item.error);
    });
  }

  const config = await mutableProfileConfig();
  const lfRegistry = parseProfileRegistryBytes(canonicalBytes(config));
  const crlfRegistry = parseProfileRegistryBytes(
    Buffer.from(canonicalBytes(config).toString("utf8").replace(/\n/gu, "\r\n"), "utf8"),
  );
  assert.equal(lfRegistry.profileConfigDigest, crlfRegistry.profileConfigDigest);
  assert.throws(
    () => parseProfileRegistryBytes(Buffer.from(JSON.stringify(config), "utf8")),
    /canonical UTF-8 JSON/iu,
  );
  assert.throws(
    () => parseProfileRegistryBytes(Buffer.from([0xff, 0xfe, 0xfd])),
    /valid UTF-8 JSON/iu,
  );
  assert.throws(
    () => parseProfileRegistryBytes(Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n', "utf8")),
    /canonical UTF-8 JSON/iu,
  );
});

test("milliunits preserve exact large and signed values without Number conversion", () => {
  assert.equal(parseMilliunits("0", "amount"), 0n);
  assert.equal(parseMilliunits("1.2", "amount"), 1200n);
  assert.equal(parseMilliunits("1.230", "amount"), 1230n);
  assert.equal(
    parseMilliunits("900719925474099312345.678", "amount"),
    900719925474099312345678n,
  );
  assert.equal(parseMilliunits("-4.125", "amount", { allowNegative: true }), -4125n);
  assert.equal(formatMilliunits(900719925474099312345678n), "900719925474099312345.678");
  assert.equal(formatMilliunits(-4125n), "-4.125");

  for (const invalid of ["-0", "-0.000", "01", "+1", "1.", ".1", "1.0000", "1e3", 1]) {
    assert.throws(
      () => parseMilliunits(invalid, "amount", { allowNegative: true }),
      /decimal string|negative zero/iu,
      String(invalid),
    );
  }
  assert.throws(() => parseMilliunits("-1", "amount"), /non-negative decimal string/iu);
});

test("every accepted profile registry field is bound by profileConfigDigest", async () => {
  const original = await mutableProfileConfig();
  const changed = structuredClone(original);
  changed.profiles.company.archiveStem = "公司支出总表_新策略";
  const originalRegistry = parseProfileRegistryBytes(canonicalBytes(original));
  const changedRegistry = parseProfileRegistryBytes(canonicalBytes(changed));
  assert.notEqual(originalRegistry.profileConfigDigest, changedRegistry.profileConfigDigest);
});

test("canonical digest is key-order independent and value sensitive", () => {
  const left = canonicalDigest({ z: [2, { b: true, a: "x" }], a: 1 });
  const reordered = canonicalDigest({ a: 1, z: [2, { a: "x", b: true }] });
  const changed = canonicalDigest({ a: 1, z: [2, { a: "y", b: true }] });
  assert.equal(left, reordered);
  assert.notEqual(left, changed);
});
