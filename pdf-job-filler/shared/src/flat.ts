// Turn a "flat" PDF (no form fields) into a fillable one: every spot the user picked becomes a
// text field that covers the old value with the page's background colour and shows the old value
// by default. Filling, flattening, templates and the bot then work exactly like with real forms.
import {
  PDFDocument,
  StandardFonts,
  TextAlignment,
  rgb,
  type PDFFont,
} from "pdf-lib";

export interface Spot {
  /** field name, e.g. "Site" */
  name: string;
  /** 1-based page */
  page: number;
  /** box in PDF points (origin bottom-left) */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  /** background colour 0..1, default white */
  background?: [number, number, number] | undefined;
  /** text shown until a new value is given (normally the old value) */
  text?: string | undefined;
  multiline?: boolean | undefined;
}

/** Characters the standard font cannot draw are dropped from the default text (▼, ▲…). */
function drawable(font: PDFFont, s: string): string {
  return [...s]
    .filter((ch) => {
      try {
        font.encodeText(ch);
        return true;
      } catch {
        return false;
      }
    })
    .join("");
}

export async function addFieldsToPdf(
  bytes: Uint8Array,
  spots: Spot[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const used = new Set(form.getFields().map((f) => f.getName()));
  for (const s of spots) {
    const page = pages[s.page - 1];
    if (!page) continue;
    let name = s.name.trim().replace(/\./g, " ") || "Field";
    for (let n = 2; used.has(name); n++)
      name = `${s.name.trim().replace(/\./g, " ") || "Field"} ${n}`;
    used.add(name);
    const field = form.createTextField(name);
    if (s.multiline) field.enableMultiline();
    field.setAlignment(TextAlignment.Left);
    const [r, g, b] = s.background ?? [1, 1, 1];
    field.addToPage(page, {
      x: s.x,
      y: s.y,
      width: s.w,
      height: s.h,
      font,
      textColor: rgb(0, 0, 0),
      backgroundColor: rgb(r, g, b),
      borderWidth: 0,
    });
    field.setFontSize(s.fontSize);
    if (s.text) field.setText(drawable(font, s.text));
  }
  form.updateFieldAppearances(font);
  return doc.save({ updateFieldAppearances: false });
}

/** Width of text in the standard font (for splitting "Label:value" pieces). */
export async function textWidth(text: string, size: number): Promise<number> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return font.widthOfTextAtSize(drawable(font, text), size);
}
