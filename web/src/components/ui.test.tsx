import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Modal } from './ui';

function DialogExample() {
  const [open, setOpen] = useState(false),
    [value, setValue] = useState('');
  return (
    <>
      <div className="cqa-app-shell">
        <button onClick={() => setOpen(true)}>Оспорить</button>
      </div>
      {open && (
        <Modal
          title="Апелляция"
          onClose={() => setOpen(false)}
          footer={<button onClick={() => setOpen(false)}>Сохранить</button>}
        >
          <label>
            Комментарий
            <textarea value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        </Modal>
      )}
    </>
  );
}

describe('Accessible modal', () => {
  it('keeps focus in the text field while typing and restores the opener on Escape', async () => {
    const user = userEvent.setup();
    render(<DialogExample />);
    const opener = screen.getByRole('button', { name: 'Оспорить' });
    await user.click(opener);
    const field = screen.getByRole('textbox', { name: 'Комментарий' });
    expect(field).toHaveFocus();
    expect((document.querySelector('.cqa-app-shell') as HTMLElement).inert).toBe(true);
    await user.type(field, 'Нужно проверить причину снижения');
    expect(field).toHaveValue('Нужно проверить причину снижения');
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect((document.querySelector('.cqa-app-shell') as HTMLElement).inert).toBe(false);
  });
  it('traps keyboard traversal inside the dialog', async () => {
    render(<DialogExample />);
    fireEvent.click(screen.getByRole('button', { name: 'Оспорить' }));
    const close = screen.getByRole('button', { name: 'Закрыть окно' }),
      save = screen.getByRole('button', { name: 'Сохранить' });
    save.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();
  });
});
