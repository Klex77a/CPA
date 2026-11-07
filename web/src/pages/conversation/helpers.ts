import type { Conversation, Evaluation, Criterion } from '../../types';

export const SPEAKERS: Record<string, string> = {
  operator: 'Оператор',
  client: 'Клиент',
  bot: 'Бот',
  system: 'Система',
};

export function number(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

export function time(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function timestamp(value: string | number | null | undefined): string {
  const match = String(value || '').match(/T(\d\d:\d\d:\d\d)/);
  return match ? match[1] : String(value ?? '—');
}

export function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

export function cardPath(groupId: string, conversationId: string, evaluationId?: string): string {
  return `#/card/${encodeURIComponent(groupId)}/${encodeURIComponent(conversationId)}${evaluationId ? `/${encodeURIComponent(evaluationId)}` : ''}`;
}

/** An unresolved flag must never become a green "no violations" status. */
export function grossStatus(evaluation: Evaluation): 'violation' | 'unknown' | 'clear' {
  const unknown = evaluation.checklist_snapshot.criteria.some((criterion) => {
    if (criterion.type !== 'flag') return false;
    const answer = evaluation.final_criteria[criterion.id];
    return (
      !answer ||
      !['YES', 'NO'].includes(answer.answer) ||
      answer.review_required ||
      (answer.issues || []).length > 0
    );
  });
  if (unknown) return 'unknown';
  return evaluation.final_result.gross_error ? 'violation' : 'clear';
}

export function shownRecord(
  current: Conversation | null,
  evaluation: Evaluation | null,
): Conversation | null {
  return evaluation?.record_changed && evaluation.record_snapshot
    ? evaluation.record_snapshot
    : current;
}

export function answerText(
  criterion: Criterion,
  answer: Evaluation['final_criteria'][string] | undefined,
): string {
  if (!answer || answer.answer === 'INVALID') return 'Нет допустимого ответа';
  if (answer.answer === 'NA') return 'N/A';
  if (answer.answer === 'SCORE')
    return `${number(answer.value)} из ${number(Math.max(...(criterion.scale || []).map((step) => step.value)))}`;
  if (criterion.type === 'flag') return answer.answer === 'YES' ? 'Выявлено' : 'Не выявлено';
  return answer.answer === 'YES' ? 'Да' : 'Нет';
}

export interface EvidenceFocus {
  msg: number;
  range?: { from: number; to: number };
  fragment?: string;
  token: number;
}

export function hashEvidence(hash: string): EvidenceFocus | null {
  const query = new URLSearchParams(hash.split('?')[1] || '');
  const turn = Number(query.get('turn'));
  if (!Number.isInteger(turn) || turn < 1) return null;
  const to = Number(query.get('to'));
  return {
    msg: turn - 1,
    range: Number.isInteger(to) && to >= turn ? { from: turn - 1, to: to - 1 } : undefined,
    token: Date.now(),
  };
}

/** Keep evidence navigation inside its panel; scrollIntoView also moves the page. */
export function scrollMessage(container: HTMLElement, message: HTMLElement, center = true): void {
  const outer = container.getBoundingClientRect();
  const inner = message.getBoundingClientRect();
  const top =
    container.scrollTop +
    inner.top -
    outer.top -
    (center ? Math.max(16, (container.clientHeight - inner.height) / 2) : 16);
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  container.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'instant' : 'smooth' });
}
