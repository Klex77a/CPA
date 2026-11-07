import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { advanceQueue, errorMessage } from './logic';
import type { QueueJob } from './models';

const storageKey = 'cqa.activeCloudJob';
function rememberedId() {
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
}
function remember(job: QueueJob | null) {
  try {
    if (job?.status === 'running') localStorage.setItem(storageKey, JSON.stringify(job.id));
    else localStorage.removeItem(storageKey);
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}

/** Mounted once by WorkspaceProvider; changing application routes never restarts execution. */
export function useQueue(
  onUpdate: () => void,
  notify: (message: string, kind: 'success' | 'error' | 'info') => void,
) {
  const [id, setId] = useState(rememberedId);
  const [job, setJob] = useState<QueueJob | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const handlers = useRef({ onUpdate, notify });
  handlers.current = { onUpdate, notify };
  const currentId = useRef(id),
    currentJob = useRef(job);
  currentId.current = id;
  currentJob.current = job;
  const mounted = useRef(false),
    inFlight = useRef(false),
    pollRequested = useRef(false);
  const generation = useRef(0),
    failures = useRef(0),
    startLock = useRef(false),
    cancelLock = useRef(false);
  const observed = useRef(''),
    notified = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const poll = useRef<() => Promise<void>>(async () => {});
  const clearTimer = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const requestPoll = useCallback(() => {
    clearTimer();
    if (!mounted.current || !currentId.current) return;
    if (inFlight.current) {
      pollRequested.current = true;
      return;
    }
    void poll.current();
  }, [clearTimer]);

  poll.current = async () => {
    if (!mounted.current || !currentId.current || inFlight.current) return;
    inFlight.current = true;
    const jobId = currentId.current,
      attemptGeneration = generation.current;
    const active = () =>
      mounted.current && currentId.current === jobId && generation.current === attemptGeneration;
    const schedule = (delay: number) => {
      clearTimer();
      timer.current = setTimeout(requestPoll, delay);
    };
    try {
      const next = await advanceQueue(
        jobId,
        (path) => api.get<QueueJob>(path),
        (path, body) => api.post<QueueJob>(path, body),
        active,
        (durable) => {
          if (active()) {
            setJob(durable);
            currentJob.current = durable;
          }
        },
      );
      if (!active()) return;
      failures.current = 0;
      setError('');
      setJob(next);
      currentJob.current = next;
      remember(next);
      const signature = `${next.id}:${next.status}:${next.done}:${next.errors.length}`;
      if (observed.current !== signature) {
        observed.current = signature;
        handlers.current.onUpdate();
      }
      if (next.status === 'running') schedule(1500);
      else if (notified.current !== signature) {
        notified.current = signature;
        handlers.current.notify(
          next.status === 'cancelled'
            ? 'Очередь остановлена. Готовые оценки сохранены.'
            : next.status === 'failed'
              ? 'Очередь завершилась с ошибкой. Готовые оценки сохранены.'
              : `Оценка завершена${next.errors.length ? ` · ошибок: ${next.errors.length}` : ''}`,
          next.status === 'failed' ? 'error' : next.errors.length ? 'info' : 'success',
        );
      }
    } catch (cause) {
      if (!active()) return;
      if (cause instanceof ApiError && cause.status === 404) {
        remember(null);
        currentId.current = '';
        setId('');
        setJob(null);
        currentJob.current = null;
        setError(
          'Очередь не найдена. Готовые оценки сохранены; запустите набор снова для оставшихся диалогов.',
        );
        handlers.current.onUpdate();
      } else {
        const delay = Math.min(10000, 1500 * 2 ** Math.min(failures.current++, 3));
        setError(
          `Связь с очередью потеряна: ${errorMessage(cause)}. Повтор через ${Math.ceil(delay / 1000)} с.`,
        );
        schedule(delay);
      }
    } finally {
      inFlight.current = false;
      if (pollRequested.current && mounted.current && currentId.current) {
        pollRequested.current = false;
        clearTimer();
        timer.current = setTimeout(requestPoll, 0);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    requestPoll();
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, [id, requestPoll, clearTimer]);

  const start = useCallback(async (group: string, checklist: string, force: boolean) => {
    if (
      startLock.current ||
      (currentId.current && (!currentJob.current || currentJob.current.status === 'running'))
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
      generation.current++;
      failures.current = 0;
      observed.current = '';
      notified.current = '';
      currentId.current = created.id;
      currentJob.current = created;
      setJob(created);
      setId(created.id);
      setError('');
      remember(created);
      if (created.status !== 'running') handlers.current.onUpdate();
    } catch (cause) {
      handlers.current.notify(errorMessage(cause), 'error');
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }, []);
  const cancel = useCallback(async () => {
    const jobId = currentId.current;
    if (!jobId || cancelLock.current || currentJob.current?.status !== 'running') return;
    cancelLock.current = true;
    setCancelling(true);
    try {
      const result = await api.post<QueueJob | { ok: boolean }>(
        `/batch/${encodeURIComponent(jobId)}/cancel`,
        {},
      );
      if (currentId.current !== jobId) return;
      generation.current++;
      if ('id' in result) {
        setJob(result);
        currentJob.current = result;
        remember(result);
      }
      requestPoll();
    } catch (cause) {
      handlers.current.notify(errorMessage(cause), 'error');
    } finally {
      cancelLock.current = false;
      setCancelling(false);
    }
  }, [requestPoll]);
  const dismiss = useCallback(() => {
    if (currentJob.current?.status === 'running') return;
    generation.current++;
    currentId.current = '';
    currentJob.current = null;
    clearTimer();
    remember(null);
    setId('');
    setJob(null);
    setError('');
  }, [clearTimer]);
  return {
    job,
    error,
    starting,
    cancelling,
    running: !!id && (!job || job.status === 'running'),
    start,
    cancel,
    retry: requestPoll,
    dismiss,
  };
}
export type QueueController = ReturnType<typeof useQueue>;
