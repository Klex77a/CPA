'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const review = require('../src/human-review');
const checklist = require('../src/default-checklist.json');
const fixture = require('./fixtures/benchmark-cases.json');
const { main, privateOutput } = require('../scripts/review-quality');
const clone = (value) => JSON.parse(JSON.stringify(value));
const dataset = {
  group_id: 'REVIEW_TEST',
  records: fixture.cases.map((item) => clone(item.record)),
};
const { packet, manifest } = review.prepareReview(dataset, checklist, {
  count: 3,
  seed: 'frozen-test-seed',
});
const defaultScope = { packet, manifest };
const original = (caseId, scope = defaultScope) =>
  fixture.cases.find(
    (item) =>
      item.record.conversation_id ===
      scope.manifest.cases.find((row) => row.case_id === caseId).conversation_id,
  );
const reviewer = (id) => ({
  id,
  role: 'Synthetic test reviewer',
  independence: 'self_attested',
  attestation: {
    human: true,
    model_answers_unseen: true,
    no_llm_assistance: true,
    submitted_at: '2026-11-08T00:00:00Z',
  },
});
function annotation(id, scope = defaultScope) {
  return {
    kind: 'cqa_human_annotations',
    schema_version: '1.0',
    packet_id: scope.packet.packet_id,
    packet_digest: scope.packet.packet_digest,
    stage: 'submitted',
    reviewer: reviewer(id),
    cases: scope.packet.cases.map((item) => ({
      case_id: item.case_id,
      criteria: Object.fromEntries(
        checklist.criteria.map((criterion) => {
          const expected = original(item.case_id, scope).expected[criterion.id];
          return [
            criterion.id,
            {
              state: 'labeled',
              value: expected.value,
              rationale: expected.rationale || expected.reason || 'Synthetic reference rationale',
              evidence_turns: expected.evidence_turns,
            },
          ];
        }),
      ),
    })),
  };
}
function evaluations(scope = defaultScope) {
  return scope.packet.cases.map((item) => {
    const source = original(item.case_id, scope);
    return {
      id: 'evaluation-' + item.case_id,
      group_id: dataset.group_id,
      conversation_id: source.record.conversation_id,
      created_at: '2026-11-08T00:00:00Z',
      status: 'ok',
      provider: 'deepseek',
      model: 'synthetic-test-model',
      prompt_version: 'synthetic-test-version',
      record_snapshot: clone(source.record),
      checklist: { id: checklist.id, version: checklist.version },
      checklist_snapshot: clone(checklist),
      criteria: Object.fromEntries(
        checklist.criteria.map((criterion) => {
          const expected = source.expected[criterion.id],
            value = expected.value;
          return [
            criterion.id,
            {
              answer:
                value === null ? 'NA' : criterion.type === 'scale' ? 'SCORE' : value ? 'YES' : 'NO',
              value: criterion.type === 'scale' ? value : null,
              explanation: 'Synthetic model rationale',
              na_reason: value === null ? 'Synthetic N/A context' : undefined,
              evidence: expected.evidence_turns.map((turn) => ({ msg: turn - 1 })),
            },
          ];
        }),
      ),
    };
  });
}
let passed = 0;
function test(name, callback) {
  callback();
  passed++;
  console.log('✔ ' + name);
}
test('packet omits model answers, source IDs and signed audio links, balances languages', () => {
  assert.equal(review.validatePacket(packet), packet);
  assert.deepEqual(packet.cases.map((item) => item.language).sort(), ['EN', 'KZ', 'RU']);
  for (const source of dataset.records)
    assert.ok(!JSON.stringify(packet).includes(source.conversation_id));
  assert.ok(!JSON.stringify(packet).includes('audio_url'));
  assert.equal(packet.blinding.independence_verified, false);
  const selection = review.prepareReview(dataset, checklist, {
    count: 3,
    seed: 'frozen-test-seed',
  });
  assert.deepEqual(
    selection.manifest.cases.map((item) => item.conversation_id),
    manifest.cases.map((item) => item.conversation_id),
  );
});
test('tampered packets and embedded model fields cannot be accepted as blinded input', () => {
  const tampered = clone(packet);
  tampered.cases[0].transcript[0].text += 'changed';
  assert.throws(() => review.validatePacket(tampered), /сумма/);
  tampered.packet_digest = review.packetDigest(tampered);
  tampered.model_answers = {};
  tampered.packet_digest = review.packetDigest(tampered);
  assert.throws(() => review.validatePacket(tampered), /Посторонние/);
});
test('drafts, same reviewer identities and absent human attestation cannot create consensus', () => {
  const left = annotation('A'),
    right = annotation('B');
  left.stage = 'draft';
  assert.throws(() => review.reconcileReviews(packet, left, right), /Черновик/);
  left.stage = 'submitted';
  right.reviewer.id = ' a ';
  assert.throws(() => review.reconcileReviews(packet, left, right), /разных/);
  right.reviewer.id = 'B';
  right.reviewer.attestation.no_llm_assistance = false;
  assert.throws(() => review.reconcileReviews(packet, left, right), /подтверждение/);
});
test('UNKNOWN remains explicit and cannot silently become N/A or a fully scored case', () => {
  const left = annotation('A'),
    right = annotation('B');
  const id = packet.cases[0].case_id;
  for (const input of [left, right])
    input.cases.find((item) => item.case_id === id).criteria.c04 = {
      state: 'unknown',
      value: null,
      rationale: 'No approved factual reference',
      unknown_reason: 'Missing knowledge base',
      evidence_turns: [],
    };
  const reference = review.reconcileReviews(packet, left, right);
  const result = review.compareHumanReference(packet, manifest, reference, evaluations());
  assert.equal(result.metrics.unknown, 1);
  assert.equal(result.metrics.labeled, 23);
  assert.equal(result.metrics.expected, 24);
  assert.equal(result.metrics.scored_cases, 2);
  assert.equal(result.metrics.criterion_match, 1);
  assert.equal(result.metrics.by_language[packet.cases[0].language].unknown, 1);
  assert.equal(result.metrics.by_language[packet.cases[0].language].labeled, 7);
  assert.equal(result.metrics.by_criterion.c04.unknown, 1);
  assert.equal(result.metrics.by_criterion.c04.labeled, 2);
  assert.equal(result.independent_expert_validation, false);
});
test('adjudication requires a third human and exact binding to both reviews', () => {
  const left = annotation('A'),
    right = annotation('B');
  right.cases[0].criteria.c01.value = !right.cases[0].criteria.c01.value;
  const pending = review.reconcileReviews(packet, left, right);
  assert.equal(pending.unresolved, 1);
  assert.equal(pending.state, 'needs_adjudication');
  const resolution = {
    packet_digest: packet.packet_digest,
    left_digest: review.digest(left),
    right_digest: review.digest(right),
    reviewer: reviewer('A'),
    cases: [{ case_id: packet.cases[0].case_id, criteria: { c01: left.cases[0].criteria.c01 } }],
  };
  assert.throws(() => review.reconcileReviews(packet, left, right, resolution), /третий/);
  resolution.reviewer = reviewer('C');
  resolution.right_digest = 'wrong';
  assert.throws(() => review.reconcileReviews(packet, left, right, resolution), /привязаны/);
  resolution.right_digest = review.digest(right);
  assert.equal(review.reconcileReviews(packet, left, right, resolution).state, 'consensus');
});
test('model comparison uses original predictions, and missing models stay in denominators', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  const observed = evaluations();
  observed[0].criteria.c01.answer = observed[0].criteria.c01.answer === 'YES' ? 'NO' : 'YES';
  observed[0].final_criteria = clone(evaluations()[0].criteria);
  const result = review.compareHumanReference(packet, manifest, reference, observed);
  assert.equal(result.metrics.matched, 23);
  assert.equal(result.metrics.criterion_match, 23 / 24);
  const missing = review.compareHumanReference(packet, manifest, reference, []);
  assert.equal(missing.metrics.labeled, 24);
  assert.equal(missing.metrics.missing_predictions, 24);
  assert.equal(missing.metrics.criterion_match, 0);
});
test('changed source and mismatched checklist cannot bind historical model answers', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  const observed = evaluations();
  observed[0].record_snapshot.transcript[0].text += 'modified';
  observed[1].checklist_snapshot.criteria[0].weight++;
  assert.equal(
    review.compareHumanReference(packet, manifest, reference, observed).metrics.missing_predictions,
    16,
  );
});
test('invalid scalar types, missing proof and out-of-range labels fail before comparison', () => {
  const input = annotation('A');
  input.cases[0].criteria.c01.value = 'true';
  assert.throws(() => review.validateAnnotation(packet, input), /тип/);
  input.cases[0].criteria.c01.value = true;
  input.cases[0].criteria.c01.evidence_turns = [];
  assert.throws(() => review.validateAnnotation(packet, input), /участок/);
  input.cases[0].criteria.c01.evidence_turns = [99999];
  assert.throws(() => review.validateAnnotation(packet, input), /реплики/);
});

