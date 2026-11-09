import { useEffect, useMemo, useState } from "react";
import { addFieldsToPdf, errorMessage, extractSource, type SourceDoc, type Spot } from "@shared";
import { pdfjs, pdfjsOptions } from "@/lib/pdfjs";
import { rasterize, spotFromArea, spotFromText, type Raster } from "@/lib/spots";
import { PdfPage, PageNav, type Box } from "./PdfPage";

interface Props {
  bytes: Uint8Array;
  fileName: string;
  onDone: (fillable: Uint8Array, fieldNames: string[]) => void;
  onCancel: () => void;
}

/** For PDFs without fill-in boxes: tap the text to change (or drag over an empty spot) to make boxes. */
export function SpotPicker({ bytes, fileName, onDone, onCancel }: Props) {
  const [doc, setDoc] = useState<SourceDoc>();
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(1);
  const [raster, setRaster] = useState<Raster>();
  const [spots, setSpots] = useState<(Spot & { key: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    extractSource(pdfjs, bytes, pdfjsOptions)
      .then(setDoc)
      .catch((e) => setError(errorMessage(e)));
  }, [bytes]);

  useEffect(() => {
    setRaster(undefined);
    rasterize(bytes, page)
      .then(setRaster)
      .catch((e) => setError(errorMessage(e)));
  }, [bytes, page]);

  const toggleText = async (key: string, lineIndex: number, segIndex: number) => {
    if (spots.some((s) => s.key === key)) return setSpots(spots.filter((s) => s.key !== key));
    const line = doc?.lines.find((l) => l.index === lineIndex);
    const seg = line?.segments[segIndex];
    if (!line || !seg || !raster) return;
    const spot = await spotFromText(raster, line, seg, segIndex, spots.length + 1);
    setSpots((prev) => [...prev, { ...spot, key }]);
  };

  const boxes: Box[] = useMemo(() => {
    const out: Box[] = [];
    for (const line of doc?.pages.find((p) => p.page === page)?.lines ?? []) {
      line.segments.forEach((seg, i) => {
        const key = `t${line.index}-${i}`;
        const on = spots.some((s) => s.key === key);
        out.push({
          key,
          x: seg.x,
          y: line.y - line.h * 0.25,
          w: seg.w,
          h: line.h * 1.2,
          className: on ? "picked" : "seg",
          title: seg.text,
          onClick: () => void toggleText(key, line.index, i),
        });
      });
    }
    for (const s of spots.filter((s) => s.page === page)) {
      out.push({ key: `s-${s.key}`, x: s.x, y: s.y, w: s.w, h: s.h, className: "area", label: <span className="spot-name">{s.name}</span> });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, spots, raster]);

  async function done() {
    setBusy(true);
    setError(undefined);
    try {
      const fillable = await addFieldsToPdf(bytes, spots);
      onDone(fillable, spots.map((s) => s.name));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>Choose what changes in “{fileName}”</h3>
      <p className="muted">
        This PDF has no fill-in boxes, so let's make them. <b>Tap each piece of text you want to change</b> (tap again to undo). For an empty spot, tap <b>✏️ Draw a box</b> and drag. On a phone, use <b>Zoom</b>. Everything else stays exactly as it is.
      </p>
      <div className="picker-tools">
        <span className="muted small">Zoom</span>
        {[1, 2, 3].map((z) => (
          <button key={z} className={`btn small ${zoom === z ? "primary" : ""}`} onClick={() => setZoom(z)}>
            {z}×
          </button>
        ))}
        <button className={`btn small ${drawing ? "primary" : ""}`} onClick={() => setDrawing(!drawing)}>
          {drawing ? "✏️ Drawing: drag on the page" : "✏️ Draw a box"}
        </button>
      </div>
      <PageNav page={page} count={count} onChange={setPage} />
      <PdfPage
        bytes={bytes}
        page={page}
        boxes={boxes}
        zoom={zoom}
        onPageCount={setCount}
        {...(drawing
          ? {
              onSelectRect: (r: { x: number; y: number; w: number; h: number }) => {
                if (!raster) return;
                const spot = spotFromArea(raster, page, r, spots.length + 1);
                setSpots((prev) => [...prev, { ...spot, key: `a${Date.now()}` }]);
                setDrawing(false);
              },
            }
          : {})}
      />
      {spots.length > 0 && (
        <>
          <h3>Boxes ({spots.length}) — give each a clear name</h3>
          <ul className="spot-list">
            {spots.map((s) => (
              <li key={s.key}>
                <input
                  value={s.name}
                  onChange={(e) => setSpots(spots.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)))}
                />
                <span className="muted small">{s.text ? `now: ${s.text}` : "empty area"}</span>
                <button className="btn small ghost" onClick={() => setSpots(spots.filter((x) => x.key !== s.key))}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="error">{error}</div>}
      <div className="btn-row">
        <button className="btn primary" disabled={!spots.length || busy} onClick={done}>
          {busy ? "Making boxes…" : `Use these ${spots.length || ""} boxes`}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
