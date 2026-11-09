// Node.js-only helper (bot, tests, scripts). Not exported from index.ts so the web build never sees it.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));

pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsDir, 'legacy/build/pdf.worker.mjs')).href;

/** getDocument options so pdf.js finds its font metrics and CMaps on disk. */
export const nodePdfjsOptions = {
  standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
  cMapUrl: path.join(pdfjsDir, 'cmaps') + path.sep,
  cMapPacked: true,
  verbosity: 0,
};

export { pdfjs };