test('mock variants and missing provider/model/prompt identity cannot count as predictions', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  for (const patch of [
    { provider: 'mock' },
    { provider: 'MOCK' },
    { provider: ' mock ' },
    { provider: '' },
    { provider: null },
    { model: '   ' },
    { prompt_version: '' },
  ]) {
    const observed = evaluations().map((evaluation) => ({ ...evaluation, ...patch }));
    const result = review.compareHumanReference(packet, manifest, reference, observed);
    assert.equal(result.metrics.missing_predictions, 24, JSON.stringify(patch));
    assert.equal(result.metrics.criterion_match, 0);
    assert.equal(result.metrics.scored_cases, 0);
    assert.equal(result.metrics.score_mae, null);
    assert.equal(result.prediction_model, null);
  }
});

test('mixed model or prompt identities fail instead of producing a pooled quality percentage', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  for (const patch of [
    { model: 'different-synthetic-model' },
    { provider: 'openai' },
    { prompt_version: 'different-synthetic-version' },
  ]) {
    const observed = evaluations();
    Object.assign(observed[1], patch);
    assert.throws(
      () => review.compareHumanReference(packet, manifest, reference, observed),
      /смешаны модели|версии промпта/i,
    );
  }
});

test('unsupported quotes and model validation issues stay UNKNOWN in the labeled denominator', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  for (const mutate of [
    (answer) => {
      answer.evidence[0].fragment = 'This exact claim was never present in the source.';
    },
    (answer) => {
      answer.evidence = [{ msg: -1 }];
    },
    (answer) => {
      answer.issues = ['Evidence requires manual review'];
    },
    (answer) => {
      answer.review_required = true;
    },
  ]) {
    const observed = evaluations();
    mutate(observed[0].criteria.c01);
    const result = review.compareHumanReference(packet, manifest, reference, observed);
    assert.equal(result.metrics.expected, 24);
    assert.equal(result.metrics.labeled, 24);
    assert.equal(result.metrics.missing_predictions, 1);
    assert.equal(result.metrics.matched, 23);
    assert.equal(result.metrics.criterion_match, 23 / 24);
    assert.equal(
      result.metrics.scored_cases,
      2,
      'a partially unsupported case must not receive an artificial zero score error',
    );
    assert.equal(
      result.rows.find(
        (row) => row.case_id === packet.cases[0].case_id && row.criterion_id === 'c01',
      ).actual,
      'UNKNOWN',
    );
  }
});

