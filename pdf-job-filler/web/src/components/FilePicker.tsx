import { useRef, useState } from 'react';

interface Props {
  label: string;
  accept?: string;
  fileName?: string;
  hint?: string;
  onFile: (file: File) => void;
}

/** Big tap target + drag & drop. */
export function FilePicker({ label, accept = 'application/pdf,.pdf', fileName, hint, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`filepicker ${over ? 'over' : ''} ${fileName ? 'has-file' : ''}`}
      onClick={() => input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
    >
      <div className="filepicker-label">{label}</div>
      <div className="filepicker-name">{fileName ?? 'Tap to choose or drop a file'}</div>
      {hint && <div className="muted small">{hint}</div>}
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
