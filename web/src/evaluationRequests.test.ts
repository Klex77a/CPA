import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { evaluateWithRequest } from './evaluationRequests';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return { ...original, api: { ...original.api, post: mocks.post } };
});
const intent = {
  group_id: 'DEV',
  conversation_id: 'synthetic-id',
  checklist_id: 'default',
  force: false,
};
const saved = () =>
  JSON.parse(window.sessionStorage.getItem('cqa.evaluationRequests.v1') || '{"records":[]}')
    .records;
beforeEach(() => {
  window.sessionStorage.clear();
  mocks.post.mockReset();
});
afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
});
describe('evaluation request safety', () => {
  it('reuses the exact body after a transport failure even when the next caller now proposes force=true; after success an explicit regrade gets a new ID', async () => {
    mocks.post
      .mockRejectedValueOnce(new TypeError('Network response lost'))
      .mockResolvedValue({ id: 'saved' });
    await expect(evaluateWithRequest(intent)).rejects.toThrow('Network response lost');
    const first = mocks.post.mock.calls[0][1];
    expect(saved()[0].body).toEqual(first);
    await evaluateWithRequest({ ...intent, force: true });
    expect(mocks.post.mock.calls[1][1]).toEqual(first);
    expect(saved()).toEqual([]);
    await evaluateWithRequest({ ...intent, force: true });
    const regrade = mocks.post.mock.calls[2][1];
    expect(regrade.request_id).not.toBe(first.request_id);
    expect(regrade.force).toBe(true);
  });
  it('retains the request on an uncoded server failure without automatically posting again', async () => {
    vi.useFakeTimers();
    mocks.post.mockRejectedValue(new ApiError('Temporary failure', 503));
    await expect(evaluateWithRequest(intent)).rejects.toThrow('Temporary failure');
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(saved()[0].state).toBe('checking');
    expect(saved()[0].body.request_id).toBeTruthy();
  });
  it('drops an uncertain ID but retains an explicit paid-retry notice until the next user action', async () => {
    vi.useFakeTimers();
    mocks.post
      .mockRejectedValueOnce(new ApiError('Unknown outcome', 409, 'EVALUATION_UNCERTAIN'))
      .mockResolvedValue({ id: 'new-result' });
    await expect(evaluateWithRequest(intent)).rejects.toThrow('Unknown outcome');
    const first = mocks.post.mock.calls[0][1];
    expect(saved()[0].body).toBeUndefined();
    expect(saved()[0].state).toBe('uncertain');
    expect(saved()[0].message).toContain('могла быть оплачена');
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.post).toHaveBeenCalledOnce();
    await evaluateWithRequest(intent);
    const second = mocks.post.mock.calls[1][1];
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.force).toBe(true);
  });
  it.each(['EVALUATION_FAILED', 'EVALUATION_INPUT_CHANGED', 'EVALUATION_RESULT_REMOVED'])(
    'clears a definitively ended ID for %s',
    async (code) => {
      mocks.post
        .mockRejectedValueOnce(new ApiError('Definitive response', 409, code))
        .mockResolvedValue({ id: 'result' });
      await expect(evaluateWithRequest(intent)).rejects.toThrow('Definitive response');
      const first = mocks.post.mock.calls[0][1];
      expect(saved()[0].body).toBeUndefined();
      await evaluateWithRequest(intent);
      expect(mocks.post.mock.calls[1][1].request_id).not.toBe(first.request_id);
    },
  );
  it('shares an in-flight intent between callers instead of dispatching another POST', async () => {
    let finish!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      finish = resolve;
    });
    mocks.post.mockReturnValue(response);
    const first = evaluateWithRequest(intent),
      second = evaluateWithRequest({ ...intent, force: true });
    expect(mocks.post).toHaveBeenCalledOnce();
    finish({ id: 'done' });
    await Promise.all([first, second]);
  });
});