test('N/A confusion distinguishes false positives and false negatives from UNKNOWN', () => {
  const scope = review.prepareReview(dataset, checklist, {
    count: 15,
    seed: 'synthetic-na-confusion',
  });
  const reference = review.reconcileReviews(
    scope.packet,
    annotation('A', scope),
    annotation('B', scope),
  );
  const observed = evaluations(scope);
  const positive = observed.find((evaluation) => evaluation.criteria.c02.answer === 'NA');
  const negative = observed.find((evaluation) => evaluation.criteria.c02.answer !== 'NA');
  positive.criteria.c02.answer = 'YES';
  negative.criteria.c02.answer = 'NA';
  negative.criteria.c02.na_reason = 'Synthetic deliberately incorrect N/A prediction';
  const result = review.compareHumanReference(scope.packet, scope.manifest, reference, observed);
  assert.equal(result.metrics.na.positive_references, 27);
  assert.deepEqual(
    [
      result.metrics.na.tp,
      result.metrics.na.tn,
      result.metrics.na.fp,
      result.metrics.na.fn,
      result.metrics.na.unknown_predictions,
    ],
    [26, 32, 1, 1, 0],
  );
  assert.equal(result.metrics.na.precision, 26 / 27);
  assert.equal(result.metrics.na.recall, 26 / 27);
  assert.equal(result.metrics.missing_predictions, 0);
  assert.equal(result.metrics.matched, 118);
});

