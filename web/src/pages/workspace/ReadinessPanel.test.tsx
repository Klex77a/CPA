import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReadinessPanel from './ReadinessPanel';
import type { BenchmarkCoverage, BenchmarkStatus, Readiness } from '../../types';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api', () => ({ api: { get: mocks.get }, apiUrl: (path: string) => '/api' + path }));
const regression: BenchmarkStatus = {
  state: 'measured',
  message: 'Инженерный прогон сохранён.',
  case_count: 15,
  model: 'saved-model',
  metrics: {
    criterion_match: { rate: 119 / 120, matched: 119, total: 120 },
    by_language: {
      RU: { matched: 40, total: 40 },
      KZ: { matched: 40, total: 40 },
      EN: { matched: 39, total: 40 },
    },
    cases: { failed: 0, invalid: 0 },
    critical: { tp: 2, expected_positive: 2, fp: 0, unknown: 0 },
    timing: { p50_ms: 7657 },
    cost: { total_usd: 0.046211, complete: true },
  },
};
const coverage: BenchmarkCoverage = {
  cases: 39,
  labels: 312,
  languages: { RU: 13, KZ: 13, EN: 13 },
  channels: { 'agent chat': 36, 'voice call': 3 },
  label_distribution: {
    c04: { '0': 3, '5': 3, '10': 3, '15': 3, '20': 24, NA: 3 },
    c06: { '0': 3, '4': 3, '7': 3, '10': 30 },
  },
  critical_by_language: Object.fromEntries(
    ['RU', 'KZ', 'EN'].map((language) => [
      language,
      {
        positive: 3,
        negative: 10,
        types: { insult: 1, 'private-paid': 1, 'confidential-disclosure': 1 },
      },
    ]),
  ),
  source_turns: 414,
  max_source_turns: 81,
  measured: false,
};
const report = (benchmark: BenchmarkStatus = regression): Readiness => ({
  benchmark,
  submissions: [
    {
      split: 'dev',
      state: 'ready',
      path: 'results/dev/results.json',
      expected: 65,
      total: 65,
      ok: 65,
      errors: 0,
      message: 'Файл проверен.',
    },
  ],
  publication: { state: 'not_verified', message: 'Push проверяется отдельно.' },
  demo: { total_seconds: 300, steps: [] },
});
beforeEach(() => mocks.get.mockReset());
describe('readiness evidence', () => {
  it('keeps the raw 283/312 agreement visible with a disputed-reference warning and incomplete billing', async () => {
    const challenge: BenchmarkStatus = {
      ...regression,
      state: 'measured',
      quality_state: 'measured',
      runtime_state: 'matched',
      suite: 'challenge',
      case_count: 39,
      reference_review: {
        state: 'disputed',
        summary:
          'Часть инженерных меток требует предметного согласования; ошибка модели не доказана.',
        disputed_label_count: 21,
      },
      metrics: {
        ...regression.metrics!,
        criterion_match: { rate: 283 / 312, matched: 283, total: 312 },
        cases: { failed: 1, invalid: 0 },
        cost: {
          total_usd: null,
          known_total_usd: 0.123456,
          complete: false,
          unknown_call_count: 1,
        },
      },
    };
    mocks.get.mockResolvedValue({ ...report(), benchmarks: { regression, challenge } });
    render(<ReadinessPanel />);
    const section = await screen.findByRole('region', { name: 'Расширенные инженерные примеры' });
    expect(within(section).getByText('90,71')).toBeInTheDocument();
    expect(within(section).getByText(/283 из 312 ответов/)).toBeInTheDocument();
    expect(within(section).getByText('Эталон требует проверки')).toBeInTheDocument();
    expect(within(section).getByText(/не независимая точность модели/)).toBeInTheDocument();
    expect(within(section).getByText(/Меток на проверку: 21/)).toBeInTheDocument();
    expect(
      within(section).getByText(/не менее \$0.1235; полная стоимость неизвестна/),
    ).toBeInTheDocument();
    expect(within(section).getByText(/Ошибок обработки: 1/)).toBeInTheDocument();
    expect(within(section).queryByText(/\$0.0000/)).not.toBeInTheDocument();
  });
  it('retains measured engineering semantics from the legacy response while qualifying historical runtime', async () => {
    mocks.get.mockResolvedValue(report());
    render(<ReadinessPanel />);
    const section = await screen.findByRole('region', { name: 'Регрессионные примеры' });
    expect(within(section).getByText('99,17')).toBeInTheDocument();
    expect(within(section).getByText(/119 из 120 ответов/)).toBeInTheDocument();
    expect(within(section).getByText('Параметры выполнения не сверены')).toBeInTheDocument();
    expect(within(section).getByText(/не точность на DEV или PROD/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть ручную разметку →' })).toHaveAttribute(
      'href',
      '#/quality',
    );
  });
  it('shows a runtime change separately and presents challenge coverage without inventing measured accuracy', async () => {
    const saved = {
      ...regression,
      state: 'runtime_changed',
      quality_state: 'measured',
      runtime_state: 'changed',
      runtime: { state: 'changed', note: 'В HTTP-режиме другой тайм-аут и число попыток.' },
    };
    const challenge = {
      state: 'not_run',
      suite: 'challenge',
      quality_state: 'not_run',
      runtime_state: 'not_run',
      case_count: 39,
      message: 'Живой прогон расширенных примеров ещё не выполнен.',
      coverage,
    };
    mocks.get.mockResolvedValue({ ...report(saved), benchmarks: { regression: saved, challenge } });
    const user = userEvent.setup();
    render(<ReadinessPanel />);
    const historical = await screen.findByRole('region', { name: 'Регрессионные примеры' });
    expect(within(historical).getByText('99,17')).toBeInTheDocument();
    expect(within(historical).getByText('Параметры выполнения отличаются')).toBeInTheDocument();
    expect(
      within(historical).getByText(
        /не подтверждает время, стоимость и устойчивость текущего HTTP\/Vercel/,
      ),
    ).toBeInTheDocument();
    const expanded = screen.getByRole('region', { name: 'Расширенные инженерные примеры' });
    expect(within(expanded).getByText('Не измерено')).toBeInTheDocument();
    expect(within(expanded).getByText('39 примеров · 312 меток')).toBeInTheDocument();
    expect(within(expanded).getByText('KZ · 13 диалогов')).toBeInTheDocument();
    expect(within(expanded).getByText(/Грубые нарушения в эталоне: 9 случаев/)).toBeInTheDocument();
    await user.click(within(expanded).getByText('Покрытие подготовленного набора'));
    expect(
      within(expanded).getByText('Ступени консультации: 0 / 5 / 10 / 15 / 20 / N/A.'),
    ).toBeVisible();
    expect(within(expanded).getByText('Ступени ведения диалога: 0 / 4 / 7 / 10.')).toBeVisible();
    expect(within(expanded).queryByText(/% совпадений/)).not.toBeInTheDocument();
    expect(within(expanded).queryByText('100')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Экспертная проверка' })).toHaveTextContent(
      'Не подтверждена',
    );
  });
  it('does not present metrics of an unverified run as a measured success', async () => {
    const unverified = {
      ...regression,
      state: 'unverified_run',
      quality_state: 'unverified_run',
      message: 'Это не живой прогон.',
      metrics: { ...regression.metrics!, criterion_match: { rate: 1, matched: 120, total: 120 } },
    };
    mocks.get.mockResolvedValue(report(unverified));
    render(<ReadinessPanel />);
    const section = await screen.findByRole('region', { name: 'Регрессионные примеры' });
    expect(within(section).getByText('Прогон не подтверждён')).toBeInTheDocument();
    expect(within(section).queryByText('100')).not.toBeInTheDocument();
    expect(within(section).queryByText(/% совпадений/)).not.toBeInTheDocument();
  });
});
