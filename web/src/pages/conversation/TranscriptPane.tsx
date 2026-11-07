import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Evaluation } from '../../types';
import { apiUrl } from '../../api';
import { SPEAKERS, scrollMessage, time, timestamp, type EvidenceFocus } from './helpers';

interface Props {
  groupId: string;
  conversationId: string;
  record: Conversation;
  evaluation: Evaluation | null;
  focus: EvidenceFocus | null;
  visible: boolean;
  onEvidence: (msg: number, range?: EvidenceFocus['range'], fragment?: string) => void;
}

function MarkedText({ text, needle }: { text: string; needle: string }) {
  if (!needle.trim()) return <>{text}</>;
  const pieces: React.ReactNode[] = [];
  const lower = text.toLocaleLowerCase();
  const search = needle.toLocaleLowerCase();
  let start = 0;
  let found = lower.indexOf(search);
  while (found >= 0) {
    pieces.push(
      text.slice(start, found),
      <mark key={found}>{text.slice(found, found + needle.length)}</mark>,
    );
    start = found + needle.length;
    found = lower.indexOf(search, start);
  }
  pieces.push(text.slice(start));
  return <>{pieces}</>;
}

const Message = memo(function Message({
  message,
  index,
  offset,
  active,
  focused,
  ranged,
  needle,
  onSeek,
  elementRef,
}: {
  message: Conversation['transcript'][number];
  index: number;
  offset: number | null;
  active: boolean;
  focused: boolean;
  ranged: boolean;
  needle: string;
  onSeek: (index: number) => void;
  elementRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={elementRef}
      tabIndex={-1}
      className={`conversation-message ${message.speaker}${active ? ' is-playing' : ''}${focused ? ' is-focused' : ''}${ranged ? ' is-range' : ''}`}
      data-message-index={index}
    >
      <div className="conversation-message-meta">
        <strong>
          <i aria-hidden="true" />
          {SPEAKERS[message.speaker] || message.speaker}
        </strong>
        <time title={String(message.timestamp)}>{timestamp(message.timestamp)}</time>
        <span className="conversation-message-number">№{index + 1}</span>
        {offset != null && (
          <button
            type="button"
            className="conversation-seek"
            title={`Слушать реплику ${index + 1} с ${time(offset)}`}
            onClick={() => onSeek(index)}
          >
            <span aria-hidden="true">▶</span> {time(offset)}
          </button>
        )}
      </div>
      <p>
        <MarkedText text={String(message.text || '')} needle={needle} />
      </p>
    </div>
  );
});