test('unsupported critical-positive prediction remains in recall denominator and is not a true positive', () => {
  const scope = review.prepareReview(dataset, checklist, {
    count: 15,
    seed: 'synthetic-critical-unknown',
  });
  const reference = review.reconcileReviews(
    scope.packet,
    annotation('A', scope),
    annotation('B', scope),
  );
  for (const mutate of [
    (answer) => {
      answer.evidence[0].fragment = 'An invented critical quote.';
    },
    (answer) => {
      answer.review_required = true;
    },
  ]) {
    const observed = evaluations(scope);
    const positive = observed.find((evaluation) => evaluation.criteria.c08.answer === 'YES');
    mutate(positive.criteria.c08);
    const result = review.compareHumanReference(scope.packet, scope.manifest, reference, observed);
    assert.equal(result.metrics.critical.positive_references, 2);
    assert.equal(result.metrics.critical.tp, 1);
    assert.equal(result.metrics.critical.unknown_positive, 1);
    assert.equal(result.metrics.critical.unknown_predictions, 1);
    assert.equal(result.metrics.critical.recall, 0.5);
    assert.equal(result.metrics.missing_predictions, 1);
    assert.equal(result.metrics.scored_cases, 14);
  }
});

test('full checklist metadata and source channel/language remain bound to frozen review inputs', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  for (const mutate of [
    (evaluation) => {
      evaluation.checklist_snapshot.notes += ' changed';
    },
    (evaluation) => {
      evaluation.checklist_snapshot.rounding = 3;
    },
    (evaluation) => {
      evaluation.checklist_snapshot.sections[0].name += ' changed';
    },
    (evaluation) => {
      evaluation.record_snapshot.channel = 'voice call';
    },
    (evaluation) => {
      evaluation.record_snapshot.language = 'ZZ';
    },
  ]) {
    const observed = evaluations();
    mutate(observed[0]);
    const result = review.compareHumanReference(packet, manifest, reference, observed);
    assert.equal(result.metrics.missing_predictions, 8);
    assert.equal(result.metrics.scored_cases, 2);
    assert.equal(result.metrics.matched, 16);
  }
});

test('incomplete drafts may be saved but malformed populated cells cannot masquerade as valid draft data', () => {
  const draft = annotation('A');
  draft.stage = 'draft';
  draft.cases[0].criteria.c01 = {
    state: 'unknown',
    value: null,
    rationale: '',
    unknown_reason: '',
    evidence_turns: [],
  };
  assert.equal(review.validateAnnotation(packet, draft, { submitted: false }), draft);
  assert.throws(() => review.validateAnnotation(packet, draft), /Черновик/);
  for (const malformed of [
    'YES',
    null,
    { state: 'labeled', value: 'true', rationale: 'Populated draft', evidence_turns: [1] },
    { state: 'unknown', value: true, rationale: '', unknown_reason: '', evidence_turns: [] },
    { state: 'unknown', value: null, rationale: '', unknown_reason: '', evidence_turns: '1' },
  ]) {
    const broken = clone(draft);
    broken.cases[0].criteria.c01 = malformed;
    assert.throws(
      () => review.validateAnnotation(packet, broken, { submitted: false }),
      /критер|ответ|тип|реплик|чернов|размет/i,
    );
  }
});

