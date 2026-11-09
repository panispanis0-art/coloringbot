import { useEffect, useState } from "react";
import { base64ToBytes, errorMessage, listFormFields, needsSource, runJob, type Template } from "@shared";
import { pdfjs, pdfjsOptions } from "@/lib/pdfjs";
import { readFile } from "@/lib/files";
import { getFont, loadSettings } from "@/lib/store";
import { FilePicker } from "@/components/FilePicker";
import { ResultView } from "@/components/ResultView";

interface Props {
  templates: Template[];
  activeId?: string | undefined;
  onActive: (id: string) => void;
  goSetup: () => void;
}

export function RunPage({ templates, activeId, onActive, goSetup }: Props) {
  const template = templates.find((t) => t.id === activeId) ?? templates[0];
  const [source, setSource] = useState<{ name: string; bytes: Uint8Array }>();
  const [jobName, setJobName] = useState("");
  const [flatten, setFlatten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [values, setValues] = useState<Record<string, string>>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{
    bytes: Uint8Array;
    fileName: string;
    warnings: string[];
  }>();

  useEffect(() => setFlatten(template?.options.flatten ?? false), [template?.id, template?.options.flatten]);

  // fields typed in for each job, pre-filled with what the form says now
  const askFields = template?.mappings.filter((m) => m.rule.type === "ask").map((m) => m.fieldName) ?? [];
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  useEffect(() => {
    setOriginal({});
    setTyped({});
    if (!template?.targetFormBase64 || !template.mappings.some((m) => m.rule.type === "ask")) return;
    listFormFields(base64ToBytes(template.targetFormBase64))
      .then((fields) => {
        const now = Object.fromEntries(fields.map((f) => [f.name, f.currentValue ?? ""]));
        setOriginal(now);
        setTyped(now);
      })
      .catch(() => {});
  }, [template?.id, template?.updatedAt]);

  if (!templates.length || !template) {
    return (
      <div className="page">
        <section className="card center">
          <h2>No template yet</h2>
          <p className="muted">
            Create one in Setup (one time), or import a template JSON in Templates.
          </p>
          <button className="btn primary" onClick={goSetup}>
            Go to Setup
          </button>
        </section>
      </div>
    );
  }

  const needs = template ? needsSource(template.mappings) : true;

  async function run(overrides = edits) {
    if (!template || (needs && !source)) return;
    // only what was actually changed: untouched boxes keep the PDF's own text
    const changed = Object.fromEntries(askFields.filter((f) => typed[f] !== original[f]).map((f) => [f, typed[f] ?? ""]));
    setBusy(true);
    setError(undefined);
    try {
      const s = loadSettings();
      const font = await getFont();
      const res = await runJob({
        pdfjs,
        pdfjsOptions,
        template,
        sourceBytes: source?.bytes,
        jobName,
        overrides: { ...changed, ...overrides },
        fill: {
          flatten,
          stripXmp: s.stripXmp,
          updateDates: s.updateDates,
          fontBytes: font?.bytes,
          metadata: {
            author: s.author,
            creator: s.creator,
            producer: s.producer,
            ...(s.titleFromJobName ? { title: jobName.trim() } : {}),
          },
        },
      });
      setValues(res.values);
      setResult({ bytes: res.bytes, fileName: res.fileName, warnings: res.warnings });
    } catch (e) {
      setError(errorMessage(e));
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }

  const ready = (!needs || !!source) && !!jobName.trim();
  const mapped = template.mappings.filter((m) => m.rule.type !== "skip" && m.rule.type !== "ask");

  return (
    <div className="page run">
      <section className="card">
        <h2>Run: fill a job</h2>
        <label className="row">
          <span>Template</span>
          <select value={template.id} onChange={(e) => onActive(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {needs && (
          <FilePicker
            label="Source PDF"
            fileName={source?.name}
            onFile={async (f) => {
              setSource({ name: f.name, bytes: await readFile(f) });
              setResult(undefined);
              setValues(undefined);
              setEdits({});
            }}
          />
        )}
        <label className="row">
          <span>Job Name</span>
          <input
            value={jobName}
            placeholder="e.g. Smith Kitchen 2026-11"
            onChange={(e) => setJobName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ready && run()}
          />
        </label>
        {askFields.length > 0 && (
          <div className="values-ask">
            <h3>What changes this time</h3>
            <p className="muted small">Change only what is different; the rest stays as it is in the PDF.</p>
            {askFields.map((f) => (
              <label className="row" key={f}>
                <span>
                  {f}
                  {typed[f] !== original[f] && <span className="tag green"> changed</span>}
                </span>
                <input value={typed[f] ?? ""} onChange={(e) => setTyped({ ...typed, [f]: e.target.value })} />
              </label>
            ))}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
          Flatten (fields become plain text, not editable)
        </label>
        <div className="btn-row">
          <button className="btn primary big" disabled={!ready || busy} onClick={() => run({})}>
            {busy ? "Filling…" : "Fill form"}
          </button>
        </div>
        {!template.targetFormBase64 && (
          <div className="error">
            This template has no target form inside. Edit it in Setup and load the form.
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </section>

      {values && (
        <section className="card">
          <details open={!result || Object.keys(edits).length > 0}>
            <summary>
              <strong>Values</strong>{" "}
              <span className="muted small">— correct anything and press “Apply”</span>
            </summary>
            <table className="values">
              <tbody>
                {mapped.map((m) => (
                  <tr key={m.fieldName}>
                    <th>{m.fieldName}</th>
                    <td>
                      <input
                        value={edits[m.fieldName] ?? values[m.fieldName] ?? ""}
                        className={
                          values[m.fieldName] === undefined && edits[m.fieldName] === undefined
                            ? "missing"
                            : ""
                        }
                        placeholder="not found"
                        onChange={(e) => setEdits({ ...edits, [m.fieldName]: e.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="btn-row">
              <button className="btn" disabled={busy} onClick={() => run(edits)}>
                Apply
              </button>
            </div>
          </details>
        </section>
      )}

      {result && (
        <section className="card">
          <ResultView {...result} />
        </section>
      )}
    </div>
  );
}
