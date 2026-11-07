import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import type { Conversation, Evaluation, EvaluationSummary } from '../../types';
import ConversationPage from '../ConversationPage';

const workspace = vi.hoisted(() => ({
  group: 'DEV',
  checklistId: 'default',
  evaluationRevision: 0,
  checklists: [{ id: 'default', name: 'Проверка', version: 1 }],
  conversationOrder: null,
  setChecklistId: vi.fn(),
  setGroup: vi.fn(),
  notify: vi.fn(),
  refreshBase: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../Workspace', () => ({ useWorkspace: () => workspace }));

const record: Conversation = {
  conversation_id: 'refresh-case',
  channel: 'voice call',
  language: 'RU',
  audio_url: 'https://example.org/synthetic.mp3',
  transcript: [{ speaker: 'operator', timestamp: '00:01', text: 'Здравствуйте, мой ответ.' }],
  audio_segments: [{ start: 1, end: 60 }],
};
const criterion = {
  id: 'c01',
  title: 'Контакт',
  type: 'binary' as const,
  weight: 100,
  na_allowed: false,
  description: 'Правило',
};
const checklist = {
  id: 'default',
  name: 'Проверка',
  version: 1,
  rounding: 2,
  criteria: [criterion],
  sections: [],
};
function evaluation(id = 'new-evaluation', total = 80): Evaluation {
  const answer = { answer: 'YES' as const, explanation: 'Ответ проверен.', evidence: [{ msg: 0 }] };
  const score = {
    total,
    total_exact: total,
    applicable_weight: 100,
    earned_weight: total,
    redistribution_factor: 1,
    gross_error: false,
    gross_error_criteria: [],
    invalid_criteria: [],
    sections: [],
    criteria: [
      {
        id: 'c01',
        type: 'binary' as const,
        answer: 'YES' as const,
        value: null,
        weight: 100,
        section: null,
        scored: true,
        raw: total,
        points: total,
        contribution: total,
        max_contribution: 100,
        effective_weight: 100,
      },
    ],
  };
  return {
    id,
    group_id: 'DEV',
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    checklist,
    checklist_snapshot: checklist,
    provider: 'test',
    model: 'synthetic',
    created_at: '2026-01-01T00:00:00Z',
    status: 'ok',
    criteria: { c01: answer },
    final_criteria: { c01: answer },
    original_result: score,
    final_result: score,
    coaching: [],
    appeals: [],
    validation_errors: [],
    duration_ms: 1,
    cost_usd: 0,
    usage: { input: 1, output: 1, thoughts: 0 },
  };
}
function summary(value: Evaluation): EvaluationSummary {
  return {
    id: value.id,
    group_id: 'DEV',
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    checklist,
    created_at: value.created_at,
    provider: value.provider,
    model: value.model,
    status: 'ok',
    original_total: value.original_result.total,
    final_total: value.final_result.total,
    gross_error: false,
    gross_error_unknown: false,
    appeals_open: 0,
    appeals_total: 0,
  };
}

beforeEach(() => {
  workspace.evaluationRevision = 0;
  window.location.hash = '#/card/DEV/refresh-case';
});

describe('background evaluation refresh in an open card', () => {
  it('shows a newly saved result while retaining the audio element, playback position and transcript search', async () => {
    let revised = false;
    let resolveHistory: (history: EvaluationSummary[]) => void = () => {};
    const pendingHistory = new Promise<EvaluationSummary[]>((resolve) => {
      resolveHistory = resolve;
    });
    const result = evaluation();
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.startsWith('/datasets/')) return Promise.resolve(structuredClone(record)) as never;
      if (path.startsWith('/evaluations?'))
        return (revised ? pendingHistory : Promise.resolve([])) as never;
      return Promise.resolve(result) as never;
    });
    const view = render(<ConversationPage groupId="DEV" conversationId={record.conversation_id} />);
    const audio = (await screen.findByLabelText('Аудиозапись диалога')) as HTMLAudioElement;
    audio.currentTime = 37;
    fireEvent.change(screen.getByRole('textbox', { name: 'Найти в диалоге' }), {
      target: { value: 'ответ' },
    });
    revised = true;
    workspace.evaluationRevision = 1;
    view.rerender(<ConversationPage groupId="DEV" conversationId={record.conversation_id} />);
    expect(screen.getByLabelText('Аудиозапись диалога')).toBe(audio);
    expect(screen.queryByText('Открываем диалог и оценку…')).not.toBeInTheDocument();
    await act(async () => {
      resolveHistory([summary(result)]);
    });
    await screen.findByLabelText('Предварительная оценка ИИ: 80 из 100');
    expect(screen.getByLabelText('Аудиозапись диалога')).toBe(audio);
    expect(audio.currentTime).toBe(37);
    expect(screen.getByRole('textbox', { name: 'Найти в диалоге' })).toHaveValue('ответ');
  });

  it('keeps an explicit historical evaluation pinned when the global queue revision advances', async () => {
    const historical = evaluation('historical', 60);
    const get = vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.startsWith('/datasets/')) return Promise.resolve(structuredClone(record)) as never;
      if (path.startsWith('/evaluations?')) return Promise.resolve([summary(historical)]) as never;
      return Promise.resolve(historical) as never;
    });
    const view = render(
      <ConversationPage
        groupId="DEV"
        conversationId={record.conversation_id}
        evaluationId="historical"
      />,
    );
    await screen.findByLabelText('Предварительная оценка ИИ: 60 из 100');
    const requests = get.mock.calls.length;
    workspace.evaluationRevision = 2;
    view.rerender(
      <ConversationPage
        groupId="DEV"
        conversationId={record.conversation_id}
        evaluationId="historical"
      />,
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(requests));
    expect(screen.getByLabelText('Предварительная оценка ИИ: 60 из 100')).toBeInTheDocument();
  });
});
