import { Button } from '../../components/ui';
import Icon from '../../components/Icon';
import { costDescription } from '../../format';
import type { QueueController } from './useQueue';
import '../../styles/pages.css';

export default function QueueStatus({ queue }: { queue?: QueueController }) {
  if (!queue || (!queue.job && !queue.error && !queue.running && !queue.starting)) return null;
  const { job } = queue;
  const title = queue.starting
    ? 'Запускаем оценку'
    : queue.running
      ? `Оценка${job?.group_id ? ` ${job.group_id}` : ' набора'}`
      : job?.status === 'cancelled'
        ? 'Очередь остановлена'
        : job?.status === 'failed'
          ? 'Ошибка очереди'
          : job
            ? 'Оценка завершена'
            : 'Очередь недоступна';
  return (
    <section
      className={`cqa-global-queue ${queue.error || job?.status === 'failed' ? 'has-error' : ''}`}
      aria-label="Очередь оценки"
    >
      <div className="cqa-global-queue-line">
        <Icon
          name={queue.running ? 'refresh' : job?.status === 'failed' ? 'warning' : 'check'}
          size={17}
        />
        <div className="cqa-global-queue-heading" aria-live="polite">
          <strong>{title}</strong>
          <span>
            {job
              ? `${job.done} / ${job.total} · ошибок ${job.errors.length} · ${costDescription(job)}`
              : 'Восстанавливаем сохранённую задачу…'}
          </span>
        </div>
        <a href="#/list" className="cqa-text-link">
          К диалогам
        </a>
        {queue.error && queue.running && (
          <Button size="sm" variant="secondary" onClick={queue.retry}>
            Повторить связь
          </Button>
        )}
        {queue.running && (
          <Button
            size="sm"
            variant="secondary"
            loading={queue.cancelling}
            disabled={!job}
            onClick={() => void queue.cancel()}
          >
            Остановить
          </Button>
        )}
        {!queue.running && !queue.starting && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={job ? 'Скрыть завершённую очередь' : 'Скрыть сообщение очереди'}
            onClick={queue.dismiss}
            icon={<Icon name="close" size={15} />}
          />
        )}
      </div>
      {queue.running && job && (
        <progress aria-label="Прогресс оценки набора" value={job.done} max={job.total || 1} />
      )}
      {queue.error ? (
        <p role="status">{queue.error}</p>
      ) : (
        queue.running && (
          <p>
            {job?.execution_mode === 'stepped'
              ? 'Можно переходить между разделами. При закрытии вкладки обработка приостановится; при следующем открытии продолжится.'
              : 'Можно переходить между разделами — очередь продолжит работу.'}
          </p>
        )
      )}
      {!queue.running && job && job.errors.length > 0 && (
        <details>
          <summary>Причины ошибок · {job.errors.length}</summary>
          {job.errors.map((item, index) => (
            <p key={index}>
              {item.conversation_id ? `${item.conversation_id}: ` : ''}
              {item.error}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
