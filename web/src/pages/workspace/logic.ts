import type { Filters, ListRecord, QueueJob, Row } from './models';

export const quickFilters = [
  ['all', 'Все'],
  ['todo', 'Не оценены'],
  ['review', 'Нужна проверка'],
  ['gross', 'Грубые ошибки'],
  ['low', 'Ниже 60'],
  ['appeal', 'Апелляции'],
  ['changed', 'Пересмотрены'],
  ['noname', 'Без имени'],
] as const;

export function matchesQuick(row: Row, key: string): boolean {
  const e = row.evaluation;
  switch (key) {
    case 'todo':
      return !e;
    case 'review':
      return !!e && (e.status === 'needs_review' || e.gross_error_unknown);
    case 'gross':
      return !!e?.gross_error;
    case 'low':
      return e?.final_total != null && e.final_total < 60;
    case 'appeal':
      return !!e?.appeals_open;
    case 'changed':
      return !!e && e.final_total !== e.original_total;
    case 'noname':
      return !!e && !e.operator_name;
    default:
      return true;
  }
}
export function listRows(records: ListRecord[], checklistId: string): Row[] {
  return records.map((record) => {
    const history = record.evaluations.filter((e) => e.checklist.id === checklistId);
    return { record, history, evaluation: history.find((e) => !e.stale) };
  });
}
export function filterRows(rows: Row[], filters: Filters): Row[] {
  const query = filters.query.trim().toLocaleLowerCase('ru');
  return rows.filter(
    ({ record, evaluation }) =>
      (!filters.channel || record.channel === filters.channel) &&
      (!filters.language || record.language === filters.language) &&
      (!query ||
        record.conversation_id.toLocaleLowerCase('ru').includes(query) ||
        evaluation?.operator_name?.toLocaleLowerCase('ru').includes(query)),
  );
}
export function sortRows(rows: Row[], filters: Filters): Row[] {
  const value = (row: Row) =>
    filters.sort === 'operator'
      ? row.evaluation?.operator_name
      : filters.sort === 'messages'
        ? row.record.messages
        : filters.sort === 'total'
          ? row.evaluation?.final_total
          : row.record.conversation_id;
  return rows
    .filter((row) => matchesQuick(row, filters.quick))
    .sort((a, b) => {
      const av = value(a),
        bv = value(b);
      if (av == null || bv == null) return Number(av == null) - Number(bv == null);
      return (
        filters.direction *
        (typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), 'ru', { numeric: true }))
      );
    });
}
/** Always read durable state before advancing. A lost POST response is retried through GET. */
export async function advanceQueue(
  id: string,
  get: (path: string) => Promise<QueueJob>,
  post: (path: string, body: object) => Promise<QueueJob>,
  active: () => boolean = () => true,
): Promise<QueueJob> {
  const job = await get('/batch/' + encodeURIComponent(id));
  if (!active() || job.execution_mode !== 'stepped' || job.status !== 'running') return job;
  return post('/batch/' + encodeURIComponent(id) + '/step', {});
}
export const number = (value: number | null | undefined, digits = 1) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
export const cardHref = (group: string, conversation: string, evaluation?: string) =>
  `#/card/${encodeURIComponent(group)}/${encodeURIComponent(conversation)}${evaluation ? '/' + encodeURIComponent(evaluation) : ''}`;
export const operatorHref = (group: string, name: string) =>
  `#/operator/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
