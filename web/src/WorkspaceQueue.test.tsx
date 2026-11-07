import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { WorkspaceProvider } from './Workspace';
import ConversationsPage from './pages/ConversationsPage';
import type { DatasetList, ListEvaluation, QueueJob } from './pages/workspace/models';
import type { EvaluationFailureSummary } from './types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, api: { ...original.api, get: mocks.get, post: mocks.post } };
});
vi.mock('./pages/ConversationPage', () => ({
  default: ({ conversationId }: { conversationId: string }) => <h1>Карточка {conversationId}</h1>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const score = (value = 85, created_at = '2026-11-08T00:00:00Z'): ListEvaluation => ({
  id: 'good',
  checklist: { id: 'default', name: 'Исходный чек-лист', version: 1 },
  created_at,
  final_total: value,
  original_total: value,
  operator_name: 'Анна',
  gross_error: false,
  gross_error_unknown: false,
  status: 'ok',
  provider: 'deepseek',
  model: 'model',
  appeals_open: 0,
  appeals_total: 0,
});
const failure: EvaluationFailureSummary = {
  id: 'failed-1',
  conversation_id: 'dialog-a',
  group_id: 'DEV',
  status: 'error',
  created_at: '2026-11-08T00:01:00Z',
  checklist: { id: 'default', version: 1 },
  reason: 'Сервис модели временно недоступен. Повторите оценку.',
};
const dataset = (
  evaluations: ListEvaluation[] = [],
  failures: EvaluationFailureSummary[] = [],
): DatasetList => ({
  group_id: 'DEV',
  fetched_at: '2026-11-08',
  records: [
    {
      conversation_id: 'dialog-a',
      channel: 'agent chat',
      language: 'RU',
      messages: 3,
      has_audio: false,
      evaluations,
      failures,
    },
  ],
});
const job = (patch: Partial<QueueJob> = {}): QueueJob => ({
  id: 'job-1',
  group_id: 'DEV',
  execution_mode: 'stepped',
  status: 'running',
  done: 0,
  total: 2,
  cost_usd: 0,
  errors: [],
  ...patch,
});
function baseGet(path: string, records: () => DatasetList) {
  if (path === '/config')
    return { provider: 'deepseek', model: 'model', data_api_configured: false };
  if (path === '/datasets') return [{ group_id: 'DEV', total_records: 1 }];
  if (path === '/checklists') return [{ id: 'default', name: 'Исходный чек-лист', version: 1 }];
  if (path === '/appeals?status=open') return [];
  if (path === '/datasets/DEV') return records();
  throw new Error('Unexpected GET ' + path);
}
const savedValues = new Map<string, string>();
// Node 25 exposes an experimental storage shim; use the browser Storage contract in this test.
vi.stubGlobal('localStorage', {
  getItem: (key: string) => savedValues.get(key) ?? null,
  setItem: (key: string, value: string) => savedValues.set(key, String(value)),
  removeItem: (key: string) => savedValues.delete(key),
  clear: () => savedValues.clear(),
});
beforeEach(() => {
  savedValues.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/#/list');
  mocks.get.mockReset();
  mocks.post.mockReset();
});
afterEach(() => {
  savedValues.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterAll(() => vi.unstubAllGlobals());

describe('workspace queue execution', () => {
  it('does not let a late step response undo cancellation or start another paid step', async () => {
    const user = userEvent.setup(),
      step = deferred<QueueJob>();
    let durable = job(),
      steps = 0,
      reads = 0;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/batch/job-1') {
        reads++;
        return durable;
      }
      return baseGet(path, () => dataset());
    });
    mocks.post.mockImplementation(async (path: string) => {
      if (path === '/batch') return durable;
      if (path === '/batch/job-1/step') {
        steps++;
        return step.promise;
      }
      if (path === '/batch/job-1/cancel') {
        durable = job({ status: 'cancelled' });
        return durable;
      }
      throw new Error('Unexpected POST ' + path);
    });
    render(
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Оценить набор' }));
    await waitFor(() => expect(steps).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Остановить' }));
    await screen.findByText('Очередь остановлена');
    await act(async () => step.resolve(job({ done: 1 })));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(
      within(screen.getByRole('region', { name: 'Очередь оценки' })).getByText(
        'Очередь остановлена',
      ),
    ).toBeInTheDocument();
    expect(steps).toBe(1);
  });
  it('keeps a deferred step alive while navigating from list to card, then continues without restarting', async () => {
    const user = userEvent.setup(),
      firstStep = deferred<QueueJob>();
    let durable = job(),
      steps = 0;
    const sequence: string[] = [];
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/batch/job-1') {
        sequence.push(`GET:${durable.done}`);
        return durable;
      }
      return baseGet(path, () => dataset());
    });
    mocks.post.mockImplementation(async (path: string) => {
      if (path === '/batch') return durable;
      if (path === '/batch/job-1/step') {
        sequence.push(`POST:${durable.done}`);
        steps++;
        durable = steps === 1 ? await firstStep.promise : job({ done: 2, status: 'finished' });
        return durable;
      }
      throw new Error('Unexpected POST ' + path);
    });
    render(
      <StrictMode>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </StrictMode>,
    );
    await user.click(await screen.findByRole('button', { name: 'Оценить набор' }));
    await waitFor(() => expect(steps).toBe(1));
    await user.click(screen.getByRole('link', { name: 'dialog-a' }));
    expect(await screen.findByRole('heading', { name: 'Карточка dialog-a' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Очередь оценки' })).getByText('Оценка DEV'),
    ).toBeInTheDocument();
    expect(screen.getByText(/При закрытии вкладки обработка приостановится/)).toBeInTheDocument();
    await act(async () => firstStep.resolve(job({ done: 1 })));
    await waitFor(() => expect(steps).toBe(2), { timeout: 4000 });
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Очередь оценки' })).getByText(
          'Оценка завершена',
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Карточка dialog-a' })).toBeInTheDocument();
    expect(mocks.post.mock.calls.filter(([path]) => path === '/batch')).toHaveLength(1);
    expect(sequence).toEqual(['GET:0', 'POST:0', 'GET:1', 'POST:1']);
  });
  it('resumes one stored job under StrictMode without parallel or duplicate paid steps', async () => {
    localStorage.setItem('cqa.activeCloudJob', 'job-1');
    const step = deferred<QueueJob>();
    let durable = job({ total: 1 }),
      steps = 0;
    mocks.get.mockImplementation(async (path: string) =>
      path === '/batch/job-1' ? durable : baseGet(path, () => dataset()),
    );
    mocks.post.mockImplementation(async (path: string) => {
      if (path === '/batch/job-1/step') {
        steps++;
        durable = await step.promise;
        return durable;
      }
      throw new Error('A resumed job must not be recreated');
    });
    render(
      <StrictMode>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(steps).toBe(1));
    await act(async () => step.resolve(job({ total: 1, done: 1, status: 'finished' })));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Очередь оценки' })).getByText(
          'Оценка завершена',
        ),
      ).toBeInTheDocument(),
    );
    expect(steps).toBe(1);
    expect(mocks.post.mock.calls.filter(([path]) => path === '/batch')).toHaveLength(0);
    expect(localStorage.getItem('cqa.activeCloudJob')).toBeNull();
  });
});
describe('persistent failed evaluation', () => {
  it('distinguishes provisional, appealed, confirmed-unchanged and changed results in the list', async () => {
    const cases = [
      { id: 'provisional', evaluation: score() },
      { id: 'appealed', evaluation: { ...score(), appeals_total: 1, appeals_open: 1 } },
      { id: 'confirmed', evaluation: { ...score(), appeals_total: 1, appeals_open: 0 } },
      {
        id: 'invalid',
        evaluation: { ...score(), status: 'needs_review', gross_error_unknown: true },
      },
      {
        id: 'changed',
        evaluation: { ...score(90), original_total: 85, appeals_total: 1, appeals_open: 0 },
      },
    ];
    const records = {
      ...dataset(),
      records: cases.map((item) => ({
        ...dataset().records[0],
        conversation_id: item.id,
        evaluations: [{ ...item.evaluation, id: `ev-${item.id}` }],
      })),
    };
    mocks.get.mockImplementation(async (path: string) => baseGet(path, () => records));
    render(
      <WorkspaceProvider>
        <ConversationsPage />
      </WorkspaceProvider>,
    );
    await screen.findByRole('link', { name: 'provisional' });
    const row = (id: string) => screen.getByRole('link', { name: id }).closest('tr')!;
    expect(within(row('provisional')).getByText('Предварительная оценка ИИ')).toBeVisible();
    expect(within(row('appealed')).getByText('Оценка оспаривается')).toBeVisible();
    expect(within(row('confirmed')).getByText('После пересмотра')).toBeVisible();
    expect(within(row('confirmed')).getByText('85')).toBeVisible();
    expect(within(row('changed')).getByText('После пересмотра')).toBeVisible();
    expect(within(row('changed')).getByText('90')).toBeVisible();
    expect(within(row('changed')).getByText('было 85')).toBeVisible();
    expect(within(row('invalid')).getByText('Ответ модели требует проверки')).toBeVisible();
    expect(within(row('invalid')).queryByText('Предварительная оценка ИИ')).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('survives remount, keeps the old good score, and checks a lost response with the same request', async () => {
    const user = userEvent.setup();
    let records = dataset([score()], [failure]),
      attempt = 0;
    mocks.get.mockImplementation(async (path: string) => baseGet(path, () => records));
    mocks.post.mockImplementation(async (path: string) => {
      if (path !== '/evaluate') throw new Error('Unexpected POST');
      attempt++;
      if (attempt === 1) throw new Error('Response lost');
      records = dataset([score(90, '2026-11-08T00:02:00Z')]);
      return {};
    });
    const first = render(
      <WorkspaceProvider>
        <ConversationsPage />
      </WorkspaceProvider>,
    );
    await screen.findByText('Ошибка повторной оценки');
    first.unmount();
    render(
      <WorkspaceProvider>
        <ConversationsPage />
      </WorkspaceProvider>,
    );
    await screen.findByText('Ошибка повторной оценки');
    let row = screen.getByRole('link', { name: 'dialog-a' }).closest('tr')!;
    expect(within(row).getByText('85')).toBeInTheDocument();
    expect(within(row).getByText('Предыдущий результат')).toBeInTheDocument();
    await user.click(within(row).getByText('Причина ошибки'));
    expect(within(row).getByText(failure.reason)).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Повторить оценку' }));
    await waitFor(() => expect(attempt).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Проверить результат' })).toBeEnabled(),
    );
    expect(screen.getByText('Результат не подтверждён')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Проверить результат' }));
    await waitFor(() =>
      expect(screen.queryByText('Ошибка повторной оценки')).not.toBeInTheDocument(),
    );
    row = screen.getByRole('link', { name: 'dialog-a' }).closest('tr')!;
    expect(within(row).getByText('90')).toBeInTheDocument();
    const requests = mocks.post.mock.calls
      .filter(([path]) => path === '/evaluate')
      .map(([, body]) => body);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      group_id: 'DEV',
      conversation_id: 'dialog-a',
      checklist_id: 'default',
      force: true,
    });
    expect(requests[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]).toEqual(requests[0]);
  });
});