test('imported reference provenance cannot claim verified expertise or omit durable reviewer bindings', () => {
  const reference = review.reconcileReviews(packet, annotation('A'), annotation('B'));
  for (const mutate of [
    (value) => {
      value.provenance = 'independent_expert';
    },
    (value) => {
      value.independent_expert_validation = true;
    },
    (value) => {
      value.packet_id = 'foreign-packet';
    },
    (value) => {
      value.reviewers = ['A', ' a '];
    },
    (value) => {
      value.review_digests = ['not-a-hash', 'also-not-a-hash'];
    },
    (value) => {
      value.unresolved = 1;
    },
  ]) {
    const broken = clone(reference);
    mutate(broken);
    assert.throws(
      () => review.compareHumanReference(packet, manifest, broken, evaluations()),
      /эталон|размет|пакет|проверя|происхож|сведени/i,
    );
  }
  const annotationInput = annotation('A');
  annotationInput.reviewer.independence = 'automatically_verified_expert';
  assert.throws(() => review.validateAnnotation(packet, annotationInput), /независимость/);
});

test('private output rejects junction/symlink escapes without writing or traversing their targets', () => {
  const privateRoot = path.resolve(__dirname, '..', 'output', 'private');
  fs.mkdirSync(privateRoot, { recursive: true });
  const guardDirectory = fs.mkdtempSync(path.join(privateRoot, 'symlink-guard-test-'));
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-review-external-'));
  const link = path.join(guardDirectory, 'escape');
  const sentinel = path.join(externalDirectory, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'Synthetic test target must remain untouched.');
  let linked = false;
  try {
    try {
      fs.symlinkSync(externalDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
      console.log('  SKIP symlink creation: platform does not permit symlinks/junctions.');
      return;
    }
    assert.throws(() => privateOutput(path.join(link, 'results.json')), /Символические ссылки/);
    assert.equal(fs.existsSync(path.join(externalDirectory, 'results.json')), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Synthetic test target must remain untouched.');
  } finally {
    if (linked) {
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      fs.unlinkSync(link);
    }
    const privateRelative = path.relative(privateRoot, path.resolve(guardDirectory));
    assert.ok(
      privateRelative && !privateRelative.startsWith('..') && !path.isAbsolute(privateRelative),
    );
    assert.equal(path.dirname(path.resolve(externalDirectory)), path.resolve(os.tmpdir()));
    assert.equal(
      fs.realpathSync(guardDirectory).toLowerCase(),
      path.resolve(guardDirectory).toLowerCase(),
    );
    fs.rmSync(guardDirectory, { recursive: true });
    fs.rmSync(externalDirectory, { recursive: true });
  }
});
test('CLI defaults to dry-run and rejects public output paths without touching DEV', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-review-test-'));
  const source = path.join(directory, 'source.json');
  fs.writeFileSync(source, JSON.stringify(dataset));
  const output = path.join(__dirname, '..', 'output', 'private', 'review-test-' + process.pid);
  assert.equal(main(['prepare', '--source', source, '--count', '3', '--out', output]), 0);
  assert.equal(fs.existsSync(output), false);
  assert.throws(
    () => privateOutput(path.join(__dirname, '..', 'results', 'dev', 'results.json')),
    /output\/private/,
  );
  assert.throws(() => privateOutput(path.join(directory, 'public.json')), /output\/private/);
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true });
});
console.log(`human-review: ${passed} checks passed`);
