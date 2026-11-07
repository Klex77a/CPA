import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useResource } from './hooks';

describe('resource lifecycle', () => {
  it('does not replace the selected conversation with an older delayed response', async () => {
    const pending = new Map<string, (value: string) => void>();
    const signals: AbortSignal[] = [];
    const { result, rerender } = renderHook(
      ({ id }) =>
        useResource(id, (signal) => {
          signals.push(signal);
          return new Promise<string>((resolve) => pending.set(id, resolve));
        }),
      { initialProps: { id: 'first' } },
    );
    rerender({ id: 'second' });
    expect(signals[0].aborted).toBe(true);
    await act(async () => pending.get('second')?.('SECOND'));
    await waitFor(() => expect(result.current.data).toBe('SECOND'));
    await act(async () => pending.get('first')?.('FIRST'));
    expect(result.current.data).toBe('SECOND');
  });
  it('exposes a retry without retaining an error from the previous attempt', async () => {
    let attempt = 0;
    const { result } = renderHook(() =>
      useResource('same', async () => {
        if (!attempt++) throw new Error('Connection lost');
        return 'RESTORED';
      }),
    );
    await waitFor(() => expect(result.current.error?.message).toBe('Connection lost'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe('RESTORED'));
    expect(result.current.error).toBeUndefined();
  });
});
