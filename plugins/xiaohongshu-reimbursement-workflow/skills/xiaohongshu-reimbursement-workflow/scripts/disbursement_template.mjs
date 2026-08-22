import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyStableBinaryBytes,
  loadBundledDependency,
  readStableBinaryFile,
  readStableUtf8JsonFile,
  sha256Bytes,
} from "./workflow_primitives.mjs";
import { auditOpenedWorkbookStyleContract } from "./workbook_style_contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.resolve(SCRIPT_DIR, "..", "assets", "templates", "disbursement");
const TEMPLATE_MANIFEST_PATH = path.join(TEMPLATE_ROOT, "template-manifest.json");
const STYLE_CONTRACT_PATH = path.resolve(SCRIPT_DIR, "..", "references", "workbook-style-contract.json");
const SHA_RE = /^[0-9a-f]{64}$/u;
const REQUIRED_HEADERS = Object.freeze([
  "姓名/事项", "小红书报销", "公司报销", "驻所报销", "工资类别", "工资",
  "应发合计", "实际发放", "方式", "状态", "凭证/备注",
]);
const REQUIRED_STATUSES = Object.freeze(["已核销", "待凭证", "待现金确认", "异常待说明", "非本批", "已忽略尾差"]);
const REQUIRED_STYLE_ROLES = Object.freeze(["title", "subtitle", "header", "text", "amount", "status", "summaryLabel", "summaryAmount"]);
const JSZipModule = loadBundledDependency("jszip");
const JSZip = JSZipModule.default ?? JSZipModule;

let templatePromise;

function fail(message) {
  throw new Error(`Compact Disbursement Template ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`);
  return value;
}

function exactArray(value, expected, field) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    fail(`${field} differs from the fixed compact-disbursement contract.`);
  }
}

