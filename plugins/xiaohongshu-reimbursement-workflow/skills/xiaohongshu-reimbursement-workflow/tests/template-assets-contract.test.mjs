import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadBundledDependency, sha256Bytes } from "../scripts/workflow_primitives.mjs";

const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;
const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates", "xiaohongshu");
const namespace = "(?:[A-Za-z_][\\w.-]*:)?";

function tagAttributes(tag) {
  return new Map([...tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/gu)].map((match) => [match[1], match[2]]));
}

function rowXml(worksheetXml, rowNumber) {
  return new RegExp(`<${namespace}row\\b[^>]*\\br="${rowNumber}"[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/${namespace}row\\s*>)`, "iu").exec(worksheetXml)?.[0] ?? null;
}

function mergeRows(ref) {
  const match = /^[A-Z]{1,3}([1-9]\d*):[A-Z]{1,3}([1-9]\d*)$/u.exec(ref);
  assert.ok(match, `invalid merge reference ${ref}`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function elementItems(xml, name) {
  return [...xml.matchAll(new RegExp(`<${namespace}${name}\\b[^>]*?\\/\\s*>|<${namespace}${name}\\b[^>]*>[\\s\\S]*?<\\/${namespace}${name}\\s*>`, "giu"))].map((match) => match[0]);
}

test("sanitized workbook templates contain one blank standard row and no hidden business payload", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(templateRoot, "template-manifest.json"), "utf8"));
  for (const [id, definition] of Object.entries(manifest.templates)) {
    const bytes = await fs.readFile(path.join(templateRoot, definition.file));
    assert.equal(sha256Bytes(bytes), definition.sha256, `${id} SHA`);
    const zip = await JSZip.loadAsync(bytes, { createFolders: false });
    const parts = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    const lowerParts = parts.map((name) => name.toLowerCase());
    assert.deepEqual(parts.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/iu.test(name)), ["xl/worksheets/sheet1.xml"], `${id} worksheet parts`);
    assert.equal(lowerParts.some((name) => name.startsWith("docprops/") || name.startsWith("customxml/") || /(?:comments|threadedcomments|persons|externallinks|vbaproject)/u.test(name)), false, `${id} private metadata parts`);
    assert.equal(lowerParts.some((name) => name.startsWith("xl/media/") || name.startsWith("xl/drawings/")), false, `${id} embedded media`);

    const workbookXml = await zip.file("xl/workbook.xml").async("string");
    const sheetTags = [...workbookXml.matchAll(new RegExp(`<${namespace}sheet\\b[^>]*\\/?\\s*>`, "giu"))];
    assert.equal(sheetTags.length, 1, `${id} visible sheet count`);
    assert.equal(tagAttributes(sheetTags[0][0]).get("name"), definition.sheetName, `${id} sheet name`);

    const worksheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
    const actualMerges = [...worksheetXml.matchAll(new RegExp(`<${namespace}mergeCell\\b[^>]*\\bref\\s*=\\s*"([A-Z]{1,3}[1-9]\\d*:[A-Z]{1,3}[1-9]\\d*)"[^>]*\\/>`, "giu"))].map((match) => match[1]).sort();
    assert.deepEqual(actualMerges, [...definition.staticMerges].sort(), `${id} static merges`);
    for (const ref of actualMerges) assert.ok(mergeRows(ref).end < definition.dataStartRow, `${id} data-area merge ${ref}`);

    const dataRow = rowXml(worksheetXml, definition.dataStyleRow);
    assert.ok(dataRow, `${id} standard data row`);
    assert.equal(Number(tagAttributes(/^<[^>]+>/u.exec(dataRow)[0]).get("ht")), definition.templateRowHeight, `${id} standard row height`);
    assert.equal(new RegExp(`<${namespace}(?:v|f|is|t)\\b`, "iu").test(dataRow), false, `${id} standard row payload`);
    const physicalRows = [...worksheetXml.matchAll(new RegExp(`<${namespace}row\\b[^>]*\\br\\s*=\\s*"([1-9]\\d*)"`, "giu"))].map((match) => Number(match[1]));
    assert.equal(Math.max(...physicalRows), definition.dataStyleRow, `${id} unused template tail rows`);

    const stylesXml = await zip.file("xl/styles.xml").async("string");
    const cellXfs = new RegExp(`<${namespace}cellXfs\\b[^>]*>([\\s\\S]*?)<\\/${namespace}cellXfs>`, "iu").exec(stylesXml)?.[1];
    assert.ok(cellXfs, `${id} cellXfs`);
    const xfs = [...cellXfs.matchAll(new RegExp(`<${namespace}xf\\b[^>]*>`, "giu"))];
    const styleIds = [...dataRow.matchAll(new RegExp(`<${namespace}c\\b[^>]*\\bs\\s*=\\s*"([0-9]+)"`, "giu"))].map((match) => Number(match[1]));
    assert.ok(styleIds.length > 0, `${id} standard row styles`);
    for (const styleId of styleIds) {
      assert.ok(xfs[styleId], `${id} data style ${styleId}`);
      const fillId = Number(tagAttributes(xfs[styleId][0]).get("fillId") ?? "0");
      assert.equal(fillId, 0, `${id} data style ${styleId} business fill`);
    }

    assert.deepEqual(definition.moneyNumberFormats, ["0", "0.0", "0.00", "0.000"], `${id} money formats`);
    assert.ok(Array.isArray(definition.moneyStyleRoles) && definition.moneyStyleRoles.length > 0, `${id} money roles`);
    const numberFormats = new Map([...stylesXml.matchAll(new RegExp(`<${namespace}numFmt\\b[^>]*>`, "giu"))].map((match) => {
      const attributes = tagAttributes(match[0]);
      return [Number(attributes.get("numFmtId")), attributes.get("formatCode")];
    }));
    for (const role of definition.moneyStyleRoles) for (let digits = 0; digits <= 3; digits += 1) {
      const styleId = definition.styleRoles[`${role}${digits}`];
      assert.ok(Number.isSafeInteger(styleId) && xfs[styleId], `${id}.${role}${digits} style`);
      const numFmtId = Number(tagAttributes(xfs[styleId][0]).get("numFmtId") ?? "0");
      assert.equal(numberFormats.get(numFmtId), definition.moneyNumberFormats[digits], `${id}.${role}${digits} format`);
    }

    if (id === "current-detail") {
      assert.match(worksheetXml, /补报（&lt;笔数&gt;笔）/u);
      assert.equal(definition.outputMergePolicy.description, true);
      assert.deepEqual(definition.outputRowHeightPolicy, { title: 32, subtitle: 15, summaryLabel: 15, summaryValue: 15, notes: 24, header: 26, group: 15, default: "template", longText: 42, description: 28, allowImageLayoutAdjustment: false });
      assert.equal(definition.styleRoles.description, 0);
    }
    if (id === "screenshot-map") {
      assert.equal(definition.templateRowHeight, 60);
      assert.deepEqual(definition.outputRowHeightPolicy, { noImage: 60, image: 172.5, allowImageLayoutAdjustment: true });
      assert.deepEqual(definition.outputImagePolicy, { maxWidthPx: 320, maxHeightPx: 220, fit: "contain", align: "center" });
      const fillsBlock = new RegExp(`<${namespace}fills\\b[^>]*>[\\s\\S]*?<\\/${namespace}fills>`, "iu").exec(stylesXml)?.[0] ?? "";
      const fills = elementItems(fillsBlock, "fill");
      const expectedFill = { oddDate: "FFFFFCF4", oddText: "FFFFFCF4", oddAmount: "FFFFFCF4", oddNote: "FFFFFCF4", evenDate: "FFFFF7E6", evenText: "FFFFF7E6", evenAmount: "FFFFF7E6", evenNote: "FFFFF7E6", image: "FFF5F8FA" };
      for (const [role, rgb] of Object.entries(expectedFill)) {
        const fillId = Number(tagAttributes(xfs[definition.styleRoles[role]][0]).get("fillId"));
        assert.match(fills[fillId], new RegExp(`fgColor\\b[^>]*rgb="${rgb}"`, "u"), `${id}.${role} fill`);
      }
    }
    if (id === "supplement-detail") {
      assert.equal(definition.dataStartRow, 5);
      assert.equal(definition.outputMergePolicy.personGroup, false);
      assert.equal(definition.outputMergePolicy.footer, true);
      assert.equal(definition.outputRowHeightPolicy.footer, 28);
      assert.ok(Number.isSafeInteger(definition.styleRoles.footerLabel));
      assert.ok(Number.isSafeInteger(definition.styleRoles.footerValue));
    }
    if (id === "ledger-batch-preview") {
      assert.equal(definition.templateRowHeight, 30);
      assert.equal(definition.outputMergePolicy.sameDate, true);
      assert.equal(definition.outputMergePolicy.expenseGroup, true);
    }
  }
});
