import { parentPort, workerData } from "node:worker_threads";

import { importBundledDependency } from "./workflow_primitives.mjs";

function positiveLimit(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer.`);
  return value;
}

async function parseCompletePdf() {
  if (!parentPort) throw new Error("PDF validator must run in a worker thread.");
  const bytes = workerData?.bytes;
  if (!(bytes instanceof Uint8Array)) throw new Error("PDF worker bytes must be a Uint8Array.");
  const maxPages = positiveLimit(workerData.maxPages, "maxPages");
  const maxOperatorsPerPage = positiveLimit(workerData.maxOperatorsPerPage, "maxOperatorsPerPage");
  const maxOperatorsTotal = positiveLimit(workerData.maxOperatorsTotal, "maxOperatorsTotal");
  const pdfjs = await importBundledDependency("pdfjs-dist");
  if (typeof pdfjs.getDocument !== "function" || !pdfjs.VerbosityLevel) {
    throw new Error("bundled pdfjs-dist does not expose the required parser API");
  }

  let loadingTask;
  let document;
  let primaryError;
  let result;
  try {
    loadingTask = pdfjs.getDocument({
      data: Uint8Array.from(bytes),
      stopAtErrors: true,
      verbosity: pdfjs.VerbosityLevel.WARNINGS,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      maxImageSize: 100_000_000,
    });
    document = await loadingTask.promise;
    const [metadata, permissions] = await Promise.all([
      document.getMetadata(),
      document.getPermissions(),
    ]);
    const encryptFilterName = metadata?.info?.EncryptFilterName;
    if (encryptFilterName !== null && encryptFilterName !== undefined) {
      throw new Error("encrypted PDFs are not allowed, even when an empty user password opens the document");
    }
    if (permissions !== null && permissions !== undefined) {
      throw new Error("PDF permission dictionaries are not allowed");
    }
    const pageCount = document.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > maxPages) {
      throw new Error(`page tree contains ${pageCount} pages; the allowed range is 1-${maxPages}`);
    }
    let totalOperators = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const operatorList = await page.getOperatorList({ intent: "display" });
        if (
          !Array.isArray(operatorList?.fnArray)
          || !Array.isArray(operatorList?.argsArray)
          || operatorList.fnArray.length !== operatorList.argsArray.length
        ) throw new Error(`page ${pageNumber} returned an invalid operator list`);
        const pageOperators = operatorList.fnArray.length;
        if (pageOperators > maxOperatorsPerPage) {
          throw new Error(`page ${pageNumber} exceeds the ${maxOperatorsPerPage} operator limit`);
        }
        totalOperators += pageOperators;
        if (totalOperators > maxOperatorsTotal) {
          throw new Error(`document exceeds the ${maxOperatorsTotal} total operator limit`);
        }
      } finally {
        page.cleanup();
      }
    }
    result = { ok: true, pageCount, totalOperators };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (document) await document.destroy();
      else if (loadingTask) await loadingTask.destroy();
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

parseCompletePdf().then(
  (result) => parentPort.postMessage(result),
  (error) => parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }),
);
