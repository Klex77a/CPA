import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppealsPage from '../AppealsPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  notify: vi.fn(),
  refreshBase: vi.fn(async () => {}),
}));
vi.mock('../../api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../../Workspace', () => ({
  useWorkspace: () => ({ notify: mocks.notify, refreshBase: mocks.refreshBase }),
}));

const criterion = {
  id: 'c03',
  title: 'Консультация',
  type: 'scale',
  weight: 20,
  description: 'Проверить точность',
  na_allowed: true,
  scale: [
    { value: 10, description: 'Полностью' },
    { value: 5, description: 'Частично' },
    { value: 0, description: 'Не выполнено' },
  ],
};
const appeal = {
  id: 'a1',
  evaluation_id: 'ev1',
  group_id: 'DEV',
  conversation_id: 'p4-ru-003',
  criterion_id: 'c03',
  criterion_title: 'Консультация',
  status: 'open',
  comment: 'Ответ был полным',
  created_at: '2026-11-08T00:00:00Z',
  final_total: 85,
  original_total: 85,
  disputed: {
    answer: 'SCORE',
    value: 5,
    explanation: 'Часть ответа отсутствует',
    evidence: [{ msg: 1, fragment: 'Сохранённый ответ' }],
  },
};

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.notify.mockReset();
  mocks.refreshBase.mockClear();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === '/appeals') return [appeal];
    if (path === '/evaluations/ev1')
      return {
        record_changed: true,
        checklist_snapshot: { criteria: [criterion] },
        record_snapshot: {
          transcript: [
            { speaker: 'client', text: 'Вопрос клиента' },
            { speaker: 'operator', text: 'Сохранённый ответ' },
          ],
        },
      };
    throw new Error('Unexpected GET ' + path);
  });
  mocks.post.mockResolvedValue({});
});
describe('appeal review', () => {
  it('grounds an archived appeal in the saved source and links to 1-based proof turns', async () => {
    render(<AppealsPage />);
    await screen.findByText('Сохранённый ответ');
    expect(screen.getByText(/Архивная оценка/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Реплика №2/ })).toHaveAttribute(
      'href',
      '#/card/DEV/p4-ru-003/ev1?turn=2',
    );
    expect(mocks.get).not.toHaveBeenCalledWith(
      expect.stringContaining('/datasets/'),
      expect.anything(),
    );
  });
  it('requires a reason and submits a valid selected scale value with the decision', async () => {
    const user = userEvent.setup();
    render(<AppealsPage />);
    const submit = await screen.findByRole('button', { name: 'Сохранить решение' });
    await user.click(submit);
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: /Изменить/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Новое значение' }), 'SCORE:10');
    await user.type(
      screen.getByRole('textbox', { name: 'Обоснование решения' }),
      'Полный ответ находится в реплике №2.',
    );
    await user.click(submit);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/evaluations/ev1/appeals/a1/decision', {
        action: 'change',
        reason: 'Полный ответ находится в реплике №2.',
        reviewer: 'Проверяющий',
        answer: 'SCORE',
        value: 10,
      }),
    );
    await waitFor(() => expect(mocks.refreshBase).toHaveBeenCalledOnce());
  });
  it('keeps available saved proof when the live source cannot be fetched', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/appeals') return [appeal];
      if (path === '/evaluations/ev1')
        return {
          record_changed: false,
          checklist_snapshot: { criteria: [criterion] },
          record_snapshot: {
            transcript: [
              { speaker: 'client', text: 'Вопрос клиента' },
              { speaker: 'operator', text: 'Надёжное сохранённое доказательство' },
            ],
          },
        };
      throw new Error('Live source unavailable');
    });
    render(<AppealsPage />);
    await screen.findByText('Надёжное сохранённое доказательство');
    expect(mocks.get.mock.calls.some(([path]) => String(path).startsWith('/datasets/'))).toBe(
      false,
    );
  });
});
