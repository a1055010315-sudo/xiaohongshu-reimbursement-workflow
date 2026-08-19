import { canonicalDigest } from "./workflow_primitives.mjs";

/**
 * Code-owned presentation contracts for reimbursement workbooks.
 *
 * Production writers consume these immutable values directly. Historical
 * workbook files are deliberately not consulted here: they are migration and
 * visual-regression fixtures, not runtime configuration.
 */

export const BUILTIN_VISUAL_CONTRACT_SCHEMA_VERSION = 1;
export const BUILTIN_VISUAL_CONTRACT_VERSION = "1.0.0";

const AMOUNT_FORMAT = "0.000";
const DATE_FORMAT = "mm-dd";

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="mm-dd"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><family val="2"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF176B4D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEFE6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE4C2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB7C7BF"/></left><right style="thin"><color rgb="FFB7C7BF"/></right><top style="thin"><color rgb="FFB7C7BF"/></top><bottom style="thin"><color rgb="FFB7C7BF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Codex reimbursement"><a:themeElements><a:clrScheme name="Codex reimbursement"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="176B4D"/></a:accent1><a:accent2><a:srgbClr val="DDEFE6"/></a:accent2><a:accent3><a:srgbClr val="FFE4C2"/></a:accent3><a:accent4><a:srgbClr val="B7C7BF"/></a:accent4><a:accent5><a:srgbClr val="6B7280"/></a:accent5><a:accent6><a:srgbClr val="FFFFFF"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Codex reimbursement"><a:majorFont><a:latin typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme><a:fmtScheme name="Codex reimbursement"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`;

const DETAIL_COLUMNS = ["日期", "支出明细", "支出金额", "费用组合计", "费用分类", "结算方式"];
const SCREENSHOT_COLUMNS = ["日期", "支出人/主体", "项目", "金额", "备注"];

const DETAIL_ROLES = {
  title: 3,
  subtitle: 3,
  summaryLabel: 1,
  summaryValue: 2,
  header: 1,
  groupLabel: 3,
  employeeGroupLabel: 3,
  companyGroupLabel: 4,
  groupTotal: 2,
  employeeGroupTotal: 2,
  companyGroupTotal: 6,
  date: 7,
  text: 5,
  amount: 2,
  feeTotal: 2,
  classification: 5,
  settlement: 5,
  spacer: 5,
};

const SCREENSHOT_ROLES = {
  header: 1,
  oddDate: 7,
  oddText: 5,
  oddAmount: 2,
  oddNote: 5,
  evenDate: 7,
  evenText: 5,
  evenAmount: 2,
  evenNote: 5,
  image: 5,
};

const DETAIL_COLUMN_WIDTHS = { A: 13, B: 40, C: 15, D: 16, E: 24, F: 38 };
const SCREENSHOT_COLUMN_WIDTHS = { A: 12.5, B: 15, C: 40, D: 13, E: 48, F: 42, image: 42 };
const DETAIL_ROW_HEIGHTS = {
  title: 32,
  subtitle: 24,
  summaryLabel: 24,
  summaryValue: 28,
  preHeaderSpacer: 10,
  header: 24,
  group: 24,
  data: 24,
  spacer: 24,
  supplement: 48,
  screenshotHeader: 28.5,
  screenshotData: 172.5,
};
const SCREENSHOT_ROW_HEIGHTS = { header: 28.5, data: 172.5, screenshotHeader: 28.5, screenshotData: 172.5 };

const DETAIL_LAYOUT = {
  columns: [
    { key: "A", min: 1, max: 1, width: 13 },
    { key: "B", min: 2, max: 2, width: 40 },
    { key: "C", min: 3, max: 3, width: 15 },
    { key: "D", min: 4, max: 4, width: 16 },
    { key: "E", min: 5, max: 5, width: 24 },
    { key: "F", min: 6, max: 6, width: 38 },
  ],
  rowHeights: DETAIL_ROW_HEIGHTS,
  freezePane: { ySplit: 6, topLeftCell: "A7", activePane: "bottomLeft", state: "frozen" },
  selection: { pane: "bottomLeft", activeCell: "A7", sqref: "A7" },
  sheetView: { showGridLines: false },
  print: {
    area: { startColumn: "A", endColumn: "F", startRow: 1 },
    repeatRows: { start: 6, end: 6 },
    options: { horizontalCentered: true, headings: false, gridLines: false },
    margins: { left: 0.3, right: 0.3, top: 0.3, bottom: 0.3, header: 0.15, footer: 0.15 },
    pageSetup: { paperSize: 9, orientation: "landscape", fitToWidth: 1, fitToHeight: 0 },
    footer: "&8第 &P 页 / 共 &N 页",
  },
};

const SCREENSHOT_LAYOUT = {
  columns: [
    { key: "A", min: 1, max: 1, width: 12.5 },
    { key: "B", min: 2, max: 2, width: 15 },
    { key: "C", min: 3, max: 3, width: 40 },
    { key: "D", min: 4, max: 4, width: 13 },
    { key: "E", min: 5, max: 5, width: 48 },
    { key: "image", min: 6, max: null, width: 42 },
  ],
  rowHeights: SCREENSHOT_ROW_HEIGHTS,
  freezePane: { ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" },
  selection: { pane: "bottomLeft", activeCell: "A2", sqref: "A2" },
  sheetView: { showGridLines: false },
  print: {
    area: { startColumn: "A", endColumn: "dynamic", startRow: 1 },
    repeatRows: { start: 1, end: 1 },
    options: { horizontalCentered: false, headings: false, gridLines: false },
    margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    pageSetup: { paperSize: 9, orientation: "landscape", fitToWidth: 1, fitToHeight: 0 },
  },
};

const NUMBER_FORMATS = { date: DATE_FORMAT, amount: AMOUNT_FORMAT, total: AMOUNT_FORMAT };
const IMAGE_ANCHOR = {
  widthPx: 260,
  minHeightPx: 72,
  maxHeightPx: 210,
  columnOffsetPx: 5,
  rowOffsetPx: 5,
  emuPerPixel: 9525,
  preserveAspectRatio: true,
};
IMAGE_ANCHOR.widthEmu = IMAGE_ANCHOR.widthPx * IMAGE_ANCHOR.emuPerPixel;
IMAGE_ANCHOR.minHeightEmu = IMAGE_ANCHOR.minHeightPx * IMAGE_ANCHOR.emuPerPixel;
IMAGE_ANCHOR.maxHeightEmu = IMAGE_ANCHOR.maxHeightPx * IMAGE_ANCHOR.emuPerPixel;

const SUPPLEMENT_FIELD_DEFINITIONS = [
  { id: "originalOccurrenceDate", label: "原始发生日期", type: "date", required: true },
  { id: "supplementReason", label: "补报原因", type: "text", required: true },
  { id: "sourceReference", label: "关联原始凭证/来源编号", type: "text", required: true },
];

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cleanProfileId(value) {
  if (typeof value !== "string" || value !== value.trim() || !value || /[\r\n\t]/u.test(value)) {
    throw new Error("Visual contract profileId must be a non-empty trimmed string without control whitespace.");
  }
  return value;
}

const CONTRACT_CACHE = new Map();

function buildContract({ profileId, kind, contractId, roles, columns, columnWidths, rowHeights, layout, extra = {} }) {
  const checkedProfileId = cleanProfileId(profileId);
  const cacheKey = `${kind}:${checkedProfileId}`;
  if (CONTRACT_CACHE.has(cacheKey)) return CONTRACT_CACHE.get(cacheKey);
  const body = {
    schemaVersion: BUILTIN_VISUAL_CONTRACT_SCHEMA_VERSION,
    contractId,
    version: BUILTIN_VISUAL_CONTRACT_VERSION,
    visualContractId: contractId,
    visualContractVersion: BUILTIN_VISUAL_CONTRACT_VERSION,
    kind,
    profileId: checkedProfileId,
    source: "builtin",
    stylesXml: STYLES_XML,
    themeXml: THEME_XML,
    roles,
    styleRoles: roles,
    columns,
    columnWidths,
    rowHeights,
    layout,
    freezePane: layout.freezePane,
    printArea: layout.print.area,
    pageMargins: layout.print.margins,
    pageSetup: layout.print.pageSetup,
    gridLines: layout.sheetView.showGridLines,
    numberFormats: NUMBER_FORMATS,
    numberFormat: AMOUNT_FORMAT,
    dateFormat: DATE_FORMAT,
    imageAnchor: IMAGE_ANCHOR,
    ...extra,
  };
  const result = deepFreeze({ ...body, visualContractDigest: canonicalDigest(body) });
  CONTRACT_CACHE.set(cacheKey, result);
  return result;
}

export function getDetailContract(profileId = "default") {
  return buildContract({
    profileId,
    kind: "detail",
    contractId: "current-detail-person-grouped",
    roles: DETAIL_ROLES,
    columns: DETAIL_COLUMNS,
    columnWidths: DETAIL_COLUMN_WIDTHS,
    rowHeights: DETAIL_ROW_HEIGHTS,
    layout: DETAIL_LAYOUT,
    extra: {
      sheetRole: "detail",
      formulaRoles: ["summaryValue", "groupTotal", "employeeGroupTotal", "companyGroupTotal", "feeTotal"],
      companyPaidPresentation: { placement: "last", labelRole: "companyGroupLabel", totalRole: "companyGroupTotal", fillRgb: "FFFFE4C2" },
    },
  });
}

export function getScreenshotContract(profileId = "default") {
  return buildContract({
    profileId,
    kind: "screenshot",
    contractId: "reimbursement-screenshot-contact-sheet",
    roles: SCREENSHOT_ROLES,
    columns: SCREENSHOT_COLUMNS,
    columnWidths: SCREENSHOT_COLUMN_WIDTHS,
    rowHeights: SCREENSHOT_ROW_HEIGHTS,
    layout: SCREENSHOT_LAYOUT,
    extra: {
      sheetRole: "screenshot",
      imageColumnsStart: 6,
      minimumImageColumns: 3,
      imageAnchor: IMAGE_ANCHOR,
    },
  });
}

export function getSupplementContract(profileId = "default") {
  return buildContract({
    profileId,
    kind: "supplement",
    contractId: "ordinary-reimbursement-supplement-detail",
    roles: DETAIL_ROLES,
    columns: DETAIL_COLUMNS,
    columnWidths: DETAIL_COLUMN_WIDTHS,
    rowHeights: DETAIL_ROW_HEIGHTS,
    layout: DETAIL_LAYOUT,
    extra: {
      sheetRole: "supplement",
      formulaRoles: ["summaryValue", "groupTotal", "employeeGroupTotal", "companyGroupTotal", "feeTotal"],
      supplementFields: SUPPLEMENT_FIELD_DEFINITIONS.map((field) => field.label),
      supplementFieldDefinitions: SUPPLEMENT_FIELD_DEFINITIONS,
      emitWhen: "hasSupplementTransactions",
    },
  });
}

export function getVisualContract(kind, profileId = "default") {
  if (kind === "detail") return getDetailContract(profileId);
  if (kind === "screenshot") return getScreenshotContract(profileId);
  if (kind === "supplement") return getSupplementContract(profileId);
  throw new Error(`Unknown built-in visual contract kind: ${String(kind)}.`);
}

export function summarizeVisualContract(contract) {
  if (!contract || typeof contract !== "object" || !["builtin", "template-fallback"].includes(contract.source)) {
    throw new Error("A built-in or explicitly enabled fixture visual contract is required.");
  }
  if (!Number.isSafeInteger(contract.schemaVersion) || contract.schemaVersion !== BUILTIN_VISUAL_CONTRACT_SCHEMA_VERSION
    || contract.version !== BUILTIN_VISUAL_CONTRACT_VERSION
    || !["detail", "screenshot", "supplement"].includes(contract.kind)
    || contract.visualContractId !== contract.contractId
    || contract.visualContractVersion !== contract.version) {
    throw new Error("Built-in visual contract metadata is invalid.");
  }
  const expected = CONTRACT_CACHE.get(`${contract.kind}:${contract.profileId}`);
  if (contract.source === "builtin" && expected !== contract) {
    throw new Error("Built-in visual contract must come from the fixed contract registry.");
  }
  if (contract.source === "template-fallback") {
    if (!expected || expected.contractId !== contract.contractId || expected.profileId !== contract.profileId
      || typeof contract.legacyFixtureFile !== "string" || !contract.legacyFixtureFile
      || !/^[0-9a-f]{64}$/u.test(contract.legacyFixtureSha256 ?? "")
      || !/^[0-9a-f]{64}$/u.test(contract.visualContractDigest ?? "")) {
      throw new Error("Fixture visual contract must be derived from the fixed contract registry.");
    }
    const body = { ...contract };
    delete body.visualContractDigest;
    if (canonicalDigest(body) !== contract.visualContractDigest) {
      throw new Error("Fixture visual contract digest does not match its complete contract body.");
    }
  }
  return deepFreeze({
    visualContractId: contract.contractId,
    visualContractVersion: contract.version,
    visualContractDigest: contract.visualContractDigest,
    visualContractSource: contract.source,
  });
}

export const BUILTIN_STYLES_XML = STYLES_XML;
export const BUILTIN_THEME_XML = THEME_XML;
