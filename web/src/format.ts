import type { Answer, Criterion, Evaluation, EvaluationSummary } from './types';
export const formatNumber = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
export const fmt = formatNumber;
export const formatDate = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ru-RU', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
export const formatDuration = (seconds?: number | null) =>
  seconds == null || !Number.isFinite(seconds)
    ? '—'
    : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const shortTimestamp = (timestamp: string | number) =>
  String(timestamp).match(/T(\d\d:\d\d:\d\d)/)?.[1] || String(timestamp);
export const speakerNames = {
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
};
export const criterionMax = (criterion: Criterion) =>
  criterion.type === 'scale'
    ? Math.max(...(criterion.scale || []).map((step) => step.value), 0)
    : 1;
export const scoreTone = (value?: number | null) =>
  value == null
    ? ('neutral' as const)
    : value >= 85
      ? ('success' as const)
      : value >= 60
        ? ('warning' as const)
        : ('danger' as const);
export function answerLabel(criterion: Criterion | undefined, answer: Answer | undefined) {
  if (!answer) return 'Нет оценки';
  if (answer.answer === 'INVALID') return 'Нужна проверка';
  if (answer.answer === 'NA') return 'N/A';
  if (answer.answer === 'SCORE')
    return `${answer.value} / ${criterion ? criterionMax(criterion) : '—'}`;
  if (criterion?.type === 'flag') return answer.answer === 'YES' ? 'Выявлено' : 'Не выявлено';
  return answer.answer === 'YES' ? 'Да' : 'Нет';
}
export function criticalState(
  evaluation: Evaluation | EvaluationSummary,
): 'yes' | 'no' | 'unknown' {
  if ('final_criteria' in evaluation) {
    const flags = evaluation.checklist_snapshot.criteria.filter(
      (criterion) => criterion.type === 'flag',
    );
    if (!flags.length) return 'unknown';
    if (
      flags.some((criterion) => {
        const answer = evaluation.final_criteria[criterion.id];
        return (
          !answer ||
          !['YES', 'NO'].includes(answer.answer) ||
          answer.review_required ||
          !!answer.issues?.length
        );
      })
    )
      return 'unknown';
    return evaluation.final_result.gross_error ? 'yes' : 'no';
  }
  return evaluation.gross_error_unknown ? 'unknown' : evaluation.gross_error ? 'yes' : 'no';
}
export function currentEvaluation(evaluations: EvaluationSummary[], checklistId: string) {
  return evaluations
    .filter((item) => item.checklist.id === checklistId && !item.stale)
    .sort(
      (a, b) =>
        b.checklist.version - a.checklist.version ||
        Number(a.provider === 'mock') - Number(b.provider === 'mock') ||
        b.created_at.localeCompare(a.created_at),
    )[0];
}
