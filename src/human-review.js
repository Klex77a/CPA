'use strict';
// Private, blinded human review. No provider, environment or datastore access.
const crypto = require('node:crypto');
const { validateChecklist, validateAnswer, computeScore } = require('./scoring');
const { evidenceErrors } = require('./benchmark');
const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digest = (value) =>
  crypto
    .createHash('sha256')
    .update(canonical(value) ?? 'undefined')
    .digest('hex');
const assert = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'REVIEW_VALIDATION' });
};
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const packetDigest = (packet) =>
  digest(Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'packet_digest')));
const sourceDigest = (record) =>
  digest({
    conversation_id: record.conversation_id,
    channel: record.channel,
    language: record.language,
    transcript: record.transcript,
  });
const checklistDigest = (value) =>
  digest({
    id: value?.id,
    version: value?.version,
    name: value?.name,
    notes: value?.notes || '',
    rounding: value?.rounding ?? 2,
    criteria: value?.criteria,
    sections: value?.sections || [],
  });
const asAnswer = (criterion, value) =>
  value === null
    ? { answer: 'NA', value: null }
    : criterion.type === 'scale'
      ? { answer: 'SCORE', value }
      : { answer: value ? 'YES' : 'NO', value: null };

function validatePacket(packet) {
  assert(
    packet?.kind === 'cqa_blind_review_packet' && packet.schema_version === '1.0',
    'Нужен пакет слепой разметки версии 1.0',
  );
  assert(
    text(packet.packet_id) && packet.packet_digest === packetDigest(packet),
    'Контрольная сумма пакета не совпадает',
  );
  assert(
    Object.keys(packet).every((key) =>
      [
        'kind',
        'schema_version',
        'packet_id',
        'packet_digest',
        'created_at',
        'scope',
        'checklist',
        'cases',
        'blinding',
        'privacy_notice',
      ].includes(key),
    ),
    'Посторонние поля в слепом пакете',
  );
  assert(validateChecklist(packet.checklist).length === 0, 'Некорректный чек-лист в пакете');
  assert(
    packet.blinding?.model_answers_excluded === true &&
      packet.blinding?.source_ids_removed === true &&
      packet.blinding?.independence_verified === false,
    'Неверные сведения о слепой проверке',
  );
  assert(
    Array.isArray(packet.cases) && packet.cases.length > 0 && packet.cases.length <= 1000,
    'Пакет не содержит диалогов',
  );
  const ids = new Set();
  const allowed = ['case_id', 'language', 'channel', 'transcript'];
  for (const item of packet.cases) {
    assert(text(item.case_id) && !ids.has(item.case_id), 'Повторяющийся ID случая');
    ids.add(item.case_id);
    assert(
      Object.keys(item).every((key) => allowed.includes(key)),
      'Пакет содержит посторонние поля: слепая проверка нарушена',
    );
    assert(
      ['RU', 'KZ', 'EN'].includes(item.language) && text(item.channel),
      'Неизвестный язык или канал',
    );
    assert(Array.isArray(item.transcript) && item.transcript.length > 0, 'Пустой транскрипт');
    item.transcript.forEach((turn, index) => {
      assert(
        turn.turn === index + 1 &&
          ['operator', 'client', 'bot', 'system'].includes(turn.speaker) &&
          text(turn.text) &&
          typeof turn.timestamp === 'string',
        'Повреждена исходная реплика',
      );
      assert(
        Object.keys(turn).every((key) => ['turn', 'speaker', 'text', 'timestamp'].includes(key)),
        'Лишние данные в реплике',
      );
    });
  }
  return packet;
}

