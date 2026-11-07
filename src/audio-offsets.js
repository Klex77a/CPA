'use strict';
/**
 * Участок аудиозаписи для каждой реплики звонка: {start, end} в секундах от начала файла.
 * Запись начинается с системного события и может прерываться паузой, а метки времени идут по часам звонка.
 * Константы измерены сравнением речи в записях DEV (5 звонков) с метками транскрипта:
 *  - метка стоит в конце реплики, поэтому начало оценивается по длине текста;
 *  - после возобновления запись идёт на 4,5 с позже, чем следует из меток паузы.
 * Без события начала записи соответствие неизвестно — возвращается null.
 */
const START_RE = /(запис|жазу|recording).*(запущен|басталды|started)/i;
const PAUSE_RE = /(запис|жазу|recording).*(приостановлен|тоқтатыл|кідірт|paused)/i;
const RESUME_RE = /(запис|жазу|recording).*(возобновлен|жалғас|resumed)/i;
const RESUME_SHIFT_S = 4.5;
const SPEECH_CHARS_PER_S = 14;
const MIN_SPEECH_S = 0.6;
const LEAD_S = 0.3; // небольшой запас, чтобы не обрезать первое слово

const round1 = (n) => Math.round(n * 10) / 10;

function audioSegments(record) {
  const tr = record.transcript || [];
  if (record.channel !== 'voice call' || !record.audio_url) return tr.map(() => null);
  let start = null, pausedAt = null, removed = 0, prevEnd = 0;
  return tr.map((m) => {
    const t = Date.parse(m.timestamp) / 1000;
    if (Number.isNaN(t)) return null;
    const isSystem = m.speaker === 'system';
    if (isSystem) {
      if (start == null && START_RE.test(m.text)) start = t;
      else if (start != null && pausedAt == null && PAUSE_RE.test(m.text)) pausedAt = t;
      else if (pausedAt != null && RESUME_RE.test(m.text)) { removed += Math.max(0, t - pausedAt - RESUME_SHIFT_S); pausedAt = null; }
    }
    if (start == null || (pausedAt != null && !isSystem)) return null;
    const end = (pausedAt ?? t) - start - removed;
    const speech = isSystem ? 0 : Math.max(MIN_SPEECH_S, String(m.text || '').length / SPEECH_CHARS_PER_S);
    const begin = Math.max(prevEnd, end - speech);
    prevEnd = Math.max(prevEnd, end);
    return { start: round1(Math.max(0, begin - LEAD_S)), end: round1(Math.max(end, 0)) };
  });
}

module.exports = { audioSegments };
