import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./Workspace', () => ({
  useWorkspace: () => ({
    config: { provider: 'mock', model: 'demo' },
    openAppeals: 0,
    group: 'DEV',
  }),
}));
vi.mock('./pages/ConversationsPage', () => ({ default: () => <h1>Список диалогов</h1> }));
vi.mock('./pages/ConversationPage', () => ({
  default: ({ groupId, conversationId }: { groupId: string; conversationId: string }) => (
    <h1>
      {groupId}/{conversationId}
    </h1>
  ),
}));

const originalWidth = window.innerWidth;
afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true });
  window.history.replaceState(null, '', '/');
});

describe('workspace navigation', () => {
  it('traps mobile navigation focus and restores the opener after Escape', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 720, configurable: true });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Список диалогов' });
    const opener = screen.getByRole('button', { name: 'Открыть навигацию' });
    await user.click(opener);
    const close = screen.getByRole('button', { name: 'Закрыть навигацию' });
    expect(close).toHaveFocus();
    expect(document.querySelector<HTMLElement>('.cqa-workspace')?.inert).toBe(true);
    await user.tab({ shift: true });
    expect(screen.getByRole('link', { name: 'Чек-лист' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.querySelector<HTMLElement>('.cqa-workspace')?.inert).toBe(false);
    expect(opener).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the existing conversation URL without treating proof query parameters as its ID', async () => {
    window.history.replaceState(null, '', '/#/card/DEV/p4-ru-003?turn=8&to=9');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'DEV/p4-ru-003' })).toBeInTheDocument();
  });
});
