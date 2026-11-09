import { useRef, useState } from "react";
import { errorMessage, describeRule, safeFileName, type Template } from "@shared";
import { deleteTemplate, importTemplateJson, loadSettings } from "@/lib/store";
import { downloadBytes } from "@/lib/files";

interface Props {
  templates: Template[];
  activeId?: string | undefined;
  onActive: (id: string) => void;
  onEdit: (t: Template) => void;
  onChanged: () => void;
}

export function TemplatesPage({ templates, activeId, onActive, onEdit, onChanged }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();

  function exportTemplate(t: Template) {
    const withForm = loadSettings().exportWithForm;
    const out = withForm ? t : { ...t, targetFormBase64: undefined };
    const json = JSON.stringify(out, null, 2);
    downloadBytes(
      new TextEncoder().encode(json),
      safeFileName(t.name, ".template.json"),
      "application/json",
    );
  }

  return (
    <div className="page">
      <section className="card">
        <div className="result-head">
          <h2>Templates</h2>
          <div className="btn-row">
            <button className="btn" onClick={() => fileInput.current?.click()}>
              Import JSON
            </button>
          </div>
        </div>
        <p className="muted small">
          Templates are stored on this device (browser storage). Export one to back it up, move it
          to another device, or give it to the Telegram bot (send the .json to the bot with the
          caption /template).
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const t = await importTemplateJson(await f.text());
              setMsg(`Imported "${t.name}".`);
              setError(undefined);
              onChanged();
            } catch (err) {
              setError(`Import failed: ${errorMessage(err)}`);
            }
          }}
        />
        {msg && <div className="notice">{msg}</div>}
        {error && <div className="error">{error}</div>}
        {!templates.length && <p className="muted">No templates yet.</p>}
        <ul className="template-list">
          {templates.map((t) => {
            const used = t.mappings.filter((m) => m.rule.type !== "skip");
            return (
              <li key={t.id} className={t.id === activeId ? "active" : ""}>
                <div className="tpl-head">
                  <div>
                    <strong>{t.name}</strong>{" "}
                    {t.id === activeId && <span className="tag green">active</span>}
                    <div className="muted small">
                      {t.targetFormName ?? "no form"} · {used.length}/{t.mappings.length} fields
                      mapped · flatten {t.options.flatten ? "on" : "off"} · updated{" "}
                      {new Date(t.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="btn-row">
                    {t.id !== activeId && (
                      <button className="btn small" onClick={() => onActive(t.id)}>
                        Make active
                      </button>
                    )}
                    <button
                      className="btn small"
                      onClick={() => setOpen(open === t.id ? undefined : t.id)}
                    >
                      {open === t.id ? "Hide" : "Show"}
                    </button>
                    <button className="btn small" onClick={() => onEdit(t)}>
                      Edit
                    </button>
                    <button className="btn small" onClick={() => exportTemplate(t)}>
                      Export
                    </button>
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        if (!confirm(`Delete template "${t.name}"?`)) return;
                        await deleteTemplate(t.id);
                        onChanged();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {open === t.id && (
                  <ul className="rules small">
                    {used.map((m) => (
                      <li key={m.fieldName}>
                        <strong>{m.fieldName}</strong> ← {describeRule(m)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
