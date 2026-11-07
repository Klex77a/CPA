import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import type { Answer, Criterion, Tone } from '../types';
import { answerLabel, formatNumber, scoreTone } from '../format';

export function Spinner({ label = 'Загружаем данные' }: { label?: string }) {
  return (
    <span className="cqa-loading" role="status">
      <span className="cqa-spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  children,
  className = '',
  disabled,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      className={`cqa-button ${variant} ${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="cqa-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}
export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={`cqa-badge ${tone} ${className}`}>{children}</span>;
}
export function AnswerBadge({ criterion, answer }: { criterion?: Criterion; answer?: Answer }) {
  const tone: Tone =
    !answer || answer.answer === 'NA'
      ? 'neutral'
      : answer.answer === 'INVALID' || answer.review_required
        ? 'warning'
        : answer.answer === 'SCORE'
          ? 'info'
          : criterion?.type === 'flag'
            ? answer.answer === 'YES'
              ? 'danger'
              : 'success'
            : answer.answer === 'YES'
              ? 'success'
              : 'danger';
  return <Badge tone={tone}>{answerLabel(criterion, answer)}</Badge>;
}
export function Score({ value, size = 96 }: { value?: number | null; size?: number }) {
  const tone = scoreTone(value);
  return (
    <div
      className={`cqa-score-ring ${tone}`}
      role="img"
      aria-label={value == null ? 'Итог не рассчитан' : `${formatNumber(value)} из 100`}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(var(--cqa-score-color) ${Math.max(0, Math.min(100, value || 0))}%, var(--cqa-border) 0)`,
      }}
    >
      <div>
        <strong>{formatNumber(value)}</strong>
        <span>из 100</span>
      </div>
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={`cqa-panel ${className}`} {...props}>
      {(title || actions) && (
        <div className="cqa-panel-heading">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="cqa-panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="cqa-page-header">
      <div className="cqa-page-heading">
        {eyebrow && <div className="cqa-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="cqa-page-actions">{children}</div>}
    </header>
  );
}
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cqa-empty">
      <div className="cqa-empty-icon">{icon || <Icon name="message" size={26} />}</div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="cqa-error-state" role="alert">
      <Icon name="warning" size={24} />
      <h2>Не удалось загрузить данные</h2>
      <p>{error instanceof Error ? error.message : String(error || 'Попробуйте ещё раз.')}</p>
      {onRetry && (
        <Button onClick={onRetry} icon={<Icon name="refresh" />}>
          Повторить
        </Button>
      )}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const id = useId(),
    dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const workspace = document.querySelector('.cqa-app-shell') as HTMLElement | null;
    if (workspace) workspace.inert = true;
    const first = () =>
      dialog.current?.querySelector<HTMLElement>(
        '.cqa-modal-body input:not([disabled]),.cqa-modal-body textarea:not([disabled]),.cqa-modal-body select:not([disabled])',
      ) ||
      dialog.current?.querySelector<HTMLElement>('button:not([disabled]),a[href],[tabindex="0"]');
    first()?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]',
        ) || []),
      ];
      if (!elements.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const [firstEl, lastEl] = [elements[0], elements[elements.length - 1]];
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (workspace) workspace.inert = false;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className="cqa cqa-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`cqa-modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        ref={dialog}
        tabIndex={-1}
      >
        <div className="cqa-modal-header">
          <h2 id={id}>{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Закрыть окно"
            onClick={onClose}
            icon={<Icon name="close" />}
          />
        </div>
        <div className="cqa-modal-body">{children}</div>
        {footer && <div className="cqa-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
