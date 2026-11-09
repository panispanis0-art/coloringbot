import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = import.meta.env.BASE_URL;

/** Where pdf.js finds the files copied to public/pdfjs by vite.config.ts */
export const pdfjsOptions = {
  standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  cMapUrl: `${base}pdfjs/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${base}pdfjs/wasm/`,
};

export { pdfjs };
