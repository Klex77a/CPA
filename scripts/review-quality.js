'use strict';
// Local-only review tools. Never calls a model or publishes conversations.
const fs = require('node:fs');
const path = require('node:path');
const review = require('../src/human-review');
const checklist = require('../src/default-checklist.json');
const root = path.resolve(__dirname, '..');
const problem = (message) => Object.assign(new Error(message), { code: 'REVIEW_VALIDATION' });

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { command, write: false };
  const accepted = new Set([
    'source',
    'count',
    'seed',
    'out',
    'packet',
    'manifest',
    'left',
    'right',
    'resolutions',
    'reference',
    'evaluations',
  ]);
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (value === '--write') options.write = true;
    else if (
      value.startsWith('--') &&
      accepted.has(value.slice(2)) &&
      rest[index + 1] &&
      !rest[index + 1].startsWith('--')
    )
      options[value.slice(2)] = rest[++index];
    else throw problem('Неизвестный параметр или отсутствует значение');
  }
  if (!['prepare', 'reconcile', 'compare'].includes(command))
    throw problem('Команды: prepare, reconcile, compare. Запись файлов только с --write.');
  return options;
}
const read = (file) => {
  if (!file) throw problem('Не указан обязательный путь');
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
};
function privateOutput(file) {
  const allowed = path.join(root, 'output', 'private');
  const resolved = path.resolve(file);
  const relative = path.relative(allowed, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw problem('Результаты разметки записываются только внутри output/private/');
  // Reject existing directory junctions/symlinks before mkdir/write, including
  // dangling links. A private-looking lexical path must not resolve into Git.
  for (let cursor = resolved; path.relative(root, cursor) !== ''; cursor = path.dirname(cursor)) {
    if (path.dirname(cursor) === cursor) throw problem('Выход находится вне проекта');
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw problem('Символические ссылки в output/private/ не разрешены');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}
function write(file, value) {
  const target = privateOutput(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.command === 'prepare') {
    const input = read(options.source);
    const dataset = Array.isArray(input?.data?.records)
      ? { group_id: input.data.dataset_group_id, records: input.data.records }
      : input;
    const count =
      options.count === undefined
        ? Math.min(30, dataset.records?.length || 0)
        : Number(options.count);
    const { packet, manifest } = review.prepareReview(dataset, checklist, {
      count,
      ...(options.seed ? { seed: options.seed } : {}),
    });
    const directory = privateOutput(
      options.out || path.join(root, 'output', 'private', 'review-' + packet.packet_id),
    );
    if (options.write) {
      if (
        fs.existsSync(path.join(directory, 'packet.json')) ||
        fs.existsSync(path.join(directory, 'source-map.private.json'))
      )
        throw problem('Пакет уже существует; выберите новую папку');
      write(path.join(directory, 'packet.json'), packet);
      write(path.join(directory, 'source-map.private.json'), manifest);
    }
    console.log(
      JSON.stringify({
        command: 'prepare',
        mode: options.write ? 'written_private' : 'dry_run',
        cases: packet.cases.length,
        languages: Object.fromEntries(
          ['RU', 'KZ', 'EN'].map((language) => [
            language,
            packet.cases.filter((item) => item.language === language).length,
          ]),
        ),
        voice_cases: packet.cases.filter((item) => item.channel === 'voice call').length,
        model_answers_included: false,
        independent_validation: 'not_reviewed',
        ...(options.write ? { directory } : {}),
      }),
    );
    return 0;
  }
  const packet = read(options.packet);
  if (options.command === 'reconcile') {
    const left = read(options.left),
      right = read(options.right);
    const result = review.reconcileReviews(
      packet,
      left,
      right,
      options.resolutions ? read(options.resolutions) : undefined,
    );
    if (options.write) {
      if (!options.out) throw problem('--write требует --out output/private/...json');
      write(options.out, result);
      if (result.unresolved)
        write(options.out.replace(/\.json$/i, '') + '.resolutions-template.json', {
          kind: 'cqa_review_resolutions',
          packet_digest: packet.packet_digest,
          left_digest: review.digest(left),
          right_digest: review.digest(right),
          reviewer: {
            id: '',
            role: '',
            independence: 'self_attested',
            attestation: {
              human: false,
              model_answers_unseen: false,
              no_llm_assistance: false,
              submitted_at: '',
            },
          },
          cases: packet.cases.map((item) => ({
            case_id: item.case_id,
            criteria: Object.fromEntries(
              result.disagreements
                .filter((row) => row.case_id === item.case_id)
                .map((row) => [
                  row.criterion_id,
                  {
                    state: 'unknown',
                    value: null,
                    rationale: '',
                    unknown_reason: '',
                    evidence_turns: [],
                  },
                ]),
            ),
          })),
        });
    }
    console.log(
      JSON.stringify({
        command: 'reconcile',
        mode: options.write ? 'written_private' : 'dry_run',
        state: result.state,
        disagreements: result.disagreements.length,
        unresolved: result.unresolved,
        independent_expert_validation: false,
      }),
    );
    return result.unresolved ? 1 : 0;
  }
  const directory = path.resolve(options.evaluations || path.join(root, 'data', 'evaluations'));
  const evaluations = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
  const result = review.compareHumanReference(
    packet,
    read(options.manifest),
    read(options.reference),
    evaluations,
  );
  if (options.write) {
    if (!options.out) throw problem('--write требует --out output/private/...json');
    write(options.out, result);
  }
  console.log(
    JSON.stringify({
      command: 'compare',
      mode: options.write ? 'written_private' : 'dry_run',
      metrics: result.metrics,
      independent_expert_validation: false,
      scope: result.scope,
    }),
  );
  return 0;
}
if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      error?.code === 'REVIEW_VALIDATION'
        ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
        : 'Проверка разметки не выполнена. Проверьте JSON и права доступа к указанным файлам. Данные диалогов не выводились.',
    );
    process.exitCode = 2;
  }
}
module.exports = { main, parseArgs, privateOutput };
