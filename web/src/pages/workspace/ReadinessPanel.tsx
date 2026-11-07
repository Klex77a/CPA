import { api, apiUrl } from '../../api';
import { useResource } from '../../hooks';
import { ErrorState, Spinner } from '../../components/ui';
import { costDescription } from '../../format';
import type { BenchmarkCoverage, BenchmarkStatus, Readiness } from '../../types';
import { number } from './logic';
import { SectionTitle, StatusTag } from './WorkspaceUi';

function Coverage({ coverage }: { coverage: BenchmarkCoverage }) {
  const positive = Object.values(coverage.critical_by_language || {}).reduce(
    (sum, row) => sum + row.positive,
    0,
  );
  const steps = (criterion: string) =>
    Object.keys(coverage.label_distribution?.[criterion] || {})
      .filter((value) => (coverage.label_distribution?.[criterion]?.[value] || 0) > 0)
      .sort((a, b) => (a === 'NA' ? 1 : b === 'NA' ? -1 : Number(a) - Number(b)))
      .map((value) => (value === 'NA' ? 'N/A' : value))
      .join(' / ');
  return (
    <div className="cqa-benchmark-coverage">
      <p>
        <strong>
          {coverage.cases} примеров · {coverage.labels} меток
        </strong>
      </p>
      <div className="cqa-inline-tags">
        {Object.entries(coverage.languages).map(([language, count]) => (
          <StatusTag key={language}>
            {language} · {count} диалогов
          </StatusTag>
        ))}
      </div>
      {coverage.critical_by_language && (
        <p>
          Грубые нарушения в эталоне: {positive} случаев (
          {Object.entries(coverage.critical_by_language)
            .map(([language, row]) => `${language}: ${row.positive}`)
            .join(' · ')}
          ).
        </p>
      )}
      <details>
        <summary>Покрытие подготовленного набора</summary>
        {steps('c04') && <p>Ступени консультации: {steps('c04')}.</p>}
        {steps('c06') && <p>Ступени ведения диалога: {steps('c06')}.</p>}
        {coverage.critical_by_language &&
          Object.entries(coverage.critical_by_language).map(([language, row]) => (
            <p key={language}>
              {language}:{' '}
              {Object.entries(row.types)
                .map(
                  ([kind, count]) =>
                    `${({ insult: 'оскорбление', 'private-paid': 'частная платная услуга', 'confidential-disclosure': 'разглашение данных' } as Record<string, string>)[kind] || kind} — ${count}`,
                )
                .join('; ')}
              .
            </p>
          ))}
        {coverage.source_turns != null && (
          <p>
            Всего реплик: {coverage.source_turns}; максимум в диалоге:{' '}
            {coverage.max_source_turns ?? '—'}.
          </p>
        )}
        {!!coverage.channels?.['voice call'] && (
          <p>
            Канал «звонок»: {coverage.channels['voice call']} транскрипта. Наличие этого канала в
            эталоне не подтверждает проверку аудио.
          </p>
        )}
      </details>
      <p className="cqa-method-note">Это состав эталонов, а не измеренный результат модели.</p>
    </div>
  );
}
function BenchmarkCard({
  title,
  status,
  download,
}: {
  title: string;
  status: BenchmarkStatus;
  download?: string;
}) {
  const measured = (status.quality_state ?? status.state) === 'measured';
  const disputed = status.reference_review?.state === 'disputed';
  const metrics = status.metrics;
  const runtime =
    status.runtime_state ??
    status.runtime?.state ??
    (status.state === 'runtime_changed' ? 'changed' : 'unverified');
  const labels: Record<string, string> = {
    not_run: 'Не измерено',
    stale: 'Отчёт устарел',
    blocked: 'Отчёт повреждён',
    unverified_run: 'Прогон не подтверждён',
  };
  return (
    <section
      className={`cqa-benchmark-card ${disputed ? 'cqa-benchmark-disputed' : ''}`}
      aria-label={title}
    >
      <div className="cqa-inline-between">
        <h3>{title}</h3>
        <StatusTag tone={measured && !disputed ? 'success' : 'warning'}>
          {disputed
            ? 'Эталон требует проверки'
            : measured
              ? 'Измерено на эталонах'
              : labels[status.quality_state ?? status.state] || 'Нужна проверка'}
        </StatusTag>
      </div>
      {disputed && (
        <div className="cqa-inline-notice" role="note">
          <div>
            <strong>Расхождения требуют проверки инженерных меток</strong>
            <p>
              {status.reference_review?.summary ||
                'Часть эталонных ответов оспаривается. Эти расхождения нельзя автоматически считать ошибками модели.'}
            </p>
            <p>
              Ниже сохранено сырое совпадение с исходной разметкой. Это не независимая точность
              модели.
              {status.reference_review?.disputed_label_count != null
                ? ` Меток на проверку: ${status.reference_review.disputed_label_count}.`
                : ''}
            </p>
          </div>
        </div>
      )}
      {measured && metrics ? (
        <>
          <div className="cqa-benchmark-number">
            {metrics.criterion_match.rate == null
              ? '—'
              : number(100 * metrics.criterion_match.rate, 2)}
            <small>
              {disputed ? '% сырых совпадений с инженерными метками' : '% совпадений с эталонами'}
            </small>
          </div>
          <p className="cqa-cell-muted">
            {metrics.criterion_match.matched} из {metrics.criterion_match.total} ответов ·{' '}
            {status.case_count} примеров
          </p>
          <div className="cqa-inline-tags">
            {Object.entries(metrics.by_language).map(([language, value]) => (
              <StatusTag key={language}>
                {language} · {value.matched}/{value.total}
              </StatusTag>
            ))}
          </div>
          <p className="cqa-cell-muted">
            Ошибок обработки: {metrics.cases.failed}. Требуют проверки: {metrics.cases.invalid}.
            Грубые нарушения: {metrics.critical.tp}/{metrics.critical.expected_positive}, ложных
            срабатываний {metrics.critical.fp}, неопределённых {metrics.critical.unknown}.
          </p>
          <p className="cqa-cell-muted">
            Исторический прогон: {status.model} · медиана{' '}
            {number(metrics.timing.p50_ms == null ? null : metrics.timing.p50_ms / 1000)} с ·{' '}
            {costDescription({
              cost_usd: metrics.cost.total_usd,
              known_cost_usd: metrics.cost.known_total_usd,
              billing_complete: metrics.cost.complete,
              unknown_call_count: metrics.cost.unknown_call_count,
            })}
          </p>
          {runtime !== 'matched' && (
            <div className="cqa-inline-notice" role="note">
              <div>
                <strong>
                  {runtime === 'changed'
                    ? 'Параметры выполнения отличаются'
                    : 'Параметры выполнения не сверены'}
                </strong>
                <p>
                  Исторический CLI-прогон не подтверждает время, стоимость и устойчивость текущего
                  HTTP/Vercel-режима.
                </p>
                {status.runtime?.note && <p>{status.runtime.note}</p>}
              </div>
            </div>
          )}
        </>
      ) : (
        <p>{status.message}</p>
      )}
      {status.coverage && <Coverage coverage={status.coverage} />}
      <p className="cqa-method-note">
        Синтетическая инженерная разметка. Это не независимая экспертная проверка и не точность на
        DEV или PROD.
      </p>
      {metrics && download && (
        <a className="cqa-text-link" href={download}>
          Отчёт с расхождениями ↓
        </a>
      )}
    </section>
  );
}
export default function ReadinessPanel() {
  const {
    data: report,
    error,
    loading,
    reload,
  } = useResource<Readiness>('readiness', (signal) => api.get('/readiness', signal));
  const regression = report?.benchmarks?.regression || report?.benchmark;
  const challenge = report?.benchmarks?.challenge;
  return (
    <section className="cqa-data-panel cqa-readiness-panel">
      <SectionTitle
        title="Результаты и апелляции"
        description="Предварительная оценка ИИ, необязательный пересмотр и итоговые файлы"
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
                <section aria-label="Порядок оценки">
                  <h3>От оценки ИИ к текущему результату</h3>
                  <ol className="cqa-assessment-flow">
                    <li>
                      <strong>Предварительная оценка ИИ</strong>
                      <p>Модель предлагает ответы по критериям, баллы и реплики-доказательства.</p>
                    </li>
                    <li>
                      <strong>Апелляция при несогласии</strong>
                      <p>
                        Это необязательный шаг: выберите критерий и объясните, что вызывает
                        сомнение.
                      </p>
                    </li>
                    <li>
                      <strong>Решение в приложении</strong>
                      <p>
                        Проверяющий подтверждает или изменяет оспариваемый ответ с причиной. Текущий
                        итог пересчитывается, история сохраняется.
                      </p>
                    </li>
                  </ol>
                  <p>
                    Предварительная оценка доступна сразу. Если вы не согласны с критерием, подайте
                    апелляцию; проверяющий подтвердит или изменит ответ с причиной.
                  </p>
                  <a className="cqa-text-link" href="#/appeals">
                    Открыть апелляции →
                  </a>
                </section>
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
            <details className="cqa-algorithm-diagnostics">
              <summary>Диагностика алгоритма</summary>
              <div className="cqa-algorithm-diagnostics-body">
                <p className="cqa-method-note">
                  Технические измерения помогают улучшать алгоритм и не добавляют обязательного
                  этапа к обработке диалога.
                </p>
                {regression && (
                  <BenchmarkCard
                    title="Регрессионные примеры"
                    status={regression}
                    download={apiUrl('/benchmark/report')}
                  />
                )}
                <BenchmarkCard
                  title="Расширенные инженерные примеры"
                  status={
                    challenge || {
                      state: 'not_run',
                      quality_state: 'not_run',
                      message: 'Расширенный набор пока не измерен.',
                    }
                  }
                />
              </div>
            </details>
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
