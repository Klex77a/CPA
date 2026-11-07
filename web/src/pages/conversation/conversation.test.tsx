import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Appeal, Conversation, Evaluation, EvaluationSummary } from '../../types';
import EvaluationPane from './EvaluationPane';
import TranscriptPane from './TranscriptPane';
import {
  assessmentStage,
  criterionAssessment,
  grossStatus,
  hashEvidence,
  scrollMessage,
  shownRecord,
  timestamp,
} from './helpers';

const record: Conversation = {
  conversation_id: 'test-dialog',
  channel: 'voice call',
  language: 'ru',
  audio_url: 'https://example.org/private.mp3',
  transcript: [
    {
      speaker: 'client',
      timestamp: '2026-11-08T10:20:30Z',
      text: 'Здравствуйте, уточните статус заявки.',
    },
    {
      speaker: 'operator',
      timestamp: '2026-11-08T10:20:32Z',
      text: 'Заявка принята. Я уточню срок ответа.',
    },
  ],
  audio_segments: [
    { start: 0, end: 2 },
    { start: 2, end: 5 },
  ],
};
const checklist = {
  id: 'default',
  name: 'Качество чата',
  version: 1,
  rounding: 2,
  sections: [],
  criteria: [
    {
      id: 'contact',
      code: '01',
      title: 'Установление контакта',
      type: 'binary' as const,
      weight: 100,
      na_allowed: false,
      description: 'Приветствие клиента',
    },
    {
      id: 'privacy',
      code: '02',
      title: 'Раскрытие данных',
      type: 'flag' as const,
      weight: 0,
      na_allowed: false,
      description: 'Проверка безопасности',
    },
  ],
};
const score = {
  total: 0,
  total_exact: 0,
  applicable_weight: 100,
  earned_weight: 0,
  redistribution_factor: 1,
  gross_error: false,
  gross_error_criteria: [],
  invalid_criteria: [],
  sections: [],
  criteria: [
    {
      id: 'contact',
      type: 'binary' as const,
      answer: 'NO' as const,
      value: null,
      weight: 100,
      section: null,
      scored: true,
      raw: 0,
      points: 0,
      contribution: 0,
      max_contribution: 100,
      effective_weight: 100,
    },
    {
      id: 'privacy',
      type: 'flag' as const,
      answer: 'NO' as const,
      value: null,
      weight: 0,
      section: null,
      scored: false,
      raw: 0,
      points: null,
      contribution: null,
      max_contribution: 0,
      effective_weight: 0,
    },
  ],
};
function makeEvaluation(): Evaluation {
  return {
    id: 'eval-1',
    conversation_id: record.conversation_id,
    group_id: 'DEV',
    channel: record.channel,
    language: record.language,
    checklist,
    checklist_snapshot: checklist,
    provider: 'deepseek',
    model: 'test',
    created_at: '2026-11-08T10:20:40Z',
    status: 'ok',
    criteria: {
      contact: { answer: 'NO', explanation: 'Не представился.', evidence: [{ msg: 1 }] },
      privacy: {
        answer: 'NO',
        explanation: 'Данные не раскрыты.',
        evidence: [],
        checked_range: { from: 0, to: 1 },
      },
    },
    final_criteria: {
      contact: { answer: 'NO', explanation: 'Не представился.', evidence: [{ msg: 1 }] },
      privacy: {
        answer: 'NO',
        explanation: 'Данные не раскрыты.',
        evidence: [],
        checked_range: { from: 0, to: 1 },
      },
    },
    original_result: score,
    final_result: score,
    summary: 'Сводка оценки.',
    coaching: [
      { criterion_id: 'contact', type: 'required', text: 'Представляйтесь при начале диалога.' },
    ],
    appeals: [],
    validation_errors: [],
    duration_ms: 100,
    cost_usd: 0.001,
    usage: { input: 100, output: 100, thoughts: 0 },
  };
}
const history: EvaluationSummary[] = [
  {
    id: 'eval-1',
    conversation_id: record.conversation_id,
    group_id: 'DEV',
    channel: record.channel,
    language: record.language,
    checklist,
    created_at: '2026-11-08T10:20:40Z',
    provider: 'deepseek',
    model: 'test',
    status: 'ok',
    original_total: 0,
    final_total: 0,
    gross_error: false,
    gross_error_unknown: false,
    appeals_open: 0,
    appeals_total: 0,
  },
];

