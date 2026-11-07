import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { useHashRoute } from './hooks';
import { useWorkspace } from './Workspace';
import Icon from './components/Icon';
import { Badge, Button, ErrorState, Spinner } from './components/ui';
import QueueStatus from './pages/workspace/QueueStatus';
const ConversationsPage = lazy(() => import('./pages/ConversationsPage'));
const ConversationPage = lazy(() => import('./pages/ConversationPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AppealsPage = lazy(() => import('./pages/AppealsPage'));
const ChecklistsPage = lazy(() => import('./pages/ChecklistsPage'));
const OperatorPage = lazy(() => import('./pages/OperatorPage'));

class PageBoundary extends Component<
  { children: ReactNode; route: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(previous: { route: string }) {
    if (previous.route !== this.props.route && this.state.error) this.setState({ error: null });
  }
  render() {
    return this.state.error ? (
      <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />
    ) : (
      this.props.children
    );
  }
}
const navigation = [
  {
    id: 'dashboard',
    label: 'Аналитика',
    icon: 'dashboard' as const,
    description: 'Качество команды',
  },
  { id: 'list', label: 'Диалоги', icon: 'message' as const, description: 'Оценка и разбор' },
  {
    id: 'appeals',
    label: 'Апелляции',
    icon: 'appeal' as const,
    description: 'Решения проверяющего',
  },
  {
    id: 'checklist',
    label: 'Чек-лист',
    icon: 'checklist' as const,
    description: 'Критерии оценки',
  },
];

export default function App() {
  const route = useHashRoute(),
    workspace = useWorkspace();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.getElementById('cqa-sidebar');
    const background = document.querySelector<HTMLElement>('.cqa-workspace');
    if (background) background.inert = true;
    const controls = () =>
      Array.from(sidebar?.querySelectorAll<HTMLElement>('*') || []).filter((element) =>
        element.matches('a[href],button:not(:disabled)'),
      );
    controls()[0]?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key !== 'Tab') return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const resize = () => {
      if (window.innerWidth > 760) setMobileOpen(false);
    };
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', resize);
    return () => {
      if (background) background.inert = false;
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', resize);
      previous?.focus({ preventScroll: true });
    };
  }, [mobileOpen]);
  const section =
    route[0] === 'card'
      ? 'list'
      : route[0] === 'operator'
        ? 'dashboard'
        : route[0] === 'checklists'
          ? 'checklist'
          : route[0];
  const current = navigation.find((item) => item.id === section) || navigation[1];
  const title =
    route[0] === 'card'
      ? 'Карточка диалога'
      : route[0] === 'operator'
        ? 'Профиль оператора'
        : current.label;
  useEffect(() => {
    document.title = `Freedom CQA · ${title}`;
  }, [title]);
  let page: ReactNode;
  switch (route[0]) {
    case 'card':
      page =
        route[1] && route[2] ? (
          <ConversationPage groupId={route[1]} conversationId={route[2]} evaluationId={route[3]} />
        ) : (
          <ErrorState error="В ссылке отсутствует ID диалога" />
        );
      break;
    case 'dashboard':
      page = <DashboardPage />;
      break;
    case 'operator':
      page = (
        <OperatorPage
          groupId={route[2] ? route[1] : workspace.group}
          operatorName={route[2] || route[1] || ''}
        />
      );
      break;
    case 'appeals':
      page = <AppealsPage />;
      break;
    case 'checklists':
    case 'checklist':
      page = <ChecklistsPage />;
      break;
    default:
      page = <ConversationsPage />;
  }
  return (
    <div className={`cqa-app-shell ${mobileOpen ? 'sidebar-open' : ''}`}>
      <a
        className="cqa-skip-link"
        href="#cqa-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('cqa-content')?.focus();
        }}
      >
        Перейти к содержимому
      </a>
      {mobileOpen && (
        <button
          className="cqa-sidebar-scrim"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className="cqa-sidebar"
        id="cqa-sidebar"
        aria-label="Рабочее пространство"
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen || undefined}
      >
        <Button
          className="cqa-sidebar-close"
          variant="ghost"
          aria-label="Закрыть навигацию"
          onClick={() => setMobileOpen(false)}
          icon={<Icon name="close" />}
        />
        <a
          href="#/list"
          className="cqa-logo"
          aria-label="Freedom CQA — диалоги"
          onClick={() => setMobileOpen(false)}
        >
          <img src="/assets/freedom-logo.svg" alt="Freedom" />
        </a>
        <div className="cqa-product">
          <span>CQA</span>
          <div>
            <strong>Контроль качества</strong>
            <small>Рабочее пространство</small>
          </div>
        </div>
        <p className="cqa-nav-label">Обзор команды</p>
        <nav className="cqa-navigation" aria-label="Основная навигация">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              className={current.id === item.id ? 'active' : ''}
              aria-current={current.id === item.id ? 'page' : undefined}
              onClick={() => setMobileOpen(false)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'appeals' && workspace.openAppeals > 0 && <b>{workspace.openAppeals}</b>}
            </a>
          ))}
        </nav>
        <div className="cqa-sidebar-bottom">
          <div className="cqa-engine">
            <span className="cqa-status-dot" />
            <div>
              <strong>{workspace.config.provider === 'mock' ? 'Демо-режим' : 'Оценка с ИИ'}</strong>
              <span>{workspace.config.model}</span>
            </div>
            <Icon name="sparkles" size={17} />
          </div>
          <div className="cqa-sidebar-foot">
            <span>Midnight Commit</span>
            <span>Freedom Broker · MVP</span>
          </div>
        </div>
      </aside>
      <div className="cqa-workspace">
        <header className="cqa-topbar">
          <div className="cqa-topbar-left">
            <Button
              className="cqa-menu-button"
              variant="ghost"
              aria-label="Открыть навигацию"
              aria-expanded={mobileOpen}
              aria-controls="cqa-sidebar"
              onClick={() => setMobileOpen((value) => !value)}
              icon={<Icon name="menu" />}
            />
            <span className="cqa-breadcrumb-root">Рабочее пространство</span>
            <span className="cqa-breadcrumb-divider">/</span>
            <strong>{title}</strong>
          </div>
          <div className="cqa-topbar-right">
            <Badge tone={workspace.config.provider === 'mock' ? 'warning' : 'success'}>
              <span className="cqa-status-dot" />
              {workspace.config.provider === 'mock' ? 'Демо без ИИ' : 'ИИ подключён'}
            </Badge>
            <span className="cqa-topbar-divider" />
            <div className="cqa-team-avatar" aria-hidden="true">
              MC
            </div>
            <div className="cqa-team">
              <strong>Midnight Commit</strong>
              <span>Рабочая команда</span>
            </div>
          </div>
        </header>
        <QueueStatus queue={workspace.queue} />
        <main className="cqa-content" id="cqa-content" tabIndex={-1}>
          <PageBoundary route={route.join('/')}>
            <Suspense
              fallback={
                <div className="cqa-page-loading">
                  <Spinner />
                </div>
              }
            >
              {page}
            </Suspense>
          </PageBoundary>
        </main>
      </div>
    </div>
  );
}
