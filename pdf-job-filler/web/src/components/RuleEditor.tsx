import type { FormFieldInfo, MappingRule } from '@shared';

const TYPES: { value: MappingRule['type']; label: string }[] = [
  { value: 'skip', label: 'Leave empty (skip)' },
  { value: 'label', label: 'Text next to a label' },
  { value: 'regex', label: 'Regular expression' },
  { value: 'position', label: 'Area on the page' },
  { value: 'jobName', label: 'Job Name' },
  { value: 'static', label: 'Fixed value' },
  { value: 'date', label: "Today's date" },
];

export function defaultRule(type: MappingRule['type'], prev?: MappingRule): MappingRule {
  const common =
    prev && prev.type !== 'skip'
      ? { transform: prev.transform, defaultValue: prev.defaultValue, prefix: prev.prefix, suffix: prev.suffix }
      : {};
  switch (type) {
    case 'skip':
      return { type: 'skip' };
    case 'label':
      return { ...common, type: 'label', label: '', valueOn: 'auto' };
    case 'regex':
      return { ...common, type: 'regex', pattern: '', flags: 'i' };
    case 'position':
      return { ...common, type: 'position', page: 1, x: 0, y: 0, w: 0, h: 0 };
    case 'jobName':
      return { ...common, type: 'jobName' };
    case 'static':
      return { ...common, type: 'static', value: '' };
    case 'date':
      return { ...common, type: 'date', format: 'DD.MM.YYYY' };
  }
}

interface Props {
  field: FormFieldInfo | { name: string; type: string; options?: string[] };
  rule: MappingRule;
  onChange: (r: MappingRule) => void;
}

export function RuleEditor({ field, rule, onChange }: Props) {
  const set = (patch: Partial<MappingRule>) => onChange({ ...rule, ...patch } as MappingRule);
  const num = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <div className="rule-editor">
      <label className="row">
        <span>Source</span>
        <select value={rule.type} onChange={(e) => onChange(defaultRule(e.target.value as MappingRule['type'], rule))}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {rule.type === 'label' && (
        <>
          <label className="row">
            <span>Label text</span>
            <input value={rule.label} placeholder="e.g. Invoice No" onChange={(e) => set({ label: e.target.value })} />
          </label>
          <label className="row">
            <span>Value is</span>
            <select value={rule.valueOn ?? 'auto'} onChange={(e) => set({ valueOn: e.target.value as any })}>
              <option value="auto">Auto (right of label, else below)</option>
              <option value="sameLine">Rest of the same line</option>
              <option value="nextLine">Next line</option>
              <option value="below">Directly below the label</option>
            </select>
          </label>
          <div className="grid2">
            <label className="row">
              <span>Occurrence</span>
              <input type="number" min={1} value={rule.occurrence ?? 1} onChange={(e) => set({ occurrence: num(e.target.value) || 1 })} />
            </label>
            <label className="row">
              <span>Lines</span>
              <input type="number" min={1} value={rule.lines ?? 1} onChange={(e) => set({ lines: num(e.target.value) || 1 })} />
            </label>
          </div>
          <label className="row">
            <span>Stop at (regex)</span>
            <input value={rule.stopAt ?? ''} placeholder="optional, e.g. \s{2,}|Date" onChange={(e) => set({ stopAt: e.target.value || undefined })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rule.caseSensitive} onChange={(e) => set({ caseSensitive: e.target.checked })} />
            Case sensitive
          </label>
        </>
      )}

      {rule.type === 'regex' && (
        <>
          <label className="row">
            <span>Pattern</span>
            <input
              className="mono"
              value={rule.pattern}
              placeholder="e.g. Order\s*#?\s*(\d+)"
              onChange={(e) => set({ pattern: e.target.value })}
            />
          </label>
          <div className="grid3">
            <label className="row">
              <span>Flags</span>
              <input value={rule.flags ?? 'i'} onChange={(e) => set({ flags: e.target.value })} />
            </label>
            <label className="row">
              <span>Group</span>
              <input
                type="number"
                min={0}
                value={rule.group ?? ''}
                placeholder="auto"
                onChange={(e) => set({ group: e.target.value === '' ? undefined : num(e.target.value) })}
              />
            </label>
            <label className="row">
              <span>Match #</span>
              <input type="number" min={1} value={rule.occurrence ?? 1} onChange={(e) => set({ occurrence: num(e.target.value) || 1 })} />
            </label>
          </div>
          <RegexHelp pattern={rule.pattern} />
        </>
      )}

      {rule.type === 'position' && (
        <>
          <p className="muted small">Drag a box on the source page (Page view) to set the area. Values are PDF points.</p>
          <div className="grid5">
            {(['page', 'x', 'y', 'w', 'h'] as const).map((k) => (
              <label className="row" key={k}>
                <span>{k}</span>
                <input type="number" value={Math.round((rule as any)[k] * 10) / 10} onChange={(e) => set({ [k]: num(e.target.value) } as any)} />
              </label>
            ))}
          </div>
        </>
      )}

      {rule.type === 'static' && (
        <label className="row">
          <span>Value</span>
          {field.options?.length ? (
            <select value={rule.value} onChange={(e) => set({ value: e.target.value })}>
              <option value="">(none)</option>
              {field.options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          ) : field.type === 'checkbox' ? (
            <select value={rule.value} onChange={(e) => set({ value: e.target.value })}>
              <option value="true">Checked</option>
              <option value="false">Unchecked</option>
            </select>
          ) : (
            <input value={rule.value} onChange={(e) => set({ value: e.target.value })} />
          )}
        </label>
      )}

      {rule.type === 'date' && (
        <label className="row">
          <span>Format</span>
          <input value={rule.format ?? 'DD.MM.YYYY'} onChange={(e) => set({ format: e.target.value })} />
        </label>
      )}

      {rule.type !== 'skip' && (
        <details className="more">
          <summary>More: case, default, prefix/suffix</summary>
          <label className="row">
            <span>Change case</span>
            <select value={rule.transform ?? 'none'} onChange={(e) => set({ transform: e.target.value as any })}>
              <option value="none">Keep</option>
              <option value="upper">UPPERCASE</option>
              <option value="lower">lowercase</option>
              <option value="title">Title Case</option>
            </select>
          </label>
          <label className="row">
            <span>If not found</span>
            <input value={rule.defaultValue ?? ''} placeholder="leave empty" onChange={(e) => set({ defaultValue: e.target.value || undefined })} />
          </label>
          <div className="grid2">
            <label className="row">
              <span>Prefix</span>
              <input value={rule.prefix ?? ''} onChange={(e) => set({ prefix: e.target.value || undefined })} />
            </label>
            <label className="row">
              <span>Suffix</span>
              <input value={rule.suffix ?? ''} onChange={(e) => set({ suffix: e.target.value || undefined })} />
            </label>
          </div>
        </details>
      )}
    </div>
  );
}

function RegexHelp({ pattern }: { pattern: string }) {
  if (!pattern) return <p className="muted small">Use ( ) around the part you want. Example: Total:\s*([\d.,]+)</p>;
  try {
    new RegExp(pattern);
    return null;
  } catch (e: any) {
    return <p className="error small">{e.message}</p>;
  }
}
