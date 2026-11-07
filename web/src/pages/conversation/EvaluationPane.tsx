import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Answer, Conversation, Criterion, Evaluation, EvaluationSummary } from '../../types';
import { api } from '../../api';
import {
  answerText,
  cardPath,
  dateTime,
  grossStatus,
  number,
  SPEAKERS,
  type EvidenceFocus,
} from './helpers';

type FinalAnswer = Answer & { changed_by_appeal?: boolean; reviewer_reason?: string };
interface Props {
  evaluation: Evaluation | null;
  history: EvaluationSummary[];
  record: Conversation;
  checklistId: string;
  groupId: string;
  conversationId: string;
  evaluating: boolean;
  onEvaluate: () => void;
  onEvaluation: (evaluation: Evaluation) => void;
  onEvidence: (msg: number, range?: EvidenceFocus['range'], fragment?: string) => void;
  notify: (message: string, tone: 'success' | 'error' | 'info') => void;
}

function Notice({ children, tone = 'warning' }: { children: ReactNode; tone?: string }) {
  return <div className={`conversation-notice ${tone}`}>{children}</div>;
}

function AnswerPill({ criterion, answer }: { criterion: Criterion; answer?: Answer }) {
  const tone =
    !answer || answer.answer === 'INVALID' || answer.review_required
      ? 'warning'
      : answer.answer === 'NA'
        ? 'neutral'
        : criterion.type === 'flag'
          ? answer.answer === 'YES'
            ? 'danger'
            : 'success'
          : answer.answer === 'NO'
            ? 'danger'
            : 'success';
  return <span className={`conversation-pill ${tone}`}>{answerText(criterion, answer)}</span>;
}

