import { useState } from 'react';
import { PdfPage, PageNav } from './PdfPage';
import { downloadBytes, shareBytes, canShareFiles } from '@/lib/files';

interface Props {
  bytes: Uint8Array;
  fileName: string;
  warnings?: string[];
}

export function ResultView({ bytes, fileName, warnings = [] }: Props) {
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(1);
  const share = canShareFiles();
  return (
    <div className="result">
      <div className="result-bar">
        <strong className="filename">{fileName}</strong>
        <span className="muted small">{(bytes.length / 1024).toFixed(0)} KB</span>
        <div className="spacer" />
        {share && (
          <button className="btn" onClick={() => shareBytes(bytes, fileName)}>
            Share / Save
          </button>
        )}
        <button className="btn primary" onClick={() => downloadBytes(bytes, fileName)}>
          Download
        </button>
      </div>
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <PageNav page={page} count={count} onChange={setPage} />
      <PdfPage bytes={bytes} page={page} onPageCount={setCount} />
    </div>
  );
}
