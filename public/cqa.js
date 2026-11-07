/* CQA — интерфейс. Чистый JavaScript без фреймворков; монтируется в #cqa-app. */
(function () {
  'use strict';
  const CFG = Object.assign({ apiBase: '', mount: '#cqa-app' }, window.CQA_CONFIG || {});
  const root = document.querySelector(CFG.mount);
  if (!root) return;
  root.classList.add('cqa');

  // ---------- утилиты ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), (event) => {
        try { Promise.resolve(v(event)).catch((error) => toast(error.message || 'Не удалось выполнить действие', true)); }
        catch (error) { toast(error.message || 'Не удалось выполнить действие', true); }
      });
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    if (tag === 'button' && !el.hasAttribute('type')) el.type = 'button';
    if (attrs && attrs.onclick && ['tr', 'div'].includes(tag)) {
      el.tabIndex = 0;
      el.addEventListener('keydown', (event) => {
        if (event.target === el && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); el.click(); }
      });
    }
    return el;
  }
  async function api(method, path, body) {
    const r = await fetch(CFG.apiBase + '/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Ошибка ' + r.status), { status: r.status });
    return j;
  }
  // replaceChildren с поддержкой массивов и пропуском null/false
  function rc(el, ...kids) { el.replaceChildren(); for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k)); }
  let toastTimer;
  function toast(msg, err, warn) {
    document.querySelectorAll('.cqa-toast').forEach((t) => t.remove());
    const t = h('div', { class: 'cqa-toast' + (err ? ' err' : warn ? ' warn' : ''), role: err ? 'alert' : 'status', 'aria-live': err ? 'assertive' : 'polite' }, h('span', {}, msg), h('button', { class: 'cqa-toast-close', 'aria-label': 'Закрыть уведомление', onclick: () => t.remove() }, '×'));
    root.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 7000 : 3500);
  }
  const store = {
    get(k, d) { try { return localStorage.getItem('cqa.' + k) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('cqa.' + k, v); } catch (_) {} },
  };
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
  function timingLine(ev) {
    const t = ev.timing;
    if (!t) return h('div', {}, `${(ev.duration_ms / 1000).toFixed(1)} с`);
    const calls = (t.calls || []).length;
    const parts = [`всего ${(t.total_ms / 1000).toFixed(1)} с`, `модель ${((t.llm_ms || 0) / 1000).toFixed(1)} с`];
    if (calls > 1) parts.push(`запросов ${calls} (в т.ч. повтор после проверки)`);
    if ((t.http_attempts || 0) > calls) parts.push(`HTTP-попыток ${t.http_attempts}`);
    if (t.retry_wait_ms) parts.push(`ожидание повторов ${(t.retry_wait_ms / 1000).toFixed(1)} с`);
    if (t.queue_ms) parts.push(`в очереди ${(t.queue_ms / 1000).toFixed(1)} с`);
    parts.push(`токены ${ev.usage.input}/${ev.usage.output}${ev.usage.thoughts ? '+' + ev.usage.thoughts + ' размышл.' : ''}`);
    return h('div', {}, parts.join(' · '));
  }
  const SPEAKER = { operator: 'Оператор', client: 'Клиент', bot: 'Бот', system: 'Система' };
  const TYPE = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг (без баллов)' };

  function answerBadge(c, a) {
    if (!a) return h('span', { class: 'cqa-badge na' }, '—');
    if (a.answer === 'INVALID') return h('span', { class: 'cqa-badge warn' }, 'нет допустимого ответа');
    if (c && c.type === 'flag') return a.answer === 'YES' ? h('span', { class: 'cqa-badge gross' }, 'Выявлено') : h('span', { class: 'cqa-badge yes' }, 'Не выявлено');
    if (a.answer === 'YES') return h('span', { class: 'cqa-badge yes' }, 'Да');
    if (a.answer === 'NO') return h('span', { class: 'cqa-badge no' }, 'Нет');
    if (a.answer === 'NA') return h('span', { class: 'cqa-badge na' }, 'N/A');
    const max = c && c.scale ? Math.max(...c.scale.map((s) => s.value)) : '';
    return h('span', { class: 'cqa-badge score' }, `${a.value} из ${max}`);
  }
  const answerText = (c, a) => (a ? (a.answer === 'INVALID' ? 'Нет допустимого ответа' : a.answer === 'SCORE' ? `${a.value}` : c && c.type === 'flag' ? (a.answer === 'YES' ? 'Выявлено' : 'Не выявлено') : { YES: 'Да', NO: 'Нет', NA: 'N/A' }[a.answer] || '—') : '—');
  /** Доказательства трёх видов; текст берётся из исходного транскрипта по ID, а не из ответа модели. */
  function evidenceList(a, record, focus) {
    if (!focus) return h('div', { class: 'cqa-note' }, 'Доказательства относятся к предыдущему тексту диалога. Исходный текст не сохранён; переход к текущим репликам отключён.');
    const tr = record.transcript;
    const items = [];
    for (const e of a.evidence || []) {
      const m = tr[e.msg];
      if (!m) { items.push(h('span', { class: 'cqa-badge warn' }, `ссылка на несуществующую реплику №${e.msg + 1}`)); continue; }
      const text = String(m.text || '');
      const shown = e.fragment ? e.fragment : text.length > 160 ? text.slice(0, 160) + '…' : text;
      items.push(h('button', { class: 'cqa-evidence', onclick: () => focus(e.msg), title: 'Перейти к реплике' }, h('span', { class: 'cqa-chip' }, '№' + (e.msg + 1)), `${SPEAKER[m.speaker] || m.speaker}: «${shown}»`));
    }
    if (a.missing_range) items.push(h('button', { class: 'cqa-evidence', onclick: () => focus(a.missing_range.from, a.missing_range) }, h('span', { class: 'cqa-chip', style: 'background:var(--warn-bg);color:var(--warn)' }, `№${a.missing_range.from + 1}–${a.missing_range.to + 1}`), 'Здесь действие ожидалось, но отсутствует'));
    if (a.checked_range) items.push(h('button', { class: 'cqa-evidence', onclick: () => focus(a.checked_range.from, a.checked_range) }, h('span', { class: 'cqa-chip' }, `№${a.checked_range.from + 1}–${a.checked_range.to + 1}`), a.checked_range.from === 0 && a.checked_range.to === tr.length - 1 ? 'Проверен весь диалог' : 'Проверенный участок разговора'));
    if (!items.length) items.push(h('span', { class: 'cqa-small cqa-muted' }, 'Доказательства не указаны'));
    return h('div', { class: 'cqa-ev' }, items);
  }
  function totalBadge(total) {
    if (total == null) return h('span', { class: 'cqa-muted' }, '—');
    const cls = total >= 85 ? 'yes' : total >= 60 ? 'warn' : 'no';
    return h('span', { class: 'cqa-badge ' + cls }, fmt(total));
  }

  /** Короткая метка для показа: у звонков ISO 8601 → ЧЧ:ММ:СС. Исходное значение остаётся в подсказке. */
  const shortTs = (ts) => { const m = String(ts).match(/T(\d\d:\d\d:\d\d)/); return m ? m[1] : ts; };
  const mmss = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

  // ---------- состояние ----------
  const activeCloudJob = store.get('activeCloudJob', '');
  const S = { config: null, datasets: [], checklists: [], group: store.get('group', ''), checklist: store.get('checklist', 'default'), job: activeCloudJob ? { id: activeCloudJob, status: 'running', execution_mode: 'stepped' } : null, openAppeals: 0,
    listFilter: { q: '', quick: 'all', channel: '', lang: '', sort: 'id', dir: 1 }, listOrder: [], listGroup: '', cardNav: null };

  async function loadBase() {
    const [config, datasets, checklists, appeals] = await Promise.all([api('GET', '/config'), api('GET', '/datasets'), api('GET', '/checklists'), api('GET', '/appeals?status=open')]);
    S.config = config;
    S.datasets = datasets;
    S.checklists = checklists;
    S.openAppeals = appeals.length;
    if (!S.datasets.find((d) => d.group_id === S.group)) S.group = S.datasets[0] ? S.datasets[0].group_id : '';
    if (!S.checklists.find((c) => c.id === S.checklist)) S.checklist = 'default';
  }

  // ---------- каркас ----------
  const ICONS = {
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    appeal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 21h20zM12 10v5M12 18h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5m0 14h16M8 14l4-5 4 3 4-7"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 3 3 5-3 3a15 15 0 0 0 5 5l3-3 5 3-1 4c-1 3-9 0-13-4S0 4 3 3l5-1Z"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5"/></svg>',
  };
  const icon = (k) => h('span', { class: 'cqa-icon', html: ICONS[k] || ICONS.list, 'aria-hidden': 'true' });
  const main = h('main', { class: 'cqa-main', id: 'cqa-main', tabindex: '-1' });
  const nav = h('nav', { class: 'cqa-nav', 'aria-label': 'Основная навигация' });
  const modelBox = h('div', { class: 'cqa-side-foot' });
  const shellBreadcrumb = h('div', { class: 'cqa-breadcrumb' });
  const shellModel = h('div', { class: 'cqa-shell-model' });
  const shellHeader = h('header', { class: 'cqa-shell-header' },
    shellBreadcrumb,
    h('div', { class: 'cqa-shell-meta' }, shellModel,
      h('div', { class: 'cqa-team' }, h('span', { class: 'cqa-team-avatar', 'aria-hidden': 'true' }, 'MC'), h('div', {}, h('b', {}, 'Midnight Commit'), h('small', {}, 'Рабочая команда')))));
  root.append(
    h('a', { class: 'cqa-skip', href: '#cqa-main', onclick: (e) => { e.preventDefault(); main.focus(); } }, 'К содержимому'),
    h('aside', { class: 'cqa-side' },
      h('a', { class: 'cqa-brand', href: '#/dashboard', 'aria-label': 'Freedom CQA — обзор качества' }, h('img', { class: 'cqa-brand-logo', src: 'assets/freedom-logo.svg', alt: 'Freedom', width: 166, height: 38 })),
      h('div', { class: 'cqa-product' }, h('span', {}, 'CQA'), h('div', {}, 'Контроль качества', h('small', {}, 'Freedom Broker'))),
      h('div', { class: 'cqa-nav-label' }, 'Рабочее пространство'), nav, modelBox,
      h('div', { class: 'cqa-side-note' }, 'CQA · MVP', h('small', {}, 'Хакатон Freedom Broker'))),
    h('div', { class: 'cqa-workspace' }, shellHeader, main));

  let viewSequence = 0;
  function startView(active) {
    const sequence = ++viewSequence;
    renderTop(active);
    return () => sequence === viewSequence;
  }
  const loading = () => h('div', { class: 'cqa-loading', role: 'status' }, h('span', { class: 'cqa-spinner', 'aria-hidden': 'true' }), 'Загружаем данные…');

  function renderTop(active) {
    const positions = { dashboard: '01', list: '02', appeals: '03', checklist: '04' };
    const item = (href, key, ico, label, extra) => h('a', { href, 'aria-current': active === key || (key === 'list' && active === 'card') ? 'page' : null, class: active === key || (key === 'list' && active === 'card') ? 'active' : '' }, icon(ico), h('span', { class: 'cqa-nav-title' }, label), extra || h('span', { class: 'cqa-nav-index', 'aria-hidden': 'true' }, positions[key]));
    rc(nav,
      item('#/dashboard', 'dashboard', 'dash', 'Аналитика'),
      item('#/list', 'list', 'list', 'Диалоги'),
      item('#/appeals', 'appeals', 'appeal', 'Апелляции', S.openAppeals ? h('span', { class: 'cqa-count' }, S.openAppeals) : null),
      item('#/checklist', 'checklist', 'check', 'Чек-лист'));
    const c = S.config || {};
    const titles = { dashboard: 'Аналитика', list: 'Диалоги', card: 'Карточка диалога', appeals: 'Апелляции', checklist: 'Чек-лист', operator: 'Результаты оператора' };
    rc(shellBreadcrumb, h('span', {}, 'Рабочее пространство'), h('span', { class: 'cqa-breadcrumb-sep', 'aria-hidden': 'true' }, '/'), h('b', {}, titles[active] || 'Контроль качества'));
    rc(shellModel, h('span', { class: 'cqa-dot' + (c.provider === 'mock' ? ' demo' : '') }), c.provider === 'mock' ? 'Демо-режим' : `ИИ · ${c.model || c.provider || 'Загрузка'}`);
    rc(modelBox, h('div', { class: 'cqa-model-label' }, icon('spark'), 'Оценка с ИИ'),
      h('b', {}, `${c.provider || ''} / ${c.model || ''}`),
      c.provider === 'mock' ? h('div', { class: 'cqa-demo' }, 'Демо · оценка по правилам') : h('div', {}, (c.samples || 1) > 1 ? `голосование: ${c.samples} прогона` : 'один прогон на диалог'));
  }
  const pageHead = (title, sub, ...actions) => h('header', { class: 'cqa-page-head' }, h('div', { class: 'cqa-grow' }, h('div', { class: 'cqa-page-kicker' }, 'FREEDOM BROKER · CQA'), h('h1', {}, title), sub ? h('p', {}, sub) : null), actions.length ? h('div', { class: 'cqa-page-actions' }, actions) : null);
  const AVATAR_BG = ['#164734', '#007d35', '#365c4a', '#53725e', '#285b52'];
  const avatar = (name) => {
    const n = String(name || '?');
    let hsh = 0; for (const ch of n) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    return h('span', { class: 'cqa-avatar', style: `background:${AVATAR_BG[hsh % AVATAR_BG.length]}` }, n.slice(0, 1).toUpperCase());
  };
  const scoreColor = (t) => (t == null ? 'var(--muted)' : t >= 85 ? 'var(--good)' : t >= 60 ? 'var(--warn)' : 'var(--bad)');
  const ring = (t, label) => h('div', { class: 'cqa-ring', style: `--p:${t == null ? 0 : t};--c:${scoreColor(t)}` }, h('div', {}, h('b', { style: `color:${scoreColor(t)}` }, fmt(t)), h('span', {}, label || 'из 100')));

  /** Окно подтверждения внутри страницы (работает и во встроенном компоненте Dynamics 365). */
  function confirmBox(title, text, okLabel) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const siblings = [...root.children];
      const inertBefore = siblings.map((el) => el.inert);
      let closed = false;
      const close = (v) => { if (closed) return; closed = true; back.remove(); siblings.forEach((el, i) => { el.inert = inertBefore[i]; }); document.removeEventListener('keydown', onKey); if (previous && previous.isConnected) previous.focus(); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Tab') {
          const buttons = [...back.querySelectorAll('button')];
          if (e.shiftKey && document.activeElement === buttons[0]) { e.preventDefault(); buttons.at(-1).focus(); }
          else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); }
        }
      };
      const cancel = h('button', { class: 'cqa-btn', onclick: () => close(false) }, 'Отмена');
      const back = h('div', { class: 'cqa-modal-back', onclick: (e) => { if (e.target === back) close(false); } },
        h('div', { class: 'cqa-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cqa-confirm-title' }, h('h2', { id: 'cqa-confirm-title' }, title), h('p', {}, text),
          h('div', { class: 'cqa-row', style: 'justify-content:flex-end' }, cancel, h('button', { class: 'cqa-btn danger-fill', onclick: () => close(true) }, okLabel))));
      document.addEventListener('keydown', onKey);
      siblings.forEach((el) => { el.inert = true; });
      root.append(back);
      cancel.focus();
    });
  }

  /** Очищает результат строки. Возвращает true, если результат удалён. */
  async function clearResult(gid, cid, checklistId, list) {
    const appeals = list.reduce((s, e) => s + e.appeals_total, 0);
    const ok = await confirmBox(`Очистить результат ${cid}?`,
      `Будет удалено оценок: ${list.length}${appeals ? `, апелляций: ${appeals}` : ''}. Восстановить их нельзя, новая оценка снова потратит запрос к ИИ. Сам диалог останется в наборе.`,
      'Очистить');
    if (!ok) return false;
    try {
      await api('DELETE', `/evaluations?group_id=${encodeURIComponent(gid)}&conversation_id=${encodeURIComponent(cid)}&checklist_id=${encodeURIComponent(checklistId)}`);
      await loadBase();
      toast(`Результат ${cid} очищен`);
      return true;
    } catch (e) { toast(e.message, true); return false; }
  }

  function checklistSelect(onchange) {
    return h('select', { class: 'cqa-select', onchange: (e) => { S.checklist = e.target.value; store.set('checklist', S.checklist); onchange && onchange(); } },
      S.checklists.map((c) => h('option', { value: c.id, selected: c.id === S.checklist }, `${c.name} · v${c.version}`)));
  }

  // ================= СПИСОК ДИАЛОГОВ =================
  async function viewList() {
    const isCurrent = startView('list');
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: onUpload });
    const groupInput = h('input', { class: 'cqa-input', 'aria-label': 'Идентификатор набора для загрузки', placeholder: 'Например, DEV', value: S.group || 'DEV', style: 'width:150px', onkeydown: (e) => { if (e.key === 'Enter') onFetch(); } });
    const forceBox = h('input', { type: 'checkbox', id: 'cqa-force' });
    const progress = h('div', { class: 'cqa-row', 'aria-live': 'polite' });
    const tableBox = h('div', {}, loading());
    const overview = h('div', { class: 'cqa-kpis cqa-list-overview' });
    const teamInput = h('input', { class: 'cqa-input', value: store.get('teamName', 'Midnight Commit'), placeholder: 'Название вашей команды', maxlength: 120, required: true, oninput: (e) => store.set('teamName', e.target.value) });
    const splitSelect = h('select', { class: 'cqa-select' }, h('option', { value: 'dev', selected: !/prod/i.test(S.group) }, 'DEV · 65 диалогов'), h('option', { value: 'prod', selected: /prod/i.test(S.group) }, 'PROD · 10 диалогов'));
    const exportStatus = h('div', { class: 'cqa-small', role: 'status' });
    const exportButton = h('button', { class: 'cqa-btn primary', onclick: downloadSubmission }, 'Скачать results.json');
    const submissionBox = h('section', { class: 'cqa-panel cqa-submission', hidden: true, 'aria-label': 'Результаты для сдачи' },
      h('div', { class: 'cqa-row' }, h('h2', { class: 'cqa-grow', style: 'margin:0' }, 'Результаты для сдачи'), h('button', { class: 'cqa-btn sm', 'aria-label': 'Закрыть экспорт результатов', onclick: () => { submissionBox.hidden = true; } }, 'Закрыть')),
      h('p', { class: 'cqa-muted cqa-small' }, 'JSON по схеме организаторов. Нужен полный набор: 65 диалогов DEV или 10 PROD. Ошибки обработки останутся отдельными записями без балла. Демо-оценки для сдачи не подходят.'),
      h('div', { class: 'cqa-row' }, h('label', { class: 'cqa-field cqa-grow' }, 'Название команды', teamInput), h('label', { class: 'cqa-field' }, 'Набор для сдачи', splitSelect), h('div', { class: 'cqa-control-actions' }, exportButton)),
      h('p', { class: 'cqa-small cqa-muted' }, 'Сохраните файл в results/dev/results.json или results/prod/results.json своего репозитория. CSV подходит для анализа; на сдачу нужен JSON.'), exportStatus);
    async function downloadSubmission() {
      if (!teamInput.value.trim()) { toast('Укажите название команды', true); teamInput.focus(); return; }
      exportButton.disabled = true; exportStatus.textContent = 'Проверяем результаты…';
      try {
        const query = new URLSearchParams({ group_id: S.group, checklist_id: S.checklist, team_name: teamInput.value.trim(), split: splitSelect.value });
        const results = await api('GET', '/export.json?' + query);
        const url = URL.createObjectURL(new Blob([JSON.stringify(results, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }));
        const link = h('a', { href: url, download: 'results.json', style: 'display:none' }); root.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const successful = results.results.filter((result) => result.status === 'ok').length;
        const failed = results.results.filter((result) => result.status === 'error').length;
        exportStatus.textContent = `Файл скачан. Оценено успешно: ${successful}; с ошибками без балла: ${failed}. ` + (failed ? 'Проверьте ошибки перед сдачей.' : 'Сохраните файл в папку выбранного набора.');
        exportStatus.style.color = failed ? 'var(--warn)' : 'var(--good)';
        toast(failed ? `JSON скачан: ${successful} успешных оценок, ${failed} ошибок. Проверьте записи без балла перед сдачей.` : `JSON скачан: ${successful} успешных оценок, ошибок нет.`, false, failed > 0);
      } catch (error) { exportStatus.textContent = error.message; toast(error.message, true); }
      finally { exportButton.disabled = false; }
    }
    const F = S.listFilter;
    const chipsBox = h('div', { class: 'cqa-chips' });
    let dsCache = null, rowsCache = [];
    const QUICK = [
      ['all', 'Все', () => true],
      ['todo', 'Не оценены', (x) => !x.ev],
      ['review', 'Нужна проверка', (x) => x.ev && x.ev.status === 'needs_review'],
      ['gross', 'Грубые ошибки', (x) => x.ev && x.ev.gross_error],
      ['low', 'Ниже 60', (x) => x.ev && x.ev.final_total != null && x.ev.final_total < 60],
      ['appeal', 'Открытые апелляции', (x) => x.ev && x.ev.appeals_open > 0],
      ['changed', 'Изменены апелляцией', (x) => x.ev && x.ev.final_total !== x.ev.original_total],
      ['noname', 'Не представились', (x) => x.ev && !x.ev.operator_name],
    ];
    const searchInput = h('input', { class: 'cqa-input cqa-search', type: 'search', 'aria-label': 'Поиск по ID диалога или имени оператора', placeholder: 'Найти диалог или оператора', value: F.q, oninput: (e) => { F.q = e.target.value; renderTable(); } });
    const pickFilter = (key, all, opts) => h('select', { class: 'cqa-select', 'aria-label': key === 'channel' ? 'Фильтр по каналу' : 'Фильтр по языку', onchange: (e) => { F[key] = e.target.value; renderTable(); } },
      h('option', { value: '' }, all), opts.map(([v, l]) => h('option', { value: v, selected: F[key] === v }, l)));
    const channelSelect = pickFilter('channel', 'Все каналы', [['agent chat', 'Чаты'], ['voice call', 'Звонки']]);
    const langSelect = pickFilter('lang', 'Все языки', [['RU', 'Русский'], ['KZ', 'Казахский'], ['EN', 'Английский']]);
    function resetFilters() {
      Object.assign(F, { q: '', quick: 'all', channel: '', lang: '' });
      searchInput.value = ''; channelSelect.value = ''; langSelect.value = '';
      renderTable();
    }
    const filterBar = h('div', { class: 'cqa-filters' },
      h('div', { class: 'cqa-row' }, searchInput, channelSelect, langSelect, h('button', { class: 'cqa-btn', onclick: resetFilters }, 'Сбросить')),
      chipsBox);

    let importing = false, startingBatch = false;
    const importStatus = h('span', { class: 'cqa-small cqa-muted', role: 'status' });
    const fetchButton = h('button', { class: 'cqa-btn', onclick: onFetch, disabled: !S.config.data_api_configured, title: S.config.data_api_configured ? 'Получить диалоги из API организаторов' : 'Адрес API не настроен. Используйте JSON или пример.' }, 'Получить из API');
    const uploadButton = h('button', { class: 'cqa-btn', onclick: () => fileInput.click() }, 'Импорт JSON');
    const sampleButton = h('button', { class: 'cqa-btn cqa-text-btn', onclick: onSample }, 'Открыть пример · 4 диалога');
    const batchButton = h('button', { class: 'cqa-btn primary', onclick: () => onBatch(forceBox.checked), disabled: !S.group || S.job?.status === 'running' }, S.job?.status === 'running' ? 'Оценка выполняется…' : 'Оценить весь набор');
    function setImportBusy(busy) {
      importing = busy; uploadButton.disabled = busy; sampleButton.disabled = busy;
      fetchButton.disabled = busy || !S.config.data_api_configured;
      groupInput.disabled = busy; importStatus.textContent = busy ? 'Загружаем диалоги…' : '';
    }
    rc(main,
      pageHead('Диалоги', 'Контролируйте качество общения. Помогайте команде становиться лучше.', h('a', { class: 'cqa-btn', href: '#/dashboard' }, icon('activity'), 'Аналитика')),
      S.config.provider === 'mock' ? h('div', { class: 'cqa-demo-banner', role: 'note' }, h('span', { class: 'cqa-badge warn' }, 'Демо-режим'), h('div', {}, h('b', {}, 'Можно проверить весь рабочий процесс без API-ключа'), h('div', { class: 'cqa-small' }, 'Оценки строятся по правилам и не отражают качество реальной модели. Демо помечено в каждой карточке.'))) : null,
      overview,
      h('div', { class: 'cqa-workflow', 'aria-label': 'Этапы проверки диалогов' },
        h('div', {}, h('span', {}, '01'), h('b', {}, 'Загрузите диалоги'), h('small', {}, 'API, JSON или готовый пример')),
        h('div', {}, h('span', {}, '02'), h('b', {}, 'Оцените по чек-листу'), h('small', {}, 'Баллы и доказательства по каждому пункту')),
        h('div', {}, h('span', {}, '03'), h('b', {}, 'Проверьте результат'), h('small', {}, 'Разберите ошибки и спорные оценки'))),
      h('div', { class: 'cqa-panel cqa-control-panel' },
        h('div', { class: 'cqa-import-controls' },
          h('div', { class: 'cqa-control-title' }, h('span', { class: 'cqa-step-number' }, '1'), h('h2', {}, 'Данные')),
          h('div', { class: 'cqa-row' },
          h('label', { class: 'cqa-field' }, 'Набор данных',
            h('select', { class: 'cqa-select', onchange: (e) => { S.group = e.target.value; store.set('group', S.group); viewList(); } },
              S.datasets.length ? S.datasets.map((d) => h('option', { value: d.group_id, selected: d.group_id === S.group }, `${d.group_id} · ${d.total_records} диал.`)) : h('option', {}, 'Выберите после загрузки'))),
          h('label', { class: 'cqa-field' }, 'ID для загрузки', groupInput),
          h('div', { class: 'cqa-row cqa-control-actions' }, fetchButton, uploadButton, fileInput)),
          h('div', { class: 'cqa-row cqa-control-help' }, sampleButton, importStatus,
            !S.config.data_api_configured ? h('span', { class: 'cqa-small cqa-muted' }, 'API не настроен — начните с JSON или примера') : null)),
        h('div', { class: 'cqa-evaluate-controls' },
          h('div', { class: 'cqa-control-title' }, h('span', { class: 'cqa-step-number' }, '2'), h('h2', {}, 'Оценка')),
          h('div', { class: 'cqa-row' },
          h('label', { class: 'cqa-field' }, 'Чек-лист', checklistSelect(viewList)),
          h('div', { class: 'cqa-control-actions' }, batchButton)),
          h('label', { class: 'cqa-row cqa-small cqa-control-help', for: 'cqa-force' }, forceBox, 'Заново оценить готовые диалоги'),
          h('div', { class: 'cqa-small cqa-muted' }, 'Готовые оценки сохраняются. Новая версия чек-листа запускает новую проверку.'))),
      h('div', { class: 'cqa-job-area' }, progress),
      submissionBox,
      h('div', { class: 'cqa-panel' }, filterBar, tableBox)
    );

    async function onFetch() {
      if (importing) return;
      const gid = groupInput.value.trim();
      if (!gid) { toast('Укажите ID набора, например DEV', true); groupInput.focus(); return; }
      setImportBusy(true);
      try {
        toast('Запрашиваю данные ' + gid + '…');
        const r = await api('POST', '/datasets/fetch', { group_id: gid });
        S.group = gid; store.set('group', gid);
        toast(`Загружено ${r.total_records} диалогов`);
        await loadBase(); if (isCurrent()) viewList();
      } catch (e) { toast(e.message, true); }
      finally { if (isCurrent()) setImportBusy(false); }
    }
    async function onUpload() {
      const f = fileInput.files[0];
      if (!f || importing) return;
      if (f.size > 20 * 1024 * 1024) { toast('JSON-файл должен быть меньше 20 МБ', true); fileInput.value = ''; return; }
      setImportBusy(true);
      try {
        const payload = JSON.parse(await f.text());
        const gid = groupInput.value.trim() || 'UPLOAD';
        const r = await api('POST', '/datasets/upload', { group_id: gid, payload });
        S.group = gid; store.set('group', gid);
        toast(`Загружено: ${r.total_records} диалогов в наборе ${gid}`);
        await loadBase(); if (isCurrent()) viewList();
      } catch (e) { toast('Не удалось импортировать JSON: ' + e.message, true); }
      finally { fileInput.value = ''; if (isCurrent()) setImportBusy(false); }
    }
    async function onSample() {
      if (importing) return;
      setImportBusy(true);
      try {
        const response = await fetch(CFG.apiBase + '/demo-sample.json');
        if (!response.ok) throw new Error('Не удалось открыть пример');
        const payload = await response.json();
        const exists = S.datasets.some((d) => d.group_id === 'SAMPLE');
        if (!exists) await api('POST', '/datasets/upload', { group_id: 'SAMPLE', payload });
        S.group = 'SAMPLE'; store.set('group', S.group);
        await loadBase(); if (isCurrent()) viewList();
        toast('Пример готов. Нажмите «Оценить весь набор» или откройте отдельный диалог.');
      } catch (e) { toast(e.message, true); }
      finally { if (isCurrent()) setImportBusy(false); }
    }
    async function onBatch(force) {
      if (startingBatch || S.job?.status === 'running') return;
      startingBatch = true; batchButton.disabled = true; batchButton.textContent = 'Запускаем оценку…';
      try {
        S.job = await api('POST', '/batch', { group_id: S.group, checklist_id: S.checklist, force });
        store.set('activeCloudJob', S.job.execution_mode === 'stepped' && S.job.status === 'running' ? S.job.id : '');
        if (isCurrent()) pollJob();
      } catch (e) { toast(e.message, true); batchButton.disabled = false; batchButton.textContent = 'Оценить весь набор'; }
      finally { startingBatch = false; }
    }
    function drawJob(job) {
      const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
      rc(progress, 
        h('div', { class: 'cqa-progress', role: 'progressbar', 'aria-label': 'Прогресс оценки набора', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` })),
        h('span', { class: 'cqa-small' }, `${job.done} / ${job.total}`, job.skipped ? ` (пропущено уже оценённых: ${job.skipped})` : '', job.counts ? ` · ${Object.entries(job.counts).map(([k, v]) => `${{ queued: 'в очереди', running: 'выполняется', done: 'готово', skipped: 'уже были', needs_review: 'требуют проверки', error: 'ошибка', cancelled: 'отменено' }[k] || k}: ${v}`).join(', ')}` : '', ` · ≈ $${job.cost_usd.toFixed(4)}`, job.unknown_cost_count ? ' · часть расходов неизвестна' : ''),
        job.status === 'running' ? h('button', { class: 'cqa-btn sm', onclick: async (e) => { const button = e.currentTarget; button.disabled = true; try { await api('POST', `/batch/${job.id}/cancel`); } catch (error) { button.disabled = false; throw error; } } }, 'Остановить очередь') : h('span', { class: 'cqa-small cqa-muted' }, job.status === 'finished' ? 'Готово' : job.status === 'cancelled' ? 'Остановлено' : job.status),
        job.execution_mode === 'stepped' && job.status === 'running' ? h('span', { class: 'cqa-small cqa-muted' }, 'Держите список диалогов открытым, пока идёт оценка. После обновления страницы она продолжится; готовые результаты сохраняются.') : null,
        job.errors.length ? h('details', { class: 'cqa-small' }, h('summary', {}, 'ошибки'), job.errors.slice(0, 10).map((e) => h('div', {}, `${e.conversation_id || ''}: ${e.error}`))) : null
      );
      batchButton.disabled = job.status === 'running' || !S.group;
      batchButton.textContent = job.status === 'running' ? 'Оценка выполняется…' : 'Оценить весь набор';
    }
    let lastDone = -1, pollTimer = null, pollInFlight = false, pollFailures = 0;
    function schedulePoll(delay) {
      clearTimeout(pollTimer);
      if (isCurrent() && S.job?.status === 'running') pollTimer = setTimeout(() => { pollTimer = null; pollJob(); }, delay);
    }
    async function pollJob() {
      if (!isCurrent() || !S.job || pollInFlight) return;
      clearTimeout(pollTimer); pollTimer = null;
      const jobId = S.job.id;
      pollInFlight = true;
      try {
        let job = await api('GET', '/batch/' + encodeURIComponent(jobId));
        if (!isCurrent() || S.job?.id !== jobId) return;
        if (job.execution_mode === 'stepped' && job.status === 'running') {
          S.job = job;
          drawJob(job);
          job = await api('POST', '/batch/' + encodeURIComponent(jobId) + '/step');
          if (!isCurrent() || S.job?.id !== jobId) return;
        }
        pollFailures = 0;
        S.job = job;
        store.set('activeCloudJob', job.execution_mode === 'stepped' && job.status === 'running' ? job.id : '');
        drawJob(job);
        if (job.done !== lastDone) { lastDone = job.done; drawTable(); }
        if (job.status === 'running') schedulePoll(1500);
        else { toast(job.status === 'cancelled' ? 'Очередь остановлена. Готовые результаты сохранены.' : 'Оценка завершена' + (job.errors.length ? ` · ошибок: ${job.errors.length}` : '')); drawTable(); }
      } catch (error) {
        if (!isCurrent() || S.job?.id !== jobId) return;
        if (error.status === 404) {
          S.job = null;
          store.set('activeCloudJob', '');
          batchButton.disabled = !S.group; batchButton.textContent = 'Оценить весь набор';
          rc(progress, h('div', { class: 'cqa-small', role: 'status' }, 'Очередь не найдена: сервер мог быть перезапущен. Готовые оценки сохранены. Запустите набор снова, чтобы обработать оставшиеся диалоги.'));
          drawTable();
        } else {
          const delay = Math.min(10000, 1500 * 2 ** Math.min(pollFailures++, 3));
          rc(progress, h('span', { class: 'cqa-small', role: 'status' }, `Связь с очередью потеряна. Повторяем через ${Math.ceil(delay / 1000)} с. Готовые оценки сохранены.`), h('button', { class: 'cqa-btn sm', onclick: pollJob }, 'Повторить сейчас'));
          schedulePoll(delay);
        }
      } finally { pollInFlight = false; }
    }

    async function drawTable() {
      if (!isCurrent()) return;
      if (!S.group) {
        rc(chipsBox);
        rc(tableBox, h('div', { class: 'cqa-empty cqa-welcome' }, h('div', { class: 'cqa-empty-symbol', 'aria-hidden': 'true' }, icon('list')), h('b', {}, 'Первый диалог — начало контроля качества'), h('p', {}, 'Загрузите JSON с диалогами или откройте пример, чтобы пройти весь сценарий за пару минут.'), h('button', { class: 'cqa-btn primary', onclick: onSample }, 'Начать с примера')));
        return;
      }
      try { dsCache = await api('GET', '/datasets/' + encodeURIComponent(S.group)); } catch (e) { if (isCurrent()) rc(tableBox, h('div', { class: 'cqa-empty' }, e.message, h('button', { class: 'cqa-btn', onclick: drawTable }, 'Повторить'))); return; }
      if (!isCurrent()) return;
      // Сервер уже отсортировал оценки: первая — действующая
      rowsCache = dsCache.records.map((r) => {
        const evs = r.evaluations.filter((e) => e.checklist.id === S.checklist);
        return { r, ev: evs.find((evaluation) => !evaluation.stale), evs };
      });
      renderTable();
    }

    function sortValue(x) {
      if (F.sort === 'operator') return x.ev && x.ev.operator_name ? x.ev.operator_name : null;
      if (F.sort === 'messages') return x.r.messages;
      if (F.sort === 'total') return x.ev ? x.ev.final_total : null;
      return x.r.conversation_id;
    }
    function compareRows(a, b) {
      const va = sortValue(a), vb = sortValue(b);
      if (va == null || vb == null) return (va == null) - (vb == null); // пустые значения всегда внизу
      return F.dir * (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ru', { numeric: true }));
    }
    const sortTh = (label, key, cls) => h('th', { class: `cqa-sort ${cls || ''}`, 'aria-sort': F.sort === key ? (F.dir > 0 ? 'ascending' : 'descending') : 'none' },
      h('button', { class: 'cqa-sort-button', 'data-sort': key, title: 'Сортировать: ' + label, onclick: () => { if (F.sort === key) F.dir = -F.dir; else { F.sort = key; F.dir = 1; } renderTable(); tableBox.querySelector(`[data-sort="${key}"]`)?.focus(); } }, label, F.sort === key ? (F.dir > 0 ? ' ↑' : ' ↓') : ' ↕'));

    function renderTable() {
      if (!dsCache) return;
      const rows = rowsCache;
      const done = rows.filter((x) => x.ev && x.ev.final_total != null);
      const avg = done.length ? done.reduce((s, x) => s + x.ev.final_total, 0) / done.length : null;
      const gross = rows.filter((x) => x.ev && x.ev.gross_error).length;
      const q = F.q.trim().toLowerCase();
      const base = rows.filter((x) => (!F.channel || x.r.channel === F.channel) && (!F.lang || x.r.language === F.lang)
        && (!q || x.r.conversation_id.toLowerCase().includes(q) || String((x.ev && x.ev.operator_name) || '').toLowerCase().includes(q)));
      const quick = QUICK.find((k) => k[0] === F.quick) || QUICK[0];
      const shown = base.filter(quick[2]).sort(compareRows);
      S.listOrder = shown.map((x) => x.r.conversation_id);
      S.listGroup = S.group;
      rc(overview,
        kpi('Всего диалогов', String(rows.length), `${rows.filter((x) => x.r.channel === 'voice call').length} звонков · ${rows.filter((x) => x.r.channel !== 'voice call').length} чатов`),
        kpi('Оценено', `${rows.filter((x) => x.ev).length} / ${rows.length}`, 'По выбранному чек-листу'),
        kpi('Средний балл', [h('span', { style: `color:${scoreColor(avg)}` }, fmt(avg)), h('small', {}, ' / 100')], done.length ? 'По рассчитанным результатам' : 'Появится после оценки'),
        kpi('Требуют внимания', String(rows.filter((x) => x.ev && (x.ev.gross_error || x.ev.status === 'needs_review' || x.ev.appeals_open)).length), `${gross} грубых ошибок · ${rows.filter((x) => x.ev?.appeals_open).length} с апелляциями`));
      rc(chipsBox, QUICK.map(([key, label, test]) => h('button', { class: 'cqa-fchip' + (quick[0] === key ? ' active' : ''), 'data-quick': key, 'aria-pressed': String(quick[0] === key), onclick: () => { F.quick = key; renderTable(); chipsBox.querySelector(`[data-quick="${key}"]`)?.focus(); } }, label, h('span', {}, base.filter(test).length))));
      rc(tableBox,
        h('div', { class: 'cqa-row', style: 'margin-bottom:10px' },
          h('h2', { style: 'margin:0' }, `Набор ${dsCache.group_id}`),
          h('div', { class: 'cqa-grow' }),
          h('span', { class: 'cqa-small cqa-muted', role: 'status' }, `Показано ${shown.length} из ${rows.length}`),
          h('a', { class: 'cqa-btn sm', href: `${CFG.apiBase}/api/export.csv?group_id=${encodeURIComponent(S.group)}&checklist_id=${encodeURIComponent(S.checklist)}` }, 'Скачать CSV'),
          h('button', { class: 'cqa-btn sm', onclick: () => { submissionBox.hidden = !submissionBox.hidden; if (!submissionBox.hidden) { submissionBox.scrollIntoView({ block: 'nearest' }); teamInput.focus(); } } }, 'Результаты JSON')),
        shown.length ? h('div', { class: 'cqa-table-wrap' }, h('table', { class: 'cqa-table' },
          h('thead', {}, h('tr', {}, sortTh('ID диалога', 'id'), sortTh('Оператор', 'operator'), h('th', {}, 'Канал'), h('th', {}, 'Язык'), sortTh('Реплик', 'messages', 'cqa-num'), sortTh('Итог', 'total', 'cqa-num'), h('th', {}, 'Грубая ошибка'), h('th', {}, 'Апелляции'), h('th', {}, ''))),
          h('tbody', {}, shown.map(({ r, ev, evs }) =>
            h('tr', { class: 'cqa-click', onclick: () => (location.hash = `#/card/${encodeURIComponent(S.group)}/${encodeURIComponent(r.conversation_id)}`) },
              h('td', { class: 'cqa-nowrap' }, h('a', { class: 'cqa-dialog-link', href: `#/card/${encodeURIComponent(S.group)}/${encodeURIComponent(r.conversation_id)}`, onclick: (e) => e.stopPropagation() }, r.conversation_id)),
              h('td', {}, ev && ev.operator_name
                ? h('a', { class: 'cqa-oplink', href: `#/operator/${encodeURIComponent(ev.operator_name)}`, onclick: (e) => e.stopPropagation() }, avatar(ev.operator_name), ev.operator_name)
                : h('span', { class: 'cqa-muted cqa-small' }, ev ? 'Не представился' : '—')),
              h('td', { class: 'cqa-nowrap' }, h('span', { class: 'cqa-channel' }, icon(r.channel === 'voice call' ? 'phone' : 'list'), r.channel === 'voice call' ? 'Звонок' : 'Чат')),
              h('td', {}, h('span', { class: 'cqa-chip' }, r.language)),
              h('td', { class: 'cqa-num' }, r.messages),
              h('td', { class: 'cqa-num' }, ev ? [totalBadge(ev.final_total), ev.final_total !== ev.original_total ? h('div', { class: 'cqa-small cqa-muted' }, 'было ' + fmt(ev.original_total)) : null, ev.provider === 'mock' ? h('div', { class: 'cqa-small cqa-muted' }, 'демо') : null] : h('span', { class: evs.length ? 'cqa-badge warn' : 'cqa-muted cqa-small' }, evs.length ? 'нужна новая оценка' : 'не оценён')),
              h('td', {}, ev ? (ev.gross_error ? h('span', { class: 'cqa-badge gross' }, 'Да') : ev.gross_error_unknown ? h('span', { class: 'cqa-badge warn' }, 'нужна проверка') : h('span', { class: 'cqa-muted' }, 'нет')) : ''),
              h('td', {}, ev && ev.appeals_total ? h('span', { class: 'cqa-badge ' + (ev.appeals_open ? 'warn' : 'na') }, ev.appeals_open ? `открыто ${ev.appeals_open}` : `рассмотрено ${ev.appeals_total}`) : ''),
              h('td', { class: 'cqa-actions' }, h('button', { class: 'cqa-btn sm', onclick: async (e) => { e.stopPropagation(); e.target.disabled = true; e.target.textContent = 'Оцениваю…'; try { await api('POST', '/evaluate', { group_id: S.group, conversation_id: r.conversation_id, checklist_id: S.checklist, force: !!ev }); drawTable(); } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Оценить'; } } }, ev ? 'Переоценить' : evs.length ? 'Оценить заново' : 'Оценить'),
                ev ? h('button', { class: 'cqa-btn sm danger', title: 'Удалить оценки этой строки', onclick: async (e) => {
                  e.stopPropagation();
                  if (await clearResult(S.group, r.conversation_id, S.checklist, evs)) { renderTop('list'); drawTable(); }
                } }, 'Очистить') : null)
            ))))) : h('div', { class: 'cqa-empty' }, h('b', {}, 'Ничего не найдено'), 'Измените условия или нажмите «Сбросить».')
      );
    }
    drawTable();
    if (S.job && S.job.status === 'running') pollJob();
    else if (S.job) drawJob(S.job);
  }

  // ================= КАРТОЧКА ДИАЛОГА =================
  async function viewCard(gid, cid, wantEv) {
    const isCurrent = startView('card');
    rc(main, loading());
    let record, evs;
    try {
      [record, evs] = await Promise.all([api('GET', `/datasets/${encodeURIComponent(gid)}/${encodeURIComponent(cid)}`).catch((error) => { if (error.status === 404) return null; throw error; }), api('GET', `/evaluations?group_id=${encodeURIComponent(gid)}`)]);
    } catch (e) { if (isCurrent()) rc(main, h('div', { class: 'cqa-empty' }, e.message)); return; }
    if (!isCurrent()) return;
    evs = evs.filter((e) => e.conversation_id === cid);
    const pick = wantEv ? evs.find((e) => e.id === wantEv) : evs.find((e) => e.checklist.id === S.checklist && !e.stale);
    let ev = pick ? await api('GET', '/evaluations/' + encodeURIComponent(pick.id)) : null;
    if (!isCurrent()) return;
    const hasArchivedSnapshot = !!(ev?.record_changed && ev.record_snapshot);
    const evidenceAvailable = !ev?.record_changed || hasArchivedSnapshot;
    if (hasArchivedSnapshot) record = ev.record_snapshot;
    if (!record) { rc(main, pageHead('Диалог недоступен', '', h('a', { class: 'cqa-btn', href: '#/list' }, 'К диалогам')), h('div', { class: 'cqa-panel cqa-empty' }, 'Исходный диалог удалён, и сохранённого текста этой оценки нет.')); return; }

    // Участок записи для каждой реплики считает сервер (src/audio-offsets.js); null — в записи этого места нет.
    const segs = record.audio_segments || record.transcript.map(() => null);
    const offs = segs.map((s) => (s ? s.start : null));
    const audioURL = /^https?:\/\//i.test(record.audio_url || '') ? record.audio_url : null;
    const audioError = h('div', { class: 'cqa-small', role: 'status', style: 'display:none;color:var(--bad);margin:-6px 0 8px' }, 'Не удалось загрузить запись. ',
      audioURL ? h('a', { href: audioURL, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть у организаторов') : null);
    const audio = record.audio_url && !ev?.record_changed ? h('audio', { class: 'cqa-audio', 'aria-label': 'Аудиозапись диалога', controls: true, preload: 'none', src: `${CFG.apiBase}/api/audio/${encodeURIComponent(gid)}/${encodeURIComponent(cid)}`, onerror: () => { audioError.style.display = ''; } }) : null;
    const speed = h('label', { class: 'cqa-audio-tool' }, 'Скорость',
      h('select', { class: 'cqa-select', onchange: (e) => { audio.playbackRate = Number(e.target.value); } },
        [0.75, 1, 1.25, 1.5, 2].map((v) => h('option', { value: v, selected: v === 1 }, `${String(v).replace('.', ',')}×`))));
    const msgEls = [];
    function seek(i) {
      if (!audio || offs[i] == null) return;
      audio.currentTime = offs[i];
      audio.play().catch(() => {});
    }
    function focusMsg(i, range) {
      if (onlySpeaker && record.transcript[i] && record.transcript[i].speaker !== onlySpeaker) setFilter(null);
      msgEls.forEach((el) => el.classList.remove('hl', 'range'));
      if (range) for (let k = range.from; k <= range.to; k++) msgEls[k] && msgEls[k].classList.add('range');
      const el = msgEls[i];
      if (!el) return;
      el.classList.add('hl');
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
      seek(i);
    }

    // ---------- таймлайн разговора: дорожки участников, замечания, текущая реплика ----------
    let nowIdx = -1, follow = true, onlySpeaker = null;
    const hasTimeline = !!audio && offs.some((x) => x != null);
    const total = Math.max(1, ...segs.filter(Boolean).map((s) => s.end)) + 2;
    const pct = (s) => `${Math.min(100, (s / total) * 100)}%`;
    const heads = [];
    const laneButtons = [];
    const firstAudible = (i) => { for (let k = i; k < offs.length; k++) if (offs[k] != null) return k; return null; };
    const titleOf = (id) => ((ev.checklist_snapshot.criteria.find((c) => c.id === id) || {}).title || id);
    const issues = !ev ? [] : ev.final_result.criteria
      .filter((r) => (r.scored ? r.raw < r.weight : r.type === 'flag' && r.answer === 'YES'))
      .map((r) => {
        const c = ev.final_criteria[r.id] || {};
        const first = c.evidence && c.evidence[0] ? c.evidence[0].msg : c.missing_range ? c.missing_range.from : null;
        return { id: r.id, msg: first == null ? null : firstAudible(first), range: c.missing_range || null, explanation: c.explanation || '' };
      })
      .filter((x) => x.msg != null)
      .sort((a, b) => a.msg - b.msg);

    function setFilter(speaker) {
      onlySpeaker = speaker;
      msgEls.forEach((el, i) => { el.style.display = !speaker || record.transcript[i].speaker === speaker ? '' : 'none'; });
      laneButtons.forEach(([key, el]) => el.classList.toggle('active', key === speaker));
    }
    function setNow(i) {
      if (i === nowIdx) return;
      if (msgEls[nowIdx]) msgEls[nowIdx].classList.remove('now');
      nowIdx = i;
      const el = msgEls[i];
      if (!el) return;
      el.classList.add('now');
      if (!follow || el.style.display === 'none') return;
      const box = transcript.getBoundingClientRect(), r = el.getBoundingClientRect(), top = box.top + player.offsetHeight;
      if (r.top < top + 8 || r.bottom > box.bottom - 8) transcript.scrollTo({ top: transcript.scrollTop + r.top - top - 24, behavior: 'smooth' });
    }
    function syncToTime(t) {
      heads.forEach((el) => { el.style.left = pct(t); });
      let idx = -1;
      for (let i = 0; i < offs.length; i++) if (offs[i] != null && offs[i] <= t + 0.35 && record.transcript[i].speaker !== 'system') idx = i;
      if (idx >= 0) setNow(idx);
    }
    function step(list, dir) {
      const target = dir > 0 ? list.find((i) => i > nowIdx) : list.slice().reverse().find((i) => i < nowIdx);
      if (target == null) return;
      focusMsg(target, (issues.find((x) => x.msg === target) || {}).range);
      setNow(target);
    }
    function track(marks) {
      const head = h('i', { class: 'cqa-head' });
      heads.push(head);
      const el = h('div', { class: 'cqa-track', role: 'slider', 'aria-label': 'Место в записи', 'aria-valuemin': 0, 'aria-valuemax': Math.round(total), 'aria-valuenow': 0, title: 'Нажмите, чтобы перейти к этому месту записи', onkeydown: (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); audio.currentTime = Math.max(0, Math.min(total, audio.currentTime + (e.key === 'ArrowLeft' ? -5 : 5))); }
      }, onclick: (e) => {
        const r = el.getBoundingClientRect();
        if (!e.detail) return;
        audio.currentTime = Math.max(0, ((e.clientX - r.left) / r.width) * total);
        audio.play().catch(() => {});
      } }, marks, head);
      audio.addEventListener('timeupdate', () => { el.setAttribute('aria-valuenow', String(Math.round(audio.currentTime))); el.setAttribute('aria-valuetext', mmss(audio.currentTime)); });
      return el;
    }
    const navButtons = (list, what) => h('div', { class: 'cqa-lane-nav' },
      h('button', { title: `Предыдущая: ${what}`, onclick: () => step(list, -1) }, '‹'),
      h('button', { title: `Следующая: ${what}`, onclick: () => step(list, 1) }, '›'));
    function speakerLane(key, label) {
      const list = record.transcript.map((_, i) => i).filter((i) => record.transcript[i].speaker === key && offs[i] != null);
      if (!list.length) return null;
      const name = h('button', { class: `cqa-lane-name ${key}`, title: 'Показать в транскрипте только эту сторону', onclick: () => setFilter(onlySpeaker === key ? null : key) }, label, h('span', {}, list.length));
      laneButtons.push([key, name]);
      const marks = list.map((i) => h('div', { class: `cqa-seg ${key}`, title: `${mmss(offs[i])} · ${record.transcript[i].text}`, style: `left:${pct(offs[i])};width:${pct(Math.max(segs[i].end - offs[i], 0.6))}`, onclick: (e) => { e.stopPropagation(); focusMsg(i); setNow(i); } }));
      return h('div', { class: 'cqa-lane' }, name, track(marks), navButtons(list, label.toLowerCase()));
    }
    function issueLane() {
      if (!issues.length) return null;
      const marks = issues.map((x) => h('div', { class: 'cqa-issue', title: `${titleOf(x.id)} · ${mmss(offs[x.msg])}. ${x.explanation}`, style: `left:${pct(offs[x.msg])}`, onclick: (e) => { e.stopPropagation(); focusMsg(x.msg, x.range); setNow(x.msg); } }));
      return h('div', { class: 'cqa-lane' }, h('span', { class: 'cqa-lane-name issue' }, 'Замечания', h('span', {}, issues.length)), track(marks), navButtons([...new Set(issues.map((x) => x.msg))], 'замечание'));
    }
    const followBox = h('input', { type: 'checkbox', checked: true, onchange: (e) => { follow = e.target.checked; } });
    const player = audio ? h('div', { class: 'cqa-player' }, audio, audioError,
      hasTimeline ? h('div', { class: 'cqa-timeline' }, speakerLane('client', 'Клиент'), speakerLane('operator', 'Оператор'), speakerLane('bot', 'Бот'), issueLane()) : null,
      h('div', { class: 'cqa-audio-tools' }, speed, hasTimeline ? h('label', { class: 'cqa-audio-tool' }, followBox, 'Следить за записью') : null)) : null;
    if (hasTimeline) audio.addEventListener('timeupdate', () => syncToTime(audio.currentTime));

    const transcript = h('div', { class: 'cqa-panel cqa-transcript' },
      h('div', { class: 'cqa-row' }, h('h2', { style: 'margin:0' }, 'Транскрипт'), h('span', { class: 'cqa-chip' }, record.language), h('span', { class: 'cqa-chip' }, record.channel === 'voice call' ? 'Звонок' : 'Чат')),
      ev?.record_changed ? h('div', { class: 'cqa-note' }, hasArchivedSnapshot ? 'Архив: показан исходный текст этой оценки. Запись могла измениться; встроенный плеер отключён.' : 'Текст диалога изменился. Исходный текст оценки не сохранён; ниже текущая версия. Старые доказательства нельзя привязать к этим репликам.') : null,
      hasArchivedSnapshot && audioURL ? h('a', { class: 'cqa-btn sm', href: audioURL, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть исходную запись') : null,
      player,
      audio ? h('div', { class: 'cqa-small cqa-muted', style: 'margin:8px 0' }, hasTimeline
        ? 'Дорожки показывают, кто и когда говорил. Стрелки ‹ › переходят к соседней реплике участника или замечанию, а имя участника оставляет в тексте только его реплики. Момент рассчитан по меткам времени и может отличаться на 1–2 секунды.'
        : 'Соответствие меток времени и записи в данных не задано: автоматическая перемотка отключена.') : null,
      record.channel === 'voice call' ? h('div', { class: 'cqa-asr-note' }, 'Текст звонка — автоматическая расшифровка организаторов. Слова и роли могут быть распознаны с ошибками, спорные места сверяйте со звуком.') : null,
      record.transcript.map((m, i) => {
        const el = h('div', { class: `cqa-msg ${m.speaker}`, id: `cqa-m${i}`, tabindex: '-1' },
          h('div', { class: 'cqa-meta' }, h('b', {}, SPEAKER[m.speaker] || m.speaker),
            h('span', { title: m.timestamp }, shortTs(m.timestamp)),
            audio && offs[i] != null ? h('button', { class: 'cqa-seek', title: 'Слушать с этого места', onclick: () => { seek(i); setNow(i); } }, `▶ ${mmss(offs[i])}`) : null,
            h('div', {}, h('span', { class: 'cqa-chip' }, '№' + (i + 1)))),
          h('div', { class: 'cqa-text' }, m.text));
        msgEls.push(el);
        return el;
      })
    );

    const order = S.listGroup === gid ? S.listOrder : [];
    const pos = order.indexOf(cid);
    const cardHref = (id) => `#/card/${encodeURIComponent(gid)}/${encodeURIComponent(id)}`;
    S.cardNav = { prev: pos > 0 ? cardHref(order[pos - 1]) : null, next: pos >= 0 && pos < order.length - 1 ? cardHref(order[pos + 1]) : null };
    const stepBtn = (href, label, title) => h('button', { class: 'cqa-btn', disabled: !href, title, onclick: () => (location.hash = href) }, label);

    const results = h('div', {});
    const toolbar = h('div', { class: 'cqa-panel cqa-card-toolbar', style: 'margin-bottom:16px' },
      h('div', { class: 'cqa-row' },
        h('a', { class: 'cqa-btn', href: '#/list' }, '← К списку'),
        pos >= 0 ? h('div', { class: 'cqa-row', style: 'gap:6px' }, stepBtn(S.cardNav.prev, '‹', 'Предыдущий диалог (клавиша ←)'), h('span', { class: 'cqa-small cqa-muted' }, `${pos + 1} / ${order.length}`), stepBtn(S.cardNav.next, '›', 'Следующий диалог (клавиша →)')) : null,
        h('div', { class: 'cqa-grow' }, h('div', { class: 'cqa-page-kicker' }, 'КАРТОЧКА ДИАЛОГА'), h('h1', { class: 'cqa-card-title', style: 'margin:0' }, cid), h('div', { class: 'cqa-small cqa-muted cqa-channel' }, icon(record.channel === 'voice call' ? 'phone' : 'list'), `${record.channel === 'voice call' ? 'Звонок' : 'Чат'} · ${record.language} · ${record.transcript.length} реплик`)),
        ev ? h('button', { class: 'cqa-btn', onclick: () => window.print() }, 'Печать / PDF') : null,
        ev ? h('button', { class: 'cqa-btn danger', onclick: async () => {
          if (await clearResult(gid, cid, ev.checklist.id, evs.filter((e) => e.checklist.id === ev.checklist.id))) { location.hash = cardHref(cid); route(); }
        } }, 'Очистить результат') : null,
        evs.length && (evs.length > 1 || !ev) ? h('label', { class: 'cqa-field' }, 'История оценок', h('select', { class: 'cqa-select', onchange: (e) => (location.hash = e.target.value ? `#/card/${encodeURIComponent(gid)}/${encodeURIComponent(cid)}/${encodeURIComponent(e.target.value)}` : cardHref(cid)) },
          !ev ? h('option', { value: '', selected: true }, 'Выберите сохранённую оценку') : null,
          evs.map((e) => h('option', { value: e.id, selected: ev && e.id === ev.id }, `${e.stale ? 'Архив · ' : ''}${e.checklist.name} v${e.checklist.version} · ${fmt(e.final_total)}`)))) : null,
        h('label', { class: 'cqa-field' }, 'Чек-лист для оценки', checklistSelect()),
        h('label', { class: 'cqa-field' }, ' ', h('button', { class: 'cqa-btn primary', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Оцениваю…';
          try {
            const nev = await api('POST', '/evaluate', { group_id: gid, conversation_id: cid, checklist_id: S.checklist, force: !!(ev && ev.checklist.id === S.checklist) });
            if (!isCurrent()) { toast('Оценка ' + cid + ' сохранена'); return; }
            if (nev.cached) toast('Для этого содержимого диалога и чек-листа уже есть готовая оценка — показываю её. «Переоценить» запустит новую.');
            const target = `#/card/${encodeURIComponent(gid)}/${encodeURIComponent(cid)}/${encodeURIComponent(nev.id)}`;
            if (location.hash === target) { await loadBase(); route(); } else location.hash = target;
          } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Запустить оценку'; }
        } }, ev ? 'Переоценить' : 'Запустить оценку'))));

    rc(main, toolbar, h('div', { class: 'cqa-card' }, transcript, results));

    function drawResults() {
      if (!ev) { rc(results, h('div', { class: 'cqa-panel cqa-empty' }, evs.some((evaluation) => evaluation.checklist.id === S.checklist && evaluation.stale) ? 'Для текущего текста и версии чек-листа нужна новая оценка. Предыдущие результаты доступны в истории оценок.' : 'Диалог ещё не оценён по выбранному чек-листу. Выберите чек-лист и нажмите «Запустить оценку».')); return; }
      const cl = ev.checklist_snapshot;
      const fr = ev.final_result, or = ev.original_result;
      const secName = Object.fromEntries((cl.sections || []).map((s) => [s.id, s.name]));
      const changed = fr.total !== or.total;
      const grossUnknown = cl.criteria.some((criterion) => criterion.type === 'flag' && (!ev.final_criteria[criterion.id] || ev.final_criteria[criterion.id].answer === 'INVALID' || ev.final_criteria[criterion.id].review_required));

      const head = h('div', { class: 'cqa-panel cqa-result-summary' },
        ev.stale ? h('div', { class: 'cqa-note', role: 'note' }, 'Архивная оценка. ', ev.record_changed ? 'Она относится к предыдущим данным диалога; для текущих данных запустите новую оценку.' : 'Чек-лист или данные изменились после её сохранения. Для актуального результата нужна новая оценка.') : null,
        ev.provider === 'mock' ? h('div', { class: 'cqa-result-demo', role: 'note' }, 'Демо-оценка по правилам · результат реальной модели может отличаться') : null,
        h('div', { class: 'cqa-total' },
          ring(fr.total, changed ? 'финальный' : 'из 100'),
          h('div', { class: 'cqa-grow', style: 'min-width:240px' },
            ev.operator_name ? h('div', { class: 'cqa-row', style: 'gap:8px;margin-bottom:8px' }, avatar(ev.operator_name), h('div', {}, h('div', { class: 'cqa-small cqa-muted' }, 'Оператор'), h('b', {}, ev.operator_name))) : null,
            h('div', { class: 'cqa-row', style: 'gap:8px' },
              fr.gross_error ? h('span', { class: 'cqa-badge gross' }, icon('appeal'), 'Грубая ошибка') : grossUnknown ? h('span', { class: 'cqa-badge warn' }, 'Грубые ошибки: нужна проверка') : h('span', { class: 'cqa-badge yes' }, icon('shield'), 'Грубых ошибок нет'),
              changed ? h('span', { class: 'cqa-badge warn' }, `Исходно ИИ: ${fmt(or.total)} → после апелляции: ${fmt(fr.total)}`) : null),
            h('div', { class: 'cqa-small cqa-muted', style: 'margin-top:8px' },
              h('div', {}, `${cl.name} · версия ${cl.version}`),
              h('div', {}, `Применимый вес: ${fmt(fr.applicable_weight)} из ${fmt(cl.criteria.reduce((s, c) => s + (c.type === 'flag' ? 0 : c.weight), 0))} · коэффициент перераспределения ×${fmt(fr.redistribution_factor)}`),
              h('div', {}, `${ev.provider} / ${ev.model}${ev.samples > 1 ? ' · ' + ev.samples + ' прогона, голосование' : ''} · ≈ $${ev.cost_usd}`)))),
        ev.status === 'needs_review' ? h('div', { class: 'cqa-note' }, 'Результат требует проверки человеком: ответ модели не прошёл часть проверок даже после повторного запроса. ', (ev.validation_errors || []).length ? h('details', {}, h('summary', {}, 'подробнее'), h('ul', {}, ev.validation_errors.map((x) => h('li', {}, x)))) : null) : null,
        fr.note ? h('div', { class: 'cqa-note' }, fr.note) : null,
        h('details', { class: 'cqa-calculation' }, h('summary', {}, 'Расчёт и параметры оценки'),
          fr.total_exact != null ? h('p', {}, `Итог = 100 × ${fmt(fr.earned_weight)} / ${fmt(fr.applicable_weight)} (набрано / вес применимых критериев) = ${fr.total_exact.toFixed(4).replace('.', ',')} → ${fmt(fr.total)}. Итог считается до округления, поэтому сумма показанных долей может отличаться на 0,01.`) : null,
          h('div', { class: 'cqa-small cqa-muted' }, timingLine(ev))),
        ev.summary ? h('p', { style: 'margin:12px 0 0' }, ev.summary) : null,
        (ev.coaching || []).length ? h('div', { class: 'cqa-coach' }, h('b', {}, icon('spark'), 'Рекомендации оператору'), h('ul', {}, ev.coaching.map((t) => typeof t === 'string' ? h('li', {}, t) :
          h('li', {}, h('span', { class: 'cqa-badge ' + (t.type === 'required' ? 'no' : 'na'), style: 'margin-right:6px' }, t.type === 'required' ? 'требование чек-листа' : 'совет'), t.criterion_title ? h('span', { class: 'cqa-muted' }, `«${t.criterion_title}»: `) : null, t.text)))) : null,
        fr.sections.some((s) => s.points != null) ? h('div', { class: 'cqa-sections' }, fr.sections.filter((s) => s.max).map((s) =>
          h('div', { class: 'cqa-section' }, h('div', { class: 'cqa-small cqa-muted' }, s.name), h('b', {}, `${fmt(s.points)} / ${fmt(s.max)}`), h('div', { class: 'cqa-bar' }, h('div', { style: `width:${s.percent || 0}%` }))))) : null
      );

      const crits = cl.criteria.map((c) => {
        const a = ev.final_criteria[c.id];
        const a0 = ev.criteria[c.id];
        const row = fr.criteria.find((r) => r.id === c.id);
        const row0 = or.criteria.find((r) => r.id === c.id);
        const openAp = ev.appeals.find((x) => x.criterion_id === c.id && x.status === 'open');
        const aps = ev.appeals.filter((x) => x.criterion_id === c.id);
        const appealBox = h('div', {});

        let pts;
        if (c.type === 'flag') pts = h('span', { class: 'cqa-muted cqa-small' }, 'без баллов');
        else if (a.answer === 'NA') pts = h('span', { class: 'cqa-muted cqa-small' }, `исключён · базовый вес ${c.weight} перераспределён`);
        else if (a.answer === 'INVALID') pts = h('span', { class: 'cqa-muted cqa-small' }, `не рассчитан · исходный вес ${c.weight}`);
        else pts = h('span', { class: 'cqa-pts', title: `Точное значение: ${row.contribution != null ? row.contribution.toFixed(4) : '—'} из ${row.max_contribution != null ? row.max_contribution.toFixed(4) : '—'}` }, `${fmt(row.points)} из ${fmt(row.effective_weight)}`, h('span', { class: 'cqa-small cqa-muted' }, ` · исходный вес ${c.weight}`));

        return h('div', { class: 'cqa-crit' + (a.changed_by_appeal ? ' changed' : '') + (a.review_required ? ' changed' : '') },
          h('div', { class: 'cqa-crit-head' },
            h('span', { class: 'cqa-chip' }, c.code || c.id),
            h('span', { class: 'cqa-title' }, c.title, c.section ? h('span', { class: 'cqa-small cqa-muted' }, ' · ' + (secName[c.section] || '')) : null),
            a.agreement && a.agreement.runs > 1 ? h('span', { class: 'cqa-chip', title: 'Сколько прогонов модели дали этот же ответ' }, `согласие ${a.agreement.agree}/${a.agreement.runs}`) : null,
            a.review_required && !a.changed_by_appeal ? h('span', { class: 'cqa-badge warn', title: (a.issues || []).join('; ') }, 'требует проверки') : null,
            answerBadge(c, a), pts),
          a.changed_by_appeal ? h('div', { class: 'cqa-note' }, `Изменено по апелляции: было «${answerText(c, a0)}» (${row0.points == null ? '—' : fmt(row0.points)} б.) → стало «${answerText(c, a)}». Причина: ${a.reviewer_reason}`) : null,
          a.answer === 'NA' ? h('p', {}, h('b', {}, 'Причина N/A: '), a.na_reason || a.explanation || '—') : null,
          a.explanation && !(a.answer === 'NA' && a.na_reason === a.explanation) ? h('p', {}, a.explanation) : null,
          evidenceList(a, record, evidenceAvailable ? focusMsg : null),
          (a.unverified_claims || []).length ? h('div', { class: 'cqa-note', style: 'background:var(--info-bg);color:var(--info)' }, 'Фактическая корректность не проверена (нет базы знаний), нужна проверка человеком: ', a.unverified_claims.join('; ')) : null,
          (a.issues || []).length && !a.changed_by_appeal ? h('div', { class: 'cqa-note' }, 'Проблемы проверки ответа модели: ', a.issues.join('; ')) : null,
          aps.map((ap) => h('div', { class: 'cqa-appeal cqa-small' },
            h('div', {}, h('b', {}, 'Апелляция: '), ap.comment, h('span', { class: 'cqa-muted' }, ` — ${ap.author}, ${new Date(ap.created_at).toLocaleString('ru-RU')}`)),
            ap.status === 'open' ? h('div', { class: 'cqa-muted' }, icon('clock'), 'Ожидает решения проверяющего. ', h('a', { href: '#/appeals' }, 'Открыть очередь')) :
              h('div', {}, h('b', {}, icon(ap.decision.action === 'confirm' ? 'done' : 'edit'), ap.decision.action === 'confirm' ? 'Оценка подтверждена' : 'Оценка изменена'), `: ${ap.decision.reason}`, h('span', { class: 'cqa-muted' }, ` — ${ap.decision.reviewer}. Итог ${fmt(ap.decision.total_before)} → ${fmt(ap.decision.total_after)}`)))),
          appealBox,
          !openAp ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'cqa-btn sm', onclick: () => {
            const ta = h('textarea', { class: 'cqa-textarea', 'aria-label': 'Причина несогласия с оценкой критерия ' + c.title, maxlength: 4000, placeholder: 'Укажите, с чем не согласны, и сошлитесь на реплики диалога' });
            rc(appealBox, h('div', { class: 'cqa-appeal' }, h('b', { class: 'cqa-small' }, `Оспорить «${c.title}»`), ta,
              h('div', { class: 'cqa-row', style: 'margin-top:6px' },
                h('button', { class: 'cqa-btn primary sm', onclick: async (event) => {
                  if (!ta.value.trim()) { toast('Напишите причину апелляции', true); ta.focus(); return; }
                  const button = event.currentTarget; button.disabled = true;
                  try {
                    ev = await api('POST', `/evaluations/${encodeURIComponent(ev.id)}/appeals`, { criterion_id: c.id, comment: ta.value });
                    S.openAppeals++; if (isCurrent()) { renderTop('card'); drawResults(); } toast('Апелляция сохранена');
                  } catch (e) { toast(e.message, true); button.disabled = false; }
                } }, 'Отправить'),
                h('button', { class: 'cqa-btn sm', onclick: () => rc(appealBox) }, 'Отмена'))));
            ta.focus();
          } }, 'Оспорить')) : null
        );
      });
      rc(results, head, h('div', { class: 'cqa-panel cqa-criteria-panel' }, h('div', { class: 'cqa-result-section-head' }, h('h2', {}, 'Оценка по критериям'), h('span', { class: 'cqa-chip' }, String(cl.criteria.length))), crits));
    }
    drawResults();
    const requested = S.focusEvidence;
    if (requested && requested.gid === gid && requested.cid === cid) {
      S.focusEvidence = null;
      if (evidenceAvailable) focusMsg(requested.msg, requested.range);
    }
  }

  // ================= АПЕЛЛЯЦИИ (рабочее место проверяющего) =================
  async function viewAppeals() {
    const isCurrent = startView('appeals');
    rc(main, loading());
    const list = await api('GET', '/appeals');
    if (!isCurrent()) return;
    S.openAppeals = list.filter((a) => a.status === 'open').length;
    renderTop('appeals');
    if (!list.length) { rc(main, pageHead('Апелляции', 'Проверяем спорные оценки с опорой на факты'), h('div', { class: 'cqa-panel cqa-empty' }, h('b', {}, 'Все спокойно: апелляций пока нет'), h('p', {}, 'Если оценка вызывает сомнения, откройте диалог и нажмите «Оспорить» у нужного критерия.'), h('a', { class: 'cqa-btn', href: '#/list' }, 'К диалогам'))); return; }

    const recCache = {};
    const getRec = (g, c) => { const key = JSON.stringify([g, c]); return recCache[key] = recCache[key] || api('GET', `/datasets/${encodeURIComponent(g)}/${encodeURIComponent(c)}`); };
    const evCache = {};
    const getEv = (id) => (evCache[id] = evCache[id] || api('GET', '/evaluations/' + encodeURIComponent(id)));

    const items = await Promise.all(list.map(async (ap) => {
      const [currentRec, ev] = await Promise.all([getRec(ap.group_id, ap.conversation_id).catch(() => null), getEv(ap.evaluation_id)]);
      const rec = ev.record_changed ? ev.record_snapshot || null : currentRec;
      const c = ev.checklist_snapshot.criteria.find((x) => x.id === ap.criterion_id);
      const d = ap.disputed;
      // фрагмент: доказательства ±2 реплики либо проверенный участок
      const idx = new Set();
      (d.evidence || []).forEach((e) => { for (let k = e.msg - 2; k <= e.msg + 2; k++) idx.add(k); });
      for (const r of [d.missing_range, d.checked_range]) if (r) for (let k = r.from; k <= r.to && idx.size < 40; k++) idx.add(k);
      const ev_ids = new Set((d.evidence || []).map((e) => e.msg));
      const frag = rec ? [...idx].filter((k) => k >= 0 && k < rec.transcript.length).sort((a, b) => a - b) : [];

      const box = h('div', { class: 'cqa-panel', 'data-appeal-status': ap.status, 'data-appeal-group': ap.group_id });
      const disputedPts = d.points == null ? '' : ` · ${fmt(d.points)} б.`;
      const head = h('div', { class: 'cqa-row' },
        h('span', { class: 'cqa-badge ' + (ap.status === 'open' ? 'warn' : 'na') }, ap.status === 'open' ? 'Открыта' : 'Рассмотрена'),
        h('b', {}, ap.conversation_id), h('span', { class: 'cqa-chip' }, ap.group_id), h('span', { class: 'cqa-muted' }, `· ${ap.criterion_title}`),
        h('div', { class: 'cqa-grow' }),
        h('span', { class: 'cqa-small cqa-muted' }, `Итог диалога: ${fmt(ap.final_total)}`),
        h('a', { class: 'cqa-btn sm', href: `#/card/${encodeURIComponent(ap.group_id)}/${encodeURIComponent(ap.conversation_id)}/${encodeURIComponent(ap.evaluation_id)}` }, 'Открыть карточку'));
      const body = h('div', { class: 'cqa-appeal-layout' },
        h('div', {},
          h('div', { class: 'cqa-small cqa-muted' }, 'Спорная оценка'),
          h('div', { class: 'cqa-row' }, answerBadge(c, d), h('span', { class: 'cqa-small' }, disputedPts)),
          h('p', { class: 'cqa-small' }, d.explanation),
          ev.record_changed ? h('div', { class: 'cqa-note' }, rec ? 'Архивная оценка: доказательства показаны по сохранённому исходному тексту.' : 'Текст диалога изменился, исходная версия не сохранена. Доказательства нельзя сопоставить с текущими репликами.') : null,
          d.na_reason ? h('p', { class: 'cqa-small' }, h('b', {}, 'Причина N/A: '), d.na_reason) : null,
          rec ? evidenceList(d, rec, (msg, range) => { S.focusEvidence = { gid: ap.group_id, cid: ap.conversation_id, msg, range }; location.hash = `#/card/${encodeURIComponent(ap.group_id)}/${encodeURIComponent(ap.conversation_id)}/${encodeURIComponent(ap.evaluation_id)}`; }) : null,
          h('div', { class: 'cqa-small cqa-muted', style: 'margin-top:8px' }, 'Комментарий заявителя'),
          h('p', { style: 'margin:4px 0' }, '«' + ap.comment + '»'),
          ap.status === 'open' ? decisionForm(ap, c) : h('div', { class: 'cqa-appeal cqa-small' },
            h('b', {}, ap.decision.action === 'confirm' ? 'Оценка подтверждена' : `Изменено на «${answerText(c, ap.decision)}»`), h('div', {}, 'Причина: ' + ap.decision.reason), h('div', { class: 'cqa-muted' }, `Итог ${fmt(ap.decision.total_before)} → ${fmt(ap.decision.total_after)}`))),
        h('div', {}, h('div', { class: 'cqa-small cqa-muted' }, 'Фрагмент диалога'),
          h('div', { class: 'cqa-fragment' }, frag.length ? frag.map((k) => h('div', { class: `cqa-msg ${rec.transcript[k].speaker}${ev_ids.has(k) ? ' hl' : ''}` },
            h('div', { class: 'cqa-meta' }, h('b', {}, SPEAKER[rec.transcript[k].speaker] || ''), shortTs(rec.transcript[k].timestamp), h('div', {}, h('span', { class: 'cqa-chip' }, 'm' + k))),
            h('div', { class: 'cqa-text' }, rec.transcript[k].text))) : h('div', { class: 'cqa-muted cqa-small', style: 'padding:8px' }, 'Нет ссылок на реплики — откройте карточку, чтобы увидеть весь диалог.'))));
      box.append(head, body);
      return box;
    }));
    if (!isCurrent()) return;
    const empty = h('div', { class: 'cqa-panel cqa-empty' }, h('b', {}, 'В этой очереди нет апелляций'), 'Выберите другой статус или набор.');
    const statusFilter = h('select', { class: 'cqa-select', 'aria-label': 'Статус апелляций', onchange: filterAppeals }, h('option', { value: 'open' }, `Открытые · ${S.openAppeals}`), h('option', { value: 'all' }, `Все · ${list.length}`), h('option', { value: 'resolved' }, 'Рассмотренные'));
    const groupFilter = h('select', { class: 'cqa-select', 'aria-label': 'Набор апелляций', onchange: filterAppeals }, h('option', { value: '' }, 'Все наборы'), [...new Set(list.map((a) => a.group_id))].map((gid) => h('option', { value: gid }, gid)));
    function filterAppeals() {
      let count = 0;
      items.forEach((item) => {
        const matchesStatus = statusFilter.value === 'all' || (statusFilter.value === 'open' ? item.dataset.appealStatus === 'open' : item.dataset.appealStatus !== 'open');
        item.hidden = !matchesStatus || (!!groupFilter.value && item.dataset.appealGroup !== groupFilter.value);
        if (!item.hidden) count++;
      });
      empty.hidden = count > 0;
    }
    rc(main, pageHead('Апелляции', 'Спорная оценка, позиция оператора и решение проверяющего', h('div', { class: 'cqa-row' }, statusFilter, groupFilter)), ...items, empty);
    filterAppeals();

    function decisionForm(ap, c) {
      const reason = h('textarea', { class: 'cqa-textarea', 'aria-label': 'Обоснование решения проверяющего', required: true, maxlength: 4000, placeholder: 'Обоснуйте решение со ссылкой на диалог' });
      const opts = c.type === 'scale'
        ? [...c.scale.map((s) => ({ v: 'SCORE:' + s.value, t: `${s.value} — ${s.description}` })), ...(c.na_allowed ? [{ v: 'NA', t: 'N/A' }] : [])]
        : c.type === 'flag' ? [{ v: 'YES', t: 'Выявлено' }, { v: 'NO', t: 'Не выявлено' }]
        : [{ v: 'YES', t: 'Да' }, { v: 'NO', t: 'Нет' }, ...(c.na_allowed ? [{ v: 'NA', t: 'N/A' }] : [])];
      const selectedAnswer = ap.disputed.answer === 'SCORE' ? 'SCORE:' + ap.disputed.value : ap.disputed.answer;
      const sel = h('select', { class: 'cqa-select', 'aria-label': 'Новое значение критерия', style: 'width:100%' }, opts.map((o) => h('option', { value: o.v, selected: o.v === selectedAnswer }, o.t)));
      let submitting = false;
      const confirmButton = h('button', { class: 'cqa-btn primary sm', onclick: () => submit('confirm') }, 'Подтвердить оценку');
      const changeButton = h('button', { class: 'cqa-btn sm', onclick: () => submit('change') }, 'Изменить оценку');
      async function submit(action) {
        if (submitting) return;
        if (!reason.value.trim()) { toast('Обоснуйте решение проверяющего', true); reason.focus(); return; }
        const body = { action, reason: reason.value, reviewer: 'Проверяющий' };
        if (action === 'change') {
          const [ans, val] = sel.value.split(':');
          body.answer = ans; body.value = val != null ? Number(val) : null;
        }
        try {
          submitting = true; confirmButton.disabled = changeButton.disabled = true;
          const ev = await api('POST', `/evaluations/${encodeURIComponent(ap.evaluation_id)}/appeals/${encodeURIComponent(ap.id)}/decision`, body);
          const done = ev.appeals.find((x) => x.id === ap.id);
          toast(`Решение сохранено. Итог: ${fmt(done.decision.total_before)} → ${fmt(done.decision.total_after)}`);
          if (isCurrent()) viewAppeals();
        } catch (e) { toast(e.message, true); }
        finally { submitting = false; confirmButton.disabled = changeButton.disabled = false; }
      }
      return h('div', { class: 'cqa-appeal' },
        h('b', { class: 'cqa-small' }, 'Решение проверяющего'), reason,
        h('div', { class: 'cqa-row', style: 'margin-top:6px' }, confirmButton),
        h('div', { class: 'cqa-small cqa-muted', style: 'margin-top:8px' }, 'или изменить на:'), sel,
        h('div', { class: 'cqa-row', style: 'margin-top:6px' }, changeButton));
    }
  }

  // ================= РЕДАКТОР ЧЕК-ЛИСТА =================
  async function viewChecklist() {
    const isCurrent = startView('checklist');
    rc(main, loading());
    let cl;
    try { cl = await api('GET', '/checklists/' + encodeURIComponent(S.checklist)); }
    catch (e) { if (isCurrent()) rc(main, pageHead('Чек-лист'), h('div', { class: 'cqa-panel cqa-empty', role: 'alert' }, h('b', {}, 'Чек-лист не загрузился'), h('p', {}, e.message), h('button', { class: 'cqa-btn', onclick: viewChecklist }, 'Повторить'))); return; }
    if (!isCurrent()) return;
    const draftKey = cl.id + ':' + cl.version;
    S.checklistDrafts = S.checklistDrafts || {};
    const draft = S.checklistDrafts[draftKey] || JSON.parse(JSON.stringify(cl));
    S.checklistDrafts[draftKey] = draft;
    let saving = false;
    const box = h('div', {});

    function draw() {
      const sum = draft.criteria.reduce((s, c) => s + (c.type === 'flag' ? 0 : Number(c.weight) || 0), 0);
      rc(box, 
        h('div', { class: 'cqa-panel' },
          h('div', { class: 'cqa-row' },
            h('label', { class: 'cqa-field' }, 'Открыть чек-лист', checklistSelect(viewChecklist)),
            h('label', { class: 'cqa-field cqa-grow' }, 'Название', h('input', { class: 'cqa-input', value: draft.name, oninput: (e) => (draft.name = e.target.value) })),
            h('label', { class: 'cqa-field' }, 'Округление итога', h('input', { class: 'cqa-input', type: 'number', min: 0, max: 4, value: draft.rounding ?? 2, style: 'width:90px', oninput: (e) => (draft.rounding = Number(e.target.value)) }))),
          h('label', { class: 'cqa-field', style: 'margin-top:10px' }, 'Общие примечания для модели', h('input', { class: 'cqa-input', value: draft.notes || '', oninput: (e) => (draft.notes = e.target.value) })),
          h('div', { class: 'cqa-row', style: 'margin-top:12px' },
            h('span', { class: 'cqa-small ' + (sum === 100 ? 'cqa-muted' : 'cqa-badge warn') }, `Сумма весов: ${sum}${sum === 100 ? '' : ' (не 100 — итог всё равно нормируется к 100)'}`),
            h('span', { class: 'cqa-small cqa-muted' }, `Текущая версия: v${cl.version}${cl.updated_at ? ' от ' + new Date(cl.updated_at).toLocaleString('ru-RU') : ''}`),
            h('div', { class: 'cqa-grow' }),
            h('button', { class: 'cqa-btn', onclick: addCrit }, '+ Критерий'),
            h('button', { class: 'cqa-btn', onclick: async () => { if (await confirmBox('Сбросить изменения?', 'Черновик этого чек-листа будет заменён последней сохранённой версией.', 'Сбросить')) { delete S.checklistDrafts[draftKey]; if (isCurrent()) viewChecklist(); } } }, 'Сбросить черновик'),
            h('button', { class: 'cqa-btn', onclick: saveAsNew }, 'Сохранить как новый'),
            h('button', { class: 'cqa-btn primary', onclick: save }, 'Сохранить (новая версия)'))),
        h('div', { class: 'cqa-panel' }, h('h3', {}, 'Секции'),
          draft.sections.map((s, i) => h('div', { class: 'cqa-row', style: 'margin-top:6px' },
            h('input', { class: 'cqa-input', 'aria-label': 'ID секции ' + (i + 1), value: s.id, style: 'width:120px', title: 'id секции', oninput: (e) => { const prev = s.id; s.id = e.target.value; draft.criteria.forEach((c) => { if (c.section === prev) c.section = s.id; }); } }),
            h('input', { class: 'cqa-input cqa-grow', 'aria-label': 'Название секции ' + (i + 1), value: s.name, oninput: (e) => (s.name = e.target.value) }),
            h('button', { class: 'cqa-btn sm danger', onclick: () => { draft.criteria.forEach((c) => { if (c.section === s.id) c.section = ''; }); draft.sections.splice(i, 1); draw(); } }, 'Удалить'))),
          h('button', { class: 'cqa-btn sm', style: 'margin-top:8px', onclick: () => { draft.sections.push({ id: 's' + (draft.sections.length + 1), name: 'Новая секция' }); draw(); } }, '+ Секция')),
        h('div', { class: 'cqa-panel' }, h('h3', {}, `Критерии (${draft.criteria.length})`), draft.criteria.map(critEditor))
      );
    }

    function critEditor(c, i) {
      const upd = (k) => (e) => { c[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; if (k === 'type' || k === 'na_allowed') { if (c.type === 'scale' && !c.scale) c.scale = [{ value: 10, description: '' }, { value: 5, description: '' }, { value: 0, description: '' }]; if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; } draw(); } };
      return h('div', { class: 'cqa-editor-crit' },
        h('label', { class: 'cqa-field' }, 'Код', h('input', { class: 'cqa-input', value: c.code || '', oninput: upd('code') })),
        h('label', { class: 'cqa-field' }, 'Название критерия', h('input', { class: 'cqa-input', value: c.title, oninput: upd('title') })),
        h('label', { class: 'cqa-field' }, 'Тип ответа', h('select', { class: 'cqa-select', onchange: upd('type') }, Object.entries(TYPE).map(([v, t]) => h('option', { value: v, selected: c.type === v }, t)))),
        h('label', { class: 'cqa-field' }, 'Секция', h('select', { class: 'cqa-select', onchange: upd('section') }, h('option', { value: '' }, '—'), draft.sections.map((s) => h('option', { value: s.id, selected: c.section === s.id }, s.name)))),
        h('label', { class: 'cqa-field' }, 'Вес', h('input', { class: 'cqa-input', type: 'number', min: 0, value: c.weight, disabled: c.type === 'flag', oninput: (e) => { c.weight = Number(e.target.value); } })),
        h('div', { class: 'cqa-row' },
          h('button', { class: 'cqa-btn sm', 'aria-label': 'Переместить критерий выше', disabled: i === 0, onclick: () => { draft.criteria.splice(i - 1, 0, draft.criteria.splice(i, 1)[0]); draw(); } }, '↑'),
          h('button', { class: 'cqa-btn sm', 'aria-label': 'Переместить критерий ниже', disabled: i === draft.criteria.length - 1, onclick: () => { draft.criteria.splice(i + 1, 0, draft.criteria.splice(i, 1)[0]); draw(); } }, '↓'),
          h('button', { class: 'cqa-btn sm danger', onclick: () => { if (confirmInline(c)) { draft.criteria.splice(i, 1); draw(); } } }, 'Удалить')),
        h('label', { class: 'cqa-field cqa-wide' }, 'Формулировка / правило оценки (её читает ИИ)', h('textarea', { class: 'cqa-textarea', oninput: upd('description') }, c.description || '')),
        c.type !== 'flag' ? h('div', { class: 'cqa-wide cqa-row' },
          h('label', { class: 'cqa-row cqa-small' }, h('input', { type: 'checkbox', checked: c.na_allowed, onchange: upd('na_allowed') }), 'N/A разрешён'),
          c.na_allowed ? h('input', { class: 'cqa-input cqa-grow', 'aria-label': 'Условие N/A для ' + c.title, placeholder: 'Условие, при котором ставится N/A', value: c.na_condition || '', oninput: upd('na_condition') }) : null) : null,
        c.type === 'scale' ? h('div', { class: 'cqa-wide' }, h('div', { class: 'cqa-small cqa-muted' }, 'Шкала (верхняя ступень = полный вес)'),
          c.scale.map((s, k) => h('div', { class: 'cqa-scale-row' },
            h('input', { class: 'cqa-input', 'aria-label': 'Баллы ступени ' + (k + 1), type: 'number', min: 0, value: s.value, oninput: (e) => (s.value = Number(e.target.value)) }),
            h('input', { class: 'cqa-input', 'aria-label': 'Описание ступени ' + (k + 1), value: s.description, placeholder: 'Описание ступени', oninput: (e) => (s.description = e.target.value) }),
            h('button', { class: 'cqa-btn sm danger', 'aria-label': 'Удалить ступень ' + (k + 1), onclick: () => { c.scale.splice(k, 1); draw(); } }, '×'))),
          h('button', { class: 'cqa-btn sm', style: 'margin-top:6px', onclick: () => { c.scale.push({ value: 0, description: '' }); draw(); } }, '+ Ступень')) : null,
        h('div', { class: 'cqa-wide cqa-small cqa-muted' }, `id: ${c.id}`)
      );
    }
    // Простое встроенное подтверждение без браузерного confirm(): двойной клик в течение 3 с
    const pendingDel = new Set();
    function confirmInline(c) {
      if (pendingDel.has(c.id)) return true;
      pendingDel.add(c.id);
      toast(`Нажмите «Удалить» ещё раз, чтобы удалить «${c.title}»`);
      setTimeout(() => pendingDel.delete(c.id), 3000);
      return false;
    }
    function addCrit() {
      let n = draft.criteria.length + 1;
      while (draft.criteria.some((c) => c.id === 'c' + String(n).padStart(2, '0'))) n++;
      const id = 'c' + String(n).padStart(2, '0');
      draft.criteria.push({ id, code: String(n).padStart(2, '0'), section: draft.sections[0] ? draft.sections[0].id : null, title: 'Новый критерий', type: 'binary', weight: 10, na_allowed: false, description: 'Да — ...', na_condition: '' });
      draw();
      setTimeout(() => main.querySelector('.cqa-editor-crit:last-child')?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
    async function save() {
      if (saving) return;
      saving = true;
      try {
        const saved = await api('PUT', '/checklists/' + encodeURIComponent(cl.id), draft);
        delete S.checklistDrafts[draftKey];
        toast(`Сохранено: версия ${saved.version}. Чтобы применить — «Диалоги» → «Оценить все».`);
        await loadBase(); if (isCurrent()) viewChecklist();
      } catch (e) { toast(e.message, true); }
      finally { saving = false; }
    }
    async function saveAsNew() {
      if (saving) return;
      saving = true;
      try {
        const saved = await api('POST', '/checklists', { ...draft, name: draft.name === cl.name ? draft.name + ' (копия)' : draft.name });
        S.checklist = saved.id; store.set('checklist', saved.id);
        delete S.checklistDrafts[draftKey];
        toast('Создан новый чек-лист «' + saved.name + '»');
        await loadBase(); if (isCurrent()) viewChecklist();
      } catch (e) { toast(e.message, true); }
      finally { saving = false; }
    }
    rc(main, pageHead('Чек-лист', 'Каждое сохранение создаёт новую версию. Исходные оценки и история сохраняются.'), h('div', { class: 'cqa-editor-hint' }, 'Изменения остаются в черновике при переходе между разделами. Сохраните новую версию, чтобы использовать её для оценки. При обновлении страницы несохранённый черновик будет потерян.'), box);
    draw();
  }


  // ================= АНАЛИТИКА =================
  const kpi = (label, value, sub, cls) => {
    const symbol = /балл|медиан|средн/i.test(label) ? 'activity' : /наруш|вниман|апел/i.test(label) ? 'shield' : /оцен|готов/i.test(label) ? 'check' : /стоим|расход/i.test(label) ? 'spark' : 'list';
    return h('div', { class: 'cqa-kpi ' + (cls || '') }, h('div', { class: 'cqa-kpi-top' }, h('div', { class: 'cqa-kpi-label' }, label), h('span', { class: 'cqa-kpi-icon' }, icon(symbol))), h('div', { class: 'cqa-kpi-value' }, value), sub ? h('div', { class: 'cqa-kpi-sub' }, sub) : null);
  };
  const hbar = (label, v, n) => h('div', { class: 'cqa-hbar', title: `${label}: ${fmt(v)} (${n} диал.)` },
    h('span', { class: 'cqa-small' }, label, h('span', { class: 'cqa-muted' }, ` · ${n}`)),
    h('div', { class: 'cqa-hbar-track' }, h('div', { class: 'cqa-hbar-fill', style: `width:${v || 0}%` })),
    h('b', { class: 'cqa-num cqa-small' }, fmt(v)));

  // ================= СТРАНИЦА ОПЕРАТОРА =================
  async function viewOperator(name) {
    const isCurrent = startView('dashboard');
    rc(main, loading());
    const A = await api('GET', `/analytics?group_id=${encodeURIComponent(S.group)}&checklist_id=${encodeURIComponent(S.checklist)}`);
    if (!isCurrent()) return;
    const o = A.operators.find((x) => x.name === name);
    const back = h('a', { class: 'cqa-btn', href: '#/dashboard' }, '← К аналитике');
    if (!o) { rc(main, pageHead(name, `Набор ${S.group}`, back), h('div', { class: 'cqa-panel cqa-empty' }, 'В этом наборе нет оценок этого оператора.')); return; }
    const team = Object.fromEntries(A.criteria.map((c) => [c.id, c.rate]));
    const crits = o.criteria.filter((c) => c.rate != null).sort((a, b) => a.rate - b.rate);
    const diff = (v, base) => {
      if (v == null || base == null) return h('span', { class: 'cqa-muted' }, '—');
      const d = Math.round((v - base) * 10) / 10;
      return h('b', { style: `color:${d > 0 ? 'var(--good)' : d < 0 ? 'var(--bad)' : 'var(--muted)'}` }, `${d > 0 ? '+' : ''}${fmt(d)}`);
    };
    const titleOf = (id) => (o.criteria.find((c) => c.id === id) || {}).title || id;
    const dialogs = o.conversations.slice().sort((a, b) => (a.total ?? 101) - (b.total ?? 101));
    const openCard = (d) => (location.hash = `#/card/${encodeURIComponent(S.group)}/${encodeURIComponent(d.id)}/${encodeURIComponent(d.eval_id)}`);
    rc(main,
      pageHead(o.name, `Набор ${S.group} · ${o.languages.join(', ')}`, back),
      h('div', { class: 'cqa-kpis' },
        kpi('Средний балл', h('span', { style: `color:${scoreColor(o.avg)}` }, fmt(o.avg)), ['к среднему по команде: ', diff(o.avg, A.avg)]),
        kpi('Диалогов', String(o.dialogs), `худший итог ${fmt(o.min)}`),
        kpi('Грубые нарушения', String(o.gross), o.gross_unknown ? `ещё ${o.gross_unknown} флагов требуют проверки` : o.gross ? 'нужен разбор' : 'не выявлено', o.gross || o.gross_unknown ? 'alert' : ''),
        kpi('Слабое место', o.weakest ? `${fmt(o.weakest.rate)}%` : '—', o.weakest ? o.weakest.title : 'потерь по критериям нет')),
      h('div', { class: 'cqa-grid-2' },
        h('div', { class: 'cqa-panel' }, h('h2', {}, 'Критерии: от слабых к сильным'),
          h('div', { class: 'cqa-table-wrap' }, h('table', { class: 'cqa-table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Критерий'), h('th', { class: 'cqa-num' }, 'Оператор'), h('th', { class: 'cqa-num' }, 'Команда'), h('th', { class: 'cqa-num' }, 'Разница'))),
            h('tbody', {}, crits.map((c) => h('tr', {}, h('td', {}, c.title), h('td', { class: 'cqa-num' }, `${fmt(c.rate)}%`), h('td', { class: 'cqa-num cqa-muted' }, `${fmt(team[c.id])}%`), h('td', { class: 'cqa-num' }, diff(c.rate, team[c.id])))))))),
        h('div', { class: 'cqa-panel' }, h('h2', {}, 'Что улучшить'),
          o.coaching.length ? o.coaching.map((c) => h('div', { class: 'cqa-leader', style: 'grid-template-columns:1fr' }, h('div', {}, h('b', {}, titleOf(c.criterion_id)), h('span', { class: 'cqa-muted cqa-small' }, ` · ${c.conversation_id}`), h('div', { class: 'cqa-small' }, c.text))))
            : h('div', { class: 'cqa-muted' }, 'Обязательных рекомендаций нет.'))),
      h('div', { style: 'height:16px' }),
      h('div', { class: 'cqa-panel' }, h('h2', {}, 'Диалоги оператора'),
        h('div', { class: 'cqa-table-wrap' }, h('table', { class: 'cqa-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'ID диалога'), h('th', {}, 'Канал'), h('th', {}, 'Язык'), h('th', { class: 'cqa-num' }, 'Итог'), h('th', {}, 'Грубая ошибка'))),
          h('tbody', {}, dialogs.map((d) => h('tr', { class: 'cqa-click', onclick: () => openCard(d) }, h('td', { class: 'cqa-nowrap' }, h('b', {}, d.id)), h('td', { class: 'cqa-nowrap' }, d.channel === 'voice call' ? 'Звонок' : 'Чат'), h('td', {}, h('span', { class: 'cqa-chip' }, d.language)), h('td', { class: 'cqa-num' }, totalBadge(d.total)), h('td', {}, d.gross_unknown ? h('span', { class: 'cqa-badge warn' }, 'нужна проверка') : d.gross ? h('span', { class: 'cqa-badge gross' }, 'Да') : h('span', { class: 'cqa-muted' }, 'нет')))))))));
  }

  function readinessPanel(isCurrent) {
    const panel = h('section', { class: 'cqa-panel cqa-readiness', 'aria-label': 'Проверка качества и готовность результатов' });
    async function refresh() {
      rc(panel, h('div', { class: 'cqa-small cqa-muted', role: 'status' }, 'Загружаем проверку качества…'));
      try {
        const report = await api('GET', '/readiness');
        if (!isCurrent()) return;
        const benchmark = report.benchmark, measured = benchmark.state === 'measured', metrics = benchmark.metrics;
        const submission = (item) => h('div', { class: 'cqa-submission-status' },
          h('div', { class: 'cqa-row' }, h('b', {}, item.split.toUpperCase()), h('span', { class: 'cqa-badge ' + (item.state === 'ready' ? 'yes' : item.state === 'waiting_dataset' ? 'na' : 'warn') }, item.state === 'ready' ? `${item.ok}/${item.expected} готово` : item.state === 'waiting_dataset' ? 'Ожидается набор' : 'Нужна проверка')),
          h('p', { class: 'cqa-small cqa-muted' }, item.message), h('code', { class: 'cqa-small' }, item.path));
        const pct = (value) => value == null ? '—' : fmt(100 * value) + '%';
        const comparison = measured && metrics ? [
          h('div', { class: 'cqa-benchmark-value' }, pct(metrics.criterion_match.rate), h('small', {}, `${metrics.criterion_match.matched} из ${metrics.criterion_match.total} ответов совпали с контрольной разметкой`)),
          h('div', { class: 'cqa-readiness-languages' }, ['RU', 'KZ', 'EN'].map((language) => { const row = metrics.by_language[language]; return h('span', { class: 'cqa-chip' }, `${language} · ${row.matched}/${row.total}`); })),
          h('p', { class: 'cqa-small cqa-muted' }, `${benchmark.case_count} примеров · ошибок обработки ${metrics.cases.failed} · требуют проверки ${metrics.cases.invalid}. Грубые нарушения: найдено ${metrics.critical.tp}/${metrics.critical.expected_positive}, ложных срабатываний ${metrics.critical.fp}, неопределённых ${metrics.critical.unknown}.`),
          h('p', { class: 'cqa-small cqa-muted' }, `Модель: ${benchmark.model}. Медиана времени: ${fmt(metrics.timing.p50_ms == null ? null : metrics.timing.p50_ms / 1000)} с. Учтённая стоимость: $${metrics.cost.total_usd.toFixed(4)}${metrics.cost.complete ? '' : ' (неполные данные)'}.`),
        ] : h('p', { class: 'cqa-small cqa-muted' }, benchmark.message);
        rc(panel,
          h('div', { class: 'cqa-row cqa-readiness-heading' }, h('h2', { class: 'cqa-grow', style: 'margin:0' }, 'Проверка качества и результаты'), h('a', { class: 'cqa-btn sm', href: `${CFG.apiBase}/api/demo-guide` }, 'План защиты · 5 минут')),
          h('div', { class: 'cqa-readiness-grid' },
            h('div', {}, h('h3', {}, 'Контрольные примеры RU / KZ / EN'), comparison,
              h('p', { class: 'cqa-small cqa-muted' }, 'Синтетическая инженерная разметка. Это не независимая экспертная проверка и не точность на всём DEV.'),
              benchmark.metrics ? h('a', { class: 'cqa-btn sm', href: `${CFG.apiBase}/api/benchmark/report` }, 'Скачать отчёт с расхождениями') : null),
            h('div', {}, h('h3', {}, 'Файлы для сдачи'), report.submissions.map(submission), h('p', { class: 'cqa-small cqa-muted' }, report.publication.message))),
          h('details', { class: 'cqa-calculation' }, h('summary', {}, 'Сценарий защиты по минутам'), h('ol', { class: 'cqa-demo-plan' }, report.demo.steps.map((step) => h('li', {}, h('b', {}, `${step.seconds / 60} мин · ${step.title}`), h('p', { class: 'cqa-small cqa-muted' }, step.detail))))));
      } catch (error) {
        if (isCurrent()) rc(panel, h('h2', {}, 'Проверка качества'), h('p', { class: 'cqa-small cqa-muted' }, error.message), h('button', { class: 'cqa-btn sm', onclick: refresh }, 'Повторить проверку'));
      }
    }
    refresh();
    return panel;
  }

  async function viewDashboard() {
    const isCurrent = startView('dashboard');
    rc(main, loading());
    if (!S.group) { rc(main, pageHead('Аналитика качества'), h('div', { class: 'cqa-panel cqa-empty' }, h('b', {}, 'Здесь появится картина качества команды'), h('p', {}, 'Загрузите диалоги и оцените их по чек-листу. Затем сравните языки, каналы и результаты операторов.'), h('a', { class: 'cqa-btn primary', href: '#/list' }, 'Загрузить диалоги')), h('div', { style: 'height:20px' }), readinessPanel(isCurrent)); return; }
    const A = await api('GET', `/analytics?group_id=${encodeURIComponent(S.group)}&checklist_id=${encodeURIComponent(S.checklist)}`);
    if (!isCurrent()) return;
    const open = (cid, evId) => (location.hash = `#/card/${encodeURIComponent(S.group)}/${encodeURIComponent(cid)}/${encodeURIComponent(evId)}`);
    const filters = h('div', { class: 'cqa-row' },
      h('label', { class: 'cqa-field' }, 'Набор', h('select', { class: 'cqa-select', onchange: (e) => { S.group = e.target.value; store.set('group', S.group); viewDashboard(); } },
        S.datasets.map((d) => h('option', { value: d.group_id, selected: d.group_id === S.group }, d.group_id)))),
      h('label', { class: 'cqa-field' }, 'Чек-лист', checklistSelect(viewDashboard)));
    if (!A.evaluated) { rc(main, pageHead('Аналитика качества', `Набор ${S.group}`, filters), h('div', { class: 'cqa-panel cqa-empty' }, h('b', {}, 'Диалоги готовы к оценке'), h('p', {}, 'Запустите проверку набора, чтобы увидеть средний балл, частые ошибки и рекомендации команде.'), h('a', { class: 'cqa-btn primary', href: '#/list' }, 'Перейти к оценке')), h('div', { style: 'height:20px' }), readinessPanel(isCurrent)); return; }

    // --- главный вывод
    const weakest = A.criteria.filter((c) => c.rate != null).sort((a, b) => a.rate - b.rate)[0];
    const best = A.operators.find((o) => !o.unnamed && o.avg != null);
    const langs = Object.entries(A.by_language).filter(([, v]) => v.avg != null).sort((a, b) => a[1].avg - b[1].avg);
    const insights = [
      A.demo_count ? `Внимание: ${A.demo_count} из ${A.evaluated} оценок сделаны в демо-режиме без ИИ. Переоцените их, чтобы цифры были точными.` : null,
      weakest ? `Самое слабое место — «${weakest.title}»: выполняется лишь на ${fmt(weakest.rate)}%.` : null,
      langs.length > 1 && langs[langs.length - 1][1].avg - langs[0][1].avg >= 3 ? `Диалоги на ${langs[0][0]} оцениваются ниже всего (${fmt(langs[0][1].avg)} против ${fmt(langs[langs.length - 1][1].avg)} у ${langs[langs.length - 1][0]}).` : null,
      A.gross_count ? `Грубых нарушений: ${A.gross_count} — требуют разбора с руководителем.` : A.gross_unknown_count ? 'Подтверждённых грубых нарушений пока нет; часть флагов ещё требует проверки.' : 'Грубых нарушений не выявлено.',
      A.gross_unknown_count ? `В ${A.gross_unknown_count} диалогах проверка грубых нарушений не завершена. Их нельзя считать проверенными без нарушений.` : null,
      best ? `Лучший оператор — ${best.name} (средний балл ${fmt(best.avg)}).` : null,
    ].filter(Boolean);

    // --- KPI
    const kpis = h('div', { class: 'cqa-kpis' },
      kpi('Средний балл', [h('span', { style: `color:${scoreColor(A.avg)}` }, fmt(A.avg)), h('small', {}, ' / 100')], `медиана ${fmt(A.median)}`),
      kpi('Оценено диалогов', String(A.evaluated), Object.entries(A.by_channel).map(([k, v]) => `${k === 'voice call' ? 'звонков' : 'чатов'}: ${v.n}`).join(' · ')),
      kpi('Грубые нарушения', String(A.gross_count), A.gross_unknown_count ? `ещё ${A.gross_unknown_count} диал. требуют проверки флага` : A.gross_count ? 'нужен разбор' : 'не выявлено', A.gross_count || A.gross_unknown_count ? 'alert' : ''),
      kpi('Апелляции', `${A.appeals_total}`, `открыто ${A.appeals_open} · итог изменён в ${A.changed_by_appeal}`),
      kpi('Стоимость оценки', `$${fmt(A.cost_usd)}`, `≈ $${fmt(A.evaluated ? A.cost_usd / A.evaluated : 0)} за диалог`),
      A.low_confidence ? kpi('Спорные ответы ИИ', String(A.low_confidence), 'прогоны разошлись — стоит проверить') : null);

    // --- распределение баллов (одна серия → без легенды, подпись в заголовке)
    const maxC = Math.max(1, ...A.distribution.map((b) => b.count));
    const dist = h('div', { class: 'cqa-panel' }, h('h2', {}, 'Распределение итоговых баллов'),
      h('div', { class: 'cqa-bars' }, A.distribution.map((b) => h('div', { class: 'cqa-bar-col', title: `${b.from}–${Math.round(b.to)} баллов: ${b.count} диал.` },
        h('div', { class: 'cqa-bar-val' }, b.count || ''), h('div', { class: 'cqa-bar', style: `height:${(b.count / maxC) * 100}%;background:${b.from >= 80 ? 'var(--good)' : b.from >= 60 ? '#d08a1a' : 'var(--bad)'}` })))),
      h('div', { class: 'cqa-bar-labels' }, A.distribution.map((b) => h('span', {}, b.from === 0 ? '<50' : `${b.from}–${Math.round(b.to)}`))),
      h('div', { class: 'cqa-legend' }, h('i', { style: 'background:var(--bad)' }), 'ниже 60', h('i', { style: 'background:#d08a1a;margin-left:8px' }), '60–80', h('i', { style: 'background:var(--good);margin-left:8px' }), '80+'));

    const segs = h('div', { class: 'cqa-panel' }, h('h2', {}, 'Средний балл по языкам и каналам'),
      Object.entries(A.by_language).map(([k, v]) => hbar({ RU: 'Русский', KZ: 'Казахский', EN: 'Английский' }[k] || k, v.avg, v.n)),
      h('div', { style: 'height:10px' }),
      Object.entries(A.by_channel).map(([k, v]) => hbar(k === 'voice call' ? 'Звонки' : 'Чаты', v.avg, v.n)));

    // --- тепловая карта: критерии × языки (последовательная шкала одного оттенка)
    const SEQ = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
    const cell = (v) => {
      if (v == null) return h('td', { class: 'empty', title: 'нет применимых диалогов' }, '—');
      const i = Math.min(5, Math.floor(v / 100 * 6));
      return h('td', { style: `background:var(${SEQ[i]});color:${i >= 3 ? '#fff' : 'var(--ink)'}`, title: `${fmt(v)}% выполнения` }, `${Math.round(v)}%`);
    };
    const heat = h('div', { class: 'cqa-panel' }, h('h2', {}, 'Где операторы теряют баллы'),
      h('div', { class: 'cqa-small cqa-muted', style: 'margin:-6px 0 10px' }, 'Доля набранных баллов по критерию среди применимых диалогов. Чем светлее ячейка, тем чаще критерий проваливают.'),
      h('table', { class: 'cqa-heat' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Критерий'), h('th', {}, 'Все'), A.languages.map((l) => h('th', {}, l)), h('th', {}, 'N/A'))),
        h('tbody', {}, A.criteria.map((c) => h('tr', {}, h('td', {}, h('span', { class: 'cqa-chip', style: 'margin-right:6px' }, c.code || c.id), c.title), cell(c.rate), A.languages.map((l) => cell(c.by_language[l])), h('td', { class: 'empty' }, String(c.na)))))),
      h('div', { class: 'cqa-legend' }, '0%', SEQ.map((v) => h('i', { style: `background:var(${v})` })), '100% выполнения'));

    // --- рейтинг операторов
    const named = A.operators.filter((o) => !o.unnamed);
    const unnamed = A.operators.find((o) => o.unnamed);
    const leader = h('div', { class: 'cqa-panel' }, h('h2', {}, 'Результаты операторов'),
      named.length ? named.map((o, i) => h('div', { class: 'cqa-leader', style: 'cursor:pointer', title: 'Открыть страницу оператора', onclick: () => (location.hash = `#/operator/${encodeURIComponent(o.name)}`) },
        h('div', { class: 'cqa-rank' + (i < 3 ? ' r' + (i + 1) : '') }, i + 1),
        h('div', { class: 'cqa-row', style: 'gap:10px;flex-wrap:nowrap' }, avatar(o.name), h('div', {},
          h('div', { class: 'cqa-leader-name' }, o.name, o.gross ? h('span', { class: 'cqa-badge gross', style: 'margin-left:8px' }, icon('appeal'), String(o.gross)) : null),
          h('div', { class: 'cqa-leader-meta' }, `${o.dialogs} диал. · ${o.languages.join(', ')}`, o.weakest ? ` · слабое место: ${o.weakest.title} (${fmt(o.weakest.rate)}%)` : ''))),
        h('div', { class: 'cqa-leader-score', style: `color:${scoreColor(o.avg)}` }, fmt(o.avg)))) : h('div', { class: 'cqa-muted' }, 'Операторы не представлялись — имена не найдены.'),
      unnamed ? h('div', { class: 'cqa-small cqa-muted', style: 'margin-top:10px' }, `Не представились в диалоге: ${unnamed.dialogs} диал., средний балл ${fmt(unnamed.avg)}`) : null);

    // --- зона риска
    const risk = h('div', { class: 'cqa-panel' }, h('h2', {}, 'Требуют внимания'),
      A.gross.length ? [h('h3', {}, 'Грубые нарушения'), A.gross.map((g) => h('div', { class: 'cqa-leader', style: 'grid-template-columns:auto 1fr auto;cursor:pointer', onclick: () => open(g.conversation_id, g.eval_id) },
        h('span', { class: 'cqa-badge gross' }, icon('appeal')), h('div', {}, h('b', {}, g.conversation_id), g.operator ? h('span', { class: 'cqa-muted' }, ` · ${g.operator}`) : null, h('div', { class: 'cqa-small cqa-muted' }, g.explanation || '')), h('span', { class: 'cqa-small' }, '→')))] : null,
      h('h3', { style: 'margin-top:12px' }, 'Самые низкие оценки'),
      A.worst.map((w) => h('div', { class: 'cqa-leader', style: 'grid-template-columns:auto 1fr auto;cursor:pointer', onclick: () => open(w.conversation_id, w.eval_id) },
        h('b', { style: `color:${scoreColor(w.total)};font-variant-numeric:tabular-nums` }, fmt(w.total)), h('div', {}, h('b', {}, w.conversation_id), w.operator ? h('span', { class: 'cqa-muted' }, ` · ${w.operator}`) : null, h('div', { class: 'cqa-small cqa-muted' }, w.summary || '')), h('span', { class: 'cqa-small' }, '→'))));

    rc(main,
      pageHead('Аналитика качества', `${A.checklist ? A.checklist.name + ' · v' + A.checklist.version : ''} · набор ${S.group} · модель ${A.models.join(', ')}`, filters),
      h('div', { class: 'cqa-panel cqa-coach', style: 'margin:0 0 16px' }, h('b', {}, 'На что обратить внимание'), h('ul', {}, insights.map((t) => h('li', {}, t)))),
      kpis,
      readinessPanel(isCurrent),
      h('div', { style: 'height:20px' }),
      h('div', { class: 'cqa-grid-2' }, dist, segs),
      h('div', { style: 'height:16px' }),
      heat,
      h('div', { style: 'height:16px' }),
      h('div', { class: 'cqa-grid-2' }, leader, risk));
  }

  // ---------- роутинг ----------
  async function route() {
    const requestedHash = location.hash;
    try {
      const parts = (location.hash || '#/list').slice(2).split('/').map(decodeURIComponent);
      if (parts[0] === 'card') return await viewCard(parts[1], parts[2], parts[3]);
      if (parts[0] === 'appeals') return await viewAppeals();
      if (parts[0] === 'checklist') return await viewChecklist();
      if (parts[0] === 'dashboard') return await viewDashboard();
      if (parts[0] === 'operator') return await viewOperator(parts[1]);
      return await viewList();
    } catch (e) {
      if (location.hash !== requestedHash) return;
      rc(main, h('div', { class: 'cqa-panel cqa-empty', role: 'alert' }, h('b', {}, 'Не удалось открыть раздел'), h('p', {}, e.message), h('button', { class: 'cqa-btn', onclick: route }, 'Попробовать снова'), h('a', { class: 'cqa-btn', href: '#/list' }, 'К диалогам')));
    }
  }
  window.addEventListener('keydown', (e) => {
    if (!S.cardNav || location.hash.indexOf('#/card/') !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (/^(INPUT|TEXTAREA|SELECT|AUDIO)$/.test(e.target.tagName) || document.querySelector('.cqa-modal-back')) return;
    const href = e.key === 'ArrowLeft' ? S.cardNav.prev : e.key === 'ArrowRight' ? S.cardNav.next : null;
    if (href) location.hash = href;
  });
  window.addEventListener('hashchange', async () => { await loadBase().catch(() => {}); route(); });
  async function boot() {
    rc(main, loading());
    try { await loadBase(); await route(); }
    catch (e) { rc(main, h('div', { class: 'cqa-panel cqa-empty', role: 'alert' }, h('b', {}, 'Не удалось подключиться к серверу'), h('p', {}, e.message), h('button', { class: 'cqa-btn primary', onclick: boot }, 'Повторить подключение'))); }
  }
  boot();
})();
