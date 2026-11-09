import { pdfjs, nodePdfjsOptions } from '../../shared/src/node.ts';

/** Target width of the preview picture in pixels (sharp on phones, small enough to send fast). */
const WIDTH = 1240;

/**
 * Render page 1 of a PDF to a PNG, form field contents included.
 * Returns undefined when rendering is not possible (e.g. no canvas binary for this platform).
 */
export async function renderPreview(pdfBytes: Uint8Array, pageNumber = 1): Promise<Buffer | undefined> {
  let canvasMod: typeof import('@napi-rs/canvas');
  try {
    canvasMod = await import('@napi-rs/canvas');
  } catch {
    return undefined;
  }
  const doc = await pdfjs.getDocument({ ...nodePdfjsOptions, data: pdfBytes.slice() }).promise;
  try {
    const page = await doc.getPage(Math.min(pageNumber, doc.numPages));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / base.width });
    const canvas = canvasMod.createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    }).promise;
    // trim empty space at the bottom so the filled part fills the phone screen
    const bottom = lastInkRow(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const height = Math.min(canvas.height, Math.max(Math.round(canvas.width * 0.6), bottom + 60));
    if (height < canvas.height) {
      const cropped = canvasMod.createCanvas(canvas.width, height);
      cropped.getContext('2d').drawImage(canvas, 0, 0);
      return await cropped.encode('png');
    }
    return await canvas.encode('png');
  } finally {
    await doc.destroy();
  }
}

/** Index of the lowest pixel row that is not (almost) white. */
function lastInkRow(img: { data: Uint8ClampedArray; width: number; height: number }): number {
  const { data, width, height } = img;
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 2) {
      const i = row + x * 4;
      if (data[i]! < 235 || data[i + 1]! < 235 || data[i + 2]! < 235) return y;
    }
  }
  return 0;
}
