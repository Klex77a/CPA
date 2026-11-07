import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUrl } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import {
  evaluateWithRequest,
  evaluationActionLabel,
  useEvaluationRequests,
} from '../evaluationRequests';
import { Button, ErrorState, Modal, PageHeader, Spinner } from '../components/ui';
import {
  cardHref,
  errorMessage,
  filterRows,
  listRows,
  matchesQuick,
  number,
  operatorHref,
  quickFilters,
  sortRows,
} from './workspace/logic';
import type { DatasetList, Filters, Row } from './workspace/models';
import {
  CriticalTag,
  DatasetControls,
  Empty,
  ScoreValue,
  Stat,
  StatusTag,
} from './workspace/WorkspaceUi';

const initialFilters: Filters = {
  query: '',
  channel: '',
  language: '',
  quick: 'all',
  sort: 'id',
  direction: 1,
};
export default function ConversationsPage() {
  const {
    config,
    group,
    setGroup,
    checklistId,
    datasets,
    refreshBase,
    notify,
    setConversationOrder,
    checklists,
    queue,
    evaluationRevision,
  } = useWorkspace();
  const evaluationRequests = useEvaluationRequests();
  const resource = useResource<DatasetList | null>(`list:${group}`, (signal) =>
    group ? api.get(`/datasets/${encodeURIComponent(group)}`, signal) : Promise.resolve(null),
  );
  const [filters, setFilters] = useState(initialFilters);
  const [showImport, setShowImport] = useState(false),
    [showExport, setShowExport] = useState(false);
  const [importId, setImportId] = useState(group || 'DEV'),
    [importing, setImporting] = useState(false),
    [force, setForce] = useState(false);
  const [team, setTeam] = useState(
    () => localStorage.getItem('cqa.teamName')?.replace(/^"|"$/g, '') || 'Midnight Commit',
  );
  const [split, setSplit] = useState(/prod/i.test(group) ? 'prod' : 'dev'),
    [exporting, setExporting] = useState(false),
    [exportStatus, setExportStatus] = useState('');
  const [busyRows, setBusyRows] = useState<Set<string>>(new Set());
  const [clearRow, setClearRow] = useState<Row | null>(null),
    [clearing, setClearing] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importLock = useRef(false);
  const lastRevision = useRef(evaluationRevision);
  useEffect(() => {
    if (lastRevision.current !== evaluationRevision) resource.reload();
    lastRevision.current = evaluationRevision;
  }, [evaluationRevision, resource.reload]);
  const checklistVersion = checklists.find((checklist) => checklist.id === checklistId)?.version;
  const rows = useMemo(
    () => listRows(resource.data?.records || [], checklistId, checklistVersion),
    [resource.data, checklistId, checklistVersion],
  );
  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const shown = useMemo(() => sortRows(filtered, filters), [filtered, filters]);
  const ids = shown.map((r) => r.record.conversation_id).join('\u0000');
  useEffect(() => {
    setConversationOrder({ groupId: group, ids: ids ? ids.split('\u0000') : [] });
  }, [group, ids, setConversationOrder]);
  useEffect(() => {
    setSplit(/prod/i.test(group) ? 'prod' : 'dev');
    setImportId(group || 'DEV');
  }, [group]);
  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));
  const done = rows.filter((row) => row.evaluation?.final_total != null);
  const mean = done.length
    ? done.reduce((sum, row) => sum + (row.evaluation?.final_total || 0), 0) / done.length
    : null;
  async function importData(kind: 'api' | 'file' | 'sample', file?: File) {
    if (importLock.current) return;
    const gid = kind === 'sample' ? 'SAMPLE' : importId.trim();
    if (!gid) {
      notify('Укажите ID набора данных', 'error');
      return;
    }
    if (file && file.size > 20 * 1024 * 1024) {
      notify('JSON-файл должен быть меньше 20 МБ', 'error');
      return;
    }
    importLock.current = true;
    setImporting(true);
    try {
      if (kind === 'api') await api.post('/datasets/fetch', { group_id: gid });
      else if (kind === 'file' && file)
        await api.post('/datasets/upload', {
          group_id: gid,
          payload: JSON.parse(await file.text()),
        });
      else if (kind === 'sample' && !datasets.some((d) => d.group_id === 'SAMPLE')) {
        const response = await fetch(apiUrl('/').replace(/\/api\/$/, '') + '/demo-sample.json');
        if (!response.ok) throw new Error('Не удалось открыть пример');
        await api.post('/datasets/upload', { group_id: gid, payload: await response.json() });
      }
      await refreshBase();
      setGroup(gid);
      resource.reload();
      setShowImport(false);
      notify(`Набор ${gid} готов к работе`, 'success');
    } catch (cause) {
      notify(errorMessage(cause), 'error');
    } finally {
      importLock.current = false;
      setImporting(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  }
  async function evaluate(row: Row) {
    const cid = row.record.conversation_id;
    if (busyRows.has(cid)) return;
    setBusyRows((previous) => new Set(previous).add(cid));
    try {
      await evaluateWithRequest({
        group_id: group,
        conversation_id: cid,
        checklist_id: checklistId,
        force: !!row.evaluation || !!row.failure,
      });
      resource.reload();
      notify(`Диалог ${cid} оценён`, 'success');
    } catch (cause) {
      resource.reload();
      notify(errorMessage(cause), 'error');
    } finally {
      setBusyRows((previous) => {
        const next = new Set(previous);
        next.delete(cid);
        return next;
      });
    }
  }
  async function clearResult() {
    if (!clearRow || clearing) return;
    setClearing(true);
    try {
      await api.delete(
        '/evaluations?' +
          new URLSearchParams({
            group_id: group,
            conversation_id: clearRow.record.conversation_id,
            checklist_id: checklistId,
          }),
      );
      resource.reload();
      await refreshBase();
      setClearRow(null);
      notify('Оценки и связанные апелляции удалены', 'success');
    } catch (cause) {
      notify(errorMessage(cause), 'error');
    } finally {
      setClearing(false);
    }
  }
  async function exportJson() {
    if (!team.trim()) {
      setExportStatus('Укажите название команды');
      return;
    }
    setExporting(true);
    setExportStatus('');
    try {
      const results = await api.get<{ results: { status: string }[] }>(
        '/export.json?' +
          new URLSearchParams({
            group_id: group,
            checklist_id: checklistId,
            team_name: team.trim(),
            split,
          }),
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(results, null, 2) + '\n'], {
          type: 'application/json;charset=utf-8',
        }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'results.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const ok = results.results.filter((result) => result.status === 'ok').length,
        errors = results.results.length - ok;
      setExportStatus(
        `Скачано: ${ok} успешных оценок, ${errors} ошибок без балла.${errors ? ' Проверьте ошибки перед сдачей.' : ''}`,
      );
      localStorage.setItem('cqa.teamName', JSON.stringify(team.trim()));
      notify('results.json скачан', 'success');
    } catch (cause) {
      setExportStatus(errorMessage(cause));
    } finally {
      setExporting(false);
    }
  }
  const sortHeading = (label: string, key: string) => (
    <th
      aria-sort={
        filters.sort === key ? (filters.direction === 1 ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        className="cqa-table-sort"
        onClick={() =>
          update({ sort: key, direction: filters.sort === key ? -filters.direction : 1 })
        }
      >
        {label}
        <span aria-hidden="true">
          {filters.sort === key ? (filters.direction === 1 ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
  return (
    <div className="cqa-workspace-page">
      <PageHeader title="Диалоги" subtitle="Оценка качества общения с опорой на факты">
        <Button variant="secondary" onClick={() => setShowImport(true)}>
          Загрузить данные
        </Button>
        <Button variant="primary" disabled={!group} onClick={() => setShowExport(true)}>
          Экспорт результатов
        </Button>
      </PageHeader>
      <div className="cqa-page-scroll cqa-workspace-content">
        {config.provider === 'mock' && (
          <div className="cqa-inline-notice">
            <StatusTag tone="warning">Демо</StatusTag>
            <span>
              Оценки построены по правилам без ИИ. Для сдачи нужен прогон реальной модели.
            </span>
          </div>
        )}
        <div className="cqa-list-toolbar">
          <DatasetControls />
          <div className="cqa-evaluation-actions">
            <label className="cqa-checkbox-label">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Переоценить готовые
            </label>
            <Button
              variant="primary"
              loading={queue.starting}
              disabled={!rows.length || queue.running}
              onClick={() => void queue.start(group, checklistId, force)}
            >
              {queue.running ? 'Оценка идёт…' : 'Оценить набор'}
            </Button>
          </div>
        </div>
        <div className="cqa-metrics cqa-metrics-four">
          <Stat
            label="Всего диалогов"
            value={rows.length}
            detail={`${rows.filter((r) => r.record.channel === 'voice call').length} звонков · ${rows.filter((r) => r.record.channel !== 'voice call').length} чатов`}
          />
          <Stat
            label="Оценено"
            value={
              <>
                {rows.filter((r) => r.evaluation).length}
                <small> / {rows.length}</small>
              </>
            }
            detail="По выбранному чек-листу"
          />
          <Stat
            label="Средний балл"
            value={<ScoreValue value={mean} />}
            detail="Из 100 возможных"
          />
          <Stat
            label="Требуют внимания"
            value={
              rows.filter(
                (r) =>
                  r.failure ||
                  (r.evaluation &&
                    (r.evaluation.gross_error ||
                      r.evaluation.gross_error_unknown ||
                      r.evaluation.status === 'needs_review' ||
                      r.evaluation.appeals_open)),
              ).length
            }
            detail={`${rows.filter((r) => r.evaluation?.appeals_open).length} с открытыми апелляциями`}
            tone="warning"
          />
        </div>
        <section className="cqa-data-panel">
          <div className="cqa-list-filters">
            <div className="cqa-filter-inputs">
              <label className="cqa-search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  placeholder="Найти диалог или оператора"
                  aria-label="Поиск по диалогам"
                  value={filters.query}
                  onChange={(e) => update({ query: e.target.value })}
                />
              </label>
              <select
                aria-label="Канал"
                value={filters.channel}
                onChange={(e) => update({ channel: e.target.value })}
              >
                <option value="">Все каналы</option>
                <option value="agent chat">Чаты</option>
                <option value="voice call">Звонки</option>
              </select>
              <select
                aria-label="Язык"
                value={filters.language}
                onChange={(e) => update({ language: e.target.value })}
              >
                <option value="">Все языки</option>
                <option value="RU">Русский</option>
                <option value="KZ">Казахский</option>
                <option value="EN">Английский</option>
              </select>
              <Button variant="ghost" onClick={() => setFilters(initialFilters)}>
                Сбросить
              </Button>
            </div>
            <div className="cqa-filter-chips">
              {quickFilters.map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={filters.quick === key}
                  className={filters.quick === key ? 'is-active' : ''}
                  onClick={() => update({ quick: key })}
                >
                  {label}
                  <span>{filtered.filter((row) => matchesQuick(row, key)).length}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="cqa-table-caption">
            <strong>{group ? `Набор ${group}` : 'Рабочее пространство'}</strong>
            <span role="status">
              {shown.length} из {rows.length}
            </span>
            {group && (
              <a
                className="cqa-text-link"
                href={apiUrl(
                  '/export.csv?' +
                    new URLSearchParams({ group_id: group, checklist_id: checklistId }),
                )}
              >
                Скачать CSV ↓
              </a>
            )}
            <Button size="sm" variant="ghost" onClick={resource.reload}>
              Обновить
            </Button>
          </div>
          {resource.error ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : resource.loading && !resource.data ? (
            <div className="cqa-workspace-loading">
              <Spinner />
            </div>
          ) : !group ? (
            <Empty title="Начните с первого диалога">
              <p>Загрузите JSON, получите набор из API или откройте готовый пример.</p>
              <Button
                variant="primary"
                loading={importing}
                onClick={() => void importData('sample')}
              >
                Открыть пример
              </Button>
            </Empty>
          ) : !shown.length ? (
            <Empty title={rows.length ? 'Диалоги не найдены' : 'В наборе пока нет диалогов'}>
              <p>
                {rows.length
                  ? 'Измените фильтры или очистите поиск.'
                  : 'Добавьте данные через кнопку «Загрузить данные».'}
              </p>
            </Empty>
          ) : (
            <div className="cqa-workspace-table-wrap">
              <table className="cqa-workspace-table cqa-dialog-table">
                <thead>
                  <tr>
                    {sortHeading('Диалог', 'id')}
                    {sortHeading('Оператор', 'operator')}
                    <th>Канал / язык</th>
                    {sortHeading('Реплик', 'messages')}
                    {sortHeading('Балл', 'total')}
                    <th>Грубая ошибка</th>
                    <th>Статус</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const { record: r, evaluation: e, history, failure } = row;
                    const pendingRequest = evaluationRequests.get({
                      group_id: group,
                      conversation_id: r.conversation_id,
                      checklist_id: checklistId,
                    });
                    return (
                      <tr key={r.conversation_id}>
                        <td>
                          <a className="cqa-id-link" href={cardHref(group, r.conversation_id)}>
                            {r.conversation_id}
                          </a>
                          {r.has_audio && <small className="cqa-cell-sub">С аудиозаписью</small>}
                        </td>
                        <td>
                          {e?.operator_name ? (
                            <a
                              className="cqa-operator-link"
                              href={operatorHref(group, e.operator_name)}
                            >
                              <span className="cqa-small-avatar">
                                {e.operator_name.slice(0, 1)}
                              </span>
                              {e.operator_name}
                            </a>
                          ) : (
                            <span className="cqa-cell-muted">{e ? 'Не представился' : '—'}</span>
                          )}
                        </td>
                        <td>
                          <span>{r.channel === 'voice call' ? 'Звонок' : 'Чат'}</span>
                          <small className="cqa-cell-sub">{r.language}</small>
                        </td>
                        <td className="cqa-numeric">{r.messages}</td>
                        <td className="cqa-numeric">
                          {e ? (
                            <>
                              <ScoreValue value={e.final_total} />
                              {(failure || pendingRequest) && (
                                <small className="cqa-cell-sub">
                                  {failure ? 'Предыдущий результат' : 'Сохранённый результат'}
                                </small>
                              )}
                              {e.final_total !== e.original_total && (
                                <small className="cqa-cell-sub">
                                  было {number(e.original_total)}
                                </small>
                              )}
                              {e.provider === 'mock' && (
                                <small className="cqa-cell-sub">демо</small>
                              )}
                            </>
                          ) : failure || pendingRequest ? (
                            <span className="cqa-cell-muted">—</span>
                          ) : (
                            <StatusTag tone={history.length ? 'warning' : 'neutral'}>
                              {history.length ? 'Устарела' : 'Не оценён'}
                            </StatusTag>
                          )}
                        </td>
                        <td>
                          {e ? (
                            <CriticalTag gross={e.gross_error} unknown={e.gross_error_unknown} />
                          ) : (
                            <span className="cqa-cell-muted">—</span>
                          )}
                        </td>
                        <td>
                          {pendingRequest ? (
                            <>
                              <StatusTag tone="warning">
                                {pendingRequest.state === 'uncertain'
                                  ? 'Нужна новая попытка'
                                  : 'Результат не подтверждён'}
                              </StatusTag>
                              <p className="cqa-request-notice-text">{pendingRequest.message}</p>
                            </>
                          ) : failure ? (
                            <>
                              <StatusTag tone="danger">
                                {e ? 'Ошибка повторной оценки' : 'Ошибка оценки'}
                              </StatusTag>
                              <details className="cqa-failure-note">
                                <summary>Причина ошибки</summary>
                                <p>{failure.reason}</p>
                                <small>
                                  {new Date(failure.created_at).toLocaleString('ru-RU')}
                                </small>
                              </details>
                            </>
                          ) : e?.appeals_open ? (
                            <StatusTag tone="warning">Апелляций: {e.appeals_open}</StatusTag>
                          ) : e?.status === 'needs_review' ? (
                            <StatusTag tone="warning">Проверить</StatusTag>
                          ) : e ? (
                            <StatusTag tone="success">Готово</StatusTag>
                          ) : (
                            <span className="cqa-cell-muted">Ожидает</span>
                          )}
                        </td>
                        <td>
                          <div className="cqa-row-actions">
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={busyRows.has(r.conversation_id)}
                              disabled={queue.running || queue.starting}
                              onClick={() => void evaluate(row)}
                            >
                              {evaluationActionLabel(
                                pendingRequest,
                                failure ? 'Повторить оценку' : e ? 'Переоценить' : 'Оценить',
                              )}
                            </Button>
                            {history.length > 0 && (
                              <button
                                className="cqa-icon-action"
                                aria-label={`Очистить оценки ${r.conversation_id}`}
                                title="Очистить оценки"
                                onClick={() => setClearRow(row)}
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {showImport && (
        <Modal title="Загрузить диалоги" onClose={() => !importing && setShowImport(false)}>
          <div className="cqa-modal-form">
            <label className="cqa-field">
              ID набора
              <input
                value={importId}
                onChange={(e) => setImportId(e.target.value)}
                placeholder="Например, DEV"
                maxLength={120}
              />
            </label>
            <p className="cqa-cell-muted">
              JSON дополняет выбранный набор. Диалоги с совпадающим ID обновляются.
            </p>
            <div className="cqa-modal-actions-grid">
              <Button
                variant="primary"
                loading={importing}
                disabled={!config.data_api_configured}
                onClick={() => void importData('api')}
              >
                Получить из API
              </Button>
              <Button
                variant="secondary"
                disabled={importing}
                onClick={() => uploadRef.current?.click()}
              >
                Выбрать JSON
              </Button>
            </div>
            {!config.data_api_configured && (
              <p className="cqa-cell-muted">API данных не настроен. Используйте JSON или пример.</p>
            )}
            <input
              ref={uploadRef}
              hidden
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importData('file', file);
              }}
            />
            <div className="cqa-modal-divider" />
            <Button variant="ghost" disabled={importing} onClick={() => void importData('sample')}>
              Открыть пример · 4 диалога
            </Button>
          </div>
        </Modal>
      )}
      {showExport && (
        <Modal
          title="Результаты для сдачи"
          onClose={() => setShowExport(false)}
          footer={
            <Button variant="primary" loading={exporting} onClick={() => void exportJson()}>
              Скачать results.json
            </Button>
          }
        >
          <div className="cqa-modal-form">
            <p>
              JSON 1.0 по формату организаторов. Нужен полный набор: 65 диалогов DEV или 10 PROD.
            </p>
            <label className="cqa-field">
              Название команды
              <input
                required
                maxLength={120}
                value={team}
                onChange={(e) => setTeam(e.target.value)}
              />
            </label>
            <label className="cqa-field">
              Набор для сдачи
              <select value={split} onChange={(e) => setSplit(e.target.value)}>
                <option value="dev">DEV · 65 диалогов</option>
                <option value="prod">PROD · 10 диалогов</option>
              </select>
            </label>
            <div className="cqa-submission-destination">
              <span>Сохраните файл в репозитории</span>
              <code>results/{split}/results.json</code>
            </div>
            <p className="cqa-cell-muted">
              Ошибки обработки сохраняются отдельными записями без балла. Демо-оценки для сдачи не
              подходят. После сохранения выполните commit и push.
            </p>
            {exportStatus && (
              <div role="status" className="cqa-inline-notice">
                {exportStatus}
              </div>
            )}
          </div>
        </Modal>
      )}
      {clearRow && (
        <Modal
          title="Очистить оценки диалога?"
          onClose={() => !clearing && setClearRow(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setClearRow(null)} disabled={clearing}>
                Отмена
              </Button>
              <Button variant="danger" loading={clearing} onClick={() => void clearResult()}>
                Удалить оценки
              </Button>
            </>
          }
        >
          <p>
            Диалог <strong>{clearRow.record.conversation_id}</strong> останется в наборе. Будут
            удалены все его оценки по выбранному чек-листу ({clearRow.history.length}) и связанные
            апелляции.
          </p>
        </Modal>
      )}
    </div>
  );
}
