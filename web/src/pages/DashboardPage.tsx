import { api } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import { Button, ErrorState, PageHeader, Spinner } from '../components/ui';
import type { Analytics } from './workspace/models';
import { cardHref, number, operatorHref } from './workspace/logic';
import {
  DatasetControls,
  Empty,
  ProgressBar,
  ScoreValue,
  SectionTitle,
  Stat,
  StatusTag,
} from './workspace/WorkspaceUi';
import ReadinessPanel from './workspace/ReadinessPanel';

const languageName: Record<string, string> = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
export default function DashboardPage() {
  const { group, checklistId } = useWorkspace();
  const {
    data: a,
    loading,
    error,
    reload,
  } = useResource<Analytics | null>(`analytics:${group}:${checklistId}`, (signal) =>
    group
      ? api.get(
          '/analytics?' + new URLSearchParams({ group_id: group, checklist_id: checklistId }),
          signal,
        )
      : Promise.resolve(null),
  );
  const weakest = a?.criteria
    .filter((c) => c.rate != null)
    .sort((x, y) => (x.rate || 0) - (y.rate || 0))[0];
  const maxCount = Math.max(1, ...(a?.distribution.map((bucket) => bucket.count) || []));
  const heatCell = (value: number | null | undefined) => (
    <td
      className="cqa-heat-value"
      style={
        value == null
          ? undefined
          : {
              background: `hsl(151 48% ${96 - Math.min(100, value) * 0.58}%)`,
              color: value > 65 ? '#fff' : '#163f30',
            }
      }
      title={value == null ? 'Нет применимых диалогов' : `${number(value)}% выполнения`}
    >
      {value == null ? '—' : `${Math.round(value)}%`}
    </td>
  );
  return (
    <div className="cqa-workspace-page">
      <PageHeader
        title="Аналитика качества"
        subtitle="Где команда сильна и чему стоит уделить внимание"
      >
        <Button variant="secondary" onClick={reload}>
          Обновить
        </Button>
      </PageHeader>
      <div className="cqa-page-scroll cqa-workspace-content">
        <div className="cqa-analytics-toolbar">
          <DatasetControls />
          {a?.models.length ? <span className="cqa-cell-muted">{a.models.join(' · ')}</span> : null}
        </div>
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !a ? (
          <div className="cqa-workspace-loading">
            <Spinner />
          </div>
        ) : !a?.evaluated ? (
          <section className="cqa-data-panel">
            <Empty
              title={group ? 'Диалоги готовы к оценке' : 'Здесь появится картина качества команды'}
            >
              <p>Оцените набор, чтобы сравнить языки, каналы и результаты операторов.</p>
              <a className="cqa-action-link" href="#/list">
                Перейти к диалогам →
              </a>
            </Empty>
          </section>
        ) : (
          <>
            <div className="cqa-metrics cqa-metrics-five">
              <Stat
                label="Средний балл"
                value={<ScoreValue value={a.avg} />}
                detail={`Медиана ${number(a.median)} / 100`}
              />
              <Stat
                label="Оценено диалогов"
                value={a.evaluated}
                detail={`${Object.values(a.by_channel).reduce((sum, v) => sum + v.n, 0)} актуальных оценок`}
              />
              <Stat
                label="Грубые нарушения"
                value={a.gross_count}
                detail={
                  a.gross_unknown_count
                    ? `Ещё ${a.gross_unknown_count} требуют проверки`
                    : 'По проверенным флагам'
                }
                tone={a.gross_count || a.gross_unknown_count ? 'warning' : undefined}
              />
              <Stat
                label="Открытые апелляции"
                value={a.appeals_open}
                detail={`Всего ${a.appeals_total} · пересмотрено ${a.changed_by_appeal}`}
              />
              <Stat
                label="Стоимость оценки"
                value={`$${number(a.cost_usd, 4)}`}
                detail={`≈ $${number(a.cost_usd / a.evaluated, 4)} за диалог`}
              />
            </div>
            <div className="cqa-insight-panel">
              <div className="cqa-insight-mark" aria-hidden="true">
                ✦
              </div>
              <div>
                <strong>Фокус команды</strong>
                <p>
                  {weakest ? (
                    <>
                      Критерий «{weakest.title}» выполняется на <b>{number(weakest.rate)}%</b>.
                      Начните разбор с диалогов, где потеряны эти баллы.
                    </>
                  ) : (
                    'По применимым критериям данных пока недостаточно.'
                  )}
                </p>
                {a.gross_unknown_count > 0 && (
                  <p>В {a.gross_unknown_count} диалогах флаг грубых нарушений ещё не проверен.</p>
                )}
                {a.demo_count > 0 && (
                  <p>
                    <StatusTag tone="warning">Демо: {a.demo_count}</StatusTag> Переоцените эти
                    диалоги реальной моделью.
                  </p>
                )}
                {a.low_confidence > 0 && (
                  <p>Ответов с расхождениями между прогонами: {a.low_confidence}.</p>
                )}
              </div>
            </div>
            <div className="cqa-analytics-grid">
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Распределение баллов"
                  description="Количество диалогов по итоговой оценке"
                />
                <div
                  className="cqa-distribution"
                  role="img"
                  aria-label={a.distribution.map((b) => `${b.from}–${b.to}: ${b.count}`).join('; ')}
                >
                  {a.distribution.map((bucket, index) => (
                    <div className="cqa-distribution-column" key={bucket.from}>
                      <strong>{bucket.count}</strong>
                      <div className="cqa-distribution-track">
                        <i
                          className={
                            bucket.from >= 80 ? 'is-good' : bucket.from >= 60 ? 'is-mid' : 'is-low'
                          }
                          style={{
                            height: `${(bucket.count / maxCount) * 100}%`,
                            minHeight: bucket.count ? 4 : 0,
                          }}
                        />
                      </div>
                      <span>{index === 0 ? '<50' : `${bucket.from}–${Math.round(bucket.to)}`}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Языки и каналы"
                  description="Средний балл и объём оценённых диалогов"
                />
                <div className="cqa-segment-list">
                  {Object.entries(a.by_language).map(([key, value]) => (
                    <div className="cqa-segment" key={key}>
                      <span>
                        {languageName[key] || key}
                        <small>{value.n} диалогов</small>
                      </span>
                      <ProgressBar value={value.avg || 0} label={`${key}, средний балл`} />
                      <b>{number(value.avg)}</b>
                    </div>
                  ))}
                  <div className="cqa-chart-divider" />
                  {Object.entries(a.by_channel).map(([key, value]) => (
                    <div className="cqa-segment" key={key}>
                      <span>
                        {key === 'voice call' ? 'Звонки' : 'Чаты'}
                        <small>{value.n} диалогов</small>
                      </span>
                      <ProgressBar value={value.avg || 0} label={`${key}, средний балл`} />
                      <b>{number(value.avg)}</b>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <section className="cqa-data-panel">
              <SectionTitle
                title="Где теряются баллы"
                description="Доля набранных баллов среди применимых диалогов. N/A исключается из расчёта."
              />
              <div className="cqa-workspace-table-wrap">
                <table className="cqa-workspace-table cqa-heatmap">
                  <thead>
                    <tr>
                      <th>Критерий</th>
                      <th>Все языки</th>
                      {a.languages.map((language) => (
                        <th key={language}>{language}</th>
                      ))}
                      <th>N/A</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.criteria.map((criterion) => (
                      <tr key={criterion.id}>
                        <td>
                          <span className="cqa-criterion-code">
                            {criterion.code || criterion.id}
                          </span>
                          {criterion.title}
                        </td>
                        {heatCell(criterion.rate)}
                        {a.languages.map((language) => (
                          <td
                            key={language}
                            className="cqa-heat-value"
                            style={
                              criterion.by_language?.[language] == null
                                ? undefined
                                : {
                                    background: `hsl(151 48% ${96 - (criterion.by_language[language] || 0) * 0.58}%)`,
                                    color:
                                      (criterion.by_language[language] || 0) > 65
                                        ? '#fff'
                                        : '#163f30',
                                  }
                            }
                          >
                            {criterion.by_language?.[language] == null
                              ? '—'
                              : `${Math.round(criterion.by_language[language] || 0)}%`}
                          </td>
                        ))}
                        <td className="cqa-numeric cqa-cell-muted">{criterion.na}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="cqa-analytics-grid">
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Результаты операторов"
                  description="Откройте профиль для сравнения с командой"
                />
                <div className="cqa-ranking">
                  {a.operators
                    .filter((operator) => !operator.unnamed)
                    .map((operator, index) => (
                      <a
                        className="cqa-ranking-row"
                        key={operator.name}
                        href={operatorHref(group, operator.name)}
                      >
                        <span className="cqa-ranking-place">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span>
                          <strong>{operator.name}</strong>
                          <small>
                            {operator.dialogs} диалогов · {operator.languages.join(', ')}
                            {operator.gross ? ` · нарушений: ${operator.gross}` : ''}
                          </small>
                          {operator.weakest && <small>Зона роста: {operator.weakest.title}</small>}
                        </span>
                        <ScoreValue value={operator.avg} />
                        <span aria-hidden="true">↗</span>
                      </a>
                    ))}
                  {!a.operators.some((operator) => !operator.unnamed) && (
                    <p className="cqa-cell-muted">В этих диалогах имена операторов не найдены.</p>
                  )}
                  {a.operators
                    .filter((operator) => operator.unnamed)
                    .map((operator) => (
                      <a
                        className="cqa-unnamed-row"
                        key={operator.name}
                        href={operatorHref(group, operator.name)}
                      >
                        Не представились: {operator.dialogs} диалогов · средний балл{' '}
                        {number(operator.avg)}
                      </a>
                    ))}
                </div>
              </section>
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Требуют внимания"
                  description="Начните с нарушений и низких результатов"
                />
                {a.gross.length > 0 && (
                  <div className="cqa-risk-group">
                    <h3>Грубые нарушения</h3>
                    {a.gross.map((item) => (
                      <a
                        className="cqa-risk-row"
                        key={item.eval_id}
                        href={cardHref(group, item.conversation_id, item.eval_id)}
                      >
                        <StatusTag tone="danger">!</StatusTag>
                        <span>
                          <strong>{item.conversation_id}</strong>
                          <small>{item.operator || 'Оператор не представился'}</small>
                          <p>{item.explanation}</p>
                        </span>
                        <span aria-hidden="true">→</span>
                      </a>
                    ))}
                  </div>
                )}
                <div className="cqa-risk-group">
                  <h3>Низкие оценки</h3>
                  {a.worst.map((item) => (
                    <a
                      className="cqa-risk-row"
                      key={item.eval_id}
                      href={cardHref(group, item.conversation_id, item.eval_id)}
                    >
                      <ScoreValue value={item.total} />
                      <span>
                        <strong>{item.conversation_id}</strong>
                        <small>{item.operator || 'Оператор не представился'}</small>
                        <p>{item.summary}</p>
                      </span>
                      <span aria-hidden="true">→</span>
                    </a>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
        <ReadinessPanel />
      </div>
    </div>
  );
}
