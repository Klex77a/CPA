import { api, apiUrl } from '../../api';
import { useResource } from '../../hooks';
import { Button, ErrorState, Spinner } from '../../components/ui';
import type { Readiness } from './models';
import { number } from './logic';
import { SectionTitle, StatusTag } from './WorkspaceUi';

export default function ReadinessPanel() {
  const {
    data: report,
    error,
    loading,
    reload,
  } = useResource<Readiness>('readiness', (signal) => api.get('/readiness', signal));
  const metrics = report?.benchmark.metrics;
  return (
    <section className="cqa-data-panel cqa-readiness-panel">
      <SectionTitle
        title="Качество и готовность к сдаче"
        description="Проверка контрольных примеров и итоговых файлов"
      >
        <a className="cqa-text-link" href={apiUrl('/demo-guide')}>
          План защиты ↓
        </a>
      </SectionTitle>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !report ? (
        <div className="cqa-workspace-loading">
          <Spinner />
        </div>
      ) : (
        report && (
          <>
            <div className="cqa-readiness-columns">
              <div>
                <div className="cqa-inline-between">
                  <h3>Контрольные примеры</h3>
                  <StatusTag tone={report.benchmark.state === 'measured' ? 'success' : 'warning'}>
                    {report.benchmark.state === 'measured' ? 'Измерено' : 'Нужна проверка'}
                  </StatusTag>
                </div>
                {report.benchmark.state === 'measured' && metrics ? (
                  <>
                    <div className="cqa-benchmark-number">
                      {number(100 * metrics.criterion_match.rate)}
                      <small>% совпадений</small>
                    </div>
                    <p className="cqa-cell-muted">
                      {metrics.criterion_match.matched} из {metrics.criterion_match.total} ответов ·{' '}
                      {report.benchmark.case_count} примеров
                    </p>
                    <div className="cqa-inline-tags">
                      {Object.entries(metrics.by_language).map(([language, value]) => (
                        <StatusTag key={language}>
                          {language} · {value.matched}/{value.total}
                        </StatusTag>
                      ))}
                    </div>
                    <p className="cqa-cell-muted">
                      Ошибок обработки: {metrics.cases.failed}. Требуют проверки:{' '}
                      {metrics.cases.invalid}. Грубые нарушения: {metrics.critical.tp}/
                      {metrics.critical.expected_positive}, ложных срабатываний{' '}
                      {metrics.critical.fp}, неопределённых {metrics.critical.unknown}.
                    </p>
                    <p className="cqa-cell-muted">
                      {report.benchmark.model} · медиана{' '}
                      {number(metrics.timing.p50_ms == null ? null : metrics.timing.p50_ms / 1000)}{' '}
                      с · ${metrics.cost.total_usd.toFixed(4)}
                      {metrics.cost.complete ? '' : ' (неполные данные)'}
                    </p>
                  </>
                ) : (
                  <p>{report.benchmark.message}</p>
                )}
                <p className="cqa-method-note">
                  Синтетическая инженерная разметка. Она не заменяет независимую экспертную проверку
                  и не измеряет точность на всём DEV.
                </p>
                {metrics && (
                  <a className="cqa-text-link" href={apiUrl('/benchmark/report')}>
                    Отчёт с расхождениями ↓
                  </a>
                )}
              </div>
              <div>
                <h3>Файлы результатов</h3>
                {report.submissions.map((item) => (
                  <div className="cqa-submission-row" key={item.split}>
                    <div className="cqa-inline-between">
                      <strong>{item.split.toUpperCase()}</strong>
                      <StatusTag
                        tone={
                          item.state === 'ready'
                            ? 'success'
                            : item.state === 'waiting_dataset'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {item.state === 'ready'
                          ? `${item.ok}/${item.expected} готово`
                          : item.state === 'waiting_dataset'
                            ? 'Ожидается набор'
                            : 'Нужна проверка'}
                      </StatusTag>
                    </div>
                    <p>{item.message}</p>
                    <code>{item.path}</code>
                  </div>
                ))}
                <p className="cqa-method-note">{report.publication.message}</p>
              </div>
            </div>
            <details className="cqa-demo-details">
              <summary>Сценарий защиты · {report.demo.total_seconds / 60} минут</summary>
              <ol>
                {report.demo.steps.map((step, index) => (
                  <li key={index}>
                    <strong>
                      {step.seconds / 60} мин · {step.title}
                    </strong>
                    <p>{step.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          </>
        )
      )}
    </section>
  );
}
