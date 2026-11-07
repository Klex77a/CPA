import type { Checklist, Speaker } from '../../types';

export interface ReviewPacket {
  kind: 'cqa_blind_review_packet';
  schema_version: '1.0';
  packet_id: string;
  packet_digest: string;
  created_at: string;
  scope: string;
  checklist: Checklist;
  cases: {
    case_id: string;
    language: string;
    channel: string;
    transcript: { turn: number; speaker: Speaker; timestamp: string; text: string }[];
  }[];
  blinding: {
    model_answers_excluded: true;
    source_ids_removed: true;
    independence_verified: false;
  };
  privacy_notice: string;
}
export interface HumanLabel {
  state: 'unanswered' | 'labeled' | 'unknown';
  value: boolean | number | null;
  rationale: string;
  evidence_turns: number[];
  unknown_reason?: string;
}
export interface HumanAnnotation {
  kind: 'cqa_human_annotations';
  schema_version: '1.0';
  packet_id: string;
  packet_digest: string;
  stage: 'draft' | 'submitted';
  reviewer: {
    id: string;
    role: string;
    independence: 'self_attested';
    attestation: {
      human: boolean;
      model_answers_unseen: boolean;
      no_llm_assistance: boolean;
      submitted_at: string;
    };
  };
  cases: { case_id: string; criteria: Record<string, HumanLabel> }[];
}
export const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export async function packetChecksum(packet: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(
    canonical(
      Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'packet_digest')),
    ),
  );
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[a-zA-Z0-9_-]{1,60}$/.test(id) &&
  !['__proto__', 'constructor', 'prototype'].includes(id);
