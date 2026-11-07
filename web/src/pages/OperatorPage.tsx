import { api } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import { Button, ErrorState, PageHeader, Spinner } from '../components/ui';
import type { Analytics } from './workspace/models';
import { cardHref, number } from './workspace/logic';
import { CriticalTag, Empty, ScoreValue, SectionTitle, Stat } from './workspace/WorkspaceUi';

export default function OperatorPage({
  groupId,
  operatorName,
}: {
  groupId: string;
  operatorName: string;
}) {
  const { checklistId } = useWorkspace();
  const {
    data: a,
    loading,
    error,
    reload,
  } = useResource<Analytics>(`operator:${groupId}:${checklistId}`, (signal) =>
    api.get(
      '/analytics?' + new URLSearchParams({ group_id: groupId, checklist_id: checklistId }),
      signal,
    ),
  );
  const operator = a?.operators.find((item) => item.name === operatorName);
  const difference = (value: number | null | undefined, base: number | null | undefined) =>
    value == null || base == null ? '—' : `${value - base > 0 ? '+' : ''}${number(value - base)}`;
  return (
    <div className="cqa-workspace-page">
      <PageHeader title={operatorName} subtitle={`Профиль оператора · набор ${groupId}`}>
        <Button
          variant="secondary"
          onClick={() => {
            location.hash = '/dashboard';
          }}
        >
          ← К аналитике
        </Button>
      </PageHeader>
      <div className="cqa-page-scroll cqa-workspace-content">
        {error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : loading && !a ? (
          <div className="cqa-workspace-loading">
            <Spinner />
          </div>
        ) : !operator ? (
          <section className="cqa-data-panel">
            <Empty title="Оценки оператора не найдены">
              <p>Выберите другой набор или чек-лист в аналитике.</p>
            </Empty>
          </section>
        ) : (
          <>
            <div className="cqa-metrics cqa-metrics-four">
              <Stat
                label="Средний балл"
                value={<ScoreValue value={operator.avg} />}
                detail={`${difference(operator.avg, a?.avg)} к среднему команды`}
              />
              <Stat
                label="Диалогов"
                value={operator.dialogs}
                detail={operator.languages.join(' · ')}
              />
              <Stat
                label="Грубые нарушения"
                value={operator.gross}
                detail={
                  operator.gross_unknown
                    ? `Ещё ${operator.gross_unknown} требуют проверки`
                    : 'По проверенным флагам'
                }
                tone={operator.gross || operator.gross_unknown ? 'warning' : undefined}
              />
              <Stat
                label="Минимальный балл"
                value={<ScoreValue value={operator.min} />}
                detail="Среди оценённых диалогов"
              />
            </div>
            <div className="cqa-analytics-grid">
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Критерии и команда"
                  description="От слабых критериев к сильным"
                />
                <div className="cqa-workspace-table-wrap">
                  <table className="cqa-workspace-table">
                    <thead>
                      <tr>
                        <th>Критерий</th>
                        <th>Оператор</th>
                        <th>Команда</th>
                        <th>Разница</th>
                      </tr>
                    </thead>
                    <tbody>
                      {operator.criteria
                        .slice()
                        .sort((x, y) => (x.rate ?? 101) - (y.rate ?? 101))
                        .map((criterion) => {
                          const team = a?.criteria.find((c) => c.id === criterion.id)?.rate;
                          return (
                            <tr key={criterion.id}>
                              <td>{criterion.title}</td>
                              <td className="cqa-numeric">
                                {number(criterion.rate)}
                                {criterion.rate == null ? '' : '%'}
                              </td>
                              <td className="cqa-numeric cqa-cell-muted">
                                {number(team)}
                                {team == null ? '' : '%'}
                              </td>
                              <td className="cqa-numeric">{difference(criterion.rate, team)}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="cqa-data-panel">
                <SectionTitle
                  title="Что улучшить"
                  description="Обязательные рекомендации по диалогам"
                />
                {operator.coaching.length ? (
                  operator.coaching.map((item, index) => (
                    <div className="cqa-coaching-item" key={index}>
                      <a href={cardHref(groupId, item.conversation_id)}>{item.conversation_id} ↗</a>
                      <h3>
                        {operator.criteria.find((c) => c.id === item.criterion_id)?.title ||
                          item.criterion_id}
                      </h3>
                      <p>{item.text}</p>
                    </div>
                  ))
                ) : (
                  <Empty title="Обязательных рекомендаций нет" />
                )}
              </section>
            </div>
            <section className="cqa-data-panel">
              <SectionTitle
                title="Диалоги оператора"
                description="Сначала показаны диалоги с низкими баллами"
              />
              <div className="cqa-workspace-table-wrap">
                <table className="cqa-workspace-table">
                  <thead>
                    <tr>
                      <th>Диалог</th>
                      <th>Канал</th>
                      <th>Язык</th>
                      <th>Балл</th>
                      <th>Грубая ошибка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operator.conversations
                      .slice()
                      .sort((x, y) => (x.total ?? 101) - (y.total ?? 101))
                      .map((item) => (
                        <tr key={item.id}>
                          <td>
                            <a
                              className="cqa-id-link"
                              href={cardHref(groupId, item.id, item.eval_id)}
                            >
                              {item.id}
                            </a>
                          </td>
                          <td>{item.channel === 'voice call' ? 'Звонок' : 'Чат'}</td>
                          <td>{item.language}</td>
                          <td>
                            <ScoreValue value={item.total} />
                          </td>
                          <td>
                            <CriticalTag gross={item.gross} unknown={item.gross_unknown} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
