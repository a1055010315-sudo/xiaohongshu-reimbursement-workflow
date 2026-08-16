import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createDeterministicPng,
  loadPackage,
  sha256,
  sha256File,
} from "./benchmark-helpers.mjs";

const PROFILES = [
  {
    id: "xiaohongshu",
    templateDirectory: "01_小红书",
    templateName: "小红书报销明细对应截图表_空白模板.xlsx",
    goldenDirectory: "01_小红书专项",
    goldenRootName: "小红书支出总表.xlsx",
    goldenDetailName: "2026.8.13-2026.8.14_小红书报销_本次报销明细.xlsx",
    canonicalRootName: "小红书支出总表.xlsx",
    templateSize: 4175,
    templateSha256: "996c175b83772ee5160933bc36ce87d6d70457d5716e54ec7a48edfdf047d495",
  },
  {
    id: "company",
    templateDirectory: "02_公司",
    templateName: "公司报销明细对应截图表_空白模板.xlsx",
    goldenDirectory: "02_公司专项",
    goldenRootName: "公司支出总表.xlsx",
    goldenDetailName: "2026.8.13-2026.8.14_公司报销_本次报销明细.xlsx",
    canonicalRootName: "公司支出总表.xlsx",
    templateSize: 4169,
    templateSha256: "cbe29b185f67b63c9dd16784e160aae1d50cde6747ef82624498d0ce142001ff",
  },
  {
    id: "residence",
    templateDirectory: "03_住所",
    templateName: "住所报销明细对应截图表_空白模板.xlsx",
    goldenDirectory: "03_住所专项",
    goldenRootName: "住所支出.xlsx",
    goldenDetailName: "2026.8.13-2026.8.14_住所报销_本次报销明细.xlsx",
    canonicalRootName: "驻所支出.xlsx",
    templateSize: 4168,
    templateSha256: "ec9c417a06c262c12b54097ad223f8e2159ff263027a558edd2cad1875fc6b0c",
  },
];

function parseCli(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || key in result) {
      throw new Error("Arguments must be unique --key value pairs.");
    }
    result[key] = value;
  }
  const profileCount = Number(result["--profile-count"]);
  if (![1, 2, 3].includes(profileCount)) throw new Error("--profile-count must be 1, 2, or 3.");
  for (const key of ["--template-root", "--golden-root", "--output-root"]) {
    if (!path.isAbsolute(result[key] ?? "")) throw new Error(`${key} must be an absolute path.`);
  }
  return {
    profileCount,
    templateRoot: path.resolve(result["--template-root"]),
    goldenRoot: path.resolve(result["--golden-root"]),
    outputRoot: path.resolve(result["--output-root"]),
  };
}

