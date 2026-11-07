'use strict';
// Software-only DOM integration regression. No browser, provider, or real datastore.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const checklist = require('../src/default-checklist.json');
const { computeScore } = require('../src/scoring');
const record = require('../public/demo-sample.json').data.records[0];
const source = fs.readFileSync(path.join(__dirname, '../public/cqa.js'), 'utf8');
class Element {
  constructor(tag = '', text = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.text = text; this.attrs = {}; this.events = {}; this.className = ''; this.style = {}; this.dataset = {}; this.parentNode = null; this._value = '';
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); }, remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); }, toggle() {} };
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map((node) => node.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this.tagName === 'SELECT' ? (this.children.find((node) => node.selected) || this.children[0] || {})._value || '' : this._value; }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); if (key === 'hidden') this.hidden = true; if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
  hasAttribute(key) { return key in this.attrs; }
  append(...nodes) { for (let node of nodes) { if (!(node instanceof Element)) node = new Element('', String(node)); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach((node) => { node.parentNode = null; }); this.children = []; this.text = ''; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((node) => node !== this); this.parentNode = null; } }
  all() { return this.children.flatMap((node) => [node, ...node.all()]); }
  querySelectorAll(selector) { return this.all().filter((node) => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName === selector.toUpperCase()); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { (this.events[type] ||= []).push(listener); }
  removeEventListener() {}
  fire(type) { if (!this.disabled) for (const listener of this.events[type] || []) listener({ target: this, currentTarget: this, detail: 1, preventDefault() {}, stopPropagation() {} }); }
  click() { this.fire('click'); }
  focus() {}
  scrollIntoView() {}
  get isConnected() { return !!this.parentNode; }
}
function evaluation(critical) {
  const criteria = Object.fromEntries(checklist.criteria.map((criterion) => [criterion.id, { answer: criterion.type === 'flag' ? critical : criterion.type === 'scale' ? 'SCORE' : 'YES', value: criterion.type === 'scale' ? Math.max(...criterion.scale.map((step) => step.value)) : null, explanation: 'Основание ' + criterion.id, evidence: [{ msg: 3 }], review_required: criterion.type === 'flag' && critical === 'INVALID', issues: [] }]));
  const result = computeScore(checklist, criteria);
  return { id: 'fixture-eval', conversation_id: record.conversation_id, group_id: 'SAMPLE', checklist: { id: 'default', version: 1, name: checklist.name }, checklist_snapshot: checklist, provider: 'test-double', model: 'no-live-call', final_criteria: criteria, criteria, final_result: result, original_result: result, appeals: [], status: critical === 'INVALID' ? 'needs_review' : 'ok', validation_errors: [], duration_ms: 0, cost_usd: 0, coaching: [] };
}
function createHarness(hash, { critical = 'INVALID', pollReply, stale = false, snapshot = false, recordMissing = false, emptyDatasets = false, readinessReply, stepped = false, stepReply, initialActiveCloudJob = '' } = {}) {
  const root = new Element('div'); root.parentNode = {};
  const document = { querySelector: (selector) => selector === '#cqa-app' ? root : root.querySelector(selector), querySelectorAll: (selector) => root.querySelectorAll(selector), createElement: (tag) => new Element(tag), createTextNode: (text) => new Element('', String(text)), addEventListener() {}, removeEventListener() {} };
  const ev = evaluation(critical), timers = new Map(), requests = [], events = {}, storage = new Map();
  if (initialActiveCloudJob) storage.set('cqa.activeCloudJob', initialActiveCloudJob);
  ev.stale = stale; ev.record_changed = stale;
  const currentRecord = JSON.parse(JSON.stringify(record)); currentRecord.transcript[0].text = 'NEW IMPORTED MESSAGE';
  if (snapshot) { ev.record_snapshot = JSON.parse(JSON.stringify(record)); ev.record_snapshot.transcript[0].text = 'OLD ORIGINAL MESSAGE'; }
  let timerId = 0, polls = 0, readinessRequests = 0, steps = 0;
  const running = { id: 'job-fixture', group_id: 'SAMPLE', status: 'running', total: 1, done: 0, skipped: 0, errors: [], cost_usd: 0, counts: { running: 1 }, ...(stepped ? { execution_mode: 'stepped' } : {}) };
  const fetch = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    let body, status = 200;
    const path = String(url).replace(/^\/api/, '');
    if (path === '/config') body = { provider: 'mock', model: 'mock', data_api_configured: false };
    else if (path === '/datasets') body = emptyDatasets ? [] : [{ group_id: 'SAMPLE', total_records: 1 }];
    else if (path.startsWith('/analytics?')) body = { evaluated: 0 };
    else if (path === '/readiness') {
      const reply = readinessReply ? await readinessReply(++readinessRequests) : { body: {
        benchmark: { state: 'measured', case_count: 15, model: 'no-live-call', metrics: {
          criterion_match: { rate: 119 / 120, matched: 119, total: 120 },
          by_language: { RU: { matched: 40, total: 40 }, KZ: { matched: 40, total: 40 }, EN: { matched: 39, total: 40 } },
          cases: { failed: 0, invalid: 0 }, critical: { tp: 2, expected_positive: 2, fp: 0, unknown: 0 },
          timing: { p50_ms: 7600 }, cost: { total_usd: 0.04, complete: true },
        } },
        submissions: [{ split: 'dev', state: 'ready', ok: 65, expected: 65, path: 'results/dev/results.json', message: 'Файл сверён' }, { split: 'prod', state: 'waiting_dataset', path: 'results/prod/results.json', message: 'Ожидается контрольный набор' }],
        publication: { message: 'Commit и push не подтверждены' }, demo: { steps: [{ seconds: 60, title: 'Пример', detail: 'Тест сценария' }] },
      } };
      body = reply.body; status = reply.status || 200;
    }
    else if (path === '/checklists') body = [{ id: 'default', name: checklist.name, version: 1 }];
    else if (path.startsWith('/appeals')) body = [];
    else if (path === '/datasets/SAMPLE') body = { group_id: 'SAMPLE', records: [{ ...record, messages: record.transcript.length, evaluations: [{ ...ev, final_total: ev.final_result.total, original_total: ev.final_result.total, gross_error: false, gross_error_unknown: critical === 'INVALID', appeals_open: 0, appeals_total: 0 }] }] };
    else if (path.startsWith('/datasets/SAMPLE/')) { body = currentRecord; if (recordMissing) { status = 404; body = { error: 'Диалог удалён' }; } }
    else if (path.startsWith('/evaluations?')) body = [ev];
    else if (path === '/evaluations/fixture-eval') body = ev;
    else if (path === '/batch' && options.method === 'POST') body = running;
    else if (path === '/batch/job-fixture') { const number = ++polls; const reply = pollReply ? await pollReply(number, running) : { body: stepped ? running : { ...running, status: 'finished', done: 1 } }; body = reply.body; status = reply.status || 200; }
    else if (path === '/batch/job-fixture/step' && options.method === 'POST') { const number = ++steps; const reply = stepReply ? await stepReply(number, running) : { body: { ...running, status: 'finished', done: 1 } }; body = reply.body; status = reply.status || 200; }
    else throw new Error('Unexpected mock request: ' + path);
    return { ok: status < 400, status, json: async () => body };
  };
  vm.runInNewContext(source, { window: { CQA_CONFIG: {}, addEventListener: (key, listener) => (events[key] ||= []).push(listener) }, document, location: { hash }, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, Node: Element, fetch, URL, URLSearchParams, Blob, console, matchMedia: () => ({ matches: true }), setTimeout: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  return { root, timers, requests, storage, get polls() { return polls; }, get steps() { return steps; }, button: (text) => root.all().find((node) => node.tagName === 'BUTTON' && node.textContent === text) };
}
const flush = async () => { for (let index = 0; index < 15; index++) await new Promise(setImmediate); };
async function tick(harness, delay) { const item = [...harness.timers].find(([, timer]) => timer.ms === delay); assert.ok(item, 'expected scheduled retry ' + delay); harness.timers.delete(item[0]); item[1].callback(); await flush(); }
(async () => {
  const unknown = createHarness('#/card/SAMPLE/' + record.conversation_id + '/fixture-eval'); await flush();
  assert.match(unknown.root.textContent, /Грубые ошибки: нужна проверка/);
  assert.ok(!unknown.root.textContent.includes('Грубых ошибок нет'));
  const known = createHarness('#/card/SAMPLE/' + record.conversation_id + '/fixture-eval', { critical: 'NO' }); await flush();
  assert.match(known.root.textContent, /Грубых ошибок нет/);
  assert.ok(known.root.querySelector('.cqa-shell-header'));
  known.button('Очистить результат').click(); await flush();
  assert.ok(known.root.querySelector('.cqa-modal'));
  assert.equal(known.root.querySelector('.cqa-workspace').inert, true, 'modal makes the entire workspace inert, including its persistent header');
  known.button('Отмена').click(); await flush();
  assert.equal(known.root.querySelector('.cqa-modal'), null);
  assert.ok(!known.root.querySelector('.cqa-workspace').inert, 'cancel restores workspace interaction');
  const listUnknown = createHarness('#/list'); await flush();
  assert.ok(listUnknown.root.all().some((node) => node.tagName === 'SPAN' && node.textContent === 'нужна проверка'));
  const staleList = createHarness('#/list', { stale: true }); await flush();
  assert.match(staleList.root.textContent, /нужна новая оценка/);
  const staleDefault = createHarness('#/card/SAMPLE/' + record.conversation_id, { stale: true, snapshot: true }); await flush();
  assert.match(staleDefault.root.textContent, /Предыдущие результаты доступны в истории/);
  assert.ok(!staleDefault.root.textContent.includes('OLD ORIGINAL MESSAGE'));
  const archived = createHarness('#/card/SAMPLE/' + record.conversation_id + '/fixture-eval', { stale: true, snapshot: true }); await flush();
  assert.match(archived.root.textContent, /Архивная оценка/);
  assert.match(archived.root.textContent, /OLD ORIGINAL MESSAGE/);
  assert.ok(!archived.root.textContent.includes('NEW IMPORTED MESSAGE'));
  const legacy = createHarness('#/card/SAMPLE/' + record.conversation_id + '/fixture-eval', { stale: true }); await flush();
  assert.match(legacy.root.textContent, /NEW IMPORTED MESSAGE/);
  assert.equal(legacy.root.querySelectorAll('.cqa-evidence').length, 0);
  assert.match(legacy.root.textContent, /переход к текущим репликам отключён/);
  const deleted = createHarness('#/card/SAMPLE/' + record.conversation_id + '/fixture-eval', { stale: true, snapshot: true, recordMissing: true }); await flush();
  assert.match(deleted.root.textContent, /OLD ORIGINAL MESSAGE/);

  const retry = createHarness('#/list', { pollReply: (number, running) => number === 1 ? { status: 503, body: { error: 'Temporary offline' } } : { body: { ...running, status: 'finished', done: 1 } } });
  await flush(); retry.button('Оценить весь набор').click(); await flush();
  assert.match(retry.root.textContent, /Связь с очередью потеряна/);
  assert.equal(retry.polls, 1);
  await tick(retry, 1500);
  assert.equal(retry.polls, 2);
  assert.match(retry.root.textContent, /Оценка завершена/);
  assert.equal(retry.button('Оценить весь набор').disabled, false);
  assert.ok(![...retry.timers.values()].some((timer) => timer.ms === 1500));

  const missing = createHarness('#/list', { pollReply: () => ({ status: 404, body: { error: 'Задача не найдена' } }) });
  await flush(); missing.button('Оценить весь набор').click(); await flush();
  assert.match(missing.root.textContent, /Очередь не найдена/);
  assert.equal(missing.button('Оценить весь набор').disabled, false);

  const persistent = createHarness('#/list', { pollReply: () => ({ status: 503, body: { error: 'Temporary offline' } }) });
  await flush(); persistent.button('Оценить весь набор').click(); await flush();
  for (const delay of [1500, 3000, 6000, 10000, 10000]) await tick(persistent, delay);
  assert.equal(persistent.polls, 6);
  assert.equal([...persistent.timers.values()].filter((timer) => timer.ms === 10000).length, 1);
  const before = persistent.polls;
  persistent.button('Повторить сейчас').click(); persistent.button('Повторить сейчас').click(); await flush();
  assert.equal(persistent.polls, before + 1, 'double retry click must not issue parallel polls');
  const stepped = createHarness('#/list', { stepped: true });
  await flush(); stepped.button('Оценить весь набор').click(); await flush();
  assert.equal(stepped.steps, 1);
  assert.deepEqual(stepped.requests.filter(([url]) => url.includes('/batch/job-fixture')).map(([, method]) => method), ['GET', 'POST']);
  assert.match(stepped.root.textContent, /Оценка завершена/);
  assert.equal(stepped.storage.get('cqa.activeCloudJob'), '');
  const lostStepResponse = createHarness('#/list', { stepped: true,
    pollReply: (number, running) => ({ body: number === 1 ? running : { ...running, status: 'finished', done: 1 } }),
    stepReply: () => ({ status: 503, body: { error: 'Response lost after commit' } }),
  });
  await flush(); lostStepResponse.button('Оценить весь набор').click(); await flush();
  assert.match(lostStepResponse.root.textContent, /Связь с очередью потеряна/);
  assert.equal(lostStepResponse.storage.get('cqa.activeCloudJob'), 'job-fixture');
  await tick(lostStepResponse, 1500);
  assert.equal(lostStepResponse.polls, 2);
  assert.equal(lostStepResponse.steps, 1, 'read committed progress before attempting another paid step after a lost response');
  assert.match(lostStepResponse.root.textContent, /Оценка завершена/);
  const resumed = createHarness('#/list', { stepped: true, initialActiveCloudJob: 'job-fixture' });
  await flush();
  assert.equal(resumed.steps, 1);
  assert.ok(!resumed.requests.some(([url, method]) => url === '/api/batch' && method === 'POST'), 'reload resumes the saved job rather than creating another batch');
  assert.equal(resumed.storage.get('cqa.activeCloudJob'), '');
  for (const emptyDatasets of [true, false]) {
    const dashboard = createHarness('#/dashboard', { emptyDatasets }); await flush();
    assert.match(dashboard.root.textContent, /Проверка качества и результаты/);
    assert.match(dashboard.root.textContent, /119 из 120/);
    assert.match(dashboard.root.textContent, /не независимая экспертная проверка/);
    assert.match(dashboard.root.textContent, /65\/65 готово/);
    assert.match(dashboard.root.textContent, /Ожидается набор/);
    assert.ok(dashboard.root.all().some((node) => node.tagName === 'A' && node.attrs.href === '/api/benchmark/report'));
  }
  const readinessRetry = createHarness('#/dashboard', { readinessReply: (number) => number === 1 ? { status: 503, body: { error: 'Readiness unavailable' } } : { body: { benchmark: { state: 'not_run', message: 'Прогон не выполнен' }, submissions: [], publication: { message: 'Не подтверждено' }, demo: { steps: [] } } } });
  await flush();
  assert.match(readinessRetry.root.textContent, /Диалоги готовы к оценке/);
  assert.match(readinessRetry.root.textContent, /Readiness unavailable/);
  readinessRetry.button('Повторить проверку').click(); await flush();
  assert.match(readinessRetry.root.textContent, /Прогон не выполнен/);
  console.log('PASS: critical INVALID/known NO; stale lists/default/archive snapshots/legacy proof guard/deleted-source archive; polling recovers 503, unlocks 404, backs off to 10s and deduplicates manual retry.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
