import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

export interface EvaluationContext {
  group_id: string;
  conversation_id: string;
  checklist_id: string;
}
interface EvaluationBody extends EvaluationContext {
  force: boolean;
  request_id: string;
}
type RequestState = 'checking' | 'uncertain' | 'failed' | 'changed' | 'blocked';
export interface EvaluationRequestNotice {
  state: RequestState;
  message: string;
}
interface StoredRequest extends EvaluationContext, EvaluationRequestNotice {
  body?: EvaluationBody;
  forceNext?: boolean;
  updated_at: number;
}
const storageKey = 'cqa.evaluationRequests.v1';
const eventName = 'cqa:evaluation-request';
const maximumRecords = 64;
const inFlight = new Map<string, Promise<unknown>>();
const keyOf = (context: EvaluationContext) =>
  JSON.stringify([context.group_id, context.conversation_id, context.checklist_id]);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
function read(): StoredRequest[] {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return [];
    if (raw.length > 2 * 1024 * 1024) throw new Error();
    const saved = JSON.parse(raw) as { version?: number; records?: StoredRequest[] };
    if (
      saved.version !== 1 ||
      Object.keys(saved).some((key) => !['version', 'records'].includes(key)) ||
      !Array.isArray(saved.records) ||
      saved.records.length > maximumRecords
    )
      throw new Error();
    for (const row of saved.records) {
      if (
        !row ||
        Object.keys(row).some(
          (key) =>
            ![
              'group_id',
              'conversation_id',
              'checklist_id',
              'state',
              'message',
              'body',
              'forceNext',
              'updated_at',
            ].includes(key),
        ) ||
        !text(row.group_id) ||
        !text(row.conversation_id) ||
        !text(row.checklist_id) ||
        !['checking', 'uncertain', 'failed', 'changed'].includes(row.state) ||
        typeof row.message !== 'string' ||
        row.message.length > 3000 ||
        !Number.isFinite(row.updated_at)
      )
        throw new Error();
      if (
        (row.state === 'checking' && !row.body) ||
        (row.state !== 'checking' && row.body) ||
        (row.forceNext !== undefined && typeof row.forceNext !== 'boolean')
      )
        throw new Error();
      if (
        row.body &&
        (Object.keys(row.body).some(
          (key) =>
            !['group_id', 'conversation_id', 'checklist_id', 'force', 'request_id'].includes(key),
        ) ||
          !text(row.body.request_id) ||
          typeof row.body.force !== 'boolean' ||
          keyOf(row.body) !== keyOf(row))
      )
        throw new Error();
    }
    if (new Set(saved.records.map(keyOf)).size !== saved.records.length) throw new Error();
    return saved.records;
  } catch {
    throw new Error(
      'Не удалось прочитать сохранённую попытку оценки. Новая платная попытка не запущена.',
    );
  }
}
function write(records: StoredRequest[]) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, records }));
  } catch {
    throw new Error(
      'Не удалось сохранить попытку в этой вкладке. Оценка не запущена; проверьте доступность хранилища браузера.',
    );
  }
  window.dispatchEvent(new Event(eventName));
}
function update(context: EvaluationContext, next: StoredRequest | null) {
  const rows = read().filter((row) => keyOf(row) !== keyOf(context));
  if (next) {
    if (rows.length >= maximumRecords)
      throw new Error(
        'Слишком много незавершённых оценок. Проверьте результаты предыдущих попыток перед новым запуском.',
      );
    rows.push(next);
  }
  write(rows);
}
function snapshot() {
  try {
    return { records: read(), error: '' };
  } catch (cause) {
    return {
      records: [] as StoredRequest[],
      error: cause instanceof Error ? cause.message : 'Сохранённые попытки недоступны.',
    };
  }
}
export function useEvaluationRequests() {
  const [saved, setSaved] = useState(snapshot);
  useEffect(() => {
    const changed = () => setSaved(snapshot());
    window.addEventListener(eventName, changed);
    changed();
    return () => window.removeEventListener(eventName, changed);
  }, []);
  return {
    get: (context: EvaluationContext): EvaluationRequestNotice | undefined =>
      saved.error
        ? { state: 'blocked', message: saved.error }
        : saved.records.find((row) => keyOf(row) === keyOf(context)),
  };
}
export function evaluationActionLabel(
  notice: EvaluationRequestNotice | undefined,
  fallback: string,
) {
  return notice?.state === 'checking'
    ? 'Проверить результат'
    : notice?.state === 'uncertain'
      ? 'Начать новую оценку'
      : notice?.state === 'changed'
        ? 'Оценить заново'
        : fallback;
}

/** One explicit user action; transport failures never create or automatically repeat paid work. */
export function evaluateWithRequest<T>(intent: EvaluationContext & { force: boolean }): Promise<T> {
  const key = keyOf(intent),
    pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const run = async () => {
    const previous = read().find((row) => keyOf(row) === key);
    const body: EvaluationBody = previous?.body || {
      group_id: intent.group_id,
      conversation_id: intent.conversation_id,
      checklist_id: intent.checklist_id,
      force: !!intent.force || !!previous?.forceNext,
      request_id: crypto.randomUUID(),
    };
    const base: StoredRequest = {
      group_id: body.group_id,
      conversation_id: body.conversation_id,
      checklist_id: body.checklist_id,
      state: 'checking',
      body,
      message: 'Оценка запрошена. При потере связи проверяйте результат этой же попытки.',
      updated_at: Date.now(),
    };
    update(intent, base);
    try {
      const result = await api.post<T>('/evaluate', body);
      update(intent, null);
      return result;
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : undefined;
      let next: StoredRequest;
      if (code === 'EVALUATION_UNCERTAIN')
        next = {
          ...base,
          body: undefined,
          state: 'uncertain',
          forceNext: true,
          message:
            'Предыдущая оценка могла быть оплачена, но её результат не подтверждён. «Начать новую оценку» создаст новую платную попытку только после вашего нажатия.',
        };
      else if (code === 'EVALUATION_FAILED')
        next = {
          ...base,
          body: undefined,
          state: 'failed',
          forceNext: true,
          message:
            'Предыдущая оценка завершилась ошибкой. Повторная оценка начнёт новую попытку только после вашего нажатия.',
        };
      else if (
        [
          'EVALUATION_INPUT_CHANGED',
          'INPUT_CHANGED',
          'EVALUATION_RESULT_REMOVED',
          'RESULT_REMOVED',
          'EVALUATION_NOT_FOUND',
        ].includes(code || '')
      )
        next = {
          ...base,
          body: undefined,
          state: 'changed',
          forceNext: false,
          message: code?.includes('INPUT_CHANGED')
            ? 'Исходный диалог или чек-лист изменился. Для новой оценки нажмите «Оценить заново».'
            : 'Сохранённый результат этой попытки недоступен. Для новой оценки нажмите «Оценить заново».',
        };
      else
        next = {
          ...base,
          message:
            code === 'EVALUATION_IN_PROGRESS'
              ? 'Оценка ещё выполняется. «Проверить результат» проверит ту же попытку без создания новой.'
              : 'Ответ сервера не получен; предыдущая попытка могла завершиться. «Проверить результат» проверит ту же оценку, сохраняя защиту от повторного списания.',
        };
      update(intent, next);
      throw cause;
    }
  };
  const promise = run();
  inFlight.set(key, promise);
  void promise
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    })
    .catch(() => {});
  return promise;
}
