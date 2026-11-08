'use strict';
// Contract/integration tests with offline responses. These are NOT a measurement
// of semantic LLM accuracy or a replacement for a separately authorized live run.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
Object.assign(process.env, {
  LLM_PROVIDER: 'deepseek', LLM_MODEL: 'offline-rubric-model',
  DEEPSEEK_API_KEY: 'offline-only', OPENAI_API_KEY: 'offline-only', ANTHROPIC_API_KEY: 'offline-only', GEMINI_API_KEY: 'offline-only',
  SAMPLES: '1', REPAIR_ATTEMPTS: '0', LLM_MAX_ATTEMPTS: '1', MAX_OUTPUT_TOKENS: '',
  TEMPERATURE: '', DEEPSEEK_REASONING_EFFORT: '', GEMINI_THINKING_LEVEL: '',
  DEEPSEEK_BASE_URL: '', OPENAI_BASE_URL: '',
});
global.fetch = async () => { throw new Error('Unexpected network request in offline rubric tests'); };
const cfg = require('../src/config');
const llm = require('../src/llm');
const realComplete = llm.complete;
const { evaluate, cacheKey, buildUserPrompt, buildSchema, validateOutput, buildSummary, computeFacts, SYSTEM_PROMPT, PROMPT_VERSION } = require('../src/evaluator');
const { computeScore } = require('../src/scoring');
const official = require('../src/default-checklist.json');
const clone = value => JSON.parse(JSON.stringify(value));
const record = (channel = 'agent chat', language = 'RU') => ({
  conversation_id: 'unseen-rubric-case', channel, language,
  transcript: [
    { timestamp: channel === 'voice call' ? '2026-11-08T10:00:00Z' : '00:00', speaker: 'client', text: 'Подскажите номер заявки.' },
    { timestamp: channel === 'voice call' ? '2026-11-08T10:00:03Z' : '00:03', speaker: 'operator', text: 'Номер заявки 123. Подождите, пожалуйста, пока я проверю её статус.' },
  ],
});
const checklist = () => ({
  id: 'arbitrary', version: 1, name: 'Номер заявки и управление ожиданием', notes: 'Приветствие и полнота банковской консультации здесь не оцениваются.', rounding: 2, sections: [],
  criteria: [
    { id: 'c04', title: 'Номер заявки', description: 'Да, если оператор сообщил номер заявки. Ничего другого не проверять.', type: 'binary', weight: 40, na_allowed: false },
    { id: 'c06', title: 'Предупреждение об ожидании', description: 'Оценивается только предупреждение оператора перед ожиданием.', type: 'scale', weight: 60, na_allowed: false, scale: [{ value: 0, description: 'Предупреждения нет.' }, { value: 2, description: 'Есть просьба подождать.' }, { value: 6, description: 'Названа причина и ожидаемая длительность.' }] },
  ],
});
const answers = () => ({ operator_name: null, criteria: [
  { id: 'c04', answer: 'YES', explanation: 'Сотрудник сообщил клиенту номер заявки 123.', evidence: [{ msg: 'm1', fragment: 'Номер заявки 123' }] },
  { id: 'c06', answer: 'SCORE', score: 2, explanation: 'Есть явная просьба подождать без указания длительности.', evidence: [{ msg: 'm1', fragment: 'Подождите, пожалуйста' }] },
], coaching: [] });
let observed = [], count = 0;
function respond(body) {
  llm.complete = async (system, user, schema) => {
    observed.push({ system, user, schema });
    return { text: JSON.stringify(body), usage: { input: 100, output: 80, thoughts: 0 }, metrics: { http_attempts: 1, request_ms: 1, wait_ms: 0 } };
  };
}
async function test(name, run) { observed = []; cfg.REPAIR_ATTEMPTS = 0; await run(); count++; console.log('✔ ' + name); }

