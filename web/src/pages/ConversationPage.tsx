import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import {
  evaluateWithRequest,
  evaluationActionLabel,
  useEvaluationRequests,
} from '../evaluationRequests';
import type { Conversation, Evaluation, EvaluationSummary } from '../types';
import TranscriptPane from './conversation/TranscriptPane';
import EvaluationPane from './conversation/EvaluationPane';
import { cardPath, hashEvidence, shownRecord, type EvidenceFocus } from './conversation/helpers';
import '../styles/conversation.css';

interface Props {
  groupId: string;
  conversationId: string;
  evaluationId?: string;
}
interface CardData {
  record: Conversation | null;
  evaluation: Evaluation | null;
  history: EvaluationSummary[];
}

function ClearDialog({
  count,
  appeals,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  count: number;
  appeals: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const active = document.activeElement as HTMLElement | null;
    const previous = active?.closest('details')?.querySelector<HTMLElement>('summary') || active;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="conversation-dialog"
      aria-labelledby="clear-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="conversation-dialog-heading">
        <div>
          <span className="conversation-eyebrow">УДАЛЕНИЕ РЕЗУЛЬТАТОВ</span>
          <h2 id="clear-dialog-title">Очистить оценки диалога?</h2>
        </div>
        <button
          type="button"
          className="conversation-icon-button"
          aria-label="Закрыть"
          onClick={onClose}
          disabled={busy}
        >
          ×
        </button>
      </div>
      <p>
        Будут удалены все оценки этого диалога по выбранному чек-листу: <b>{count}</b>. Связанных
        апелляций: <b>{appeals}</b>. Восстановить их нельзя.
      </p>
      <p className="conversation-muted">Текст диалога и оценки по другим чек-листам сохранятся.</p>
      {error && (
        <div className="conversation-notice danger" role="alert">
          {error}
        </div>
      )}
      <footer>
        <button
          autoFocus
          type="button"
          className="conversation-button secondary"
          disabled={busy}
          onClick={onClose}
        >
          Отмена
        </button>
        <button
          type="button"
          className="conversation-button danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Удаляем…' : 'Удалить оценки'}
        </button>
      </footer>
    </dialog>
  );
}