function PrintReport({ evaluation, record }: { evaluation: Evaluation; record: Conversation }) {
  const sourceAvailable = !evaluation.record_changed || !!evaluation.record_snapshot;
  return (
    <div className="conversation-print-report" aria-hidden="true">
      <p>
        {evaluation.group_id} · {evaluation.conversation_id} · {dateTime(evaluation.created_at)} ·{' '}
        {evaluation.provider} / {evaluation.model}
      </p>
      {evaluation.summary && <p>{evaluation.summary}</p>}
      <h3>Оценка по критериям</h3>
      {evaluation.checklist_snapshot.criteria.map((criterion) => {
        const answer = evaluation.final_criteria[criterion.id];
        const row = evaluation.final_result.criteria.find((item) => item.id === criterion.id);
        return (
          <article className="conversation-print-criterion" key={criterion.id}>
            <h4>
              {criterion.code || criterion.id}. {criterion.title}
            </h4>
            <p>
              <b>{answerText(criterion, answer)}</b> ·{' '}
              {criterion.type === 'flag'
                ? 'без баллов'
                : `${number(row?.points)} из ${number(row?.effective_weight)} баллов`}
            </p>
            {answer?.explanation && <p>{answer.explanation}</p>}
            {answer?.na_reason && <p>Причина N/A: {answer.na_reason}</p>}
            {answer?.evidence?.map((evidence, index) => (
              <blockquote key={index}>
                {sourceAvailable && record.transcript[evidence.msg]
                  ? `№${evidence.msg + 1}. ${SPEAKERS[record.transcript[evidence.msg].speaker] || record.transcript[evidence.msg].speaker}: ${record.transcript[evidence.msg].text}`
                  : 'Исходный текст доказательства недоступен.'}
              </blockquote>
            ))}
            {answer?.missing_range && (
              <p>
                Ожидаемое действие отсутствует в репликах №{answer.missing_range.from + 1}–
                {answer.missing_range.to + 1}.
              </p>
            )}
            {answer?.checked_range && (
              <p>
                Проверены реплики №{answer.checked_range.from + 1}–{answer.checked_range.to + 1}.
              </p>
            )}
            {!!answer?.unverified_claims?.length && (
              <p>Не проверено по базе знаний: {answer.unverified_claims.join('; ')}.</p>
            )}
            {!!answer?.issues?.length && <p>Замечания к проверке: {answer.issues.join('; ')}.</p>}
            {evaluation.appeals
              .filter((appeal) => appeal.criterion_id === criterion.id)
              .map((appeal) => (
                <div key={appeal.id}>
                  <p>
                    Апелляция ({dateTime(appeal.created_at)}): {appeal.comment}
                  </p>
                  <p>
                    {appeal.status === 'open'
                      ? 'На рассмотрении'
                      : `${appeal.decision?.action === 'confirm' ? 'Оценка подтверждена' : 'Оценка изменена'}: ${appeal.decision?.reason || ''}. ${appeal.decision?.reviewer || ''}`}
                  </p>
                </div>
              ))}
          </article>
        );
      })}
      {!!evaluation.coaching?.length && (
        <>
          <h3>Рекомендации оператору</h3>
          <ol>
            {evaluation.coaching.map((item, index) => (
              <li key={index}>
                {item.type === 'required' ? 'Требование чек-листа' : 'Совет'}: {item.text}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Evidence({
  answer,
  record,
  available,
  onEvidence,
}: {
  answer: Answer;
  record: Conversation;
  available: boolean;
  onEvidence: Props['onEvidence'];
}) {
  if (!available)
    return (
      <Notice>
        Доказательства относятся к предыдущему тексту. Его копия не сохранена; переход к текущим
        репликам отключён.
      </Notice>
    );
  const hasEvidence = answer.evidence?.length || answer.missing_range || answer.checked_range;
  return (
    <div className="conversation-evidence-list">
      {(answer.evidence || []).map((evidence, index) => {
        const message = record.transcript[evidence.msg];
        if (!message)
          return (
            <Notice key={index}>
              В ответе указана несуществующая реплика №{evidence.msg + 1}.
            </Notice>
          );
        const text = String(message.text || '');
        // A fragment is shown only when it exists in the authoritative transcript.
        const fragment =
          evidence.fragment && text.includes(evidence.fragment) ? evidence.fragment : undefined;
        const quote = fragment || (text.length > 190 ? `${text.slice(0, 190)}…` : text);
        return (
          <button
            className="conversation-evidence"
            key={index}
            onClick={() => onEvidence(evidence.msg, undefined, fragment)}
          >
            <span className="conversation-evidence-id">№{evidence.msg + 1}</span>
            <span>
              <small>{SPEAKERS[message.speaker] || message.speaker}</small>«{quote}»
            </span>
            <span className="conversation-evidence-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        );
      })}
      {answer.missing_range && (
        <button
          className="conversation-evidence missing"
          onClick={() => onEvidence(answer.missing_range!.from, answer.missing_range!)}
        >
          <span className="conversation-evidence-id">
            №{answer.missing_range.from + 1}–{answer.missing_range.to + 1}
          </span>
          <span>Здесь действие ожидалось, но отсутствует</span>
          <span aria-hidden="true">↗</span>
        </button>
      )}
      {answer.checked_range && (
        <button
          className="conversation-evidence"
          onClick={() => onEvidence(answer.checked_range!.from, answer.checked_range!)}
        >
          <span className="conversation-evidence-id">
            №{answer.checked_range.from + 1}–{answer.checked_range.to + 1}
          </span>
          <span>
            {answer.checked_range.from === 0 &&
            answer.checked_range.to === record.transcript.length - 1
              ? 'Проверен весь диалог'
              : 'Проверенный участок диалога'}
          </span>
          <span aria-hidden="true">↗</span>
        </button>
      )}
      {!hasEvidence && <span className="conversation-muted">Доказательства не указаны.</span>}
    </div>
  );
}

function AppealDialog({
  criterion,
  evaluation,
  onClose,
  onSaved,
  notify,
}: {
  criterion: Criterion;
  evaluation: Evaluation;
  onClose: () => void;
  onSaved: Props['onEvaluation'];
  notify: Props['notify'];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    fieldRef.current?.focus();
    return () => {
      dialog?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!comment.trim()) {
      setError('Опишите причину несогласия.');
      fieldRef.current?.focus();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await api.post<Evaluation>(
        `/evaluations/${encodeURIComponent(evaluation.id)}/appeals`,
        { criterion_id: criterion.id, comment: comment.trim() },
      );
      onSaved(updated);
      notify('Апелляция сохранена', 'success');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось сохранить апелляцию');
      setSaving(false);
    }
  }
  return (
    <dialog
      className="conversation-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      aria-labelledby="appeal-dialog-title"
    >
      <form onSubmit={submit}>
        <div className="conversation-dialog-heading">
          <div>
            <span className="conversation-eyebrow">ПЕРЕСМОТР ОЦЕНКИ</span>
            <h2 id="appeal-dialog-title">Подать апелляцию</h2>
          </div>
          <button
            type="button"
            className="conversation-icon-button"
            aria-label="Закрыть"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="conversation-dialog-criterion">
          {criterion.code || criterion.id} · {criterion.title}
        </p>
        <label className="conversation-field">
          Причина несогласия
          <textarea
            ref={fieldRef}
            rows={5}
            maxLength={4000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Опишите, что нужно пересмотреть, и укажите номера реплик."
            disabled={saving}
          />
        </label>
        <div className="conversation-field-caption">
          {comment.length} / 4000 · решение появится в истории критерия
        </div>
        {error && (
          <div className="conversation-notice danger" role="alert">
            {error}
          </div>
        )}
        <footer>
          <button
            type="button"
            className="conversation-button secondary"
            disabled={saving}
            onClick={onClose}
          >
            Отмена
          </button>
          <button className="conversation-button primary" disabled={saving}>
            {saving ? 'Отправляем…' : 'Отправить апелляцию'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function CriterionCard({
  criterion,
  evaluation,
  record,
  onEvidence,
  onAppeal,
}: {
  criterion: Criterion;
  evaluation: Evaluation;
  record: Conversation;
  onEvidence: Props['onEvidence'];
  onAppeal: (criterion: Criterion) => void;
}) {
  const answer = evaluation.final_criteria[criterion.id] as FinalAnswer | undefined;
  const original = evaluation.criteria[criterion.id];
  const row = evaluation.final_result.criteria.find((result) => result.id === criterion.id);
  const originalRow = evaluation.original_result.criteria.find(
    (result) => result.id === criterion.id,
  );
  const appeals = evaluation.appeals.filter((appeal) => appeal.criterion_id === criterion.id);
  const openAppeal = appeals.some((appeal) => appeal.status === 'open');
  const section = evaluation.checklist_snapshot.sections?.find(
    (item) => item.id === criterion.section,
  )?.name;
  const available = !evaluation.record_changed || !!evaluation.record_snapshot;
  const [expanded, setExpanded] = useState(true);
  let points: ReactNode;
  if (criterion.type === 'flag') points = 'Без баллов';
  else if (answer?.answer === 'NA')
    points = `Исключён · вес ${number(criterion.weight)} перераспределён`;
  else if (!answer || answer.answer === 'INVALID')
    points = `Не рассчитан · вес ${number(criterion.weight)}`;
  else
    points = (
      <>
        <b>
          {number(row?.points)} / {number(row?.effective_weight)}
        </b>{' '}
        баллов
      </>
    );
  return (
    <article
      className={`conversation-criterion${answer?.review_required ? ' needs-review' : ''}${answer?.changed_by_appeal ? ' was-changed' : ''}`}
    >
      <button
        className="conversation-criterion-toggle"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="conversation-criterion-code">{criterion.code || criterion.id}</span>
        <span className="conversation-criterion-title">
          <strong>{criterion.title}</strong>
          {section && <small>{section}</small>}
        </span>
        <span className="conversation-criterion-grade">
          <AnswerPill criterion={criterion} answer={answer} />
          <span
            title={`Исходный вес: ${criterion.weight}. Точная доля: ${row?.contribution ?? '—'} из ${row?.max_contribution ?? '—'}`}
          >
            {points}
          </span>
        </span>
        <span className={`conversation-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true">
          ⌄
        </span>
      </button>
      {expanded && (
        <div className="conversation-criterion-body">
          {answer?.review_required && !answer.changed_by_appeal && (
            <Notice>Ответ требует проверки человеком.</Notice>
          )}
          {answer?.changed_by_appeal && (
            <Notice tone="info">
              Изменено по апелляции: «{answerText(criterion, original)}» (
              {number(originalRow?.points)} б.) → «{answerText(criterion, answer)}».{' '}
              {answer.reviewer_reason}
            </Notice>
          )}
          {!answer && <Notice>Модель не вернула ответ по этому критерию.</Notice>}
          {answer?.answer === 'NA' && (
            <p>
              <b>Причина N/A: </b>
              {answer.na_reason || answer.explanation || 'Не указана'}
            </p>
          )}
          {answer?.explanation &&
            !(answer.answer === 'NA' && answer.na_reason === answer.explanation) && (
              <p>{answer.explanation}</p>
            )}
          {answer && (
            <Evidence
              answer={answer}
              record={record}
              available={available}
              onEvidence={onEvidence}
            />
          )}
          {!!answer?.unverified_claims?.length && (
            <Notice tone="info">
              <b>Фактическая корректность не проверена.</b> Нет базы знаний для проверки
              утверждений: {answer.unverified_claims.join('; ')}.
            </Notice>
          )}
          {!!answer?.issues?.length && !answer.changed_by_appeal && (
            <details className="conversation-details">
              <summary>Замечания к проверке ответа ({answer.issues.length})</summary>
              <ul>
                {answer.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </details>
          )}
          {answer?.agreement && answer.agreement.runs > 1 && (
            <span className="conversation-muted">
              Согласие прогонов модели: {answer.agreement.agree} / {answer.agreement.runs}
            </span>
          )}
          {appeals.map((appeal) => (
            <div className="conversation-appeal-record" key={appeal.id}>
              <div>
                <span
                  className={`conversation-pill ${appeal.status === 'open' ? 'warning' : 'neutral'}`}
                >
                  {appeal.status === 'open' ? 'На рассмотрении' : 'Рассмотрена'}
                </span>
                <time>{dateTime(appeal.created_at)}</time>
              </div>
              <p>{appeal.comment}</p>
              {appeal.status === 'open' ? (
                <a href="#/appeals">Открыть очередь апелляций ↗</a>
              ) : (
                appeal.decision && (
                  <p>
                    <b>
                      {appeal.decision.action === 'confirm'
                        ? 'Оценка подтверждена'
                        : 'Оценка изменена'}
                      .
                    </b>{' '}
                    {appeal.decision.reason}
                    <span className="conversation-muted">
                      {' '}
                      · {appeal.decision.reviewer} · итог {number(appeal.decision.total_before)} →{' '}
                      {number(appeal.decision.total_after)}
                    </span>
                  </p>
                )
              )}
            </div>
          ))}
          {!openAppeal && (
            <button className="conversation-text-button" onClick={() => onAppeal(criterion)}>
              Оспорить оценку <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function EvaluationPane({
  evaluation,
  history,
  record,
  checklistId,
  groupId,
  conversationId,
  evaluating,
  onEvaluate,
  onEvaluation,
  onEvidence,
  notify,
}: Props) {
  const [tab, setTab] = useState<'criteria' | 'recommendations' | 'history'>('criteria');
  const [criterionFilter, setCriterionFilter] = useState<'all' | 'attention'>('all');
  const [appealCriterion, setAppealCriterion] = useState<Criterion | null>(null);
  const resultScroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTab('criteria');
    setCriterionFilter('all');
  }, [groupId, conversationId]);
  useEffect(() => {
    if (resultScroller.current) resultScroller.current.scrollTop = 0;
  }, [tab]);
  const archiveOnly = history.some((item) => item.checklist.id === checklistId && item.stale);
  if (!evaluation)
    return (
      <section className="conversation-pane conversation-evaluation-pane">
        <header className="conversation-pane-heading">
          <div>
            <h2>Оценка качества</h2>
            <span>Проверка по выбранному чек-листу</span>
          </div>
        </header>
        <div className="conversation-empty">
          <div className="conversation-empty-symbol" aria-hidden="true">
            ✧
          </div>
          <h3>{archiveOnly ? 'Нужна актуальная оценка' : 'Диалог готов к оценке'}</h3>
          <p>
            {archiveOnly
              ? 'Текст диалога или чек-лист изменился. Сохранённые результаты доступны в истории.'
              : 'ИИ проверит критерии чек-листа, выделит доказательства и подготовит рекомендации.'}
          </p>
          <button
            className="conversation-button primary"
            disabled={evaluating}
            onClick={onEvaluate}
          >
            {evaluating ? 'Оцениваем диалог…' : 'Запустить оценку'}
          </button>
          {!!history.length && (
            <label className="conversation-field">
              Сохранённые оценки
              <select
                value=""
                onChange={(event) => {
                  if (event.target.value)
                    location.hash = cardPath(groupId, conversationId, event.target.value);
                }}
              >
                <option value="">Выберите оценку из истории</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.stale ? 'Архив · ' : ''}
                    {item.checklist.name} v{item.checklist.version} · {number(item.final_total)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>
    );

  const final = evaluation.final_result;
  const gross = grossStatus(evaluation);
  const changed = final.total !== evaluation.original_result.total;
  const scoreColor =
    final.total == null
      ? 'var(--cqa-muted)'
      : final.total >= 85
        ? 'var(--cqa-green)'
        : final.total >= 60
          ? 'var(--cqa-warning)'
          : 'var(--cqa-danger)';
  const criteria = evaluation.checklist_snapshot.criteria;
  const requiresAttention = (criterion: Criterion) => {
    const answer = evaluation.final_criteria[criterion.id];
    const row = final.criteria.find((item) => item.id === criterion.id);
    return (
      !answer ||
      answer.review_required ||
      answer.answer === 'INVALID' ||
      (row?.scored && row.raw < row.weight) ||
      (criterion.type === 'flag' && answer.answer === 'YES')
    );
  };
  const attentionCount = criteria.filter(requiresAttention).length;
  const visibleCriteria =
    criterionFilter === 'attention' ? criteria.filter(requiresAttention) : criteria;
  const tabs = [
    { id: 'criteria', title: 'Критерии', count: criteria.length },
    { id: 'recommendations', title: 'Рекомендации', count: evaluation.coaching?.length || 0 },
    { id: 'history', title: 'История', count: history.length },
  ] as const;
  return (
    <section
      className="conversation-pane conversation-evaluation-pane"
      aria-label="Оценка качества"
    >
      <div className="conversation-evaluation-summary">
        <div
          className="conversation-score-ring"
          style={
            { '--score': final.total || 0, '--score-color': scoreColor } as React.CSSProperties
          }
          aria-label={`Итоговая оценка ${number(final.total)} из 100`}
        >
          <div>
            <strong>{number(final.total)}</strong>
            <span>{changed ? 'финальный' : 'из 100'}</span>
          </div>
        </div>
        <div className="conversation-score-description">
          <span className="conversation-eyebrow">ОЦЕНКА КАЧЕСТВА</span>
          <h2>{evaluation.operator_name || 'Результат диалога'}</h2>
          <div className="conversation-summary-badges">
            <span
              className={`conversation-pill ${gross === 'unknown' ? 'warning' : gross === 'violation' ? 'danger' : 'success'}`}
            >
              {gross === 'unknown'
                ? 'Грубые ошибки: нужна проверка'
                : gross === 'violation'
                  ? 'Выявлена грубая ошибка'
                  : 'Грубых ошибок нет'}
            </span>
            {evaluation.stale && <span className="conversation-pill warning">Архив</span>}
            {evaluation.provider === 'mock' && (
              <span className="conversation-pill warning">Демо</span>
            )}
          </div>
          <p>
            {evaluation.checklist_snapshot.name} · v{evaluation.checklist.version}
          </p>
          {changed && (
            <p className="conversation-score-change">
              После апелляции: {number(evaluation.original_result.total)} → {number(final.total)}
            </p>
          )}
        </div>
      </div>
      <div className="conversation-result-tabs" role="tablist" aria-label="Разделы оценки">
        {tabs.map((item) => (
          <button
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`result-panel-${item.id}`}
            id={`result-tab-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            key={item.id}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.findIndex((candidate) => candidate.id === tab);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              requestAnimationFrame(() =>
                document.getElementById(`result-tab-${tabs[next].id}`)?.focus(),
              );
            }}
          >
            {item.title}
            <span>{item.count}</span>
          </button>
        ))}
      </div>
      <div
        ref={resultScroller}
        className="conversation-result-scroller"
        role="tabpanel"
        id={`result-panel-${tab}`}
        aria-labelledby={`result-tab-${tab}`}
        tabIndex={0}
      >
        {evaluation.stale && (
          <Notice>
            Архивная оценка:{' '}
            {evaluation.record_changed
              ? 'она относится к предыдущим данным диалога.'
              : 'чек-лист или данные изменились после сохранения.'}{' '}
            Для текущего результата запустите новую оценку.
          </Notice>
        )}
        {evaluation.provider === 'mock' && (
          <Notice>Демо-оценка по правилам. Результат реальной модели может отличаться.</Notice>
        )}
        {evaluation.status === 'needs_review' && (
          <Notice>
            <b>Нужна проверка человеком.</b> Часть ответов модели не прошла валидацию.
            {!!evaluation.validation_errors?.length && (
              <details>
                <summary>Причины ({evaluation.validation_errors.length})</summary>
                <ul>
                  {evaluation.validation_errors.map((error, index) => (
                    <li key={index}>{error}</li>
                  ))}
                </ul>
              </details>
            )}
          </Notice>
        )}
        {final.note && <Notice>{final.note}</Notice>}
        {tab === 'criteria' && (
          <>
            {!!final.sections?.some((section) => section.max) && (
              <div className="conversation-section-scores">
                {final.sections
                  .filter((section) => section.max)
                  .map((section) => (
                    <div key={section.id}>
                      <span>{section.name}</span>
                      <b>
                        {number(section.points)} <small>/ {number(section.max)}</small>
                      </b>
                      <div
                        role="meter"
                        aria-label={section.name}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={section.percent || 0}
                      >
                        <i
                          style={{ width: `${Math.max(0, Math.min(100, section.percent || 0))}%` }}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            )}
            <div className="conversation-criteria-filter">
              <strong>{criterionFilter === 'all' ? 'Все критерии' : 'Требуют внимания'}</strong>
              <label>
                <input
                  type="checkbox"
                  checked={criterionFilter === 'attention'}
                  onChange={(event) =>
                    setCriterionFilter(event.target.checked ? 'attention' : 'all')
                  }
                />
                Только замечания <span>{attentionCount}</span>
              </label>
            </div>
            {visibleCriteria.map((criterion) => (
              <CriterionCard
                key={`${evaluation.id}:${criterion.id}`}
                criterion={criterion}
                evaluation={evaluation}
                record={record}
                onEvidence={onEvidence}
                onAppeal={setAppealCriterion}
              />
            ))}
            {!visibleCriteria.length && (
              <div className="conversation-empty">
                <h3>Замечаний нет</h3>
                <p>По выбранным критериям нет снижения баллов или ответов, требующих проверки.</p>
              </div>
            )}
            <details className="conversation-details conversation-method">
              <summary>Как рассчитан результат</summary>
              {final.total_exact != null && (
                <p>
                  100 × {number(final.earned_weight)} / {number(final.applicable_weight)} ={' '}
                  {number(final.total_exact, 4)} → {number(final.total)}. Округляется итог, поэтому
                  сумма показанных долей может отличаться на 0,01.
                </p>
              )}
              <p>
                Применимый вес: {number(final.applicable_weight)}. Перераспределение: ×
                {number(final.redistribution_factor)}. Флаги грубых ошибок не изменяют баллы.
              </p>
              <p>
                {evaluation.provider} / {evaluation.model} ·{' '}
                {number((evaluation.timing?.total_ms ?? evaluation.duration_ms) / 1000, 1)} с ·{' '}
                {evaluation.cost_usd == null ? 'стоимость неизвестна' : `≈ $${evaluation.cost_usd}`}
              </p>
              <p>
                Токены: {evaluation.usage?.input ?? '—'} вход / {evaluation.usage?.output ?? '—'}{' '}
                выход
                {evaluation.usage?.thoughts
                  ? ` + ${evaluation.usage.thoughts} размышление`
                  : ''}.{' '}
                {evaluation.timing &&
                  `Модель: ${number(evaluation.timing.llm_ms / 1000, 1)} с; HTTP-попыток: ${evaluation.timing.http_attempts}; очередь: ${number(evaluation.timing.queue_ms / 1000, 1)} с; ожидание повторов: ${number(evaluation.timing.retry_wait_ms / 1000, 1)} с.`}
              </p>
            </details>
          </>
        )}
        {tab === 'recommendations' && (
          <div className="conversation-coaching">
            {evaluation.summary && (
              <div className="conversation-review-summary">
                <span className="conversation-eyebrow">ВЫВОД ПО ДИАЛОГУ</span>
                <p>{evaluation.summary}</p>
              </div>
            )}
            {evaluation.coaching?.map((item, index) => {
              const title = criteria.find((criterion) => criterion.id === item.criterion_id)?.title;
              return (
                <article key={index}>
                  <div>
                    <span
                      className={`conversation-pill ${item.type === 'required' ? 'warning' : 'neutral'}`}
                    >
                      {item.type === 'required' ? 'Требование чек-листа' : 'Совет'}
                    </span>
                    <span className="conversation-coaching-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>
                  {title && <h3>{title}</h3>}
                  <p>{item.text}</p>
                </article>
              );
            })}
            {!evaluation.coaching?.length && (
              <div className="conversation-empty">
                <h3>Рекомендаций нет</h3>
                <p>Для этой оценки модель не сформировала отдельных рекомендаций.</p>
              </div>
            )}
          </div>
        )}
        {tab === 'history' && (
          <div className="conversation-history">
            <div className="conversation-history-intro">
              <h3>Сохранённые оценки</h3>
              <p>
                Каждый запуск сохраняет отдельный результат. Апелляции изменяют итог выбранной
                оценки.
              </p>
            </div>
            {history.map((item) => (
              <a
                className={`conversation-history-item${item.id === evaluation.id ? ' selected' : ''}`}
                href={cardPath(groupId, conversationId, item.id)}
                key={item.id}
              >
                <span className="conversation-history-score">{number(item.final_total)}</span>
                <span>
                  <strong>
                    {item.checklist.name} · v{item.checklist.version}
                  </strong>
                  <small>
                    {dateTime(item.created_at)} · {item.provider} / {item.model}
                  </small>
                  <span className="conversation-history-tags">
                    {item.id === evaluation.id && (
                      <span className="conversation-pill success">Открыта</span>
                    )}
                    {item.stale && <span className="conversation-pill warning">Архив</span>}
                    {item.status === 'needs_review' && (
                      <span className="conversation-pill warning">Нужна проверка</span>
                    )}
                    {item.appeals_total > 0 && (
                      <span className="conversation-pill neutral">
                        Апелляции: {item.appeals_total}
                      </span>
                    )}
                  </span>
                </span>
                <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        )}
      </div>
      <footer className="conversation-result-footer">
        <span>Сохранено {dateTime(evaluation.created_at)}</span>
        <span>
          {evaluation.provider} / {evaluation.model}
        </span>
      </footer>
      <PrintReport evaluation={evaluation} record={record} />
      {appealCriterion && (
        <AppealDialog
          criterion={appealCriterion}
          evaluation={evaluation}
          onClose={() => setAppealCriterion(null)}
          onSaved={onEvaluation}
          notify={notify}
        />
      )}
    </section>
  );
}
