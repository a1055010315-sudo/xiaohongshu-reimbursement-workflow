import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createDeterministicPng,
  createSolidPng,
  inspectPngVisualContent,
  inspectXlsxDrawingMedia,
  isProcessAlive,
  loadPackage,
  runMeasuredProcess,
  terminateProcessTree,
  validatePngBytes,
} from "./benchmark-helpers.mjs";

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureScript = path.join(benchmarkRoot, "representative-media-fixture.mjs");
const resourceHook = path.join(benchmarkRoot, "child-resource-hook.mjs");
const templateRoot = process.env.XHS_APPROVED_TEMPLATE_ROOT;
const goldenRoot = process.env.XHS_APPROVED_30_ROOT;
const nodeModules = process.env.XHS_WORKFLOW_NODE_MODULES ?? process.env.NODE_PATH;
const APPROVED_TEMPLATE_ANCHORS = Object.freeze({
  xiaohongshu: Object.freeze({
    relativePath: path.join("01_小红书", "小红书报销明细对应截图表_空白模板.xlsx"),
    size: 4175,
    sha256: "996c175b83772ee5160933bc36ce87d6d70457d5716e54ec7a48edfdf047d495",
  }),
  company: Object.freeze({
    relativePath: path.join("02_公司", "公司报销明细对应截图表_空白模板.xlsx"),
    size: 4169,
    sha256: "cbe29b185f67b63c9dd16784e160aae1d50cde6747ef82624498d0ce142001ff",
  }),
  residence: Object.freeze({
    relativePath: path.join("03_住所", "住所报销明细对应截图表_空白模板.xlsx"),
    size: 4168,
    sha256: "ec9c417a06c262c12b54097ad223f8e2159ff263027a558edd2cad1875fc6b0c",
  }),
});
const EXPECTED_MEDIA = Object.freeze({
  a5c01e7aae2bd2714bc52837c66ce54ac511e48f16e4177c26cd139324cc3dfd: Object.freeze({
    count: 6,
    width: 640,
    height: 360,
  }),
  e2ea1c6486bf87cac9f891501747ffb44565dddb38b4c858fe8fa90e9f0381bc: Object.freeze({
    count: 3,
    width: 800,
    height: 480,
  }),
  "125280da16a566d493f6a8990ddc49e0966dd09628f1bd5c81276565b567d681": Object.freeze({
    count: 1,
    width: 1600,
    height: 900,
  }),
});

function parseSingleJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `Expected one JSON line, received ${JSON.stringify(lines)}.`);
  return JSON.parse(lines[0]);
}

async function writeMutatedXlsx(sourcePath, targetPath, mutate) {
  const JSZipModule = await loadPackage("jszip");
  const JSZip = JSZipModule.default ?? JSZipModule;
  const zip = await JSZip.loadAsync(await fs.readFile(sourcePath));
  await mutate(zip);
  await fs.writeFile(targetPath, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }), { flag: "wx" });
}

function firstZipPart(zip, pattern, description) {
  const part = Object.values(zip.files).find((entry) => !entry.dir && pattern.test(entry.name));
  assert.ok(part, `Expected ${description} to tamper.`);
  return part;
}

async function replacePartText(zip, part, transform) {
  const original = await part.async("string");
  const replacement = transform(original);
  assert.notEqual(replacement, original, `Mutation did not change ${part.name}.`);
  zip.file(part.name, replacement);
}

function expectedMediaShaMultiset() {
  return Object.entries(EXPECTED_MEDIA)
    .flatMap(([digest, expected]) => Array.from({ length: expected.count }, () => digest))
    .sort();
}

function assertExpectedReferencedMedia(media) {
  const actualMultiset = media.referencedMediaItems
    .flatMap((item) => Array.from({ length: item.referenceCount }, () => item.sha256))
    .sort();
  if (JSON.stringify(actualMultiset) !== JSON.stringify(expectedMediaShaMultiset())) {
    throw new Error(`Referenced media SHA multiset drifted: ${JSON.stringify(actualMultiset)}.`);
  }
  for (const item of media.referencedMediaItems) {
    const expected = EXPECTED_MEDIA[item.sha256];
    assert.ok(expected, `Unexpected referenced media SHA ${item.sha256}.`);
    assert.equal(item.png.fileSha256, item.sha256);
    assert.equal(item.png.width, expected.width);
    assert.equal(item.png.height, expected.height);
    assert.ok(item.png.nonBackgroundPixelRatio > 0.5, `${item.part} is not visibly populated.`);
  }
}

