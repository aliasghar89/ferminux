import type { ReactNode } from 'react';
import { IconBack } from '../components/icons.tsx';

/** Screen title (Sora) with optional trailing actions. */
export function ScreenHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub" style={{ margin: '4px 0 0' }}>{sub}</p>}
      </div>
      {children && (
        <>
          <span className="push" />
          {children}
        </>
      )}
    </div>
  );
}

export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button className="back-btn" onClick={onClick}>
      <IconBack /> {label}
    </button>
  );
}