async function assertNewOutputRoot(outputRoot) {
  try {
    await fs.lstat(outputRoot);
    throw new Error("--output-root must not already exist.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(outputRoot);
}

async function validateTemplateAnchor(profile, options) {
  const templatePath = path.join(options.templateRoot, profile.templateDirectory, profile.templateName);
  const stat = await fs.stat(templatePath);
  if (!stat.isFile() || stat.size !== profile.templateSize) {
    throw new Error(`${profile.id} approved template size drifted.`);
  }
  const digest = await sha256File(templatePath);
  if (digest !== profile.templateSha256) throw new Error(`${profile.id} approved template SHA-256 drifted.`);
  return {
    path: templatePath,
    size: stat.size,
    sha256: digest,
    sourceRole: "external-approved-baseline-only",
  };
}

async function packageMediaFacts(filePath, JSZip) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const media = Object.values(zip.files).filter((entry) => !entry.dir && /^xl\/media\//i.test(entry.name));
  const items = [];
  for (const entry of media) {
    const bytes = await entry.async("nodebuffer");
    items.push({ part: entry.name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    mediaPartCount: items.length,
    mediaBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    uniqueMediaSha256Count: new Set(items.map((item) => item.sha256)).size,
    items,
  };
}

async function captureBoundedDependencyStdout(action) {
  const originalWrite = process.stdout.write;
  const chunks = [];
  let totalBytes = 0;
  process.stdout.write = function captureWrite(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
    totalBytes += bytes.length;
    if (totalBytes > 65_536) throw new Error("Dependency stdout exceeded 65536 bytes.");
    chunks.push(bytes);
    const completed = typeof encoding === "function" ? encoding : callback;
    if (typeof completed === "function") queueMicrotask(completed);
    return true;
  };
  try {
    const value = await action();
    const bytes = Buffer.concat(chunks);
    return {
      value,
      diagnostics: {
        bytes: bytes.length,
        sha256: sha256(bytes),
        lineCount: bytes.length === 0 ? 0 : bytes.toString("utf8").split(/\r?\n/u).filter(Boolean).length,
      },
    };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function buildScreenshotMap(profile, options, packages, imageBytes, template) {
  const { FileBlob, SpreadsheetFile } = packages.artifact;
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(template.path));
  const sheet = workbook.worksheets.getItemAt(0);
  const templateRow = sheet.getRange("A2:H2");
  for (let row = 2; row <= 11; row += 1) {
    if (row > 3) templateRow.copyTo(sheet.getRange(`A${row}:H${row}`), "all");
    const index = row - 2;
    const missing = index === 4 || index === 9;
    sheet.getRange(`A${row}:H${row}`).values = [[
      new Date(Date.UTC(2026, 7, 13 + index)),
      `匿名主体${(index % 3) + 1}`,
      `脱敏媒体性能项目${index + 1}`,
      10 + index + (index % 2 === 0 ? 0.125 : 0),
      missing ? "无截图（脱敏性能夹具）" : `脱敏凭证${index + 1}`,
      null,
      null,
      null,
    ]];
    sheet.getRange(`A${row}`).format.numberFormat = "mm-dd";
    sheet.getRange(`D${row}`).format.numberFormat = "0.000";
    sheet.getRange(`A${row}:H${row}`).format.rowHeight = 82;
    if (!missing) {
      const imageKey = index === 3 ? "large" : index % 2 === 0 ? "smallA" : "smallB";
      const dataUrl = `data:image/png;base64,${imageBytes[imageKey].toString("base64")}`;
      sheet.images.add({
        dataUrl,
        anchor: { from: { row: row - 1, col: 5 }, extent: { widthPx: 150, heightPx: 74 } },
      });
      if (index === 2 || index === 6) {
        sheet.images.add({
          dataUrl,
          anchor: { from: { row: row - 1, col: 6 }, extent: { widthPx: 150, heightPx: 74 } },
        });
      }
    }
  }
  const profileRoot = path.join(options.outputRoot, profile.id);
  await fs.mkdir(profileRoot);
  const screenshotMapPath = path.join(profileRoot, `${profile.id}-screenshot-map.xlsx`);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(screenshotMapPath);

  const goldenProfileRoot = path.join(options.goldenRoot, profile.goldenDirectory);
  const rootPath = path.join(profileRoot, profile.canonicalRootName);
  const detailPath = path.join(profileRoot, `${profile.id}-detail.xlsx`);
  await fs.copyFile(path.join(goldenProfileRoot, profile.goldenRootName), rootPath, fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(goldenProfileRoot, profile.goldenDetailName), detailPath, fs.constants.COPYFILE_EXCL);
  return {
    profileId: profile.id,
    canonicalRootName: profile.canonicalRootName,
    rootPath,
    rootSha256: await sha256File(rootPath),
    detailPath,
    detailSha256: await sha256File(detailPath),
    screenshotMapPath,
    screenshotMapSha256: await sha256File(screenshotMapPath),
    screenshotMapBytes: (await fs.stat(screenshotMapPath)).size,
    media: await packageMediaFacts(screenshotMapPath, packages.JSZip),
    template,
    transactionCount: 10,
    missingEvidenceCount: 2,
  };
}

async function runTimeoutProbe(pidPath) {
  if (!path.isAbsolute(pidPath ?? "")) throw new Error("Timeout probe PID path must be absolute.");
  const descendant = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Start-Sleep -Seconds 120",
  ], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    descendant.once("spawn", resolve);
    descendant.once("error", reject);
  });
  await fs.writeFile(pidPath, `${JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid })}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await new Promise(() => {});
}

if (process.argv[2] === "--timeout-probe") {
  await runTimeoutProbe(process.argv[3]);
} else {
  const options = parseCli(process.argv.slice(2));
  const selectedProfiles = PROFILES.slice(0, options.profileCount);
  const templateAnchors = new Map();
  for (const profile of selectedProfiles) {
    templateAnchors.set(profile.id, await validateTemplateAnchor(profile, options));
  }
  await assertNewOutputRoot(options.outputRoot);
  const captured = await captureBoundedDependencyStdout(async () => {
    const artifactModule = await loadPackage("@oai/artifact-tool");
    const JSZipModule = await loadPackage("jszip");
    const packages = {
      artifact: artifactModule,
      JSZip: JSZipModule.default ?? JSZipModule,
    };
    const imageBytes = {
      smallA: createDeterministicPng(640, 360, 0x13579bdf),
      smallB: createDeterministicPng(800, 480, 0x2468ace0),
      large: createDeterministicPng(1600, 900, 0x10203040),
    };
    const imageFacts = Object.fromEntries(
      Object.entries(imageBytes).map(([key, bytes]) => [key, { bytes: bytes.length, sha256: sha256(bytes) }]),
    );
    const profiles = [];
    for (const profile of selectedProfiles) {
      profiles.push(await buildScreenshotMap(
        profile,
        options,
        packages,
        imageBytes,
        templateAnchors.get(profile.id),
      ));
    }
    return { imageFacts, profiles };
  });
  const result = {
    ok: true,
    kind: "representative-media-fixture",
    profileCount: options.profileCount,
    dependencyStdout: captured.diagnostics,
    imageFacts: captured.value.imageFacts,
    profiles: captured.value.profiles,
  };
  await fs.writeFile(
    path.join(options.outputRoot, "fixture-manifest.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
