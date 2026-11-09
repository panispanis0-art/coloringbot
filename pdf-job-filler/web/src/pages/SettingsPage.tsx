import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, getFont, loadSettings, saveSettings, setFont, type Settings } from '@/lib/store';
import { readFile } from '@/lib/files';
import { FilePicker } from '@/components/FilePicker';

export function SettingsPage() {
  const [s, setS] = useState<Settings>(loadSettings);
  const [font, setFontState] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getFont().then((f) => setFontState(f?.name));
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="page">
      <section className="card">
        <h2>Settings {saved && <span className="tag green">saved</span>}</h2>

        <h3>PDF metadata</h3>
        <p className="muted small">
          Written into every filled PDF (File → Properties). Leave a box empty to remove that entry. Nothing else is
          added: no watermark, no “pdf-lib” producer stamp.
        </p>
        <label className="row">
          <span>Author</span>
          <input value={s.author} onChange={(e) => update({ author: e.target.value })} />
        </label>
        <label className="row">
          <span>Creator (application)</span>
          <input value={s.creator} placeholder="empty = remove" onChange={(e) => update({ creator: e.target.value })} />
        </label>
        <label className="row">
          <span>Producer</span>
          <input value={s.producer} placeholder="empty = remove" onChange={(e) => update({ producer: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.titleFromJobName} onChange={(e) => update({ titleFromJobName: e.target.checked })} />
          Set the document Title to the Job Name
        </label>
        <label className="check">
          <input type="checkbox" checked={s.updateDates} onChange={(e) => update({ updateDates: e.target.checked })} />
          Set “Modified” date to now
        </label>
        <label className="check">
          <input type="checkbox" checked={s.stripXmp} onChange={(e) => update({ stripXmp: e.target.checked })} />
          Remove the form's old XMP metadata (so viewers show the values above, not the original form's)
        </label>

        <h3>Templates</h3>
        <label className="check">
          <input type="checkbox" checked={s.exportWithForm} onChange={(e) => update({ exportWithForm: e.target.checked })} />
          Export templates with the target form inside (needed by the Telegram bot)
        </label>

        <h3>Font for special characters</h3>
        <p className="muted small">
          The standard PDF font has no ă, ș, ț, Cyrillic, Greek… Without a font those letters become their plain
          version (ș → s). Load a .ttf/.otf (e.g. C:\Windows\Fonts\arial.ttf) to keep them.
        </p>
        <FilePicker
          label="Unicode font (.ttf / .otf)"
          accept=".ttf,.otf,font/ttf,font/otf"
          fileName={font}
          onFile={async (f) => {
            await setFont({ name: f.name, bytes: await readFile(f) });
            setFontState(f.name);
          }}
        />
        {font && (
          <button
            className="btn small"
            onClick={async () => {
              await setFont(undefined);
              setFontState(undefined);
            }}
          >
            Remove font
          </button>
        )}

        <div className="btn-row">
          <button
            className="btn ghost"
            onClick={() => {
              if (confirm('Reset settings to defaults?')) update({ ...DEFAULT_SETTINGS });
            }}
          >
            Reset to defaults
          </button>
        </div>
      </section>
    </div>
  );
}