export default function TranscriptPane({
  groupId,
  conversationId,
  record,
  evaluation,
  focus,
  visible,
  onEvidence,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const messages = useRef<Array<HTMLDivElement | null>>([]);
  const followRef = useRef(true);
  const currentRef = useRef(-1);
  const [current, setCurrent] = useState(-1);
  const [position, setPosition] = useState(0);
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [audioError, setAudioError] = useState(false);
  const segments = useMemo(
    () => record.audio_segments || record.transcript.map(() => null),
    [record],
  );
  const duration =
    Math.max(1, ...segments.flatMap((segment) => (segment ? [segment.end] : []))) + 2;
  const playable = !!record.audio_url && !evaluation?.record_changed;
  const hasTimeline = playable && segments.some(Boolean);
  const externalAudio = /^https?:\/\//i.test(record.audio_url || '') ? record.audio_url : null;
  const percentage = (seconds: number) =>
    `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`;

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    setCurrent(-1);
    currentRef.current = -1;
    setPosition(0);
    setAudioError(false);
    setSpeaker(null);
    setQuery('');
  }, [record]);

  function seek(index: number) {
    const audio = audioRef.current;
    const segment = segments[index];
    if (!audio || !segment) return;
    audio.currentTime = segment.start;
    audio.play().catch(() => {
      /* Native controls remain available if autoplay is blocked. */
    });
    setCurrent(index);
    currentRef.current = index;
  }

  function focusMessage(index: number, play = true) {
    const element = messages.current[index];
    if (element && scroller.current) {
      scrollMessage(scroller.current, element);
      element.focus({ preventScroll: true });
    }
    if (play) seek(index);
  }

  useEffect(() => {
    if (!focus || !visible || !record.transcript[focus.msg]) return;
    setSpeaker(null);
    setQuery('');
    const frame = requestAnimationFrame(() => focusMessage(focus.msg));
    return () => cancelAnimationFrame(frame);
    // Message elements are read after filters have been removed and the mobile pane is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, visible, record]);

  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    setPosition(now);
    let index = -1;
    segments.forEach((segment, candidate) => {
      if (
        segment &&
        segment.start <= now + 0.35 &&
        record.transcript[candidate].speaker !== 'system'
      )
        index = candidate;
    });
    if (index === currentRef.current) return;
    currentRef.current = index;
    setCurrent(index);
    const element = messages.current[index];
    if (
      !followRef.current ||
      !visible ||
      !element ||
      !scroller.current ||
      (speaker && record.transcript[index]?.speaker !== speaker)
    )
      return;
    const box = scroller.current.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    if (rect.top < box.top + 12 || rect.bottom > box.bottom - 12)
      scrollMessage(scroller.current, element, false);
  }

  const issues = useMemo(() => {
    if (!evaluation || !hasTimeline) return [];
    return evaluation.final_result.criteria.flatMap((row) => {
      if (!(row.scored && row.raw < row.weight) && !(row.type === 'flag' && row.answer === 'YES'))
        return [];
      const answer = evaluation.final_criteria[row.id];
      const first = answer?.evidence?.[0]?.msg ?? answer?.missing_range?.from;
      if (first == null) return [];
      const audible = segments.findIndex((segment, index) => index >= first && segment != null);
      return audible < 0
        ? []
        : [
            {
              index: audible,
              range: answer?.missing_range || undefined,
              title:
                evaluation.checklist_snapshot.criteria.find((criterion) => criterion.id === row.id)
                  ?.title || row.id,
            },
          ];
    });
  }, [evaluation, segments, hasTimeline]);

  function step(indices: number[], direction: number) {
    const target =
      direction > 0
        ? indices.find((index) => index > current)
        : [...indices].reverse().find((index) => index < current);
    if (target == null) return;
    onEvidence(target, issues.find((issue) => issue.index === target)?.range);
  }

  const filters = ['client', 'operator', 'bot', 'system'].filter((role) =>
    record.transcript.some((message) => message.speaker === role),
  );
  const visibleCount = record.transcript.filter(
    (message) =>
      (!speaker || message.speaker === speaker) &&
      (!query || String(message.text).toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  ).length;
  const lanes = ['client', 'operator', 'bot']
    .map((role) => ({
      role,
      indices: segments.flatMap((segment, index) =>
        segment && record.transcript[index]?.speaker === role ? [index] : [],
      ),
    }))
    .filter((lane) => lane.indices.length);

  return (
    <section
      className="conversation-pane conversation-transcript-pane"
      aria-label="Транскрипт диалога"
    >
      <header className="conversation-pane-heading">
        <div>
          <h2>Диалог</h2>
          <span>
            {record.transcript.length} реплик · {record.language}
          </span>
        </div>
        <span className="conversation-pill">
          {record.channel === 'voice call' ? 'Звонок' : 'Чат'}
        </span>
      </header>
      {evaluation?.record_changed && (
        <div className="conversation-notice warning">
          {evaluation.record_snapshot
            ? 'Архив: показан исходный текст этой оценки. Встроенный плеер отключён, запись могла измениться.'
            : 'Текст изменился. Показана текущая версия; переходы к старым доказательствам отключены.'}
          {evaluation.record_snapshot && externalAudio && (
            <a href={externalAudio} target="_blank" rel="noopener noreferrer">
              Открыть исходную запись ↗
            </a>
          )}
        </div>
      )}
      {playable && (
        <div className="conversation-player">
          <audio
            ref={audioRef}
            controls
            preload="none"
            aria-label="Аудиозапись диалога"
            src={apiUrl(
              `/audio/${encodeURIComponent(groupId)}/${encodeURIComponent(conversationId)}`,
            )}
            onTimeUpdate={onTimeUpdate}
            onError={() => setAudioError(true)}
          />
          {audioError && (
            <p className="conversation-audio-error" role="status">
              Не удалось загрузить запись.{' '}
              {externalAudio && (
                <a href={externalAudio} target="_blank" rel="noopener noreferrer">
                  Открыть у организаторов ↗
                </a>
              )}
            </p>
          )}
          <div className="conversation-audio-tools">
            <label>
              Скорость{' '}
              <select
                aria-label="Скорость воспроизведения"
                value={speed}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setSpeed(value);
                  if (audioRef.current) audioRef.current.playbackRate = value;
                }}
              >
                {[0.75, 1, 1.25, 1.5, 2].map((value) => (
                  <option key={value} value={value}>
                    {String(value).replace('.', ',')}×
                  </option>
                ))}
              </select>
            </label>
            {hasTimeline && (
              <label className="conversation-checkbox">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(event) => setFollow(event.target.checked)}
                />
                Следить за записью
              </label>
            )}
          </div>
          {hasTimeline && (
            <details className="conversation-timeline">
              <summary>
                Дорожки участников <span>{time(duration)}</span>
              </summary>
              <div className="conversation-lanes">
                {lanes.map(({ role, indices }) => (
                  <div className={`conversation-lane ${role}`} key={role}>
                    <button
                      className={`conversation-lane-label${speaker === role ? ' active' : ''}`}
                      title={`Показать только реплики: ${SPEAKERS[role]}`}
                      onClick={() => setSpeaker(speaker === role ? null : role)}
                    >
                      {SPEAKERS[role]} <small>{indices.length}</small>
                    </button>
                    <div className="conversation-lane-track">
                      <input
                        type="range"
                        min={0}
                        max={duration}
                        step={1}
                        value={Math.min(duration, position)}
                        aria-label={`Место в записи: ${SPEAKERS[role]}`}
                        aria-valuetext={time(position)}
                        onChange={(event) => {
                          if (audioRef.current)
                            audioRef.current.currentTime = Number(event.target.value);
                        }}
                      />
                      {indices.map((index) => (
                        <button
                          key={index}
                          className="conversation-lane-mark"
                          tabIndex={-1}
                          title={`${time(segments[index]!.start)} · ${record.transcript[index].text}`}
                          style={{
                            left: percentage(segments[index]!.start),
                            width: percentage(
                              Math.max(0.6, segments[index]!.end - segments[index]!.start),
                            ),
                          }}
                          onClick={() => onEvidence(index)}
                        />
                      ))}
                      <i style={{ left: percentage(position) }} />
                    </div>
                    <div className="conversation-lane-nav">
                      <button
                        title={`Предыдущая реплика: ${SPEAKERS[role]}`}
                        aria-label={`Предыдущая реплика: ${SPEAKERS[role]}`}
                        onClick={() => step(indices, -1)}
                      >
                        ‹
                      </button>
                      <button
                        title={`Следующая реплика: ${SPEAKERS[role]}`}
                        aria-label={`Следующая реплика: ${SPEAKERS[role]}`}
                        onClick={() => step(indices, 1)}
                      >
                        ›
                      </button>
                    </div>
                  </div>
                ))}
                {!!issues.length && (
                  <div className="conversation-lane issue">
                    <span className="conversation-lane-label">
                      Замечания <small>{issues.length}</small>
                    </span>
                    <div className="conversation-lane-track">
                      {issues.map((issue, index) => (
                        <button
                          key={index}
                          className="conversation-lane-mark"
                          title={issue.title}
                          style={{ left: percentage(segments[issue.index]!.start) }}
                          onClick={() => onEvidence(issue.index, issue.range)}
                        />
                      ))}
                      <i style={{ left: percentage(position) }} />
                    </div>
                    <div className="conversation-lane-nav">
                      <button
                        title="Предыдущее замечание"
                        aria-label="Предыдущее замечание"
                        onClick={() =>
                          step(
                            [...new Set(issues.map((issue) => issue.index))].sort((a, b) => a - b),
                            -1,
                          )
                        }
                      >
                        ‹
                      </button>
                      <button
                        title="Следующее замечание"
                        aria-label="Следующее замечание"
                        onClick={() =>
                          step(
                            [...new Set(issues.map((issue) => issue.index))].sort((a, b) => a - b),
                            1,
                          )
                        }
                      >
                        ›
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <p>Моменты рассчитаны по меткам времени; возможна погрешность 1–2 секунды.</p>
            </details>
          )}
          {!hasTimeline && (
            <p className="conversation-muted">
              Соответствие меток времени и записи не задано. Автоматическая перемотка недоступна.
            </p>
          )}
        </div>
      )}
      <div className="conversation-transcript-tools">
        <label className="conversation-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти в диалоге"
            aria-label="Найти в диалоге"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Очистить поиск">
              ×
            </button>
          )}
        </label>
        <div className="conversation-speaker-filters" aria-label="Фильтр участников">
          <button
            aria-pressed={!speaker}
            className={!speaker ? 'active' : ''}
            onClick={() => setSpeaker(null)}
          >
            Все
          </button>
          {filters.map((role) => (
            <button
              key={role}
              aria-pressed={speaker === role}
              className={speaker === role ? 'active' : ''}
              onClick={() => setSpeaker(speaker === role ? null : role)}
            >
              {SPEAKERS[role] || role}
            </button>
          ))}
        </div>
      </div>
      <div
        className="conversation-message-scroller"
        ref={scroller}
        tabIndex={0}
        aria-label="Реплики диалога"
      >
        {record.channel === 'voice call' && (
          <div className="conversation-asr-note">
            Автоматическая расшифровка: спорные слова и роли сверяйте с записью.
          </div>
        )}
        {record.transcript.map((message, index) => {
          if (
            (speaker && message.speaker !== speaker) ||
            (query && !String(message.text).toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          )
            return null;
          return (
            <Message
              key={index}
              elementRef={(element) => {
                messages.current[index] = element;
              }}
              message={message}
              index={index}
              offset={playable ? (segments[index]?.start ?? null) : null}
              active={current === index}
              focused={focus?.msg === index}
              ranged={!!focus?.range && index >= focus.range.from && index <= focus.range.to}
              needle={query || (focus?.msg === index ? focus.fragment || '' : '')}
              onSeek={seek}
            />
          );
        })}
        {!visibleCount && (
          <div className="conversation-empty">
            <strong>Реплики не найдены</strong>
            <p>Измените текст поиска или выберите другого участника.</p>
            <button
              className="conversation-button secondary"
              onClick={() => {
                setSpeaker(null);
                setQuery('');
              }}
            >
              Сбросить фильтры
            </button>
          </div>
        )}
      </div>
      <footer className="conversation-transcript-footer">
        <span>
          {query || speaker
            ? `Показано ${visibleCount} из ${record.transcript.length}`
            : `${record.transcript.length} реплик`}
        </span>
        {hasTimeline && (
          <span>
            <i className="conversation-live-dot" /> {time(position)}
          </span>
        )}
      </footer>
    </section>
  );
}
