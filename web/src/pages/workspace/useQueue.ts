import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { advanceQueue, errorMessage } from './logic';
import type { QueueJob } from './models';

const storageKey = 'cqa.activeCloudJob';
const rememberedId = () => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return '';
    try {
      return String(JSON.parse(raw) || '');
    } catch {
      return raw;
    }
  } catch {
    return '';
  }
};
function remember(job: QueueJob) {
  try {
    if (job.execution_mode === 'stepped' && job.status === 'running')
      localStorage.setItem(storageKey, JSON.stringify(job.id));
    else localStorage.removeItem(storageKey);
  } catch {
    /* Private browsing can disable persistence. */
  }
}

export function useQueue(
  onUpdate: () => void,
  notify: (message: string, kind: 'success' | 'error' | 'info') => void,
) {
  const [id, setId] = useState(rememberedId);
  const [job, setJob] = useState<QueueJob | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retry, setRetry] = useState(0);
  const handlers = useRef({ onUpdate, notify });
  handlers.current = { onUpdate, notify };
  const startLock = useRef(false);
  useEffect(() => {
    if (!id) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      failures = 0,
      lastDone = -1;
    async function poll() {
      try {
        const next = await advanceQueue(
          id,
          (path) => api.get<QueueJob>(path),
          (path, body) => api.post<QueueJob>(path, body),
          () => alive,
        );
        if (!alive) return;
        failures = 0;
        setError('');
        setJob(next);
        remember(next);
        if (next.done !== lastDone) {
          lastDone = next.done;
          handlers.current.onUpdate();
        }
        if (next.status === 'running') timer = setTimeout(poll, 1500);
        else {
          handlers.current.onUpdate();
          handlers.current.notify(
            next.status === 'cancelled'
              ? 'Очередь остановлена. Готовые оценки сохранены.'
              : `Оценка завершена${next.errors.length ? ` · ошибок: ${next.errors.length}` : ''}`,
            'success',
          );
        }
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof ApiError && cause.status === 404) {
          localStorage.removeItem(storageKey);
          setId('');
          setJob(null);
          setError(
            'Очередь не найдена. Готовые оценки сохранены; запустите набор снова для оставшихся диалогов.',
          );
          handlers.current.onUpdate();
          return;
        }
        const delay = Math.min(10000, 1500 * 2 ** Math.min(failures++, 3));
        setError(
          `Связь с очередью потеряна: ${errorMessage(cause)}. Повтор через ${Math.ceil(delay / 1000)} с.`,
        );
        timer = setTimeout(poll, delay);
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, retry]);
  const start = useCallback(
    async (group: string, checklist: string, force: boolean) => {
      if (
        startLock.current ||
        (id &&
          job?.status !== 'finished' &&
          job?.status !== 'cancelled' &&
          job?.status !== 'failed')
      )
        return;
      startLock.current = true;
      setStarting(true);
      try {
        const created = await api.post<QueueJob>('/batch', {
          group_id: group,
          checklist_id: checklist,
          force,
        });
        setJob(created);
        remember(created);
        setId(created.id);
        setError('');
        if (created.status !== 'running') handlers.current.onUpdate();
      } catch (cause) {
        handlers.current.notify(errorMessage(cause), 'error');
      } finally {
        startLock.current = false;
        setStarting(false);
      }
    },
    [id, job?.status],
  );
  const cancel = async () => {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      const next = await api.post<QueueJob | { ok: boolean }>(
        `/batch/${encodeURIComponent(id)}/cancel`,
        {},
      );
      if ('id' in next) {
        setJob(next);
        remember(next);
      }
      setRetry((v) => v + 1);
    } catch (cause) {
      handlers.current.notify(errorMessage(cause), 'error');
    } finally {
      setCancelling(false);
    }
  };
  return {
    job,
    error,
    starting,
    cancelling,
    running: !!id && (!job || job.status === 'running'),
    start,
    cancel,
    retry: () => setRetry((v) => v + 1),
  };
}
