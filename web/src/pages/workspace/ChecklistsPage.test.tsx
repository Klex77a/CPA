import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ChecklistsPage from '../ChecklistsPage';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  setChecklistId: vi.fn(),
  refreshBase: vi.fn(async () => {}),
  notify: vi.fn(),
}));
vi.mock('../../api', () => ({
  api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.remove },
}));
vi.mock('../../Workspace', () => ({
  useWorkspace: () => ({
    checklists: [{ id: 'default', name: 'Правила', version: 1 }],
    checklistId: 'default',
    setChecklistId: mocks.setChecklistId,
    refreshBase: mocks.refreshBase,
    notify: mocks.notify,
  }),
}));
let version = 0;
beforeEach(() => {
  vi.clearAllMocks();
  version++;
  mocks.get.mockResolvedValue({
    id: 'default',
    version,
    name: 'Правила',
    rounding: 2,
    sections: [],
    criteria: [
      {
        id: 'c01',
        title: 'Первый критерий',
        type: 'binary',
        weight: 50,
        description: 'Первое правило',
        na_allowed: false,
      },
      {
        id: 'c02',
        title: 'Второй критерий',
        type: 'binary',
        weight: 50,
        description: 'Второе правило',
        na_allowed: false,
      },
    ],
  });
});
describe('checklist editor', () => {
  it('closes criterion deletion confirmation before the next criterion is selected', async () => {
    const user = userEvent.setup();
    const { container } = render(<ChecklistsPage />);
    await screen.findByDisplayValue('Первый критерий');
    const editor = container.querySelector('.cqa-criterion-editor')!;
    await user.click(within(editor as HTMLElement).getByRole('button', { name: 'Удалить' }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить критерий?' });
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Второй критерий')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Первый критерий')).not.toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it('can return from a new copy to its original without changing the selected checklist id', async () => {
    const user = userEvent.setup();
    render(<ChecklistsPage />);
    await screen.findByDisplayValue('Правила');
    await user.click(screen.getByRole('button', { name: 'Создать копию' }));
    expect(screen.getByDisplayValue('Правила — копия')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Открыть чек-лист' }), 'default');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Переключить чек-лист?' })).getByRole('button', {
        name: 'Переключить',
      }),
    );
    await waitFor(() => expect(screen.getByDisplayValue('Правила')).toBeInTheDocument());
    expect(screen.queryByDisplayValue('Правила — копия')).not.toBeInTheDocument();
  });
});
