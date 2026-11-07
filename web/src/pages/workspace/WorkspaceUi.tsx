import type { ReactNode } from 'react';
import '../../styles/pages.css';
import { useWorkspace } from '../../Workspace';
import { number } from './logic';

export function DatasetControls() {
  const { datasets, checklists, group, setGroup, checklistId, setChecklistId } = useWorkspace();
  return (
    <div className="cqa-page-selectors">
      <label className="cqa-field">
        Набор данных
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          {!datasets.length && <option value="">Нет наборов</option>}
          {datasets.map((d) => (
            <option key={d.group_id} value={d.group_id}>
              {d.group_id} · {d.total_records}
            </option>
          ))}
        </select>
      </label>
      <label className="cqa-field cqa-checklist-picker">
        Чек-лист
        <select value={checklistId} onChange={(e) => setChecklistId(e.target.value)}>
          {checklists.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · v{c.version}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`cqa-metric ${tone ? `cqa-metric-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
export function ScoreValue({ value }: { value: number | null | undefined }) {
  return (
    <strong
      className={`cqa-score-value ${value == null ? '' : value >= 80 ? 'is-good' : value >= 60 ? 'is-mid' : 'is-low'}`}
    >
      {number(value)}
    </strong>
  );
}
export function StatusTag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return <span className={`cqa-status-tag is-${tone}`}>{children}</span>;
}
export function CriticalTag({ gross, unknown }: { gross: boolean; unknown: boolean }) {
  return gross ? (
    <StatusTag tone="danger">Выявлена</StatusTag>
  ) : unknown ? (
    <StatusTag tone="warning">Нужна проверка</StatusTag>
  ) : (
    <span className="cqa-cell-muted">Нет</span>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="cqa-workspace-empty">
      <span className="cqa-empty-mark" aria-hidden="true">
        ○
      </span>
      <h2>{title}</h2>
      {children && <div>{children}</div>}
    </div>
  );
}
export function SectionTitle({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="cqa-section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div
      className="cqa-value-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
