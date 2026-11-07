import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import type { Appeal, Checklist, Config, DatasetSummary } from './types';
import { Button, Spinner } from './components/ui';
import Icon from './components/Icon';
import { useQueue, type QueueController } from './pages/workspace/useQueue';

type NoticeKind = 'success' | 'error' | 'info';
export interface ConversationOrder {
  groupId: string;
  ids: string[];
}
interface WorkspaceValue {
  config: Config;
  datasets: DatasetSummary[];
  checklists: Checklist[];
  group: string;
  setGroup: (value: string) => void;
  checklistId: string;
  setChecklistId: (value: string) => void;
  openAppeals: number;
  refreshBase: () => Promise<void>;
  notify: (message: string, kind?: NoticeKind) => void;
  conversationOrder: ConversationOrder | null;
  setConversationOrder: (value: ConversationOrder | null) => void;
  queue: QueueController;
  evaluationRevision: number;
}
const Context = createContext<WorkspaceValue | null>(null);
const saved = (name: string, fallback: string) => {
  try {
    return localStorage.getItem('cqa.' + name) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (name: string, value: string) => {
  try {
    localStorage.setItem('cqa.' + name, value);
  } catch {
    /* Private browsing can disable storage. */
  }
};
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error('Workspace provider is missing');
  return value;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<Config | null>(null),
    [datasets, setDatasets] = useState<DatasetSummary[]>([]),
    [checklists, setChecklists] = useState<Checklist[]>([]),
    [openAppeals, setOpenAppeals] = useState(0);
  const [group, updateGroup] = useState(() => saved('group', 'DEV')),
    [checklistId, updateChecklist] = useState(() => saved('checklist', 'default'));
  const [error, setError] = useState<Error | null>(null),
    [conversationOrder, setConversationOrder] = useState<ConversationOrder | null>(null);
  const [notice, setNotice] = useState<{ message: string; kind: NoticeKind } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [evaluationRevision, setEvaluationRevision] = useState(0);
  const notify = useCallback((message: string, kind: NoticeKind = 'success') => {
    setNotice({ message, kind });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), kind === 'error' ? 8000 : 4500);
  }, []);
  const queueUpdated = useCallback(() => setEvaluationRevision((value) => value + 1), []);
  const queue = useQueue(queueUpdated, notify);
  const setGroup = useCallback((value: string) => {
    updateGroup(value);
    save('group', value);
    setConversationOrder(null);
  }, []);
  const setChecklistId = useCallback((value: string) => {
    updateChecklist(value);
    save('checklist', value);
  }, []);
  const refreshBase = useCallback(async (signal?: AbortSignal) => {
    const [nextConfig, nextDatasets, nextChecklists, appeals] = await Promise.all([
      api.get<Config>('/config', signal),
      api.get<DatasetSummary[]>('/datasets', signal),
      api.get<Checklist[]>('/checklists', signal),
      api.get<Appeal[]>('/appeals?status=open', signal),
    ]);
    if (signal?.aborted) return;
    setConfig(nextConfig);
    setDatasets(nextDatasets);
    setChecklists(nextChecklists);
    setOpenAppeals(appeals.length);
    setError(null);
    updateGroup((value) => {
      const next = nextDatasets.some((dataset) => dataset.group_id === value)
        ? value
        : nextDatasets.find((dataset) => dataset.group_id === 'DEV')?.group_id ||
          nextDatasets[0]?.group_id ||
          '';
      save('group', next);
      return next;
    });
    updateChecklist((value) => {
      const next = nextChecklists.some((checklist) => checklist.id === value) ? value : 'default';
      save('checklist', next);
      return next;
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    refreshBase(controller.signal).catch((value) => {
      if (!controller.signal.aborted)
        setError(value instanceof Error ? value : new Error('Не удалось подключиться к серверу'));
    });
    return () => {
      controller.abort();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [refreshBase]);
  if (!config)
    return (
      <div className="cqa cqa-boot">
        <img src="/assets/freedom-logo.svg" alt="Freedom" />
        {error ? (
          <>
            <h1>Не удалось подключиться</h1>
            <p>{error.message}</p>
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                refreshBase().catch(setError);
              }}
            >
              Повторить подключение
            </Button>
          </>
        ) : (
          <Spinner label="Открываем рабочее пространство" />
        )}
      </div>
    );
  return (
    <Context.Provider
      value={{
        config,
        datasets,
        checklists,
        group,
        setGroup,
        checklistId,
        setChecklistId,
        openAppeals,
        refreshBase,
        notify,
        conversationOrder,
        setConversationOrder,
        queue,
        evaluationRevision,
      }}
    >
      {children}
      {notice && (
        <div
          className={`cqa cqa-toast ${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          <Icon name={notice.kind === 'error' ? 'warning' : 'check'} />
          <span>{notice.message}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Закрыть уведомление"
            onClick={() => setNotice(null)}
            icon={<Icon name="close" />}
          />
        </div>
      )}
    </Context.Provider>
  );
}
