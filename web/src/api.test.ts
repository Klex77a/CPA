import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
afterEach(() => vi.unstubAllGlobals());
describe('public API error code', () => {
  it('retains the safe response code needed to distinguish an uncertain evaluation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'Результат не подтверждён.', code: 'EVALUATION_UNCERTAIN' }),
      })),
    );
    const failure = await api.post('/evaluate', {}).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    if (!(failure instanceof ApiError)) throw new Error('Expected an API error');
    expect(failure.code).toBe('EVALUATION_UNCERTAIN');
    expect(failure.status).toBe(409);
  });
});
