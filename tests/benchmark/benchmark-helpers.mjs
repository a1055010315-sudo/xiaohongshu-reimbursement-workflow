import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const require = createRequire(import.meta.url);

let crcTable;

function tableForCrc32() {
  if (crcTable) return crcTable;
  crcTable = Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
  return crcTable;
}

export function crc32(bytes) {
  const table = tableForCrc32();
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

export async function loadPackage(name) {
  return import(pathToFileURL(require.resolve(name)).href);
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
  return Buffer.concat([length, typeBytes, payload, checksum]);
}

export function createDeterministicPng(width, height, seed, alpha = 255) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("PNG dimensions must be positive integers.");
  }
  if (!Number.isInteger(alpha) || alpha < 0 || alpha > 255) throw new Error("PNG alpha must be a byte value.");
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let state = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = (state + x) & 0xff;
      raw[offset + 1] = ((state >>> 8) + y) & 0xff;
      raw[offset + 2] = ((state >>> 16) + x + y) & 0xff;
      raw[offset + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createSolidPng(width, height, rgba = [255, 255, 255, 255]) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("PNG dimensions must be positive integers.");
  }
  if (!Array.isArray(rgba) || rgba.length !== 4 || rgba.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("RGBA must contain four byte values.");
  }
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      raw.set(rgba, offset);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bitsPerPixel(bitDepth, colorType) {
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`);
  return channels * bitDepth;
}

function parsePngBytes(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("PNG signature is invalid.");
  }
  let offset = 8;
  let header;
  let sawEnd = false;
  const idat = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("PNG chunk is truncated.");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) throw new Error("PNG chunk payload is truncated.");
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    const payload = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    if (crc32(Buffer.concat([typeBytes, payload])) !== expectedCrc) {
      throw new Error(`PNG ${type} CRC is invalid.`);
    }
    if (type === "IHDR") {
      if (header || length !== 13) throw new Error("PNG IHDR is invalid.");
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        bitDepth: payload[8],
        colorType: payload[9],
        compression: payload[10],
        filter: payload[11],
        interlace: payload[12],
      };
    } else if (type === "IDAT") {
      idat.push(payload);
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("PNG IEND is invalid.");
      sawEnd = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!header || !sawEnd || idat.length === 0 || offset !== bytes.length) {
    throw new Error("PNG structure is incomplete or has trailing bytes.");
  }
  if (header.width < 1 || header.height < 1 || header.compression !== 0 || header.filter !== 0) {
    throw new Error("PNG header uses unsupported values.");
  }
  if (header.interlace !== 0) throw new Error("Interlaced PNG is unsupported by this benchmark verifier.");
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = Math.ceil((header.width * bitsPerPixel(header.bitDepth, header.colorType)) / 8);
  const expectedLength = (rowBytes + 1) * header.height;
  if (inflated.length !== expectedLength) {
    throw new Error(`PNG inflated length ${inflated.length} does not equal ${expectedLength}.`);
  }
  for (let row = 0; row < header.height; row += 1) {
    const filterType = inflated[row * (rowBytes + 1)];
    if (filterType > 4) throw new Error(`PNG row ${row} has invalid filter ${filterType}.`);
  }
  return { bytes, header, inflated, rowBytes };
}

export function validatePngBytes(input) {
  const { bytes, header, inflated } = parsePngBytes(input);
  return {
    ...header,
    fileSha256: sha256(bytes),
    decodedScanlineSha256: sha256(inflated),
  };
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

export function inspectPngVisualContent(input, options = {}) {
  const { bytes, header, inflated, rowBytes } = parsePngBytes(input);
  if (header.bitDepth !== 8 || ![0, 2, 4, 6].includes(header.colorType)) {
    throw new Error(`PNG visual inspection does not support bit depth ${header.bitDepth}, color type ${header.colorType}.`);
  }
  const channels = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]).get(header.colorType);
  const decoded = Buffer.alloc(rowBytes * header.height);
  for (let row = 0; row < header.height; row += 1) {
    const inputStart = row * (rowBytes + 1);
    const outputStart = row * rowBytes;
    const filterType = inflated[inputStart];
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = inflated[inputStart + 1 + column];
      const left = column >= channels ? decoded[outputStart + column - channels] : 0;
      const up = row > 0 ? decoded[outputStart - rowBytes + column] : 0;
      const upperLeft = row > 0 && column >= channels
        ? decoded[outputStart - rowBytes + column - channels]
        : 0;
      let predictor = 0;
      if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = Math.floor((left + up) / 2);
      else if (filterType === 4) predictor = paethPredictor(left, up, upperLeft);
      decoded[outputStart + column] = (raw + predictor) & 0xff;
    }
  }
  const visibleRgb = Buffer.alloc(header.width * header.height * 3);
  for (let source = 0, target = 0; source < decoded.length; source += channels, target += 3) {
    let red;
    let green;
    let blue;
    let alpha = 255;
    if (header.colorType === 0) {
      red = decoded[source];
      green = red;
      blue = red;
    } else if (header.colorType === 2) {
      red = decoded[source];
      green = decoded[source + 1];
      blue = decoded[source + 2];
    } else if (header.colorType === 4) {
      red = decoded[source];
      green = red;
      blue = red;
      alpha = decoded[source + 1];
    } else {
      red = decoded[source];
      green = decoded[source + 1];
      blue = decoded[source + 2];
      alpha = decoded[source + 3];
    }
    visibleRgb[target] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
    visibleRgb[target + 1] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
    visibleRgb[target + 2] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
  }
  const histogram = new Uint32Array(4096);
  const pixelCount = header.width * header.height;
  for (let offset = 0; offset < visibleRgb.length; offset += 3) {
    const bucket = (visibleRgb[offset] >>> 4) << 8
      | (visibleRgb[offset + 1] >>> 4) << 4
      | (visibleRgb[offset + 2] >>> 4);
    histogram[bucket] += 1;
  }
  let backgroundBucket = 0;
  for (let bucket = 1; bucket < histogram.length; bucket += 1) {
    if (histogram[bucket] > histogram[backgroundBucket]) backgroundBucket = bucket;
  }
  const nonBackgroundPixelCount = pixelCount - histogram[backgroundBucket];
  const nonBackgroundPixelRatio = nonBackgroundPixelCount / pixelCount;
  const minimumPixels = options.minimumPixels ?? 64;
  const minimumRatio = options.minimumRatio ?? 0.001;
  if (nonBackgroundPixelCount < minimumPixels || nonBackgroundPixelRatio < minimumRatio) {
    throw new Error(
      `PNG has insufficient visible variation: ${nonBackgroundPixelCount} pixels, ratio ${nonBackgroundPixelRatio}.`,
    );
  }
  return {
    ...header,
    fileSha256: sha256(bytes),
    decodedPixelSha256: sha256(visibleRgb),
    decodedRawPixelSha256: sha256(decoded),
    dominantBackgroundRgbBucket: [
      ((backgroundBucket >>> 8) & 0x0f) * 17,
      ((backgroundBucket >>> 4) & 0x0f) * 17,
      (backgroundBucket & 0x0f) * 17,
    ],
    nonBackgroundPixelCount,
    nonBackgroundPixelRatio,
  };
}

function xmlLocalName(name) {
  const separator = name.lastIndexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

function parseStrictXml(xml, partName, sax) {
  if (typeof xml !== "string" || xml.length === 0) throw new Error(`${partName} is empty.`);
  const roots = [];
  const stack = [];
  let parseError = null;
  const parser = sax.parser(true, {
    position: false,
    strictEntities: true,
    trim: false,
    normalize: false,
    xmlns: false,
  });
  parser.onerror = (error) => {
    parseError = error;
  };
  parser.ondoctype = () => {
    throw new Error(`${partName} contains a forbidden DOCTYPE declaration.`);
  };
  parser.onsgmldeclaration = () => {
    throw new Error(`${partName} contains a forbidden SGML declaration.`);
  };
  parser.onopentag = ({ name, attributes }) => {
    const node = {
      name,
      localName: xmlLocalName(name),
      attributes: new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)])),
      children: [],
    };
    if (stack.length > 0) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  };
  parser.onclosetag = (name) => {
    const current = stack.pop();
    if (!current || current.name !== name) throw new Error(`${partName} has mismatched closing tag ${name}.`);
  };
  try {
    parser.write(xml).close();
  } catch (error) {
    parseError ??= error;
  }
  if (parseError) throw new Error(`${partName} is malformed XML: ${parseError.message}`, { cause: parseError });
  if (stack.length !== 0 || roots.length !== 1) throw new Error(`${partName} is not a single balanced XML document.`);
  return roots[0];
}

function descendants(node, localName) {
  const found = [];
  const visit = (current) => {
    if (current.localName === localName) found.push(current);
    for (const child of current.children) visit(child);
  };
  visit(node);
  return found;
}

function singleAttributeByLocalName(node, localName, required = true) {
  const values = [...node.attributes.entries()].filter(([name]) => xmlLocalName(name) === localName);
  if (values.length > 1) throw new Error(`Element ${node.name} has duplicate ${localName} attributes by namespace alias.`);
  if (required && values.length === 0) throw new Error(`Element ${node.name} is missing ${localName}.`);
  return values[0]?.[1] ?? null;
}

function relationshipsPartFor(sourcePart) {
  return path.posix.join(path.posix.dirname(sourcePart), "_rels", `${path.posix.basename(sourcePart)}.rels`);
}

function resolveRelationshipTarget(sourcePart, target) {
  if (target.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//")) {
    throw new Error(`Relationship target ${target} is not a package-relative URI.`);
  }
  let decoded;
  try {
    decoded = decodeURI(target);
  } catch {
    throw new Error(`Relationship target ${target} has invalid URI encoding.`);
  }
  const normalized = decoded.startsWith("/")
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), decoded));
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Relationship target ${target} escapes the XLSX package.`);
  }
  return normalized;
}