export async function parsePacket(input: unknown): Promise<ReviewPacket> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Выберите JSON-пакет слепой разметки.');
  const packet = input as ReviewPacket;
  if (
    packet.kind !== 'cqa_blind_review_packet' ||
    packet.schema_version !== '1.0' ||
    !packet.packet_id ||
    !packet.packet_digest
  )
    throw new Error('Нужен исходный пакет слепой разметки версии 1.0.');
  const allowed = [
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
  ];
  if (
    Object.keys(packet).some((key) => !allowed.includes(key)) ||
    packet.blinding?.model_answers_excluded !== true ||
    packet.blinding?.source_ids_removed !== true ||
    packet.blinding?.independence_verified !== false
  )
    throw new Error(
      'Пакет содержит посторонние данные или не подтверждает скрытие ответов модели.',
    );
  if ((await packetChecksum(packet as unknown as Record<string, unknown>)) !== packet.packet_digest)
    throw new Error('Контрольная сумма не совпадает. Используйте неизменённый исходный пакет.');
  const criteria = packet.checklist?.criteria;
  if (
    !Array.isArray(criteria) ||
    !criteria.length ||
    criteria.length > 200 ||
    criteria.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        !validId(item.id) ||
        typeof item.title !== 'string' ||
        !item.title.trim() ||
        !['binary', 'scale', 'flag'].includes(item.type) ||
        (item.type === 'scale' &&
          (!Array.isArray(item.scale) ||
            !item.scale.length ||
            item.scale.some(
              (step) => !step || typeof step.value !== 'number' || !Number.isFinite(step.value),
            ))) ||
        typeof item.na_allowed !== 'boolean',
    ) ||
    new Set(criteria.map((item) => item.id)).size !== criteria.length
  )
    throw new Error('Чек-лист пакета повреждён.');
  if (
    !Array.isArray(packet.cases) ||
    !packet.cases.length ||
    packet.cases.length > 1000 ||
    packet.cases.some((item) => !item || typeof item !== 'object') ||
    new Set(packet.cases.map((item) => item.case_id)).size !== packet.cases.length
  )
    throw new Error('В пакете отсутствуют диалоги или повторяются ID.');
  for (const item of packet.cases) {
    if (
      !validId(item.case_id) ||
      !['RU', 'KZ', 'EN'].includes(item.language) ||
      !item.channel ||
      Object.keys(item).some(
        (key) => !['case_id', 'language', 'channel', 'transcript'].includes(key),
      ) ||
      !Array.isArray(item.transcript) ||
      !item.transcript.length ||
      item.transcript.some(
        (turn, index) =>
          !turn ||
          typeof turn !== 'object' ||
          turn.turn !== index + 1 ||
          !['operator', 'client', 'bot', 'system'].includes(turn.speaker) ||
          typeof turn.timestamp !== 'string' ||
          typeof turn.text !== 'string' ||
          !turn.text.trim() ||
          Object.keys(turn).some((key) => !['turn', 'speaker', 'timestamp', 'text'].includes(key)),
      )
    )
      throw new Error('Повреждены исходные реплики или нарушена слепая проверка.');
  }
  return packet;
}
export function emptyAnnotation(packet: ReviewPacket): HumanAnnotation {
  return {
    kind: 'cqa_human_annotations',
    schema_version: '1.0',
    packet_id: packet.packet_id,
    packet_digest: packet.packet_digest,
    stage: 'draft',
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
        packet.checklist.criteria.map((criterion) => [
          criterion.id,
          { state: 'unanswered', value: null, rationale: '', evidence_turns: [] },
        ]),
      ),
    })),
  };
}
export function labelProblem(
  label: HumanLabel | undefined,
  criterion: Checklist['criteria'][number],
  turnCount: number,
): string {
  if (!label || label.state === 'unanswered') return 'Выберите ответ.';
  if (!label.rationale?.trim()) return 'Добавьте обоснование.';
  if (
    !Array.isArray(label.evidence_turns) ||
    new Set(label.evidence_turns).size !== label.evidence_turns.length ||
    label.evidence_turns.some((turn) => !Number.isInteger(turn) || turn < 1 || turn > turnCount)
  )
    return 'Проверьте номера реплик.';
  if (label.state === 'unknown')
    return label.value === null && label.unknown_reason?.trim()
      ? ''
      : 'Укажите, почему ответ нельзя проверить.';
  if (label.state !== 'labeled') return 'Недопустимый статус ответа.';
  if (!label.evidence_turns.length)
    return 'Отметьте доказательство или проверенный участок разговора.';
  if (label.value === null) return criterion.na_allowed ? '' : 'N/A запрещён для этого критерия.';
  return criterion.type === 'scale'
    ? typeof label.value === 'number' && criterion.scale?.some((step) => step.value === label.value)
      ? ''
      : 'Выберите допустимую ступень шкалы.'
    : typeof label.value === 'boolean'
      ? ''
      : 'Нужен ответ Да или Нет.';
}
export function restoreAnnotation(packet: ReviewPacket, value: unknown): HumanAnnotation {
  const input = value as HumanAnnotation;
  if (
    input?.kind !== 'cqa_human_annotations' ||
    input.schema_version !== '1.0' ||
    input.packet_id !== packet.packet_id ||
    input.packet_digest !== packet.packet_digest ||
    !Array.isArray(input.cases) ||
    input.cases.length !== packet.cases.length ||
    input.cases.some((item) => !item || typeof item !== 'object') ||
    new Set(input.cases.map((item) => item.case_id)).size !== packet.cases.length
  )
    throw new Error('Черновик относится к другому пакету или повреждён.');
  const restored = emptyAnnotation(packet);
  restored.reviewer.id = typeof input.reviewer?.id === 'string' ? input.reviewer.id : '';
  restored.reviewer.role = typeof input.reviewer?.role === 'string' ? input.reviewer.role : '';
  for (const row of restored.cases) {
    const original = input.cases.find((item) => item.case_id === row.case_id);
    if (
      !original ||
      !original.criteria ||
      Object.keys(original.criteria).some((id) => !Object.hasOwn(row.criteria, id))
    )
      throw new Error('В черновике неизвестные случаи или критерии.');
    for (const criterion of packet.checklist.criteria) {
      const label = original.criteria[criterion.id];
      if (
        !label ||
        !['unanswered', 'labeled', 'unknown'].includes(label.state) ||
        typeof label.rationale !== 'string' ||
        !Array.isArray(label.evidence_turns) ||
        label.evidence_turns.some(
          (turn) =>
            !Number.isInteger(turn) ||
            turn < 1 ||
            turn > packet.cases.find((item) => item.case_id === row.case_id)!.transcript.length,
        )
      )
        throw new Error('Некорректная запись черновика.');
      row.criteria[criterion.id] = {
        state: label.state,
        value: label.value,
        rationale: label.rationale,
        evidence_turns: [...new Set(label.evidence_turns)],
        ...(typeof label.unknown_reason === 'string'
          ? { unknown_reason: label.unknown_reason }
          : {}),
      };
    }
  }
  return restored;
}
