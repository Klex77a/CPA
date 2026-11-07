import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import ConversationsPage from './pages/ConversationsPage';
import ConversationPage from './pages/ConversationPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  notify: vi.fn(),
  refreshBase: vi.fn(async () => {}),
  setGroup: vi.fn(),
  setChecklistId: vi.fn(),
  setConversationOrder: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, api: { ...original.api, get: mocks.get, post: mocks.post } };
});
vi.mock('./Workspace', () => ({
  useWorkspace: () => ({
    config: { provider: 'deepseek', model: 'synthetic-model' },
    group: 'DEV',
    setGroup: mocks.setGroup,
    checklistId: 'default',
    setChecklistId: mocks.setChecklistId,
    checklists: [{ id: 'default', name: 'Правила', version: 1 }],
    datasets: [{ group_id: 'DEV', total_records: 1 }],
    refreshBase: mocks.refreshBase,
    notify: mocks.notify,
    setConversationOrder: mocks.setConversationOrder,
    evaluationRevision: 0,
    queue: { running: false, starting: false },
  }),
}));
vi.mock('./pages/conversation/TranscriptPane', () => ({
  default: () => <div>Исходный синтетический текст</div>,
}));
vi.mock('./pages/conversation/EvaluationPane', () => ({
  default: () => <div>Сохранённая оценка</div>,
}));
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});
afterAll(() => vi.unstubAllGlobals());
const summary = {
  id: 'ev',
  conversation_id: 'shared',
  group_id: 'DEV',
  created_at: '2026-11-08T00:00:00Z',
  checklist: { id: 'default', name: 'Правила', version: 1 },
  final_total: 85,
  original_total: 85,
  operator_name: 'Учебный оператор',
  status: 'ok',
  gross_error: false,
  gross_error_unknown: false,
  provider: 'deepseek',
  model: 'model',
  appeals_open: 0,
  appeals_total: 0,
};
const result = {
  id: 'ev',
  checklist: summary.checklist,
  final_result: { total: 85 },
  cached: true,
};
let resultSaved = false;
beforeEach(() => {
  storage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/#/list');
  resultSaved = false;
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/datasets/DEV')
      return {
        group_id: 'DEV',
        records: [
          {
            conversation_id: 'shared',
            channel: 'agent chat',
            language: 'RU',
            messages: 1,
            has_audio: false,
            evaluations: resultSaved ? [summary] : [],
          },
        ],
      };
    if (path === '/datasets/DEV/shared')
      return {
        conversation_id: 'shared',
        channel: 'agent chat',
        language: 'RU',
        transcript: [{ speaker: 'operator', timestamp: '00:01', text: 'Учебная реплика.' }],
      };
    if (path === '/evaluations?group_id=DEV') return resultSaved ? [summary] : [];
    if (path === '/evaluations/ev') return result;
    throw new Error('Unexpected GET ' + path);
  });
});
afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('shared list/card evaluation intent', () => {
  it('still opens a confirmed result when refreshing the workspace summary fails', async () => {
    const user = userEvent.setup();
    resultSaved = true;
    window.history.replaceState(null, '', '/#/card/DEV/shared/ev');
    mocks.post.mockResolvedValue({ ...result, id: 'confirmed-new', cached: false });
    mocks.refreshBase.mockRejectedValueOnce(new Error('Summary unavailable'));
    render(<ConversationPage groupId="DEV" conversationId="shared" evaluationId="ev" />);
    const regrade = await screen.findByRole('button', { name: 'Переоценить' });
    await waitFor(() => expect(regrade).toBeEnabled());
    await user.click(regrade);
    await waitFor(() => expect(window.location.hash).toBe('#/card/DEV/shared/confirmed-new'));
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.notify.mock.calls.some(([, kind]) => kind === 'error')).toBe(false);
  });
  it('checks a lost list response from the remounted card with the same ID and force=false, then creates a fresh explicit regrade', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mocks.post.mockImplementation(async (path: string) => {
      if (path !== '/evaluate') throw new Error('Unexpected POST');
      attempts++;
      if (attempts === 1) {
        resultSaved = true;
        throw new TypeError('Response lost');
      }
      return result;
    });
    const list = render(<ConversationsPage />);
    await user.click(await screen.findByRole('button', { name: 'Оценить' }));
    await screen.findByRole('button', { name: 'Проверить результат' });
    const first = mocks.post.mock.calls[0][1];
    expect(first.force).toBe(false);
    list.unmount();
    window.history.replaceState(null, '', '/#/card/DEV/shared/ev');
    render(<ConversationPage groupId="DEV" conversationId="shared" evaluationId="ev" />);
    const check = await screen.findByRole('button', { name: 'Проверить результат' });
    await waitFor(() => expect(check).toBeEnabled());
    expect(mocks.post).toHaveBeenCalledOnce();
    await user.click(check);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1]).toEqual(first);
    const regrade = await screen.findByRole('button', { name: 'Переоценить' });
    await waitFor(() => expect(regrade).toBeEnabled());
    await user.click(regrade);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[2][1].request_id).not.toBe(first.request_id);
    expect(mocks.post.mock.calls[2][1].force).toBe(true);
  });
  it('retains the possible-charge warning across route/remount and waits for a new explicit force action after UNCERTAIN', async () => {
    const user = userEvent.setup();
    mocks.post
      .mockRejectedValueOnce(new ApiError('Uncertain attempt', 409, 'EVALUATION_UNCERTAIN'))
      .mockResolvedValue(result);
    const list = render(<ConversationsPage />);
    await user.click(await screen.findByRole('button', { name: 'Оценить' }));
    await screen.findByRole('button', { name: 'Начать новую оценку' });
    expect(screen.getByText(/могла быть оплачена/)).toBeInTheDocument();
    const first = mocks.post.mock.calls[0][1];
    list.unmount();
    window.history.replaceState(null, '', '/#/card/DEV/shared');
    render(<ConversationPage groupId="DEV" conversationId="shared" />);
    const restart = await screen.findByRole('button', { name: 'Начать новую оценку' });
    await waitFor(() => expect(restart).toBeEnabled());
    expect(screen.getByText(/могла быть оплачена/)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledOnce();
    await user.click(restart);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1][1].force).toBe(true);
    expect(mocks.post.mock.calls[1][1].request_id).not.toBe(first.request_id);
  });
});