function digest(value, field) {
  if (typeof value !== "string" || !SHA_RE.test(value)) fail(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

async function loadTemplateUncached() {
  const [manifestSnapshot, styleContractSnapshot] = await Promise.all([
    readStableUtf8JsonFile(TEMPLATE_MANIFEST_PATH, { maxBytes: 256 * 1024 }),
    readStableUtf8JsonFile(STYLE_CONTRACT_PATH, { maxBytes: 4 * 1024 * 1024 }),
  ]);
  const root = object(manifestSnapshot.value, "template manifest");
  if (root.schemaVersion !== 1 || root.contractId !== "compact-disbursement-template-v1") fail("manifest identity is invalid.");
  const contract = object(object(root.templates, "templates")["compact-disbursement"], "compact-disbursement template");
  if (contract.file !== "compact-disbursement.xlsx" || contract.sheetName !== "发放核对表") fail("template file/sheet identity is invalid.");
  if (contract.worksheetCount !== 1 || contract.visibleWorksheetCount !== 1 || contract.hiddenWorksheetCount !== 0) fail("template must have exactly one visible worksheet.");
  exactArray(contract.requiredHeaders, REQUIRED_HEADERS, "requiredHeaders");
  exactArray(contract.visibleStatuses, REQUIRED_STATUSES, "visibleStatuses");
  if (!Number.isSafeInteger(contract.headerRow) || !Number.isSafeInteger(contract.dataStartRow) || contract.dataStartRow !== contract.headerRow + 1) fail("template row contract is invalid.");
  if (!Array.isArray(contract.columns) || contract.columns.length !== 11) fail("template must define exactly eleven columns.");
  const styleRoles = object(contract.styleRoles, "styleRoles");
  for (const role of REQUIRED_STYLE_ROLES) if (!Number.isSafeInteger(styleRoles[role]) || styleRoles[role] < 0) fail(`styleRoles.${role} is invalid.`);
  const templatePath = path.join(TEMPLATE_ROOT, contract.file);
  const expectedTemplateSha256 = digest(contract.sha256, "template sha256");
  const templateSnapshot = await readStableBinaryFile(templatePath, { maxBytes: 32 * 1024 * 1024 });
  if (templateSnapshot.sha256 !== expectedTemplateSha256) fail("template XLSX SHA-256 differs from its manifest.");
  const templateBytes = copyStableBinaryBytes(templateSnapshot);
  const zip = await JSZip.loadAsync(templateBytes, { createFolders: false });
  const partSha256 = object(contract.partSha256, "partSha256");
  const partBytes = new Map();
  for (const [partName, expected] of Object.entries(partSha256)) {
    digest(expected, `partSha256.${partName}`);
    const part = zip.file(partName);
    if (!part) fail(`template part ${partName} is missing.`);
    const bytes = await part.async("nodebuffer");
    if (sha256Bytes(bytes) !== expected) fail(`template part ${partName} differs from its manifest.`);
    partBytes.set(partName, bytes);
  }
  const partText = (name) => partBytes.get(name)?.toString("utf8") ?? fail(`template part ${name} is missing from the manifest.`);
  const workbookXml = partText("xl/workbook.xml");
  if ((workbookXml.match(/<sheet\b/giu) ?? []).length !== 1 || !/name="发放核对表"/u.test(workbookXml) || /state="(?:hidden|veryHidden)"/iu.test(workbookXml)) {
    fail("template workbook does not contain exactly one visible 发放核对表 sheet.");
  }
  const styleAudit = auditOpenedWorkbookStyleContract({
    contract: styleContractSnapshot.value,
    templateId: "compact-disbursement",
    templateDefinition: contract,
    styleRoles,
    parts: {
      stylesXml: partText("xl/styles.xml"),
      themeXml: partText("xl/theme/theme1.xml"),
      worksheetXml: partText("xl/worksheets/sheet1.xml"),
      workbookXml,
    },
  });
  const contractStyleEntry = object(object(styleContractSnapshot.value.templates, "style contract templates")["compact-disbursement"], "compact-disbursement style contract");
  if (digest(contract.contractRoleSignaturesDigest, "contractRoleSignaturesDigest") !== digest(contractStyleEntry.roleSignaturesDigest, "style contract roleSignaturesDigest")
      || styleAudit.binding.styleRolesDigest !== digest(contract.styleRolesDigest, "styleRolesDigest")
      || styleAudit.binding.layoutDigest !== digest(contract.layoutDigest, "layoutDigest")
      || styleAudit.binding.bindingDigest !== digest(contract.styleBindingDigest, "styleBindingDigest")) {
    fail("template semantic digests differ from the runtime style contract.");
  }
  return Object.freeze({
    templatePath,
    templateSha256: expectedTemplateSha256,
    templateSize: templateSnapshot.size,
    templateManifestPath: TEMPLATE_MANIFEST_PATH,
    templateManifestSha256: manifestSnapshot.sha256,
    templateDefinition: Object.freeze(structuredClone(contract)),
    styleContractPath: STYLE_CONTRACT_PATH,
    styleContractSha256: styleContractSnapshot.sha256,
    styleContract: Object.freeze(structuredClone(styleContractSnapshot.value)),
    templateBytes,
    sheetName: contract.sheetName,
    headerRow: contract.headerRow,
    dataStartRow: contract.dataStartRow,
    minimumDataEndRow: contract.dataEndRow,
    styleRoles: Object.freeze({ ...styleRoles }),
    styleBindingDigest: styleAudit.binding.bindingDigest,
    layoutDigest: styleAudit.binding.layoutDigest,
    contractRoleSignaturesDigest: contractStyleEntry.roleSignaturesDigest,
    styleRolesDigest: styleAudit.binding.styleRolesDigest,
    stylesPartSha256: digest(partSha256["xl/styles.xml"], "styles part sha256"),
    themePartSha256: digest(partSha256["xl/theme/theme1.xml"], "theme part sha256"),
    columns: Object.freeze(contract.columns.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function loadDisbursementTemplate() {
  templatePromise ??= loadTemplateUncached();
  return templatePromise;
}