(async () => {
  try {
    await test('new dialogues in RU/KZ/EN use the supplied two-criterion rubric in both channels', async () => {
      const cl = checklist(), before = clone(cl);
      respond(answers());
      for (const channel of ['agent chat', 'voice call']) for (const language of ['RU', 'KZ', 'EN']) {
        const input = record(channel, language);
        input.conversation_id += '-' + channel + '-' + language;
        const output = await evaluate(input, cl, 'OFFLINE-RUBRIC');
        assert.equal(output.status, 'ok');
        assert.equal(output.original_result.total, 60, '40 + 60×2/6; no hardcoded 7/10 or 15/20');
        assert.deepEqual(Object.keys(output.criteria), ['c04', 'c06']);
        assert.equal(output.prompt_version, PROMPT_VERSION);
        const sent = observed.at(-1);
        assert.ok(sent.user.includes(`канал: ${channel} | язык по данным: ${language}`));
        assert.ok(sent.user.includes('Да, если оператор сообщил номер заявки. Ничего другого не проверять.'));
        assert.deepEqual(sent.schema.properties.criteria.items.properties.id.enum, ['c04', 'c06']);
        assert.equal(sent.schema.properties.criteria.minItems, 2);
        assert.equal(sent.schema.properties.criteria.maxItems, 2);
      }
      assert.equal(observed.length, 6, 'distinct new inputs are actually passed to the evaluator');
      assert.deepEqual(cl, before, 'channel adaptation must not rewrite the saved checklist');
    });

    await test('replacing c06 with a binary rule applies its new meaning and rejects the former scale', async () => {
      const cl = checklist();
      cl.criteria[1] = { id: 'c06', title: 'Согласие на уведомления', description: 'Да только при явном согласии клиента на уведомления.', type: 'binary', weight: 60, na_allowed: false };
      const body = answers();
      Object.assign(body.criteria[1], { answer: 'NO', score: null, explanation: 'Согласие на уведомления в диалоге не запрашивалось.', evidence: [], missing_range: { from: 'm0', to: 'm1' } });
      respond(body);
      const result = await evaluate(record(), cl, 'REPLACED');
      assert.equal(result.status, 'ok'); assert.equal(result.final_result.total, 40);
      assert.ok(observed[0].user.includes('Да только при явном согласии клиента на уведомления.'));
      assert.ok(!observed[0].user.includes('Названа причина и ожидаемая длительность.'));
      assert.ok(!observed[0].schema.properties.criteria.items.properties.answer.enum.includes('SCORE'));
      assert.equal(validateOutput(cl, record(), answers()).criteria.c06.answer, 'INVALID');
    });

    await test('custom scales and weights are applied without forcing official criterion values', async () => {
      const cl = checklist();
      cl.criteria[0] = { ...cl.criteria[0], type: 'scale', weight: 30, scale: [{ value: 1, description: 'Номер не назван.' }, { value: 3, description: 'Номер назван без подтверждения.' }, { value: 5, description: 'Номер назван и подтверждён клиентом.' }] };
      cl.criteria[1] = { ...cl.criteria[1], type: 'binary', weight: 70 }; delete cl.criteria[1].scale;
      const body = answers();
      Object.assign(body.criteria[0], { answer: 'SCORE', score: 3 });
      Object.assign(body.criteria[1], { answer: 'YES', score: null });
      respond(body);
      const result = await evaluate(record(), cl, 'SCALES');
      assert.equal(result.final_result.total, 88);
      assert.deepEqual(observed[0].schema.properties.criteria.items.properties.score.enum, [1, 3, 5, null]);
      const invalid = clone(body); invalid.criteria[0].score = 4;
      assert.equal(validateOutput(cl, record(), invalid).criteria.c04.answer, 'INVALID');
    });

    await test('rubrics with more than eight criteria keep every caller-defined ID', async () => {
      const cl = checklist();
      cl.criteria = Array.from({ length: 12 }, (_, index) => ({ id: 'custom_' + index, title: 'Требование ' + index, description: 'Проверить отдельное требование ' + index, type: 'binary', weight: index + 1 }));
      respond({ criteria: cl.criteria.map((item, index) => ({ id: item.id, answer: 'YES', explanation: `Наблюдаемое основание для отдельного требования ${index}.`, evidence: [{ msg: 'm1' }] })), coaching: [] });
      const result = await evaluate(record(), cl, 'TWELVE');
      assert.equal(Object.keys(result.criteria).length, 12); assert.equal(result.final_result.total, 100);
      assert.deepEqual(observed[0].schema.properties.criteria.items.properties.id.enum, cl.criteria.map(item => item.id));
    });

    await test('channel context distinguishes written mistakes, possible ASR artifacts and observable speech problems', () => {
      const voice = record('voice call'); voice.audio_url = 'https://recordings.example/private?token=do-not-send';
      const spoken = buildUserPrompt(voice, official), written = buildUserPrompt(record(), official);
      assert.ok(spoken.includes('Содержимое аудио НЕ передано модели и НЕ анализировалось'));
      assert.ok(spoken.includes('не списывай на ASR явно наблюдаемые противоречия'));
      assert.ok(spoken.includes('неуместные выражения'));
      assert.ok(spoken.includes('Разница временных меток сама по себе не доказывает акустическую паузу'));
      assert.ok(!spoken.includes('do-not-send'));
      assert.ok(written.includes('Не списывай ошибки письменного сообщения на автоматическое распознавание речи'));
      assert.ok(!written.includes('КАНАЛ: ТЕЛЕФОННЫЙ РАЗГОВОР'));
      assert.ok(written.includes(official.notes), 'official exclusion of first response time stays in its own notes');
      assert.ok(!SYSTEM_PROMPT.includes('Время первой реакции в оценку не входит'), 'custom timing rubrics must not be globally forbidden');
    });

    await test('an acoustic-only rule without audio cannot fabricate a score, violation or N/A', async () => {
      const cl = checklist();
      cl.criteria[1] = { ...cl.criteria[1], title: 'Дикция', description: 'Разборчивость произношения по аудиозаписи.', scale: [{ value: 0, description: 'Не разобрать речь.' }, { value: 6, description: 'Разборчивая речь.' }] };
      const body = answers();
      Object.assign(body.criteria[1], { answer: null, score: null, evidence: [], explanation: 'В распоряжении модели только текст звонка.', not_observable_reason: 'Аудио не передано, дикцию нельзя проверить по тексту.' });
      respond(body);
      const result = await evaluate(record('voice call'), cl, 'NO-AUDIO');
      assert.equal(result.status, 'needs_review'); assert.equal(result.final_result.total, null);
      assert.equal(result.criteria.c06.answer, 'INVALID');
      assert.ok(result.criteria.c06.not_observable_reason.includes('Аудио не передано'));
      const contradiction = clone(body); contradiction.criteria[1].answer = 'SCORE'; contradiction.criteria[1].score = 6;
      assert.equal(validateOutput(cl, record('voice call'), contradiction).criteria.c06.answer, 'INVALID', 'reported missing data must not coexist with a claimed full score');
    });

    await test('N/A follows the saved condition; unavailable data is not automatically N/A', async () => {
      const cl = checklist();
      cl.criteria[1].na_allowed = true; cl.criteria[1].na_condition = 'Для этого критерия аудио не предоставлено оценщику.';
      const body = answers();
      Object.assign(body.criteria[1], { answer: 'NA', score: null, na_reason: 'К оценщику передан только транскрипт.', evidence: [], checked_range: { from: 'm0', to: 'm1' } });
      respond(body);
      const result = await evaluate(record('voice call'), cl, 'ALLOWED-NA');
      assert.equal(result.status, 'ok'); assert.equal(result.final_result.total, 100);
      assert.equal(result.final_result.applicable_weight, 40);
      assert.ok(observed[0].user.includes('NA допустим ТОЛЬКО если: Для этого критерия аудио не предоставлено оценщику.'));
      cl.criteria[1].na_allowed = false;
      assert.equal(validateOutput(cl, record('voice call'), body).criteria.c06.answer, 'INVALID');
    });

    await test('missing source data does not trigger a billed repair asking the model to invent a score', async () => {
      cfg.REPAIR_ATTEMPTS = 1;
      const body = answers();
      Object.assign(body.criteria[1], { answer: null, score: null, evidence: [], explanation: 'Необходимые данные отсутствуют.', not_observable_reason: 'Обязательная аудиозапись не передана.' });
      respond(body);
      const result = await evaluate(record('voice call'), checklist(), 'NO-DATA-REPAIR');
      assert.equal(observed.length, 1);
      assert.equal(result.status, 'needs_review');
      assert.equal(result.final_result.total, null);
      assert.equal(result.timing.calls.length, 1);
    });

    await test('bot-only proof cannot certify a positive operator action, while absence may use context', () => {
      const input = record(); input.transcript.unshift({ timestamp: '00:00', speaker: 'bot', text: 'Номер заявки 123. Подождите, пожалуйста.' });
      const body = answers(); body.criteria.forEach(item => { item.evidence = [{ msg: 'm0' }]; });
      const result = validateOutput(checklist(), input, body);
      assert.equal(result.errors.filter(error => error.message.includes('Только реплики бота')).length, 2);
      body.criteria[0].answer = 'NO'; body.criteria[1].score = 0;
      assert.ok(!validateOutput(checklist(), input, body).errors.some(error => error.message.includes('Только реплики бота')));
    });

    await test('call end facts use system events in RU/KZ/EN, not holding or inferred silence', () => {
      for (const text of ['Звонок завершён.', 'Қоңырау аяқталды.', 'Call ended.']) {
        const input = record('voice call'); input.transcript.push({ speaker: 'system', timestamp: '10:01:00', text });
        assert.ok(computeFacts(input).includes('Возможное событие закрытия/завершения, найденное по словам: m2'), text);
      }
      for (const text of ['Call on hold.', 'Запись приостановлена.', 'Звонок не завершён.']) {
        const input = record('voice call'); input.transcript.push({ speaker: 'system', text });
        assert.ok(computeFacts(input).includes('Автоматический поиск не выделил системное событие закрытия звонка'), text);
        assert.ok(computeFacts(input).includes('Это не доказательство отсутствия'), text);
      }
    });

    await test('custom flags and absent flags do not produce invented gross-error conclusions', () => {
      const cl = checklist(), normalized = validateOutput(cl, record(), answers()).criteria;
      assert.ok(!/Груб|флаг/i.test(buildSummary(cl, normalized, computeScore(cl, normalized))));
      cl.criteria.push({ id: 'escalation', title: 'Неправильная эскалация', description: 'Обращение передано не в тот отдел.', type: 'flag', weight: 0 });
      normalized.escalation = { answer: 'YES', evidence: [{ msg: 1 }], explanation: 'Направление эскалации отличается от указанного в правиле.', issues: [] };
      assert.ok(buildSummary(cl, normalized, computeScore(cl, normalized)).includes('Выявлены флаги: «Неправильная эскалация»'));
      const flagOnly = { ...cl, criteria: [{ ...cl.criteria.at(-1), title: 'Грубые ошибки' }] };
      normalized.escalation.issues = ['Сломанное доказательство'];
      const summary = buildSummary(flagOnly, normalized, computeScore(flagOnly, normalized));
      assert.ok(summary.includes('Проверка грубых ошибок не завершена'));
      assert.ok(!summary.includes('Выявлена грубая ошибка'));
    });

    await test('malformed checklists and unsupported inputs fail before any model request', async () => {
      respond(answers());
      const cl = checklist(); cl.criteria[1].scale[1].value = 0;
      await assert.rejects(evaluate(record(), cl, 'INVALID'), error => error.status === 400);
      await assert.rejects(evaluate({ ...record(), channel: 'unknown' }, checklist(), 'INVALID'), error => error.status === 400);
      assert.equal(observed.length, 0);
    });

    await test('prompt, rules, input and channel identities cannot silently reuse historical assessments', () => {
      const cl = checklist(), input = record(), newKey = cacheKey(input, cl);
      const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const { settingsFingerprint } = require('../src/evaluator');
      const content = { name: cl.name, notes: cl.notes, rounding: cl.rounding, sections: cl.sections, criteria: cl.criteria };
      const historical = sha({ conv: input.conversation_id, transcript: input.transcript, channel: input.channel, language: input.language, checklist_id: cl.id, checklist_version: cl.version, checklist: sha(content), settings: { ...settingsFingerprint(), prompt: '2026-11-07.7' } });
      assert.notEqual(newKey, historical);
      const changed = clone(cl); changed.criteria[0].description = 'Новое правило при том же ID.';
      assert.notEqual(cacheKey(input, changed), newKey);
      assert.notEqual(cacheKey({ ...input, channel: 'voice call' }, cl), newKey);
      const differentText = clone(input); differentText.transcript[1].text = 'Ответ пока не готов.';
      assert.notEqual(cacheKey(differentText, cl), newKey);
      assert.equal(cacheKey({ ...input, audio_url: 'https://example.com/changed-link' }, cl), newKey, 'unconsumed audio URL is not a new acoustic assessment');
    });

    await test('all text-only provider adapters receive the current JSON contract', async () => {
      llm.complete = realComplete;
      const schema = buildSchema(checklist());
      let sent;
      global.fetch = async (_url, options) => {
        sent = JSON.parse(options.body);
        const payload = cfg.provider === 'anthropic'
          ? { content: [{ text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
      };
      for (const provider of ['deepseek', 'openai', 'anthropic']) {
        cfg.provider = provider;
        await llm.complete('Current rubric instructions', 'new input', schema);
        const instruction = provider === 'anthropic' ? sent.system : sent.messages[0].content;
        assert.ok(instruction.includes(JSON.stringify(schema)), provider);
        assert.ok(instruction.includes('not_observable_reason'), provider);
      }
    });

    await test('Gemini keeps the schema in instructions after native structured-output rejection', async () => {
      cfg.provider = 'gemini'; cfg.STRUCTURED_OUTPUT = true;
      const schema = buildSchema(checklist()), requests = [];
      global.fetch = async (_url, options) => {
        const body = JSON.parse(options.body); requests.push(body);
        const rejected = requests.length === 1;
        return { ok: !rejected, status: rejected ? 400 : 200, headers: { get: () => null }, text: async () => JSON.stringify(rejected ? { error: { message: 'Unsupported responseJsonSchema' } } : { candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0 } }) };
      };
      await llm.complete('Current rubric instructions', 'new input', schema);
      assert.deepEqual(requests[0].generationConfig.responseJsonSchema, schema);
      assert.ok(!requests[1].generationConfig.responseJsonSchema);
      assert.ok(requests[1].systemInstruction.parts[0].text.includes(JSON.stringify(schema)));
      cfg.STRUCTURED_OUTPUT = false;
      await llm.complete('Current rubric instructions', 'new input', schema);
      assert.ok(requests[2].systemInstruction.parts[0].text.includes(JSON.stringify(schema)));
    });

    console.log(`evaluator-rubric: ${count} offline checks passed; paid model calls: 0; semantic accuracy: not measured`);
  } finally { llm.complete = realComplete; }
})().catch(error => { console.error(error); process.exitCode = 1; });