function appeal(criterionId: string, action?: 'confirm' | 'change'): Appeal {
  return {
    id: `appeal-${criterionId}-${action || 'open'}`,
    criterion_id: criterionId,
    comment: 'Прошу пересмотреть конкретный критерий.',
    status: action ? 'resolved' : 'open',
    created_at: '2026-11-08T10:21:00Z',
    disputed: { answer: 'NO', explanation: 'Исходный ответ ИИ.', evidence: [{ msg: 1 }] },
    ...(action
      ? {
          decision: {
            action,
            answer: action === 'change' ? ('YES' as const) : null,
            value: null,
            reason: 'Рассмотрены указанные реплики.',
            reviewer: 'Проверяющий',
            decided_at: '2026-11-08T10:22:00Z',
            total_before: 0,
            total_after: 0,
          },
        }
      : {}),
  };
}

describe('conversation evidence and freshness', () => {
  it('derives review stage from appeals rather than a changed total and gives open appeals precedence', () => {
    const confirmed = appeal('contact', 'confirm');
    expect(assessmentStage([])).toMatchObject({
      id: 'preliminary',
      label: 'Предварительная оценка ИИ',
    });
    expect(assessmentStage([confirmed])).toMatchObject({
      id: 'reviewed',
      label: 'Результат после пересмотра',
      reviewedCriterionCount: 1,
    });
    expect(assessmentStage([confirmed, appeal('privacy')])).toMatchObject({
      id: 'contested',
      label: 'Оценка оспаривается',
      openCount: 1,
    });
    expect(criterionAssessment([confirmed], 'privacy').id).toBe('preliminary');
  });
  it('keeps unresolved flags unknown, including validation issues', () => {
    const evaluation = makeEvaluation();
    expect(grossStatus(evaluation)).toBe('clear');
    evaluation.final_criteria.privacy.issues = ['Источник не подтверждён'];
    expect(grossStatus(evaluation)).toBe('unknown');
    evaluation.final_criteria.privacy.issues = [];
    evaluation.final_criteria.privacy.answer = 'INVALID';
    expect(grossStatus(evaluation)).toBe('unknown');
  });

  it('selects the archived source rather than attaching old evidence to new messages', () => {
    const evaluation = makeEvaluation();
    evaluation.record_changed = true;
    evaluation.record_snapshot = {
      ...record,
      transcript: [{ speaker: 'operator', timestamp: 0, text: 'Архивный текст' }],
    };
    expect(shownRecord(record, evaluation)?.transcript[0].text).toBe('Архивный текст');
    expect(timestamp(0)).toBe('0');
    expect(timestamp('2026-11-08T10:20:30Z')).toBe('10:20:30');
  });

  it('uses shareable one-based turn links and rejects malformed positions', () => {
    expect(hashEvidence('#/card/DEV/id/eval?turn=2&to=5')).toMatchObject({
      msg: 1,
      range: { from: 1, to: 4 },
    });
    expect(hashEvidence('#/card/DEV/id?turn=-1')).toBeNull();
    expect(hashEvidence('#/card/DEV/id?turn=1.5')).toBeNull();
  });

  it('scrolls only the transcript container', () => {
    const container = document.createElement('div');
    const message = document.createElement('div');
    container.scrollTop = 100;
    Object.defineProperty(container, 'clientHeight', { value: 400 });
    container.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    message.getBoundingClientRect = () => ({ top: 550, height: 100 }) as DOMRect;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    const scrollIntoView = vi.fn();
    message.scrollIntoView = scrollIntoView;
    scrollMessage(container, message);
    expect(scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'smooth' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('React conversation panels', () => {
  function evaluationProps(evaluation = makeEvaluation()) {
    return {
      evaluation,
      history,
      record,
      groupId: 'DEV',
      conversationId: record.conversation_id,
      checklistId: 'default',
      evaluating: false,
      onEvaluate: vi.fn(),
      onEvaluation: vi.fn(),
      onEvidence: vi.fn(),
      notify: vi.fn(),
    };
  }

  it('presents an unappealed score as an AI proposal and explains how to contest a criterion', () => {
    const { container } = render(<EvaluationPane {...evaluationProps()} />);
    expect(screen.getByLabelText('Предварительная оценка ИИ: 0 из 100')).toBeInTheDocument();
    const summary = container.querySelector('.conversation-score-description') as HTMLElement;
    expect(
      within(summary).getByText(/ИИ может ошибаться.*Оспорьте конкретный критерий/),
    ).toBeVisible();
    expect(container.querySelector('.conversation-score-ring span')).toHaveTextContent('из 100');
    expect(container.querySelector('.conversation-score-ring')).not.toHaveTextContent('финальный');
  });

  it('shows a confirmed criterion as reviewed even when its answer and total stay unchanged', () => {
    const evaluation = makeEvaluation();
    evaluation.appeals = [appeal('contact', 'confirm')];
    const snapshots = structuredClone({
      original: evaluation.original_result,
      final: evaluation.final_result,
      criteria: evaluation.criteria,
    });
    const { container } = render(<EvaluationPane {...evaluationProps(evaluation)} />);
    expect(screen.getByLabelText('Результат после пересмотра: 0 из 100')).toBeInTheDocument();
    const cards = container.querySelectorAll('.conversation-criterion');
    expect(within(cards[0] as HTMLElement).getByText('Рассмотрено проверяющим')).toBeVisible();
    expect(within(cards[1] as HTMLElement).getByText('Предложение ИИ')).toBeVisible();
    expect(
      within(cards[0] as HTMLElement).getByText(/Проверяющий подтвердил ответ по этому критерию/),
    ).toBeVisible();
    const summary = container.querySelector('.conversation-score-description') as HTMLElement;
    expect(
      within(summary).getByText(/Рассмотрено критериев: 1 из 2.*Баллы сохранены/),
    ).toBeVisible();
    const printed = container.querySelector('.conversation-print-report') as HTMLElement;
    expect(within(printed).getByText('Результат после пересмотра')).toBeInTheDocument();
    expect(
      within(printed).getByText('Рассмотрено проверяющим: ответ подтверждён.'),
    ).toBeInTheDocument();
    expect({
      original: evaluation.original_result,
      final: evaluation.final_result,
      criteria: evaluation.criteria,
    }).toEqual(snapshots);
  });

  it('keeps the overall score contested while another criterion already has a decision', () => {
    const evaluation = makeEvaluation();
    evaluation.appeals = [appeal('contact', 'confirm'), appeal('privacy')];
    const { container } = render(<EvaluationPane {...evaluationProps(evaluation)} />);
    expect(screen.getByLabelText('Оценка оспаривается: 0 из 100')).toBeInTheDocument();
    const cards = container.querySelectorAll('.conversation-criterion');
    expect(within(cards[0] as HTMLElement).getByText('Рассмотрено проверяющим')).toBeVisible();
    expect(within(cards[1] as HTMLElement).getByText('Оспаривается')).toBeVisible();
    const printed = container.querySelector('.conversation-print-report') as HTMLElement;
    expect(within(printed).getByText('Оценка оспаривается')).toBeInTheDocument();
    expect(within(printed).getByText(/Рассмотрено критериев: 1 из 2/)).toBeInTheDocument();
  });

  it('updates an open appeal to confirmed review from the server response without changing the score', () => {
    const pending = makeEvaluation();
    pending.appeals = [appeal('contact')];
    const view = render(<EvaluationPane {...evaluationProps(pending)} />);
    expect(screen.getByLabelText('Оценка оспаривается: 0 из 100')).toBeInTheDocument();
    const confirmed = structuredClone(pending);
    confirmed.appeals = [appeal('contact', 'confirm')];
    view.rerender(<EvaluationPane {...evaluationProps(confirmed)} />);
    expect(screen.getByLabelText('Результат после пересмотра: 0 из 100')).toBeInTheDocument();
    const criterion = view.container.querySelector('.conversation-criterion') as HTMLElement;
    expect(
      within(criterion).getByText(/Проверяющий подтвердил ответ по этому критерию/),
    ).toBeVisible();
    expect(within(criterion).queryByText('На рассмотрении')).not.toBeInTheDocument();
    expect(confirmed.final_result.total).toBe(pending.final_result.total);
    expect(view.container.querySelector('.conversation-score-ring span')).toHaveTextContent(
      'из 100',
    );
    const printed = view.container.querySelector('.conversation-print-report') as HTMLElement;
    expect(
      within(printed).getByText('Рассмотрено проверяющим: ответ подтверждён.'),
    ).toBeInTheDocument();
  });

  it('marks a changed zero-weight flag as reviewed without requiring the numeric score to change', () => {
    const evaluation = makeEvaluation();
    evaluation.appeals = [appeal('privacy', 'change')];
    Object.assign(evaluation.final_criteria.privacy, {
      answer: 'YES',
      changed_by_appeal: 'appeal-privacy-change',
      reviewer_reason: 'Рассмотрены указанные реплики.',
    });
    evaluation.final_result = { ...score, gross_error: true, gross_error_criteria: ['privacy'] };
    const { container } = render(<EvaluationPane {...evaluationProps(evaluation)} />);
    expect(screen.getByLabelText('Результат после пересмотра: 0 из 100')).toBeInTheDocument();
    expect(container.querySelector('.conversation-score-ring span')).toHaveTextContent('из 100');
    expect(
      within(container.querySelectorAll('.conversation-criterion')[1] as HTMLElement).getByText(
        'Рассмотрено проверяющим',
      ),
    ).toBeVisible();
  });

  it('opens criteria first and shows coaching on its own tab', () => {
    render(<EvaluationPane {...evaluationProps()} />);
    expect(screen.getByRole('tab', { name: /Критерии/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getByText('Не представился.')).toBeInTheDocument();
    expect(
      within(screen.getByRole('tabpanel')).queryByText('Представляйтесь при начале диалога.'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Рекомендации/ }));
    expect(
      within(screen.getByRole('tabpanel')).getByText('Представляйтесь при начале диалога.'),
    ).toBeInTheDocument();
  });
  it('shows unknown billing and observed lower bounds without fabricating zero usage', () => {
    const evaluation = makeEvaluation();
    evaluation.usage = null;
    evaluation.cost_usd = null;
    evaluation.billing_complete = false;
    evaluation.unknown_call_count = 1;
    evaluation.known_cost_usd = 0.01234;
    evaluation.known_usage = { input: 100, output: 200, thoughts: 50 };
    const { container } = render(<EvaluationPane {...evaluationProps(evaluation)} />);
    const method = container.querySelector('.conversation-method') as HTMLElement;
    fireEvent.click(within(method).getByText('Как рассчитан результат'));
    expect(
      within(method).getByText(/не менее \$0.0123; полная стоимость неизвестна/),
    ).toBeVisible();
    expect(
      within(method).getByText(/Токены \(учтённый минимум\): 100 вход \/ 200 выход/),
    ).toBeVisible();
    expect(within(method).queryByText(/Токены: 0 вход \/ 0 выход/)).not.toBeInTheDocument();
  });

  it('keeps the full print report independent of the active result tab', () => {
    const { container } = render(<EvaluationPane {...evaluationProps()} />);
    fireEvent.click(screen.getByRole('tab', { name: /История/ }));
    const printReport = container.querySelector('.conversation-print-report') as HTMLElement;
    expect(printReport).toHaveAttribute('aria-hidden', 'true');
    expect(within(printReport).getByText('01. Установление контакта')).toBeInTheDocument();
    expect(within(printReport).getByText(/Представляйтесь при начале диалога/)).toBeInTheDocument();
    expect(within(printReport).getByText(/№2. Оператор: Заявка принята/)).toBeInTheDocument();
  });

  it('quotes the source and passes its real message index on evidence clicks', () => {
    const props = evaluationProps();
    props.evaluation.final_criteria.contact.evidence[0].fragment = '<img src=x onerror=alert(1)>';
    render(<EvaluationPane {...props} />);
    const evidence = screen.getByRole('button', { name: /№2.*Заявка принята/ });
    fireEvent.click(evidence);
    expect(props.onEvidence).toHaveBeenCalledWith(1, undefined, undefined);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('<img src=x onerror=alert(1)>')).not.toBeInTheDocument();
  });

  it('blocks old evidence navigation when no source snapshot was saved', () => {
    const evaluation = makeEvaluation();
    evaluation.record_changed = true;
    const props = evaluationProps(evaluation);
    render(<EvaluationPane {...props} />);
    expect(screen.queryByRole('button', { name: /№2.*Заявка принята/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/переход к текущим репликам отключён/).length).toBeGreaterThan(0);
  });

  it('loads audio through the protected endpoint and preserves raw timestamp tooltips', () => {
    const { container } = render(
      <TranscriptPane
        groupId="DEV"
        conversationId="test-dialog"
        record={record}
        evaluation={null}
        focus={null}
        visible
        onEvidence={vi.fn()}
      />,
    );
    expect(container.querySelector('audio')).toHaveAttribute('src', '/api/audio/DEV/test-dialog');
    expect(screen.getByText('10:20:30')).toHaveAttribute('title', '2026-11-08T10:20:30Z');
    expect(screen.getByText('Дорожки участников')).toBeInTheDocument();
  });

  it('disables embedded audio for an archived evaluation and filters the transcript', async () => {
    const evaluation = makeEvaluation();
    evaluation.record_changed = true;
    evaluation.record_snapshot = record;
    const { container } = render(
      <TranscriptPane
        groupId="DEV"
        conversationId="test-dialog"
        record={record}
        evaluation={evaluation}
        focus={null}
        visible
        onEvidence={vi.fn()}
      />,
    );
    expect(container.querySelector('audio')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Открыть исходную запись/ })).toHaveAttribute(
      'href',
      record.audio_url,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Найти в диалоге' }), {
      target: { value: 'уточните' },
    });
    await waitFor(() =>
      expect(screen.queryByText('Заявка принята. Я уточню срок ответа.')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Показано 1 из 2')).toBeInTheDocument();
  });
});