function prepareReview(
  dataset,
  checklist,
  { count = 30, seed = crypto.randomUUID(), now = new Date().toISOString() } = {},
) {
  assert(
    Array.isArray(dataset?.records) && dataset.records.length > 0,
    'Нужен исходный набор с records',
  );
  assert(text(dataset.group_id || dataset.dataset_group_id), 'Укажите исходную группу');
  assert(validateChecklist(checklist).length === 0, 'Некорректный чек-лист');
  assert(
    Number.isSafeInteger(count) && count > 0 && count <= dataset.records.length,
    'Число диалогов выходит за размер набора',
  );
  const ids = new Set();
  for (const record of dataset.records) {
    assert(
      text(record.conversation_id) && !ids.has(record.conversation_id),
      'Исходные ID повреждены или повторяются',
    );
    ids.add(record.conversation_id);
  }
  // Selection uses source metadata only, never model answers. Balance languages,
  // include available voice calls first, then use a reproducible salted order.
  const rank = (record) => digest({ seed, id: record.conversation_id });
  const pools = ['RU', 'KZ', 'EN'].map((language) =>
    dataset.records
      .filter((record) => record.language === language)
      .sort(
        (a, b) =>
          Number(b.channel === 'voice call') - Number(a.channel === 'voice call') ||
          rank(a).localeCompare(rank(b)),
      ),
  );
  const selected = [];
  while (selected.length < count) {
    const before = selected.length;
    for (const pool of pools)
      if (pool.length && selected.length < count) selected.push(pool.shift());
    assert(selected.length > before, 'Неизвестные языки в исходном наборе');
  }
  selected.sort((a, b) => rank(a).localeCompare(rank(b)));
  const mapping = [];
  const cases = selected.map((record) => {
    const caseId = 'case-' + crypto.randomUUID();
    mapping.push({
      case_id: caseId,
      conversation_id: record.conversation_id,
      source_digest: sourceDigest(record),
    });
    return {
      case_id: caseId,
      language: record.language,
      channel: record.channel,
      transcript: record.transcript.map((turn, index) => ({
        turn: index + 1,
        speaker: turn.speaker,
        timestamp: turn.timestamp,
        text: turn.text,
      })),
    };
  });
  const packet = {
    kind: 'cqa_blind_review_packet',
    schema_version: '1.0',
    packet_id: crypto.randomUUID(),
    created_at: now,
    scope: 'human_review_of_development_data',
    checklist: clone(checklist),
    cases,
    blinding: {
      model_answers_excluded: true,
      source_ids_removed: true,
      independence_verified: false,
    },
    privacy_notice:
      'Тексты могут содержать персональные данные. Пакет предназначен только для экспертов с доступом; не публикуйте его в Git.',
  };
  packet.packet_digest = packetDigest(packet);
  validatePacket(packet);
  return {
    packet,
    manifest: {
      kind: 'cqa_private_review_manifest',
      packet_id: packet.packet_id,
      packet_digest: packet.packet_digest,
      group_id: dataset.group_id || dataset.dataset_group_id,
      selection_seed: seed,
      cases: mapping,
    },
  };
}

function validateLabel(label, criterion, turns) {
  assert(
    label && ['labeled', 'unknown'].includes(label.state),
    `Не заполнен критерий ${criterion.id}`,
  );
  assert(text(label.rationale), `Нет обоснования ${criterion.id}`);
  assert(
    Array.isArray(label.evidence_turns) &&
      new Set(label.evidence_turns).size === label.evidence_turns.length &&
      label.evidence_turns.every((turn) => Number.isInteger(turn) && turn >= 1 && turn <= turns),
    `Некорректные реплики ${criterion.id}`,
  );
  if (label.state === 'unknown') {
    assert(
      label.value === null && text(label.unknown_reason),
      `Нужна причина неизвестного ответа ${criterion.id}`,
    );
  } else {
    assert(
      label.evidence_turns.length > 0,
      `Укажите проверенный участок или доказательство ${criterion.id}`,
    );
    assert(
      label.value === null ||
        (criterion.type === 'scale'
          ? typeof label.value === 'number'
          : typeof label.value === 'boolean'),
      `Неверный тип ответа ${criterion.id}`,
    );
    validateAnswer(criterion, asAnswer(criterion, label.value));
  }
  return label;
}

function validateAnnotation(packet, annotation, { submitted = true } = {}) {
  validatePacket(packet);
  assert(
    annotation?.kind === 'cqa_human_annotations' &&
      annotation.schema_version === '1.0' &&
      annotation.packet_id === packet.packet_id &&
      annotation.packet_digest === packet.packet_digest,
    'Разметка относится к другому пакету',
  );
  assert(['draft', 'submitted'].includes(annotation.stage), 'Неизвестный статус разметки');
  if (submitted) {
    assert(annotation.stage === 'submitted', 'Черновик нельзя использовать как эталон');
    validateReviewer(annotation.reviewer);
  }
  assert(
    Array.isArray(annotation.cases) &&
      annotation.cases.length === packet.cases.length &&
      new Set(annotation.cases.map((item) => item.case_id)).size === packet.cases.length,
    'Пропущенные или повторяющиеся случаи',
  );
  for (const item of packet.cases) {
    const row = annotation.cases.find((candidate) => candidate.case_id === item.case_id);
    assert(
      row &&
        Object.keys(row.criteria || {}).every((id) =>
          packet.checklist.criteria.some((criterion) => criterion.id === id),
        ),
      'Неизвестный случай или критерий',
    );
    if (submitted)
      for (const criterion of packet.checklist.criteria)
        validateLabel(row.criteria[criterion.id], criterion, item.transcript.length);
    else
      for (const criterion of packet.checklist.criteria) {
        const label = row.criteria?.[criterion.id];
        if (label === undefined) continue;
        assert(
          label &&
            typeof label === 'object' &&
            !Array.isArray(label) &&
            ['unanswered', 'labeled', 'unknown'].includes(label.state) &&
            typeof label.rationale === 'string' &&
            (label.unknown_reason === undefined || typeof label.unknown_reason === 'string') &&
            Array.isArray(label.evidence_turns) &&
            new Set(label.evidence_turns).size === label.evidence_turns.length &&
            label.evidence_turns.every(
              (turn) => Number.isInteger(turn) && turn >= 1 && turn <= item.transcript.length,
            ),
          'Повреждена запись черновика',
        );
        if (label.state === 'labeled') {
          assert(
            label.value === null ||
              (criterion.type === 'scale'
                ? typeof label.value === 'number'
                : typeof label.value === 'boolean'),
            'Неверный тип ответа черновика',
          );
          validateAnswer(criterion, asAnswer(criterion, label.value));
        } else
          assert(
            label.value === null,
            'Неизвестный или незаполненный ответ не должен содержать значение',
          );
      }
  }
  return annotation;
}