async function relationshipMap(zip, sourcePart, sax) {
  const relsPart = relationshipsPartFor(sourcePart);
  const relsEntry = zip.file(relsPart);
  if (!relsEntry) throw new Error(`Missing relationship part ${relsPart}.`);
  const root = parseStrictXml(await relsEntry.async("string"), relsPart, sax);
  if (root.localName !== "Relationships") throw new Error(`${relsPart} has an invalid root element.`);
  const relationships = new Map();
  for (const node of root.children) {
    if (node.localName !== "Relationship") throw new Error(`${relsPart} contains an unknown child ${node.name}.`);
    const id = singleAttributeByLocalName(node, "Id");
    const type = singleAttributeByLocalName(node, "Type");
    const target = singleAttributeByLocalName(node, "Target");
    const targetMode = singleAttributeByLocalName(node, "TargetMode", false);
    if (targetMode && targetMode !== "Internal") throw new Error(`${relsPart} relationship ${id} is external.`);
    if (relationships.has(id)) throw new Error(`${relsPart} has duplicate relationship Id ${id}.`);
    relationships.set(id, {
      id,
      type,
      target: resolveRelationshipTarget(sourcePart, target),
    });
  }
  return relationships;
}

export async function inspectXlsxDrawingMedia(filePath) {
  const [JSZipModule, saxModule] = await Promise.all([loadPackage("jszip"), loadPackage("sax")]);
  const JSZip = JSZipModule.default ?? JSZipModule;
  const sax = saxModule.default ?? saxModule;
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const worksheetParts = Object.values(zip.files)
    .filter((entry) => !entry.dir && /^xl\/worksheets\/[^/]+\.xml$/iu.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (worksheetParts.length === 0) throw new Error("XLSX package has no worksheet parts.");
  const referencedDrawings = new Set();
  for (const worksheetPart of worksheetParts) {
    const worksheet = parseStrictXml(await zip.file(worksheetPart).async("string"), worksheetPart, sax);
    const drawingNodes = descendants(worksheet, "drawing");
    if (drawingNodes.length === 0) continue;
    const relationships = await relationshipMap(zip, worksheetPart, sax);
    for (const drawingNode of drawingNodes) {
      const relationshipId = singleAttributeByLocalName(drawingNode, "id");
      const relationship = relationships.get(relationshipId);
      if (!relationship || !relationship.type.endsWith("/drawing")) {
        throw new Error(`${worksheetPart} drawing ${relationshipId} is not bound to a drawing relationship.`);
      }
      if (!zip.file(relationship.target)) throw new Error(`Referenced drawing part ${relationship.target} is missing.`);
      referencedDrawings.add(relationship.target);
    }
  }

  const referencedMedia = [];
  let anchorCount = 0;
  for (const drawingPart of [...referencedDrawings].sort()) {
    const drawing = parseStrictXml(await zip.file(drawingPart).async("string"), drawingPart, sax);
    const relationships = await relationshipMap(zip, drawingPart, sax);
    const anchors = drawing.children.filter((node) => ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"].includes(node.localName));
    for (const anchor of anchors) {
      const blips = descendants(anchor, "blip");
      if (blips.length !== 1) throw new Error(`${drawingPart} anchor must contain exactly one image blip.`);
      const relationshipId = singleAttributeByLocalName(blips[0], "embed");
      const relationship = relationships.get(relationshipId);
      if (!relationship || !relationship.type.endsWith("/image")) {
        throw new Error(`${drawingPart} anchor ${relationshipId} is not bound to an image relationship.`);
      }
      const mediaEntry = zip.file(relationship.target);
      if (!mediaEntry || !/^xl\/media\//iu.test(relationship.target)) {
        throw new Error(`${drawingPart} image target ${relationship.target} is missing or outside xl/media.`);
      }
      referencedMedia.push(relationship.target);
      anchorCount += 1;
    }
  }

  const packageParts = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name)
    .sort();
  const packageContentItems = [];
  const mediaItems = [];
  for (const part of packageParts) {
    const bytes = await zip.file(part).async("nodebuffer");
    const digest = sha256(bytes);
    packageContentItems.push({ part, sha256: digest });
    if (/^xl\/media\//iu.test(part)) {
      mediaItems.push({ part, bytes: bytes.length, sha256: digest, content: bytes });
    }
  }
  const referencedSet = new Set(referencedMedia);
  const orphanMediaParts = mediaItems.filter((item) => !referencedSet.has(item.part)).map((item) => item.part);
  if (orphanMediaParts.length > 0) throw new Error(`XLSX package contains orphan media parts: ${orphanMediaParts.join(", ")}.`);
  const referenceCounts = new Map();
  for (const part of referencedMedia) referenceCounts.set(part, (referenceCounts.get(part) ?? 0) + 1);
  const referencedMediaItems = mediaItems
    .filter((item) => referencedSet.has(item.part))
    .map((item) => ({
      part: item.part,
      bytes: item.bytes,
      sha256: item.sha256,
      referenceCount: referenceCounts.get(item.part),
      png: inspectPngVisualContent(item.content),
    }));
  return {
    worksheetPartCount: worksheetParts.length,
    drawingPartCount: referencedDrawings.size,
    anchorCount,
    referencedMediaPartCount: referencedSet.size,
    mediaReferenceCount: referencedMedia.length,
    packageMediaPartCount: mediaItems.length,
    packageContentDigest: sha256(Buffer.from(JSON.stringify(packageContentItems), "utf8")),
    uniqueMediaSha256Count: new Set(referencedMediaItems.map((item) => item.sha256)).size,
    mediaBytes: mediaItems.reduce((sum, item) => sum + item.bytes, 0),
    orphanMediaParts,
    referencedMediaItems,
    mediaItems: mediaItems.map(({ content, ...item }) => item),
  };
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await wait(25);
  }
  return !isProcessAlive(pid);
}

