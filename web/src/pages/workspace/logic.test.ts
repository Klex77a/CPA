import { describe, expect, it, vi } from 'vitest';
import { advanceQueue, filterRows, listRows, matchesQuick, sortRows } from './logic';
import type { Filters, ListEvaluation, ListRecord, QueueJob } from './models';

const evaluation = (patch: Partial<ListEvaluation> = {}): ListEvaluation => ({
  id: 'ev',
  checklist: { id: 'default', name: 'Rules', version: 1 },
  final_total: 85,
  original_total: 85,
  operator_name: 'Айгерим',
  gross_error: false,
  gross_error_unknown: false,
  status: 'ok',
  provider: 'deepseek',
  model: 'model',
  appeals_open: 0,
  appeals_total: 0,
  ...patch,
});
const record = (id: string, evaluations: ListEvaluation[] = []): ListRecord => ({
  conversation_id: id,
  channel: 'voice call',
  language: 'KZ',
  messages: 10,
  has_audio: true,
  evaluations,
});
const filters: Filters = {
  query: '',
  channel: '',
  language: '',
  quick: 'all',
  sort: 'total',
  direction: -1,
};
const job = (patch: Partial<QueueJob> = {}): QueueJob => ({
  id: 'job',
  status: 'running',
  execution_mode: 'stepped',
  done: 0,
  total: 1,
  cost_usd: 0,
  errors: [],
  ...patch,
});

describe('conversation list', () => {
  it('keeps a newer matching failure alongside a prior score, but excludes another checklist version and a later successful retry', () => {
    const failure = {
      id: 'fail',
      group_id: 'DEV',
      conversation_id: 'x',
      status: 'error' as const,
      created_at: '2026-11-08T00:01:00Z',
      checklist: { id: 'default', version: 1 },
      reason: 'Temporary error',
    };
    const prior = evaluation({ created_at: '2026-11-08T00:00:00Z' });
    const rows = listRows([{ ...record('x', [prior]), failures: [failure] }], 'default', 1);
    expect(rows[0].evaluation).toBe(prior);
    expect(rows[0].failure).toEqual(failure);
    expect(matchesQuick(rows[0], 'failed')).toBe(true);
    expect(
      listRows([{ ...record('x'), failures: [failure] }], 'default', 2)[0].failure,
    ).toBeUndefined();
    expect(
      listRows(
        [
          {
            ...record('x', [evaluation({ created_at: '2026-11-08T00:02:00Z' })]),
            failures: [failure],
          },
        ],
        'default',
        1,
      )[0].failure,
    ).toBeUndefined();
  });
  it('uses only the current checklist and excludes stale evaluations from active scores', () => {
    const rows = listRows(
      [
        record('old', [
          evaluation({ stale: true }),
          evaluation({ id: 'other', checklist: { id: 'custom', name: 'Custom', version: 1 } }),
        ]),
        record('current', [evaluation({ id: 'stale', stale: true }), evaluation({ id: 'fresh' })]),
      ],
      'default',
    );
    expect(rows[0].evaluation).toBeUndefined();
    expect(rows[0].history).toHaveLength(1);
    expect(rows[1].evaluation?.id).toBe('fresh');
    expect(matchesQuick(rows[0], 'todo')).toBe(true);
  });
  it('keeps missing scores at the bottom in both directions', () => {
    const rows = listRows(
      [
        record('unscored'),
        record('low', [evaluation({ final_total: 45 })]),
        record('high', [evaluation({ final_total: 90 })]),
      ],
      'default',
    );
    expect(sortRows(rows, filters).map((row) => row.record.conversation_id)).toEqual([
      'high',
      'low',
      'unscored',
    ]);
    expect(
      sortRows(rows, { ...filters, direction: 1 }).map((row) => row.record.conversation_id),
    ).toEqual(['low', 'high', 'unscored']);
  });
  it('combines search and language/channel filters and surfaces unknown critical flags for review', () => {
    const rows = listRows(
      [
        record('kz-1', [evaluation({ gross_error_unknown: true })]),
        { ...record('ru-1', [evaluation()]), language: 'RU' },
      ],
      'default',
    );
    const matched = filterRows(rows, {
      ...filters,
      query: 'айгерим',
      channel: 'voice call',
      language: 'KZ',
    });
    expect(matched).toHaveLength(1);
    expect(matchesQuick(matched[0], 'review')).toBe(true);
    expect(matchesQuick(matched[0], 'gross')).toBe(false);
  });
});
describe('durable cloud queue', () => {
  it('reads durable state before stepping, and never advances finished or local jobs', async () => {
    const sequence: string[] = [];
    const get = vi.fn(async (path: string) => {
      sequence.push(`GET ${path}`);
      return job();
    });
    const post = vi.fn(async (path: string) => {
      sequence.push(`POST ${path}`);
      return job({ status: 'finished', done: 1 });
    });
    await advanceQueue('job', get, post);
    expect(sequence).toEqual(['GET /batch/job', 'POST /batch/job/step']);
    get.mockResolvedValue(job({ status: 'finished', done: 1 }));
    await advanceQueue('job', get, post);
    get.mockResolvedValue(job({ execution_mode: undefined }));
    await advanceQueue('job', get, post);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost step response through GET without repeating completed work', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job({ status: 'finished', done: 1 }));
    const post = vi.fn().mockRejectedValueOnce(new Error('Response lost'));
    await expect(advanceQueue('job', get, post)).rejects.toThrow('Response lost');
    await expect(advanceQueue('job', get, post)).resolves.toMatchObject({
      status: 'finished',
      done: 1,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a step after the view has unmounted or when GET fails', async () => {
    const post = vi.fn();
    await advanceQueue(
      'job',
      async () => job(),
      post,
      () => false,
    );
    expect(post).not.toHaveBeenCalled();
    await expect(
      advanceQueue(
        'job',
        async () => {
          throw new Error('offline');
        },
        post,
      ),
    ).rejects.toThrow('offline');
    expect(post).not.toHaveBeenCalled();
  });
});