function validateReviewer(reviewer) {
  assert(text(reviewer?.id) && text(reviewer.role), 'Укажите проверяющего и его роль');
  const attestation = reviewer.attestation;
  assert(
    attestation?.human === true &&
      attestation.model_answers_unseen === true &&
      attestation.no_llm_assistance === true &&
      text(attestation.submitted_at),
    'Нужно подтверждение ручной слепой проверки без помощи ИИ',
  );
  assert(
    reviewer.independence === 'self_attested',
    'Нельзя заявлять автоматически проверенную независимость эксперта',
  );
}

function reconcileReviews(packet, left, right, resolution) {
  validateAnnotation(packet, left);
  validateAnnotation(packet, right);
  assert(
    left.reviewer.id.trim().toLowerCase() !== right.reviewer.id.trim().toLowerCase(),
    'Нужны два разных проверяющих',
  );
  const disagreements = [];
  const cases = packet.cases.map((item) => {
    const a = left.cases.find((row) => row.case_id === item.case_id).criteria;
    const b = right.cases.find((row) => row.case_id === item.case_id).criteria;
    const criteria = Object.fromEntries(
      packet.checklist.criteria.map((criterion) => {
        const agree =
          a[criterion.id].state === b[criterion.id].state &&
          a[criterion.id].value === b[criterion.id].value;
        if (agree) return [criterion.id, clone(a[criterion.id])];
        disagreements.push({
          case_id: item.case_id,
          criterion_id: criterion.id,
          left: clone(a[criterion.id]),
          right: clone(b[criterion.id]),
        });
        const decision = resolution?.cases?.find((row) => row.case_id === item.case_id)?.criteria?.[
          criterion.id
        ];
        if (decision) validateLabel(decision, criterion, item.transcript.length);
        return [criterion.id, decision ? clone(decision) : null];
      }),
    );
    return { case_id: item.case_id, criteria };
  });
  const unresolved = cases.reduce(
    (sum, item) => sum + Object.values(item.criteria).filter((label) => label === null).length,
    0,
  );
  if (disagreements.length && !unresolved) {
    assert(
      resolution?.packet_digest === packet.packet_digest &&
        resolution.left_digest === digest(left) &&
        resolution.right_digest === digest(right),
      'Решения не привязаны к исходным разметкам',
    );
    validateReviewer(resolution.reviewer);
    assert(
      ![left.reviewer.id, right.reviewer.id].some(
        (id) => id.trim().toLowerCase() === resolution.reviewer.id.trim().toLowerCase(),
      ),
      'Разногласия разбирает третий проверяющий',
    );
  }
  return {
    kind: 'cqa_human_reference',
    schema_version: '1.0',
    packet_id: packet.packet_id,
    packet_digest: packet.packet_digest,
    state: unresolved ? 'needs_adjudication' : 'consensus',
    provenance: 'two_human_reviews_self_attested',
    independent_expert_validation: false,
    reviewers: [left.reviewer.id, right.reviewer.id],
    review_digests: [digest(left), digest(right)],
    adjudicator: resolution?.reviewer?.id || null,
    disagreements,
    unresolved,
    cases,
  };
}