async function runTreeKillCommand(command, args) {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    let timer = null;
    const killer = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({ ...result, stderr });
    };
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    killer.once("error", (error) => finish({ code: null, signal: null, error }));
    killer.once("close", (code, signal) => finish({ code, signal, error: null }));
    timer = setTimeout(() => {
      killer.kill();
      finish({ code: null, signal: null, error: new Error("Process-tree terminator timed out.") });
    }, 10_000);
  });
}

export async function terminateProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return {
      attempted: false,
      strategy: "none",
      commandExitCode: null,
      commandError: "invalid pid",
      rootAlive: false,
      detachedDescendantsCovered: false,
    };
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const command = await runTreeKillCommand(
      path.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
    );
    await waitForProcessExit(pid);
    return {
      attempted: true,
      strategy: "windows-taskkill-tree",
      commandExitCode: command.code,
      commandError: command.error?.message ?? (command.code === 0 ? null : command.stderr.trim() || "taskkill failed"),
      rootAlive: isProcessAlive(pid),
      detachedDescendantsCovered: false,
    };
  }
  let commandError = null;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") commandError = error.message;
  }
  await wait(500);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH" && commandError === null) commandError = error.message;
  }
  await waitForProcessExit(pid);
  return {
    attempted: true,
    strategy: "posix-process-group",
    commandExitCode: null,
    commandError,
    rootAlive: isProcessAlive(pid),
    detachedDescendantsCovered: false,
  };
}

export async function runMeasuredProcess(command, args, options = {}) {
  const started = process.hrtime.bigint();
  let firstStdoutNs = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError = null;
  let terminationPromise = null;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => {
    timedOut = true;
    terminationPromise ??= terminateProcessTree(child.pid);
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (firstStdoutNs === null) firstStdoutNs = process.hrtime.bigint();
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const closed = await new Promise((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timer);
  const termination = terminationPromise ? await terminationPromise : null;
  const ended = process.hrtime.bigint();
  let resourceUsage = null;
  if (options.metricsPath) {
    try {
      resourceUsage = JSON.parse(await fs.readFile(options.metricsPath, "utf8"));
    } catch {
      resourceUsage = null;
    }
  }
  return {
    command: path.basename(command),
    status: closed.status,
    signal: closed.signal,
    timedOut,
    spawnError: spawnError?.message ?? null,
    spawnToFirstStdoutMs: firstStdoutNs === null ? null : Number(firstStdoutNs - started) / 1e6,
    spawnToCloseMs: Number(ended - started) / 1e6,
    stdout,
    stderr,
    resourceUsage,
    termination,
  };
}
