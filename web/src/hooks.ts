import { useCallback, useEffect, useRef, useState } from 'react';
export function useResource<T>(key: string, loader: (signal: AbortSignal) => Promise<T>) {
  const load = useRef(loader);
  load.current = loader;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error?: Error }>({
    key,
    loading: true,
  });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
    }));
    load
      .current(controller.signal)
      .then((data) => {
        if (active) setState({ key, data, loading: false });
      })
      .catch((error) => {
        if (active && error?.name !== 'AbortError')
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            loading: false,
            error: error instanceof Error ? error : new Error('Не удалось загрузить данные'),
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, revision]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return {
    data: state.key === key ? state.data : undefined,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : undefined,
    reload,
  };
}
export function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/list');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/list');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  try {
    return hash.split('?')[0].replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  } catch {
    return ['not-found'];
  }
}
export function navigate(path: string) {
  window.location.hash = path.startsWith('#')
    ? path
    : '#' + (path.startsWith('/') ? path : '/' + path);
}