export default function ConversationPage({ groupId, conversationId, evaluationId }: Props) {
  const {
    checklists,
    checklistId,
    setChecklistId,
    group,
    setGroup,
    conversationOrder,
    refreshBase,
    notify,
    evaluationRevision,
  } = useWorkspace();
  const evaluationRequests = useEvaluationRequests();
  const evaluationRequest = evaluationRequests.get({
    group_id: groupId,
    conversation_id: conversationId,
    checklist_id: checklistId,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const contextKey = `${groupId}/${conversationId}/${evaluationId || ''}/${checklistId}`;
  const key = evaluationId ? contextKey : `${contextKey}/revision:${evaluationRevision}`;
  const requestKey = useRef(contextKey);
  requestKey.current = contextKey;
  const retained = useRef<{ contextKey: string; data: CardData } | null>(null);
  const sourceRecord = useRef<{ identity: string; record: Conversation } | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [mobilePane, setMobilePane] = useState<'dialog' | 'evaluation'>('dialog');
  const [wide, setWide] = useState(
    () =>
      typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1001px)').matches,
  );
  const [focus, setFocus] = useState<EvidenceFocus | null>(null);
  const [localEvaluation, setLocalEvaluation] = useState<{
    key: string;
    evaluation: Evaluation;
  } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState('');
  const resource = useResource<CardData>(key, async (signal) => {
    const [record, all] = await Promise.all([
      api
        .get<Conversation>(
          `/datasets/${encodeURIComponent(groupId)}/${encodeURIComponent(conversationId)}`,
          signal,
        )
        .catch((error) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }),
      api.get<EvaluationSummary[]>(`/evaluations?group_id=${encodeURIComponent(groupId)}`, signal),
    ]);
    const history = all.filter((item) => item.conversation_id === conversationId);
    const selected = evaluationId
      ? history.find((item) => item.id === evaluationId)
      : history.find((item) => item.checklist.id === checklistId && !item.stale);
    if (evaluationId && !selected)
      throw new Error('Сохранённая оценка не найдена. Возможно, она была удалена.');
    const evaluation = selected
      ? await api.get<Evaluation>(`/evaluations/${encodeURIComponent(selected.id)}`, signal)
      : null;
    return { record, evaluation, history };
  });
  if (resource.data) retained.current = { contextKey, data: resource.data };
  const data =
    resource.data ||
    (retained.current?.contextKey === contextKey ? retained.current.data : undefined);
  const evaluation =
    localEvaluation?.key === key ? localEvaluation.evaluation : data?.evaluation || null;
  const source = shownRecord(data?.record || null, evaluation);
  const identity = source ? JSON.stringify(source) : '';
  if (source && sourceRecord.current?.identity !== identity)
    sourceRecord.current = { identity, record: source };
  // A background score refresh must not remount the audio element, clear transcript
  // filters or seek back to an old evidence marker when the source is unchanged.
  const record = source ? sourceRecord.current!.record : null;
  const history = data?.history || [];
  const order = conversationOrder?.groupId === groupId ? conversationOrder.ids : [];
  const position = order.indexOf(conversationId);
  const previous = position > 0 ? order[position - 1] : null;
  const next = position >= 0 && position < order.length - 1 ? order[position + 1] : null;

  useEffect(() => {
    if (group !== groupId) setGroup(groupId);
  }, [group, groupId, setGroup]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1001px)');
    const changed = () => setWide(media.matches);
    media.addEventListener('change', changed);
    changed();
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    setMobilePane('dialog');
    setFocus(null);
    setClearOpen(false);
    setEvaluating(false);
    setLocalEvaluation(null);
  }, [groupId, conversationId]);
  useEffect(() => {
    function requestedEvidence() {
      const requested = hashEvidence(window.location.hash);
      if (requested) {
        setFocus(requested);
        setMobilePane('dialog');
      }
    }
    requestedEvidence();
    window.addEventListener('hashchange', requestedEvidence);
    return () => window.removeEventListener('hashchange', requestedEvidence);
  }, [groupId, conversationId, evaluationId]);
  useEffect(() => {
    const move = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input,textarea,select,audio,video,button,a,[contenteditable="true"],[role="slider"],[role="tab"]',
        )
      )
        return;
      const destination =
        event.key === 'ArrowLeft' ? previous : event.key === 'ArrowRight' ? next : null;
      if (destination) {
        event.preventDefault();
        location.hash = cardPath(groupId, destination);
      }
    };
    window.addEventListener('keydown', move);
    return () => window.removeEventListener('keydown', move);
  }, [previous, next, groupId]);

  async function evaluate() {
    const activeKey = contextKey;
    setEvaluating(true);
    try {
      const result = await evaluateWithRequest<Evaluation>({
        group_id: groupId,
        conversation_id: conversationId,
        checklist_id: checklistId,
        force: !!(evaluation && evaluation.checklist.id === checklistId),
      });
      notify(
        result.cached
          ? 'Открыта готовая оценка. «Переоценить» сохранит новый результат.'
          : `Оценка ${conversationId} сохранена`,
        result.cached ? 'info' : 'success',
      );
      await refreshBase().catch(() => {
        // A confirmed evaluation remains successful when the workspace summary cannot refresh.
      });
      if (!mounted.current || requestKey.current !== activeKey) return;
      const target = cardPath(groupId, conversationId, result.id);
      if (location.hash.split('?')[0] === target) {
        setLocalEvaluation({ key, evaluation: result });
        resource.reload();
      } else location.hash = target;
      setMobilePane('evaluation');
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : 'Не удалось оценить диалог', 'error');
    } finally {
      if (mounted.current && requestKey.current === activeKey) setEvaluating(false);
    }
  }

  function focusEvidence(msg: number, range?: EvidenceFocus['range'], fragment?: string) {
    if (!record?.transcript[msg]) {
      notify('Эта реплика отсутствует в сохранённом тексте.', 'error');
      return;
    }
    setMobilePane('dialog');
    setFocus({ msg, range, fragment, token: Date.now() });
  }

  async function clear() {
    if (!evaluation) return;
    setClearing(true);
    setClearError('');
    try {
      await api.delete(
        `/evaluations?group_id=${encodeURIComponent(groupId)}&conversation_id=${encodeURIComponent(conversationId)}&checklist_id=${encodeURIComponent(evaluation.checklist.id)}`,
      );
      setClearOpen(false);
      setLocalEvaluation(null);
      await refreshBase();
      notify('Оценки по этому чек-листу удалены', 'success');
      if (evaluationId) location.hash = cardPath(groupId, conversationId);
      else resource.reload();
    } catch (failure) {
      setClearError(failure instanceof Error ? failure.message : 'Не удалось удалить оценки');
    } finally {
      setClearing(false);
    }
  }

  function updateEvaluation(updated: Evaluation) {
    setLocalEvaluation({ key, evaluation: updated });
    refreshBase().catch(() => {
      /* The saved appeal remains visible if the summary refresh fails. */
    });
    resource.reload();
  }

  const relevant = history.filter((item) => item.checklist.id === evaluation?.checklist.id);
  return (
    <div className="conversation-page">
      <header className="conversation-page-toolbar">
        <div className="conversation-heading-row">
          <a
            href="#/list"
            className="conversation-back"
            title="К списку диалогов"
            aria-label="К списку диалогов"
          >
            ←
          </a>
          <div className="conversation-title">
            <span className="conversation-eyebrow">ДИАЛОГ · {groupId}</span>
            <h1>{conversationId}</h1>
          </div>
          {position >= 0 && (
            <div className="conversation-pagination">
              <button
                className="conversation-icon-button"
                disabled={!previous}
                title="Предыдущий диалог (←)"
                aria-label="Предыдущий диалог"
                onClick={() => {
                  if (previous) location.hash = cardPath(groupId, previous);
                }}
              >
                ‹
              </button>
              <span>
                {position + 1} / {order.length}
              </span>
              <button
                className="conversation-icon-button"
                disabled={!next}
                title="Следующий диалог (→)"
                aria-label="Следующий диалог"
                onClick={() => {
                  if (next) location.hash = cardPath(groupId, next);
                }}
              >
                ›
              </button>
            </div>
          )}
        </div>
        <div className="conversation-page-actions">
          <label className="conversation-checklist-select">
            <span>Чек-лист</span>
            <select
              aria-label="Чек-лист для оценки"
              value={checklistId}
              disabled={evaluating}
              onChange={(event) => setChecklistId(event.target.value)}
            >
              {checklists.map((checklist) => (
                <option value={checklist.id} key={checklist.id}>
                  {checklist.name} · v{checklist.version}
                </option>
              ))}
            </select>
          </label>
          <button
            className="conversation-button primary"
            disabled={evaluating || resource.loading || !data?.record}
            onClick={evaluate}
          >
            {evaluating && <span className="conversation-spinner" />}
            {evaluating
              ? 'Оцениваем…'
              : evaluation?.checklist.id === checklistId
                ? evaluationActionLabel(evaluationRequest, 'Переоценить')
                : evaluationActionLabel(evaluationRequest, 'Оценить диалог')}
          </button>
          {evaluation && (
            <details className="conversation-more-menu">
              <summary
                className="conversation-icon-button"
                aria-label="Действия с оценкой"
                title="Действия с оценкой"
              >
                ···
              </summary>
              <div>
                <button
                  onClick={() => {
                    document
                      .querySelector<HTMLDetailsElement>('.conversation-more-menu')
                      ?.removeAttribute('open');
                    window.print();
                  }}
                >
                  Печать / PDF
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    document
                      .querySelector<HTMLDetailsElement>('.conversation-more-menu')
                      ?.removeAttribute('open');
                    setClearError('');
                    setClearOpen(true);
                  }}
                >
                  Очистить результаты
                </button>
              </div>
            </details>
          )}
        </div>
      </header>
      {evaluationRequest && (
        <div className="conversation-notice warning" role="status">
          {evaluationRequest.message}
        </div>
      )}
      {resource.loading && !data ? (
        <div className="conversation-loading" role="status">
          <span className="conversation-spinner" />
          Открываем диалог и оценку…
        </div>
      ) : resource.error && !data ? (
        <div className="conversation-empty conversation-page-error" role="alert">
          <h2>Не удалось открыть диалог</h2>
          <p>{resource.error.message}</p>
          <div>
            <button className="conversation-button primary" onClick={resource.reload}>
              Попробовать снова
            </button>
            <a className="conversation-button secondary" href={cardPath(groupId, conversationId)}>
              Текущий результат
            </a>
            <a className="conversation-button secondary" href="#/list">
              К диалогам
            </a>
          </div>
        </div>
      ) : !record ? (
        <div className="conversation-empty conversation-page-error">
          <h2>Диалог недоступен</h2>
          <p>Исходный диалог удалён, и сохранённого текста этой оценки нет.</p>
          <a className="conversation-button secondary" href="#/list">
            К диалогам
          </a>
        </div>
      ) : (
        <>
          {resource.error && (
            <div className="conversation-notice warning" role="status">
              Не удалось обновить оценку: {resource.error.message}. Показан последний загруженный
              результат.{' '}
              <button className="conversation-text-button" onClick={resource.reload}>
                Повторить
              </button>
            </div>
          )}
          <div className="conversation-mobile-tabs" role="tablist" aria-label="Панели карточки">
            <button
              role="tab"
              aria-selected={mobilePane === 'dialog'}
              aria-controls="conversation-dialog-panel"
              onClick={() => setMobilePane('dialog')}
            >
              Диалог <span>{record.transcript.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={mobilePane === 'evaluation'}
              aria-controls="conversation-evaluation-panel"
              onClick={() => setMobilePane('evaluation')}
            >
              Оценка{' '}
              <span>
                {evaluation?.final_result.total == null
                  ? '—'
                  : evaluation.final_result.total.toLocaleString('ru-RU')}
              </span>
            </button>
          </div>
          <div className={`conversation-workspace mobile-${mobilePane}`}>
            <div className="conversation-panel-slot dialog-slot" id="conversation-dialog-panel">
              <TranscriptPane
                groupId={groupId}
                conversationId={conversationId}
                record={record}
                evaluation={evaluation}
                focus={focus}
                visible={mobilePane === 'dialog' || wide}
                onEvidence={focusEvidence}
              />
            </div>
            <div
              className="conversation-panel-slot evaluation-slot"
              id="conversation-evaluation-panel"
            >
              <EvaluationPane
                evaluation={evaluation}
                history={history}
                record={record}
                checklistId={checklistId}
                groupId={groupId}
                conversationId={conversationId}
                evaluating={evaluating}
                onEvaluate={evaluate}
                onEvaluation={updateEvaluation}
                onEvidence={focusEvidence}
                notify={notify}
              />
            </div>
          </div>
        </>
      )}
      {clearOpen && (
        <ClearDialog
          count={relevant.length}
          appeals={relevant.reduce((sum, item) => sum + item.appeals_total, 0)}
          busy={clearing}
          error={clearError}
          onClose={() => setClearOpen(false)}
          onConfirm={clear}
        />
      )}
    </div>
  );
}
