import { useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  applyRule,
  base64ToBytes,
  bytesToBase64,
  describeRule,
  emptyTemplate,
  extractSource,
  fillForm,
  listFormFields,
  safeFileName,
  applyMappings,
  type FieldMapping,
  type FormFieldInfo,
  type MappingRule,
  type SourceDoc,
  type Template,
  type TextLine,
  type LineSegment,
} from "@shared";
import { pdfjs, pdfjsOptions } from "@/lib/pdfjs";
import { readFile } from "@/lib/files";
import { getFont, loadSettings, saveTemplate } from "@/lib/store";
import { FilePicker } from "@/components/FilePicker";
import { PdfPage, PageNav, type Box } from "@/components/PdfPage";
import { RuleEditor } from "@/components/RuleEditor";
import { ResultView } from "@/components/ResultView";

interface Props {
  editing?: Template | undefined;
  onSaved: (t: Template) => void;
}

type View = "text" | "page" | "form";

const EXAMPLE_JOB = "Example Job";

export function SetupPage({ editing, onSaved }: Props) {
  const [template, setTemplate] = useState<Template>();
  const [fields, setFields] = useState<FormFieldInfo[]>([]);
  const [formBytes, setFormBytes] = useState<Uint8Array>();
  const [formName, setFormName] = useState<string>();
  const [sourceBytes, setSourceBytes] = useState<Uint8Array>();
  const [sourceName, setSourceName] = useState<string>();
  const [source, setSource] = useState<SourceDoc>();
  const [selected, setSelected] = useState<string>();
  const [picked, setPicked] = useState<{ line: TextLine; seg: LineSegment }>();
  const [view, setView] = useState<View>("text");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [formPage, setFormPage] = useState(1);
  const [formPageCount, setFormPageCount] = useState(1);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [test, setTest] = useState<{ bytes: Uint8Array; fileName: string; warnings: string[] }>();

  // open an existing template for editing
  useEffect(() => {
    if (!editing) return;
    (async () => {
      setError(undefined);
      const t = structuredClone(editing);
      setTemplate(t);
      setFormName(t.targetFormName);
      if (t.targetFormBase64) {
        const bytes = base64ToBytes(t.targetFormBase64);
        setFormBytes(bytes);
        const f = await listFormFields(bytes);
        setFields(f);
        // add fields that are in the form but not yet in the template
        const known = new Set(t.mappings.map((m) => m.fieldName));
        const extra = emptyTemplate("", f).mappings.filter((m) => !known.has(m.fieldName));
        if (extra.length) setTemplate({ ...t, mappings: [...t.mappings, ...extra] });
      }
    })().catch((e) => setError(errorMessage(e)));
  }, [editing]);

  async function onForm(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const bytes = await readFile(file);
      const f = await listFormFields(bytes);
      if (!f.length) throw new Error("This PDF has no fillable form fields (AcroForm).");
      setFormBytes(bytes);
      setFormName(file.name);
      setFields(f);
      setTemplate((prev) => {
        const fresh = emptyTemplate(prev?.name || file.name.replace(/\.pdf$/i, ""), f);
        if (!prev) return fresh;
        // keep rules of fields that still exist
        const old = new Map(prev.mappings.map((m) => [m.fieldName, m]));
        return { ...prev, mappings: fresh.mappings.map((m) => old.get(m.fieldName) ?? m) };
      });
      setSelected(f[0]?.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSource(file: File) {
    setBusy(true);
    setError(undefined);
    try {
      const bytes = await readFile(file);
      const doc = await extractSource(pdfjs, bytes, pdfjsOptions);
      if (!doc.fullText.trim())
        setError("No text found in this PDF. It is probably a scan; only text-based PDFs work.");
      setSourceBytes(bytes);
      setSourceName(file.name);
      setSource(doc);
      setPage(1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldInfo = (name: string) => fields.find((f) => f.name === name);
  const mapping = template?.mappings.find((m) => m.fieldName === selected);

  const values = useMemo(
    () => (template ? applyMappings(source, template.mappings, { jobName: EXAMPLE_JOB }) : {}),
    [template, source],
  );

  function setRule(fieldName: string, rule: MappingRule) {
    setTemplate(
      (t) =>
        t && {
          ...t,
          mappings: t.mappings.map((m) => (m.fieldName === fieldName ? { ...m, rule } : m)),
        },
    );
  }

  function applySegment(kind: "label" | "area" | "fixed") {
    if (!picked || !selected) return;
    const { line, seg } = picked;
    const prev = mapping?.rule;
    const keep =
      prev && prev.type !== "skip"
        ? { transform: prev.transform, defaultValue: prev.defaultValue }
        : {};
    if (kind === "label") {
      const colon = seg.text.search(/[:：]/);
      const label = colon > 0 ? seg.text.slice(0, colon).trim() : seg.text.trim();
      setRule(selected, { ...keep, type: "label", label, valueOn: "auto" });
    } else if (kind === "area") {
      const pad = 2;
      setRule(selected, {
        ...keep,
        type: "position",
        page: line.page,
        x: seg.x - pad,
        y: line.y - line.h * 0.3 - pad,
        w: seg.w + pad * 2,
        h: line.h * 1.3 + pad * 2,
      });
    } else {
      setRule(selected, { ...keep, type: "static", value: seg.text });
    }
    setPicked(undefined);
  }

  function autoMatch() {
    if (!template || !source) return;
    const norm = (s: string) =>
      s
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-.[\]0-9]+/g, " ")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    let n = 0;
    const mappings = template.mappings.map((m): FieldMapping => {
      if (m.rule.type !== "skip" || m.fieldType !== "text") return m;
      const want = norm(m.fieldName);
      if (want.length < 2) return m;
      for (const line of source.lines) {
        for (const seg of line.segments) {
          const colon = seg.text.search(/[:：]/);
          const label = colon > 0 ? seg.text.slice(0, colon) : seg.text;
          if (norm(label) === want) {
            const rule: MappingRule = { type: "label", label: label.trim(), valueOn: "auto" };
            if (applyRule(source, rule)) {
              n++;
              return { ...m, rule };
            }
          }
        }
      }
      return m;
    });
    setTemplate({ ...template, mappings });
    setNotice(
      n
        ? `Auto-matched ${n} field(s) by name. Check them!`
        : "No field names matched labels in the source.",
    );
  }

  async function testFill() {
    if (!template || !formBytes) return;
    setBusy(true);
    setError(undefined);
    try {
      const s = loadSettings();
      const font = await getFont();
      const res = await fillForm(formBytes, values, {
        flatten: template.options.flatten,
        stripXmp: s.stripXmp,
        updateDates: s.updateDates,
        fontBytes: font?.bytes,
        metadata: {
          author: s.author,
          creator: s.creator,
          producer: s.producer,
          ...(s.titleFromJobName ? { title: EXAMPLE_JOB } : {}),
        },
      });
      setTest({ bytes: res.bytes, fileName: safeFileName(EXAMPLE_JOB), warnings: res.warnings });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!template || !formBytes) return;
    if (!template.name.trim()) return setError("Give the template a name.");
    const t: Template = {
      ...template,
      targetFormName: formName,
      targetFormBase64: bytesToBase64(formBytes),
    };
    await saveTemplate(t);
    setTemplate(t);
    setNotice(`Template "${t.name}" saved on this device.`);
    onSaved(t);
  }

  // ---- overlay boxes ----
  const pageBoxes: Box[] = useMemo(() => {
    if (!source) return [];
    const pg = source.pages.find((p) => p.page === page);
    const boxes: Box[] = [];
    for (const line of pg?.lines ?? []) {
      line.segments.forEach((seg, i) =>
        boxes.push({
          key: `${line.index}-${i}`,
          x: seg.x,
          y: line.y - line.h * 0.25,
          w: seg.w,
          h: line.h * 1.15,
          className: picked?.seg === seg ? "picked" : "seg",
          title: seg.text,
          onClick: () => setPicked({ line, seg }),
        }),
      );
    }
    const r = mapping?.rule;
    if (r?.type === "position" && r.page === page && r.w > 0) {
      boxes.push({ key: "area", x: r.x, y: r.y, w: r.w, h: r.h, className: "area" });
    }
    return boxes;
  }, [source, page, picked, mapping]);

  const formBoxes: Box[] = useMemo(
    () =>
      fields
        .filter((f) => f.rect && (f.page ?? 1) === formPage)
        .map((f) => ({
          key: f.name,
          ...f.rect!,
          className:
            f.name === selected ? "field selected" : values[f.name] ? "field filled" : "field",
          title: f.name,
          onClick: () => setSelected(f.name),
        })),
    [fields, formPage, selected, values],
  );

  const shownMappings = (template?.mappings ?? []).filter(
    (m) => !filter || m.fieldName.toLowerCase().includes(filter.toLowerCase()),
  );
  const mappedCount = template?.mappings.filter((m) => m.rule.type !== "skip").length ?? 0;

  return (
    <div className="page setup">
      <section className="card">
        <h2>{editing ? `Edit template: ${editing.name}` : "Setup: create a template"}</h2>
        <p className="muted">
          1. Load the fillable target form. 2. Load an example source PDF. 3. For each form field
          choose where its value comes from. 4. Save.
        </p>
        <div className="grid2">
          <FilePicker label="Target form (fillable PDF)" fileName={formName} onFile={onForm} />
          <FilePicker
            label="Example source PDF (text-based)"
            fileName={sourceName}
            onFile={onSource}
          />
        </div>
        {busy && <div className="notice">Working…</div>}
        {error && <div className="error">{error}</div>}
        {notice && (
          <div className="notice" onClick={() => setNotice(undefined)}>
            {notice}
          </div>
        )}
      </section>

      {template && (
        <div className="setup-grid">
          <section className="card fields">
            <div className="fields-head">
              <h3>
                Form fields{" "}
                <span className="muted small">
                  ({mappedCount}/{template.mappings.length} mapped)
                </span>
              </h3>
              <input
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <ul className="field-list">
              {shownMappings.map((m) => {
                const v = values[m.fieldName];
                return (
                  <li
                    key={m.fieldName}
                    className={`${m.fieldName === selected ? "selected" : ""} ${m.rule.type === "skip" ? "skip" : ""}`}
                    onClick={() => setSelected(m.fieldName)}
                  >
                    <div className="field-name">
                      {m.fieldName} <span className="tag">{m.fieldType}</span>
                    </div>
                    <div className="field-rule small muted">{describeRule(m)}</div>
                    {m.rule.type !== "skip" && (
                      <div className={`field-value small ${v ? "" : "empty"}`}>
                        {v ? v : source ? "not found" : "—"}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="card editor">
            {mapping ? (
              <>
                <h3>
                  {mapping.fieldName} <span className="tag">{mapping.fieldType}</span>
                </h3>
                <RuleEditor
                  field={
                    fieldInfo(mapping.fieldName) ?? {
                      name: mapping.fieldName,
                      type: mapping.fieldType,
                    }
                  }
                  rule={mapping.rule}
                  onChange={(r) => setRule(mapping.fieldName, r)}
                />
                {mapping.rule.type !== "skip" && (
                  <div className="preview-value">
                    <span className="muted small">Value with the example source:</span>
                    <pre>{values[mapping.fieldName] ?? "(nothing found)"}</pre>
                  </div>
                )}
              </>
            ) : (
              <p className="muted">Select a field on the left.</p>
            )}

            <div className="tabs small-tabs">
              {(["text", "page", "form"] as View[]).map((v) => (
                <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
                  {v === "text" ? "Source text" : v === "page" ? "Source page" : "Target form"}
                </button>
              ))}
            </div>

            {picked && (
              <div className="picked-bar">
                <div className="picked-text">“{picked.seg.text}”</div>
                <div className="btn-row">
                  <button
                    className="btn small"
                    disabled={!selected}
                    onClick={() => applySegment("label")}
                  >
                    Use as label
                  </button>
                  <button
                    className="btn small"
                    disabled={!selected}
                    onClick={() => applySegment("area")}
                  >
                    Use this area
                  </button>
                  <button
                    className="btn small"
                    disabled={!selected}
                    onClick={() => applySegment("fixed")}
                  >
                    Fixed value
                  </button>
                  <button className="btn small ghost" onClick={() => setPicked(undefined)}>
                    ✕
                  </button>
                </div>
              </div>
            )}

            {view === "text" &&
              (source ? (
                <div className="source-text">
                  {source.lines.map((line) => (
                    <div key={line.index} className="src-line">
                      <span className="ln">{line.page}</span>
                      {line.segments.map((seg, i) => (
                        <span
                          key={i}
                          className={`src-seg ${picked?.seg === seg ? "picked" : ""}`}
                          onClick={() => setPicked({ line, seg })}
                        >
                          {seg.text}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  Load an example source PDF to see its text. Tap a piece of text to use it.
                </p>
              ))}

            {view === "page" &&
              (source && sourceBytes ? (
                <>
                  <p className="muted small">
                    Tap a text box to pick it, or drag a rectangle to use that area for the selected
                    field.
                  </p>
                  <PageNav page={page} count={pageCount} onChange={setPage} />
                  <PdfPage
                    bytes={sourceBytes}
                    page={page}
                    boxes={pageBoxes}
                    onPageCount={setPageCount}
                    onSelectRect={(r) => {
                      if (!selected) return;
                      setRule(selected, { type: "position", page, ...r });
                    }}
                  />
                </>
              ) : (
                <p className="muted">Load an example source PDF first.</p>
              ))}

            {view === "form" &&
              (formBytes ? (
                <>
                  <p className="muted small">
                    Tap a field on the form to select it. Green = has a value.
                  </p>
                  <PageNav page={formPage} count={formPageCount} onChange={setFormPage} />
                  <PdfPage
                    bytes={formBytes}
                    page={formPage}
                    boxes={formBoxes}
                    onPageCount={setFormPageCount}
                  />
                </>
              ) : (
                <p className="muted">Load the target form first.</p>
              ))}
          </section>
        </div>
      )}

      {template && (
        <section className="card save-bar">
          <label className="row grow">
            <span>Template name</span>
            <input
              value={template.name}
              onChange={(e) => setTemplate({ ...template, name: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={template.options.flatten}
              onChange={(e) =>
                setTemplate({
                  ...template,
                  options: { ...template.options, flatten: e.target.checked },
                })
              }
            />
            Flatten by default
          </label>
          <div className="btn-row">
            <button className="btn" onClick={autoMatch} disabled={!source}>
              Auto-match by name
            </button>
            <button className="btn" onClick={testFill} disabled={!formBytes || busy}>
              Test fill
            </button>
            <button className="btn primary" onClick={save} disabled={!formBytes}>
              Save template
            </button>
          </div>
        </section>
      )}

      {test && (
        <section className="card">
          <div className="result-head">
            <h3>Test result</h3>
            <button className="btn small ghost" onClick={() => setTest(undefined)}>
              Close
            </button>
          </div>
          <ResultView {...test} />
        </section>
      )}
    </div>
  );
}