test("Node preload uses file URLs for Windows paths containing spaces and CJK text", {
  skip: process.platform !== "win32",
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-import-url-"));
  try {
    const unicodeRoot = path.join(tempRoot, "含 空格");
    await fs.mkdir(unicodeRoot);
    const copiedHook = path.join(unicodeRoot, "资源 hook.mjs");
    const metricsPath = path.join(unicodeRoot, "资源 metrics.json");
    await fs.copyFile(resourceHook, copiedHook, fs.constants.COPYFILE_EXCL);
    const result = await runMeasuredProcess(process.execPath, [
      "--import",
      pathToFileURL(copiedHook).href,
      "--eval",
      "process.stdout.write('ok\\n')",
    ], {
      env: { ...process.env, XHS_BENCHMARK_METRICS_PATH: metricsPath },
      metricsPath,
      timeoutMs: 10_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "ok\n");
    assert.ok(result.resourceUsage);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await assert.rejects(fs.stat(tempRoot), { code: "ENOENT" });
});

test("visual-content verifier rejects a structurally valid uniform PNG", () => {
  const blank = createSolidPng(64, 64);
  assert.equal(validatePngBytes(blank).width, 64);
  assert.throws(() => inspectPngVisualContent(blank), /insufficient visible variation/u);
  const transparentNoise = createDeterministicPng(64, 64, 0x12345678, 0);
  assert.equal(validatePngBytes(transparentNoise).width, 64);
  assert.throws(() => inspectPngVisualContent(transparentNoise), /insufficient visible variation/u);
});

test("measured-process timeout terminates its exact PowerShell descendant tree", {
  skip: process.platform !== "win32",
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-timeout-probe-"));
  const pidPath = path.join(tempRoot, "pids.json");
  let pids = null;
  try {
    const result = await runMeasuredProcess(process.execPath, [fixtureScript, "--timeout-probe", pidPath], {
      timeoutMs: 1_000,
    });
    pids = JSON.parse(await fs.readFile(pidPath, "utf8"));
    assert.equal(result.timedOut, true);
    assert.equal(result.termination?.attempted, true);
    assert.equal(result.termination?.strategy, "windows-taskkill-tree");
    assert.equal(result.termination?.commandExitCode, 0);
    assert.equal(result.termination?.commandError, null);
    assert.equal(result.termination?.rootAlive, false);
    assert.equal(isProcessAlive(pids.rootPid), false);
    assert.equal(isProcessAlive(pids.descendantPid), false, `PowerShell descendant ${pids.descendantPid} remained alive.`);
  } finally {
    if (pids?.rootPid && isProcessAlive(pids.rootPid)) await terminateProcessTree(pids.rootPid);
    if (pids?.descendantPid && isProcessAlive(pids.descendantPid)) await terminateProcessTree(pids.descendantPid);
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await assert.rejects(fs.stat(tempRoot), { code: "ENOENT" });
});

test("fixture refuses an approved template whose bytes drifted", {
  skip: !templateRoot || !goldenRoot || process.platform !== "win32",
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-template-anchor-"));
  try {
    const templateDirectory = path.join(tempRoot, "templates", "01_小红书");
    await fs.mkdir(templateDirectory, { recursive: true });
    const source = path.join(templateRoot, APPROVED_TEMPLATE_ANCHORS.xiaohongshu.relativePath);
    const target = path.join(templateDirectory, path.basename(source));
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.appendFile(target, Buffer.from([0]));
    const outputRoot = path.join(tempRoot, "must-not-exist");
    const result = await runMeasuredProcess(process.execPath, [
      fixtureScript,
      "--profile-count",
      "1",
      "--template-root",
      path.join(tempRoot, "templates"),
      "--golden-root",
      goldenRoot,
      "--output-root",
      outputRoot,
    ], { timeoutMs: 10_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approved template size drifted/u);
    await assert.rejects(fs.stat(outputRoot), { code: "ENOENT" });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await assert.rejects(fs.stat(tempRoot), { code: "ENOENT" });
});

test("representative media fixtures cover real embedded PNG work for 1/2/3 profiles", {
  skip: !templateRoot || !goldenRoot || !nodeModules || process.platform !== "win32",
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-xhs-media-benchmark-"));
  assert.equal(path.dirname(tempRoot).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  const renderer = path.join(goldenRoot, "00_验收证据", "screenshot-map-copy-picture-renderer.ps1");
  const results = [];
  const withinRunRenderIdentity = new Map();
  try {
    for (const profileCount of [1, 2, 3]) {
      const outputRoot = path.join(tempRoot, `profiles-${profileCount}`);
      const metricsPath = path.join(tempRoot, `profiles-${profileCount}-resource.json`);
      const generated = await runMeasuredProcess(process.execPath, [
        "--import",
        pathToFileURL(resourceHook).href,
        fixtureScript,
        "--profile-count",
        String(profileCount),
        "--template-root",
        templateRoot,
        "--golden-root",
        goldenRoot,
        "--output-root",
        outputRoot,
      ], {
        cwd: benchmarkRoot,
        env: {
          ...process.env,
          NODE_PATH: nodeModules,
          XHS_BENCHMARK_METRICS_PATH: metricsPath,
        },
        metricsPath,
        timeoutMs: 180_000,
      });
      assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);
      assert.equal(generated.signal, null);
      assert.equal(generated.timedOut, false);
      assert.equal(generated.stderr, "");
      assert.ok(generated.resourceUsage, "Generator resource metrics were not written.");
      const fixture = parseSingleJsonLine(generated.stdout);
      assert.equal(fixture.profileCount, profileCount);
      assert.equal(fixture.profiles.length, profileCount);
      assert.equal(fixture.dependencyStdout.lineCount, profileCount);
      assert.ok(fixture.dependencyStdout.bytes > 0);
      assert.match(fixture.dependencyStdout.sha256, /^[a-f0-9]{64}$/u);
      const renderMeasurements = [];
      for (const profile of fixture.profiles) {
        assert.equal(profile.transactionCount, 10);
        assert.equal(profile.missingEvidenceCount, 2);
        const templateAnchor = APPROVED_TEMPLATE_ANCHORS[profile.profileId];
        assert.ok(templateAnchor, `Unknown profile ${profile.profileId}.`);
        assert.equal(path.resolve(profile.template.path), path.resolve(templateRoot, templateAnchor.relativePath));
        assert.equal(profile.template.size, templateAnchor.size);
        assert.equal(profile.template.sha256, templateAnchor.sha256);
        assert.equal(profile.template.sourceRole, "external-approved-baseline-only");
        const media = await inspectXlsxDrawingMedia(profile.screenshotMapPath);
        assert.equal(media.anchorCount, 10);
        assert.equal(media.mediaReferenceCount, 10);
        assert.equal(media.referencedMediaPartCount, 10);
        assert.equal(media.packageMediaPartCount, 10);
        assert.equal(media.uniqueMediaSha256Count, 3);
        assert.equal(media.orphanMediaParts.length, 0);
        assert.ok(media.mediaBytes > 1_000_000);
        assertExpectedReferencedMedia(media);
        if (profile.profileId === "residence") {
          assert.equal(path.basename(profile.rootPath), "驻所支出.xlsx");
        }
        if (profileCount === 1 && profile.profileId === "xiaohongshu") {
          const mutationRoot = path.join(outputRoot, profile.profileId);
          const tamperedPath = path.join(mutationRoot, "drawing-removed.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, tamperedPath, (zip) => {
            zip.remove(firstZipPart(zip, /^xl\/drawings\/[^/]+\.xml$/iu, "drawing part").name);
          });
          await assert.rejects(
            inspectXlsxDrawingMedia(tamperedPath),
            /Referenced drawing part .* is missing/u,
          );

          const externalPath = path.join(mutationRoot, "external-image-relationship.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, externalPath, async (zip) => {
            const rels = firstZipPart(zip, /^xl\/drawings\/_rels\/[^/]+\.rels$/iu, "drawing relationships part");
            await replacePartText(zip, rels, (xml) => xml.replace(
              /<Relationship\b/u,
              '<Relationship TargetMode="External"',
            ));
          });
          await assert.rejects(inspectXlsxDrawingMedia(externalPath), /relationship .* is external/u);

          const duplicateIdPath = path.join(mutationRoot, "duplicate-relationship-id.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, duplicateIdPath, async (zip) => {
            const rels = firstZipPart(zip, /^xl\/drawings\/_rels\/[^/]+\.rels$/iu, "drawing relationships part");
            await replacePartText(zip, rels, (xml) => {
              const relationship = xml.match(/<Relationship\b[^>]*\/>/u)?.[0];
              assert.ok(relationship, "Expected a self-closing relationship element.");
              return xml.replace(/<\/Relationships>/u, `${relationship}</Relationships>`);
            });
          });
          await assert.rejects(inspectXlsxDrawingMedia(duplicateIdPath), /duplicate relationship Id/u);

          const orphanPath = path.join(mutationRoot, "orphan-media.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, orphanPath, (zip) => {
            zip.file("xl/media/orphan.png", createDeterministicPng(320, 180, 0x0badf00d));
          });
          await assert.rejects(inspectXlsxDrawingMedia(orphanPath), /orphan media parts/u);

          const malformedPath = path.join(mutationRoot, "malformed-drawing-xml.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, malformedPath, async (zip) => {
            const drawing = firstZipPart(zip, /^xl\/drawings\/[^/]+\.xml$/iu, "drawing part");
            await replacePartText(zip, drawing, (xml) => xml.slice(0, xml.lastIndexOf("</")));
          });
          await assert.rejects(inspectXlsxDrawingMedia(malformedPath), /malformed XML/u);

          const replacedMediaPath = path.join(mutationRoot, "replaced-valid-media.xlsx");
          await writeMutatedXlsx(profile.screenshotMapPath, replacedMediaPath, (zip) => {
            const mediaPart = firstZipPart(zip, /^xl\/media\/[^/]+$/iu, "media part");
            zip.file(mediaPart.name, createDeterministicPng(320, 180, 0xfeedbeef));
          });
          const replacedMedia = await inspectXlsxDrawingMedia(replacedMediaPath);
          assert.throws(() => assertExpectedReferencedMedia(replacedMedia), /Referenced media SHA multiset drifted/u);
        }
        const pngPath = path.join(outputRoot, profile.profileId, `${profile.profileId}-screenshot-map.png`);
        const rendered = await runMeasuredProcess("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          renderer,
          "-WorkbookPath",
          profile.screenshotMapPath,
          "-OutputPath",
          pngPath,
          "-RangeAddress",
          "A1:H11",
        ], { cwd: outputRoot, timeoutMs: 90_000 });
        assert.equal(rendered.status, 0, `${rendered.stdout}\n${rendered.stderr}`);
        assert.equal(rendered.signal, null);
        assert.equal(rendered.timedOut, false);
        assert.equal(rendered.stderr, "");
        const png = inspectPngVisualContent(await fs.readFile(pngPath));
        const renderIdentity = {
          width: png.width,
          height: png.height,
          fileSha256: png.fileSha256,
          decodedPixelSha256: png.decodedPixelSha256,
        };
        if (withinRunRenderIdentity.has(profile.profileId)) {
          assert.deepEqual(
            renderIdentity,
            withinRunRenderIdentity.get(profile.profileId),
            `${profile.profileId} render changed within one characterization run.`,
          );
        } else {
          withinRunRenderIdentity.set(profile.profileId, renderIdentity);
        }
        renderMeasurements.push({
          profileId: profile.profileId,
          sourceRawSha256: profile.screenshotMapSha256,
          sourcePackageContentDigest: media.packageContentDigest,
          spawnToCloseMs: rendered.spawnToCloseMs,
          width: png.width,
          height: png.height,
          fileSha256: png.fileSha256,
          decodedPixelSha256: png.decodedPixelSha256,
          nonBackgroundPixelRatio: png.nonBackgroundPixelRatio,
          maxRssKilobytes: null,
          maxRssScope: "not-available-for-external-COM-engine-in-this-characterization",
        });
      }
      results.push({
        profileCount,
        generator: {
          spawnToFirstStdoutMs: generated.spawnToFirstStdoutMs,
          spawnToCloseMs: generated.spawnToCloseMs,
          ...generated.resourceUsage,
        },
        renderMeasurements,
      });
    }
    console.log(JSON.stringify({
      kind: "representative-media-characterization",
      renderRepeatabilityScope: "same-profile-within-one-test-run; cross-run renderer golden remains a production-hardening gate",
      sourceIdentityScope: "fixed template/media/data/anchor rules; raw XLSX and package-content digests are observations because artifact-tool regenerates relationship IDs",
      results,
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  await assert.rejects(fs.stat(tempRoot), { code: "ENOENT" });
});