function compareHumanReference(packet, manifest, reference, evaluations) {
  validatePacket(packet);
  assert(
    manifest?.kind === 'cqa_private_review_manifest' &&
      manifest.packet_digest === packet.packet_digest &&
      manifest.packet_id === packet.packet_id,
    'Манифест не относится к пакету',
  );
  assert(
    text(manifest.group_id) &&
      Array.isArray(manifest.cases) &&
      manifest.cases.length === packet.cases.length &&
      new Set(manifest.cases.map((item) => item.case_id)).size === packet.cases.length &&
      new Set(manifest.cases.map((item) => item.conversation_id)).size === packet.cases.length,
    'Повторяющиеся или пропущенные исходные ID в манифесте',
  );
  assert(
    reference?.kind === 'cqa_human_reference' &&
      reference.schema_version === '1.0' &&
      reference.packet_id === packet.packet_id &&
      reference.packet_digest === packet.packet_digest &&
      reference.provenance === 'two_human_reviews_self_attested' &&
      reference.state === 'consensus' &&
      reference.unresolved === 0 &&
      reference.independent_expert_validation === false,
    'Нужен согласованный человеческий эталон',
  );
  assert(
    Array.isArray(reference.reviewers) &&
      reference.reviewers.length === 2 &&
      reference.reviewers.every(text) &&
      new Set(reference.reviewers.map((id) => id.trim().toLowerCase())).size === 2 &&
      Array.isArray(reference.review_digests) &&
      reference.review_digests.length === 2 &&
      reference.review_digests.every(
        (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
      ),
    'Нет сведений о двух разметках',
  );
  assert(
    Array.isArray(reference.cases) &&
      reference.cases.length === packet.cases.length &&
      new Set(reference.cases.map((item) => item.case_id)).size === packet.cases.length,
    'Неоднозначные или пропущенные случаи эталона',
  );
  const rows = [],
    totals = {
      expected: 0,
      labeled: 0,
      unknown: 0,
      matched: 0,
      missing_predictions: 0,
      scored_cases: 0,
      absolute_score_error: 0,
      max_score_error: null,
    };
  const critical = {
    tp: 0,
    tn: 0,
    fp: 0,
    fn: 0,
    unknown_predictions: 0,
    unknown_positive: 0,
    positive_references: 0,
  };
  const na = { tp: 0, tn: 0, fp: 0, fn: 0, unknown_predictions: 0, positive_references: 0 };
  const models = new Map();
  const groups = { by_language: new Map(), by_channel: new Map(), by_criterion: new Map() };
  const groupRow = (map, key) => {
    if (!map.has(key))
      map.set(key, { expected: 0, labeled: 0, unknown: 0, matched: 0, missing_predictions: 0 });
    return map.get(key);
  };
  for (const item of packet.cases) {
    const labels = reference.cases.find((row) => row.case_id === item.case_id)?.criteria;
    const source = manifest.cases.find((row) => row.case_id === item.case_id);
    assert(labels && source, 'Пропущен случай в эталоне или манифесте');
    const candidates = evaluations
      .filter(
        (evaluation) =>
          evaluation &&
          evaluation.group_id === manifest.group_id &&
          evaluation.conversation_id === source.conversation_id &&
          checklistDigest(evaluation.checklist_snapshot) === checklistDigest(packet.checklist) &&
          evaluation.record_snapshot &&
          sourceDigest(evaluation.record_snapshot) === source.source_digest &&
          evaluation.record_snapshot.language === item.language &&
          evaluation.record_snapshot.channel === item.channel &&
          digest(
            evaluation.record_snapshot.transcript.map(({ speaker, timestamp, text: content }) => ({
              speaker,
              timestamp,
              text: content,
            })),
          ) === digest(item.transcript.map(({ turn, ...entry }) => entry)),
      )
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const evaluation = candidates[0];
    const provider =
      typeof evaluation?.provider === 'string' ? evaluation.provider.trim().toLowerCase() : '';
    const identifiedModel =
      evaluation &&
      provider &&
      provider !== 'mock' &&
      text(evaluation.model) &&
      text(evaluation.prompt_version);
    if (identifiedModel) {
      const identity = {
        provider,
        model: evaluation.model.trim(),
        prompt_version: evaluation.prompt_version.trim(),
      };
      models.set(digest(identity), identity);
    }
    const expectedAnswers = {},
      actualAnswers = {};
    let fullyLabeled = true,
      fullyPredicted = true;
    for (const criterion of packet.checklist.criteria) {
      const label = validateLabel(labels[criterion.id], criterion, item.transcript.length);
      const slices = [
        groupRow(groups.by_language, item.language),
        groupRow(groups.by_channel, item.channel),
        groupRow(groups.by_criterion, criterion.id),
      ];
      for (const slice of slices) slice.expected++;
      totals.expected++;
      if (label.state === 'unknown') {
        totals.unknown++;
        for (const slice of slices) slice.unknown++;
        fullyLabeled = false;
        continue;
      }
      totals.labeled++;
      for (const slice of slices) slice.labeled++;
      const answer = evaluation?.criteria?.[criterion.id]; // Original model result; never final_criteria after an appeal.
      let predicted = false,
        value;
      try {
        const normalized = validateAnswer(criterion, answer);
        assert(
          identifiedModel &&
            !answer.review_required &&
            !answer.issues?.length &&
            evaluation.status === 'ok' &&
            !evaluation.validation_errors?.length &&
            evidenceErrors(answer, criterion, evaluation.record_snapshot).length === 0,
          'Непроверенный ответ или некорректное доказательство',
        );
        value =
          normalized.answer === 'NA'
            ? null
            : normalized.answer === 'SCORE'
              ? normalized.value
              : normalized.answer === 'YES';
        predicted = true;
        actualAnswers[criterion.id] = normalized;
      } catch (_) {
        totals.missing_predictions++;
        for (const slice of slices) slice.missing_predictions++;
        fullyPredicted = false;
      }
      expectedAnswers[criterion.id] = asAnswer(criterion, label.value);
      const match = predicted && value === label.value;
      if (match) totals.matched++;
      if (match) for (const slice of slices) slice.matched++;
      rows.push({
        case_id: item.case_id,
        criterion_id: criterion.id,
        expected: label.value,
        actual: predicted ? value : 'UNKNOWN',
        match,
      });
      if (criterion.type === 'flag') {
        if (label.value) critical.positive_references++;
        if (!predicted) {
          critical.unknown_predictions++;
          if (label.value) critical.unknown_positive++;
        } else critical[label.value ? (value ? 'tp' : 'fn') : value ? 'fp' : 'tn']++;
      }
      if (criterion.na_allowed) {
        if (label.value === null) na.positive_references++;
        if (!predicted) na.unknown_predictions++;
        else
          na[
            label.value === null ? (value === null ? 'tp' : 'fn') : value === null ? 'fp' : 'tn'
          ]++;
      }
    }
    if (fullyLabeled && fullyPredicted) {
      const human = computeScore(packet.checklist, expectedAnswers).total;
      const model = computeScore(packet.checklist, actualAnswers).total;
      if (human !== null && model !== null) {
        const error = Math.abs(human - model);
        totals.scored_cases++;
        totals.absolute_score_error += error;
        totals.max_score_error = Math.max(totals.max_score_error || 0, error);
      }
    }
  }
  assert(
    models.size <= 1,
    'В выборке смешаны модели или версии промпта. Сравните их отдельными запусками.',
  );
  return {
    kind: 'cqa_human_comparison',
    packet_digest: packet.packet_digest,
    scope: packet.scope,
    provenance: reference.provenance,
    independent_expert_validation: false,
    human_review_completed: true,
    prediction_model: [...models.values()][0] || null,
    metrics: {
      ...totals,
      ...Object.fromEntries(
        Object.entries(groups).map(([name, map]) => [
          name,
          Object.fromEntries(
            [...map].map(([key, value]) => [
              key,
              {
                ...value,
                rate: value.labeled ? value.matched / value.labeled : null,
                label_coverage: value.expected ? value.labeled / value.expected : null,
              },
            ]),
          ),
        ]),
      ),
      case_count: packet.cases.length,
      criterion_match: totals.labeled ? totals.matched / totals.labeled : null,
      label_coverage: totals.expected ? totals.labeled / totals.expected : null,
      score_mae: totals.scored_cases ? totals.absolute_score_error / totals.scored_cases : null,
      critical: {
        ...critical,
        precision: critical.tp + critical.fp ? critical.tp / (critical.tp + critical.fp) : null,
        recall: critical.positive_references ? critical.tp / critical.positive_references : null,
      },
      na: {
        ...na,
        precision: na.tp + na.fp ? na.tp / (na.tp + na.fp) : null,
        recall: na.positive_references ? na.tp / na.positive_references : null,
      },
    },
    limitations: [
      'Проверяющие и их независимость подтверждены только их собственными заявлениями.',
      'Разметка DEV не является скрытым тестовым набором.',
      'UNKNOWN исключён из знаменателя точности с явным показом покрытия; пропущенный ответ модели остаётся ошибкой.',
      'Метрики сравнивают исходные ответы модели до апелляций.',
    ],
    rows,
  };
}

module.exports = {
  canonical,
  digest,
  packetDigest,
  sourceDigest,
  validatePacket,
  prepareReview,
  validateLabel,
  validateAnnotation,
  reconcileReviews,
  compareHumanReference,
};
