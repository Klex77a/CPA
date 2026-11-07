import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import { Button, ErrorState, PageHeader, Spinner } from '../components/ui';
import type {
  Answer,
  Appeal,
  AppealEvaluation,
  CriterionDraft,
  TranscriptRecord,
} from './workspace/models';
import { cardHref, errorMessage, number } from './workspace/logic';
import { Empty, ScoreValue, SectionTitle, StatusTag } from './workspace/WorkspaceUi';

function answerText(criterion: CriterionDraft | undefined, answer: Answer) {
  return answer.answer === 'SCORE'
    ? `${number(answer.value)} баллов`
    : answer.answer === 'NA'
      ? 'N/A'
      : answer.answer === 'YES'
        ? criterion?.type === 'flag'
          ? 'Выявлено'
          : 'Да'
        : answer.answer === 'NO'
          ? criterion?.type === 'flag'
            ? 'Не выявлено'
            : 'Нет'
          : 'Нужна проверка';
}
function evidenceTurns(answer: Answer, record: TranscriptRecord | null) {
  const turns = new Set<number>();
  answer.evidence?.forEach((item) => {
    for (let index = item.msg - 2; index <= item.msg + 2; index++) turns.add(index);
  });
  for (const range of [answer.missing_range, answer.checked_range])
    if (range)
      for (let index = range.from; index <= range.to && turns.size < 40; index++) turns.add(index);
  return [...turns]
    .filter((index) => record && index >= 0 && index < record.transcript.length)
    .sort((a, b) => a - b);
}
function AppealDetail({ appeal, onSaved }: { appeal: Appeal; onSaved: () => void }) {
  const { notify } = useWorkspace();
  const { data, loading, error, reload } = useResource(`appeal:${appeal.id}`, async (signal) => {
    const evaluation = await api.get<AppealEvaluation>(
      `/evaluations/${encodeURIComponent(appeal.evaluation_id)}`,
      signal,
    );
    const record =
      evaluation.record_snapshot ||
      (evaluation.record_changed
        ? null
        : await api
            .get<TranscriptRecord>(
              `/datasets/${encodeURIComponent(appeal.group_id)}/${encodeURIComponent(appeal.conversation_id)}`,
              signal,
            )
            .catch(() => null));
    return { evaluation, record };
  });
  const [action, setAction] = useState<'confirm' | 'change'>('confirm'),
    [reason, setReason] = useState(''),
    [answer, setAnswer] = useState(
      appeal.disputed.answer === 'SCORE'
        ? `SCORE:${appeal.disputed.value}`
        : appeal.disputed.answer,
    ),
    [saving, setSaving] = useState(false),
    [formError, setFormError] = useState('');
  const criterion = data?.evaluation.checklist_snapshot.criteria.find(
    (item) => item.id === appeal.criterion_id,
  );
  const record = data?.record || null;
  const turns = evidenceTurns(appeal.disputed, record);
  const highlighted = new Set(appeal.disputed.evidence?.map((item) => item.msg));
  const href = cardHref(appeal.group_id, appeal.conversation_id, appeal.evaluation_id);
  const options =
    criterion?.type === 'scale'
      ? [
          ...(criterion.scale || []).map((step) => ({
            value: `SCORE:${step.value}`,
            label: `${step.value} — ${step.description}`,
          })),
          ...(criterion.na_allowed ? [{ value: 'NA', label: 'N/A' }] : []),
        ]
      : [
          { value: 'YES', label: criterion?.type === 'flag' ? 'Выявлено' : 'Да' },
          { value: 'NO', label: criterion?.type === 'flag' ? 'Не выявлено' : 'Нет' },
          ...(criterion?.na_allowed ? [{ value: 'NA', label: 'N/A' }] : []),
        ];
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!reason.trim()) {
      setFormError('Обоснуйте решение со ссылкой на диалог');
      return;
    }
    if (action === 'change' && !options.some((option) => option.value === answer)) {
      setFormError('Выберите допустимый ответ критерия');
      return;
    }
    setSaving(true);
    setFormError('');
    const [nextAnswer, value] = answer.split(':');
    try {
      await api.post(
        `/evaluations/${encodeURIComponent(appeal.evaluation_id)}/appeals/${encodeURIComponent(appeal.id)}/decision`,
        {
          action,
          reason: reason.trim(),
          reviewer: 'Проверяющий',
          ...(action === 'change'
            ? { answer: nextAnswer, value: value == null ? null : Number(value) }
            : {}),
        },
      );
      notify('Решение сохранено. Текущий итог обновлён.', 'success');
      onSaved();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="cqa-data-panel cqa-appeal-detail">
      <div className="cqa-appeal-detail-head">
        <div>
          <div className="cqa-inline-tags">
            <StatusTag tone={appeal.status === 'open' ? 'warning' : 'success'}>
              {appeal.status === 'open' ? 'Ожидает решения' : 'Решение сохранено'}
            </StatusTag>
            <span className="cqa-cell-muted">{appeal.group_id}</span>
          </div>
          <h2>{appeal.criterion_title || criterion?.title || appeal.criterion_id}</h2>
          <a className="cqa-id-link" href={href}>
            {appeal.conversation_id} ↗
          </a>
        </div>
        <div className="cqa-appeal-total">
          <span>Текущий итог</span>
          <ScoreValue value={appeal.final_total} />
        </div>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="cqa-workspace-loading">
          <Spinner />
        </div>
      ) : (
        data && (
          <>
            <div className="cqa-appeal-review-grid">
              <div className="cqa-appeal-position">
                <SectionTitle title="Оспариваемый ответ" />
                <div className="cqa-inline-tags">
                  <StatusTag tone={appeal.disputed.answer === 'INVALID' ? 'warning' : 'neutral'}>
                    {answerText(criterion, appeal.disputed)}
                  </StatusTag>
                  {appeal.disputed.points != null && (
                    <span>{number(appeal.disputed.points)} б.</span>
                  )}
                </div>
                <p>{appeal.disputed.explanation}</p>
                {appeal.disputed.na_reason && (
                  <p>
                    <strong>Причина N/A:</strong> {appeal.disputed.na_reason}
                  </p>
                )}
                <div className="cqa-evidence-links">
                  {appeal.disputed.evidence?.map((item, index) => (
                    <a key={index} href={`${href}?turn=${item.msg + 1}`}>
                      Реплика №{item.msg + 1}
                      {item.fragment && <span>«{item.fragment}»</span>}
                    </a>
                  ))}
                  {[appeal.disputed.missing_range, appeal.disputed.checked_range]
                    .filter(Boolean)
                    .map((range, index) => (
                      <a
                        key={`range-${index}`}
                        href={`${href}?turn=${range!.from + 1}&to=${range!.to + 1}`}
                      >
                        Проверенный участок №{range!.from + 1}–{range!.to + 1} ↗
                      </a>
                    ))}
                </div>
                <div className="cqa-applicant-comment">
                  <span>Комментарий заявителя</span>
                  <blockquote>{appeal.comment}</blockquote>
                </div>
                {data.evaluation.record_changed && (
                  <div className="cqa-inline-notice">
                    {record
                      ? 'Архивная оценка: показан сохранённый исходный текст.'
                      : 'Исходный текст изменился и не был сохранён. Сопоставить доказательства с текущими репликами нельзя.'}
                  </div>
                )}
              </div>
              <div className="cqa-appeal-proof">
                <SectionTitle
                  title="Фрагмент диалога"
                  description="Номера реплик учитывают все роли"
                />
                <div className="cqa-proof-turns">
                  {turns.length && record ? (
                    turns.map((index) => (
                      <a
                        href={`${href}?turn=${index + 1}`}
                        className={`cqa-proof-turn ${highlighted.has(index) ? 'is-highlighted' : ''}`}
                        key={index}
                      >
                        <div>
                          <StatusTag>№{index + 1}</StatusTag>
                          <strong>
                            {{
                              operator: 'Оператор',
                              client: 'Клиент',
                              bot: 'Бот',
                              system: 'Система',
                            }[record.transcript[index].speaker] || record.transcript[index].speaker}
                          </strong>
                        </div>
                        <p>{record.transcript[index].text}</p>
                      </a>
                    ))
                  ) : (
                    <p className="cqa-cell-muted">
                      Нет ссылок на реплики. Откройте карточку, чтобы увидеть весь диалог.
                    </p>
                  )}
                </div>
              </div>
            </div>
            {appeal.status === 'open' ? (
              <form className="cqa-appeal-decision" onSubmit={(event) => void submit(event)}>
                <SectionTitle
                  title="Решение проверяющего"
                  description="Причина сохраняется в истории оценки"
                />
                <div className="cqa-decision-options">
                  <label className={action === 'confirm' ? 'is-selected' : ''}>
                    <input
                      type="radio"
                      name="decision"
                      checked={action === 'confirm'}
                      onChange={() => setAction('confirm')}
                    />
                    <span>
                      <strong>Подтвердить</strong>
                      <small>Оставить исходную оценку</small>
                    </span>
                  </label>
                  <label className={action === 'change' ? 'is-selected' : ''}>
                    <input
                      type="radio"
                      name="decision"
                      checked={action === 'change'}
                      onChange={() => setAction('change')}
                    />
                    <span>
                      <strong>Изменить</strong>
                      <small>Выбрать значение по шкале</small>
                    </span>
                  </label>
                </div>
                {action === 'change' && (
                  <label className="cqa-field">
                    Новое значение
                    <select value={answer} onChange={(e) => setAnswer(e.target.value)} required>
                      <option value="" disabled>
                        Выберите ответ
                      </option>
                      {!options.some((option) => option.value === answer) && (
                        <option value={answer} disabled>
                          Выберите допустимый ответ
                        </option>
                      )}
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="cqa-field">
                  Обоснование решения
                  <textarea
                    value={reason}
                    required
                    maxLength={4000}
                    rows={3}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Объясните решение и укажите факты из диалога"
                  />
                </label>
                {formError && (
                  <p role="alert" className="cqa-form-error">
                    {formError}
                  </p>
                )}
                <div className="cqa-form-footer">
                  <span>Подтверждение сохранит балл, изменение пересчитает текущий итог.</span>
                  <Button type="submit" variant="primary" loading={saving}>
                    Сохранить решение
                  </Button>
                </div>
              </form>
            ) : (
              <div className="cqa-resolved-decision">
                <StatusTag tone="success">
                  {appeal.decision?.action === 'confirm'
                    ? 'Ответ подтверждён'
                    : `Ответ изменён: ${answerText(criterion, appeal.decision || { answer: 'INVALID' })}`}
                </StatusTag>
                <p>{appeal.decision?.reason}</p>
                <strong>
                  Текущий итог {number(appeal.decision?.total_before)} →{' '}
                  {number(appeal.decision?.total_after)}
                </strong>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
export default function AppealsPage() {
  const { refreshBase, notify } = useWorkspace();
  const {
    data: appeals,
    loading,
    error,
    reload,
  } = useResource<Appeal[]>('appeals', (signal) => api.get('/appeals', signal));
  const [status, setStatus] = useState('open'),
    [group, setGroup] = useState(''),
    [selectedId, setSelectedId] = useState('');
  const filtered = useMemo(
    () =>
      (appeals || []).filter(
        (appeal) =>
          (status === 'all' || appeal.status === status) && (!group || appeal.group_id === group),
      ),
    [appeals, status, group],
  );
  const selected = filtered.find((appeal) => appeal.id === selectedId) || filtered[0];
  useEffect(() => {
    if (selected) setSelectedId(selected.id);
  }, [selected?.id]);
  const open = appeals?.filter((appeal) => appeal.status === 'open').length || 0;
  return (
    <div className="cqa-workspace-page">
      <PageHeader
        title="Апелляции"
        subtitle="Необязательный пересмотр оценки: подтверждение или изменение с причиной"
      >
        <Button variant="secondary" onClick={reload}>
          Обновить
        </Button>
      </PageHeader>
      <div className="cqa-page-scroll cqa-workspace-content">
        <p className="cqa-cell-muted">
          Предварительная оценка доступна сразу. Если вы не согласны с критерием, подайте апелляцию;
          проверяющий подтвердит или изменит ответ с причиной.
        </p>
        <div className="cqa-appeals-toolbar">
          <div className="cqa-filter-chips">
            <button
              className={status === 'open' ? 'is-active' : ''}
              aria-pressed={status === 'open'}
              onClick={() => setStatus('open')}
            >
              Открытые <span>{open}</span>
            </button>
            <button
              className={status === 'resolved' ? 'is-active' : ''}
              aria-pressed={status === 'resolved'}
              onClick={() => setStatus('resolved')}
            >
              Рассмотренные <span>{(appeals?.length || 0) - open}</span>
            </button>
            <button
              className={status === 'all' ? 'is-active' : ''}
              aria-pressed={status === 'all'}
              onClick={() => setStatus('all')}
            >
              Все <span>{appeals?.length || 0}</span>
            </button>
          </div>
          <select
            aria-label="Набор апелляций"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">Все наборы</option>
            {[...new Set(appeals?.map((appeal) => appeal.group_id))].map((gid) => (
              <option key={gid} value={gid}>
                {gid}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !appeals ? (
          <div className="cqa-workspace-loading">
            <Spinner />
          </div>
        ) : !filtered.length ? (
          <section className="cqa-data-panel">
            <Empty title={open ? 'В этой очереди нет апелляций' : 'Открытых апелляций нет'}>
              <p>Спорную оценку можно отправить на пересмотр из карточки диалога.</p>
              <a className="cqa-action-link" href="#/list">
                К диалогам →
              </a>
            </Empty>
          </section>
        ) : (
          <div className="cqa-appeals-workbench">
            <aside className="cqa-appeals-queue" aria-label="Очередь апелляций">
              {filtered.map((appeal) => (
                <button
                  className={`cqa-appeal-queue-item ${appeal.id === selected?.id ? 'is-active' : ''}`}
                  key={appeal.id}
                  onClick={() => setSelectedId(appeal.id)}
                  aria-pressed={appeal.id === selected?.id}
                >
                  <div>
                    <strong>{appeal.conversation_id}</strong>
                    <span>{appeal.group_id}</span>
                  </div>
                  <p>{appeal.criterion_title || appeal.criterion_id}</p>
                  <small>
                    {new Date(appeal.created_at).toLocaleDateString('ru-RU')} ·{' '}
                    {appeal.status === 'open' ? 'Открыта' : 'Рассмотрена'}
                  </small>
                </button>
              ))}
            </aside>
            {selected && (
              <AppealDetail
                key={selected.id}
                appeal={selected}
                onSaved={() => {
                  reload();
                  void refreshBase().catch((cause) => notify(errorMessage(cause), 'error'));
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
