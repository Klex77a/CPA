import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import QualityReviewPage from '../QualityReviewPage';
import {
  emptyAnnotation,
  labelProblem,
  packetChecksum,
  parsePacket,
  restoreAnnotation,
  type HumanAnnotation,
  type HumanLabel,
  type ReviewPacket,
} from './review';
import type { Checklist } from '../../types';

const require = createRequire(import.meta.url);
const humanReview = require('../../../../src/human-review.js') as {
  prepareReview: (
    dataset: unknown,
    checklist: Checklist,
    options: object,
  ) => { packet: ReviewPacket };
  packetDigest: (packet: unknown) => string;
  validateAnnotation: (packet: ReviewPacket, annotation: HumanAnnotation) => HumanAnnotation;
};
const checklist: Checklist = {
  id: 'synthetic',
  name: 'Учебные правила',
  version: 1,
  rounding: 2,
  sections: [],
  criteria: [
    {
      id: 'contact',
      title: 'Контакт',
      type: 'binary',
      weight: 40,
      na_allowed: false,
      description: 'Оператор приветствует клиента.',
    },
    {
      id: 'consultation',
      title: 'Консультация',
      type: 'scale',
      weight: 60,
      na_allowed: true,
      na_condition: 'Вопрос не был сформулирован.',
      description: 'Ответ должен соответствовать утверждённому регламенту.',
      scale: [
        { value: 20, description: 'Полный ответ' },
        { value: 10, description: 'Частичный ответ' },
        { value: 0, description: 'Нет ответа' },
      ],
    },
    {
      id: 'critical',
      title: 'Грубое нарушение',
      type: 'flag',
      weight: 0,
      na_allowed: false,
      description: 'Оскорбление или раскрытие защищённых данных.',
    },
  ],
};
function makePacket(): ReviewPacket {
  return humanReview.prepareReview(
    {
      group_id: 'SYNTHETIC',
      records: [
        {
          conversation_id: 'source-private-id',
          language: 'RU',
          channel: 'agent chat',
          transcript: [
            { speaker: 'client', timestamp: '00:01', text: 'Учебный вопрос о регламенте.' },
            { speaker: 'operator', timestamp: '00:02', text: 'Здравствуйте! Я учебный оператор.' },
            {
              speaker: 'operator',
              timestamp: '00:03',
              text: 'Срок зависит от регламента. До свидания!',
            },
          ],
          model_answers: 'secret-model-answer',
        },
      ],
    },
    checklist,
    { count: 1, seed: 'synthetic-review-tests', now: '2026-11-08T00:00:00Z' },
  ).packet;
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function jsonFile(value: unknown, name = 'packet.json') {
  const text = JSON.stringify(value);
  const file = new File([text], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  return file;
}
function readBlob(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}
const blobs: Blob[] = [];
const createObjectURL = vi.fn((blob: Blob) => {
  blobs.push(blob);
  return 'blob:human-review-test';
});
const revokeObjectURL = vi.fn();
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
});
beforeEach(() => {
  blobs.length = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe('Node-to-browser blind packet contract', () => {
  it('matches the Node checksum including Unicode and reordered object keys, without source IDs or model answers', async () => {
    const packet = makePacket();
    expect(await packetChecksum(packet as unknown as Record<string, unknown>)).toBe(
      packet.packet_digest,
    );
    const reordered = Object.fromEntries(Object.entries(packet).reverse());
    expect(await parsePacket(reordered)).toEqual(packet);
    expect(JSON.stringify(packet)).not.toContain('source-private-id');
    expect(JSON.stringify(packet)).not.toContain('secret-model-answer');
  });
  it('rejects tampered content and leaked source/model fields even if their checksum is recalculated', async () => {
    const changed = makePacket();
    changed.cases[0].transcript[0].text = 'Изменённый текст';
    await expect(parsePacket(changed)).rejects.toThrow('Контрольная сумма');
    const leaked = { ...makePacket(), model_answers: { contact: true } };
    leaked.packet_digest = humanReview.packetDigest(leaked);
    await expect(parsePacket(leaked)).rejects.toThrow('посторонние данные');
    const source = makePacket();
    Object.assign(source.cases[0], { conversation_id: 'source-private-id' });
    source.packet_digest = humanReview.packetDigest(source);
    await expect(parsePacket(source)).rejects.toThrow('слепая проверка');
  });
  it('keeps UNKNOWN distinct from an allowed N/A and enforces numeric scale and 1-based evidence', () => {
    const valid: HumanLabel = {
      state: 'labeled',
      value: null,
      rationale: 'Запрос не сформулирован.',
      evidence_turns: [1],
    };
    expect(labelProblem(valid, checklist.criteria[1], 3)).toBe('');
    expect(labelProblem(valid, checklist.criteria[2], 3)).toContain('N/A запрещён');
    const unknown: HumanLabel = {
      state: 'unknown',
      value: null,
      rationale: 'Не хватает утверждённого регламента.',
      evidence_turns: [],
      unknown_reason: 'Нет источника проверки названного срока.',
    };
    expect(labelProblem(unknown, checklist.criteria[2], 3)).toBe('');
    expect(labelProblem({ ...unknown, unknown_reason: '' }, checklist.criteria[2], 3)).toContain(
      'почему',
    );
    expect(labelProblem({ ...valid, value: 15 }, checklist.criteria[1], 3)).toContain('ступень');
    expect(
      labelProblem({ ...valid, value: 10, evidence_turns: [0] }, checklist.criteria[1], 3),
    ).toContain('номера реплик');
    expect(
      labelProblem({ ...valid, value: true, evidence_turns: [1, 1] }, checklist.criteria[0], 3),
    ).toContain('номера реплик');
  });
  it('reports malformed nested packet/draft values with actionable validation messages', async () => {
    const packet = makePacket();
    const badCriteria = clone(packet) as unknown as {
      checklist: { criteria: unknown[] };
      packet_digest: string;
    };
    badCriteria.checklist.criteria = [null];
    badCriteria.packet_digest = humanReview.packetDigest(badCriteria);
    await expect(parsePacket(badCriteria)).rejects.toThrow('Чек-лист пакета повреждён');
    const badTurns = clone(packet) as unknown as {
      cases: { transcript: unknown[] }[];
      packet_digest: string;
    };
    badTurns.cases[0].transcript = [null];
    badTurns.packet_digest = humanReview.packetDigest(badTurns);
    await expect(parsePacket(badTurns)).rejects.toThrow('Повреждены исходные реплики');
    const draft = emptyAnnotation(packet) as unknown as { cases: unknown[] };
    draft.cases = [null];
    expect(() => restoreAnnotation(packet, draft)).toThrow(
      'Черновик относится к другому пакету или повреждён',
    );
  });
  it('binds drafts to the exact packet and restores submitted files as drafts without attestation', () => {
    const packet = makePacket(),
      draft = emptyAnnotation(packet);
    draft.reviewer.id = 'reviewer-one';
    draft.reviewer.role = 'QA';
    draft.stage = 'submitted';
    draft.reviewer.attestation = {
      human: true,
      model_answers_unseen: true,
      no_llm_assistance: true,
      submitted_at: '2026-11-08',
    };
    draft.cases[0].criteria.contact = {
      state: 'labeled',
      value: true,
      rationale: 'Приветствие в реплике 2.',
      evidence_turns: [2],
    };
    const restored = restoreAnnotation(packet, draft);
    expect(restored.stage).toBe('draft');
    expect(restored.reviewer.attestation.human).toBe(false);
    expect(restored.reviewer.id).toBe('reviewer-one');
    expect(restored.cases[0].criteria.contact.evidence_turns).toEqual([2]);
    expect(() => restoreAnnotation(makePacket(), draft)).toThrow('другому пакету');
    const tampered = clone(draft);
    tampered.packet_digest = '0'.repeat(64);
    expect(() => restoreAnnotation(packet, tampered)).toThrow('другому пакету');
    const invalid = clone(draft);
    invalid.cases[0].criteria.contact.evidence_turns = [4];
    expect(() => restoreAnnotation(packet, invalid)).toThrow('Некорректная запись');
  });
});

describe('human review form', () => {
  it('imports a Node packet, requires complete human labels and attestation, and exports a Node-valid submission', async () => {
    const user = userEvent.setup(),
      packet = makePacket();
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network should be used'));
    render(<QualityReviewPage />);
    await user.upload(screen.getByLabelText('Файл слепого пакета'), jsonFile(packet));
    await screen.findByText('0 из 3 критериев заполнено');
    await user.type(
      screen.getByRole('textbox', { name: 'Имя или рабочий ID эксперта' }),
      ' Reviewer One ',
    );
    await user.type(screen.getByRole('textbox', { name: 'Роль / квалификация' }), 'Специалист QA');
    await user.click(screen.getByRole('checkbox', { name: /Я лично проверил/ }));
    await user.click(screen.getByRole('button', { name: 'Сдать разметку JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Выберите ответ');
    expect(createObjectURL).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Решение эксперта' }), 'yes');
    await user.type(
      screen.getByRole('textbox', { name: 'Обоснование' }),
      'Оператор поздоровался в реплике 2.',
    );
    await user.click(screen.getByRole('button', { name: /№2 · Оператор/ }));
    expect(screen.getByText('1 из 3 критериев заполнено')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Следующий критерий/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Решение эксперта' }), 'unknown');
    await user.type(
      screen.getByRole('textbox', { name: 'Обоснование' }),
      'Фактический срок требует внешней проверки.',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Почему ответ нельзя проверить' }),
      'Нет утверждённого регламента.',
    );
    expect(screen.getByText('2 из 3 критериев заполнено')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Следующий критерий/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Решение эксперта' }), 'no');
    await user.type(
      screen.getByRole('textbox', { name: 'Обоснование' }),
      'Проверены все реплики, нарушений нет.',
    );
    await user.click(screen.getByRole('button', { name: 'Проверен весь диалог' }));
    expect(screen.getByText('3 из 3 критериев заполнено')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сдать разметку JSON' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const submitted = JSON.parse(await readBlob(blobs[0])) as HumanAnnotation;
    expect(submitted.stage).toBe('submitted');
    expect(submitted.reviewer.id).toBe('Reviewer One');
    expect(submitted.reviewer.independence).toBe('self_attested');
    expect(submitted.cases[0].criteria.consultation).toMatchObject({
      state: 'unknown',
      value: null,
      evidence_turns: [],
    });
    expect(submitted.cases[0].criteria.critical.evidence_turns).toEqual([1, 2, 3]);
    expect(() => humanReview.validateAnnotation(packet, submitted)).not.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects a different packet draft, keeps current answers when replacement is cancelled, and downloads an unattested draft', async () => {
    const user = userEvent.setup(),
      packet = makePacket();
    render(<QualityReviewPage />);
    await user.upload(screen.getByLabelText('Файл слепого пакета'), jsonFile(packet));
    await screen.findByText('0 из 3 критериев заполнено');
    await user.type(
      screen.getByRole('textbox', { name: 'Обоснование' }),
      'Мой несохранённый комментарий.',
    );
    await user.upload(
      screen.getByLabelText('Файл черновика разметки'),
      jsonFile(emptyAnnotation(makePacket()), 'wrong-draft.json'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('другому пакету');
    await user.upload(
      screen.getByLabelText('Файл слепого пакета'),
      jsonFile(makePacket(), 'second-packet.json'),
    );
    await screen.findByRole('dialog', { name: 'Открыть другой пакет?' });
    await user.click(screen.getByRole('button', { name: 'Продолжить текущий' }));
    expect(screen.getByRole('textbox', { name: 'Обоснование' })).toHaveValue(
      'Мой несохранённый комментарий.',
    );
    await user.click(screen.getByRole('button', { name: 'Скачать черновик' }));
    const draft = JSON.parse(await readBlob(blobs[0])) as HumanAnnotation;
    expect(draft.packet_digest).toBe(packet.packet_digest);
    expect(draft.stage).toBe('draft');
    expect(draft.reviewer.attestation).toEqual({
      human: false,
      model_answers_unseen: false,
      no_llm_assistance: false,
      submitted_at: '',
    });
  });
});
