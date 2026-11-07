import type { Answer, Criterion, Evaluation, EvaluationSummary, EvaluationPhase } from './types';
export function evaluationPhase(
  value: Pick<EvaluationSummary, 'appeals_open' | 'appeals_total'>,
): EvaluationPhase {
  return value.appeals_open > 0 ? 'disputed' : value.appeals_total > 0 ? 'reviewed' : 'preliminary';
}
export const evaluationPhaseLabel = (phase: EvaluationPhase) =>
  ({
    preliminary: 'Предварительная оценка ИИ',
    disputed: 'Оценка оспаривается',
    reviewed: 'После пересмотра',
  })[phase];
export const formatNumber = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
export const fmt = formatNumber;
interface CostObservation {
  cost_usd: number | null;
  known_cost_usd?: number;
  billing_complete?: boolean;
  unknown_cost_count?: number;
  unknown_call_count?: number;
}
export const costIsComplete = (value: CostObservation) =>
  value.cost_usd != null &&
  Number.isFinite(value.cost_usd) &&
  value.billing_complete !== false &&
  !value.unknown_cost_count &&
  !value.unknown_call_count;
export const knownCost = (value: CostObservation) =>
  value.known_cost_usd != null && Number.isFinite(value.known_cost_usd)
    ? value.known_cost_usd
    : value.cost_usd != null && Number.isFinite(value.cost_usd)
      ? value.cost_usd
      : null;
export function costDescription(value: CostObservation) {
  if (costIsComplete(value)) return `≈ $${value.cost_usd!.toFixed(4)}`;
  const observed = knownCost(value);
  return observed != null && observed > 0
    ? `не менее $${observed.toFixed(4)}; полная стоимость неизвестна`
    : 'полная стоимость неизвестна';
}
export function usageDescription(
  value: Pick<Evaluation, 'usage' | 'known_usage' | 'billing_complete' | 'unknown_call_count'>,
) {
  const complete = value.usage && value.billing_complete !== false && !value.unknown_call_count;
  const usage = complete ? value.usage : (value.known_usage ?? value.usage);
  if (!usage) return 'Токены неизвестны: данные о расходе не получены.';
  const tokens = `${usage.input} вход / ${usage.output} выход${usage.thoughts ? ` + ${usage.thoughts} размышление` : ''}`;
  if (complete) return `Токены: ${tokens}.`;
  return usage.input + usage.output + usage.thoughts > 0
    ? `Токены (учтённый минимум): ${tokens}; полное число неизвестно.`
    : 'Токены неизвестны: данные о полном расходе не получены.';
}
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
