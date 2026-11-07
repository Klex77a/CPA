import type { EvaluationFailureSummary, Readiness as WorkspaceReadiness } from '../../types';

export interface ListEvaluation {
  id: string;
  checklist: { id: string; name: string; version: number };
  final_total: number | null;
  original_total: number | null;
  operator_name: string | null;
  gross_error: boolean;
  gross_error_unknown: boolean;
  status: string;
  provider: string;
  model: string;
  appeals_open: number;
  appeals_total: number;
  stale?: boolean;
  record_changed?: boolean;
  created_at?: string;
}
export interface ListRecord {
  conversation_id: string;
  channel: string;
  language: string;
  messages: number;
  has_audio: boolean;
  evaluations: ListEvaluation[];
  failures?: EvaluationFailureSummary[];
}
export interface DatasetList {
  group_id: string;
  fetched_at: string;
  records: ListRecord[];
}
export interface Row {
  record: ListRecord;
  evaluation?: ListEvaluation;
  history: ListEvaluation[];
  failure?: EvaluationFailureSummary;
}
export interface Filters {
  query: string;
  channel: string;
  language: string;
  quick: string;
  sort: string;
  direction: number;
}
export interface QueueJob {
  id: string;
  group_id?: string;
  checklist_id?: string;
  status: string;
  execution_mode?: string;
  done: number;
  total: number;
  skipped?: number;
  cost_usd: number | null;
  known_cost_usd?: number;
  billing_complete?: boolean;
  unknown_cost_count?: number;
  unknown_call_count?: number;
  counts?: Record<string, number>;
  errors: { conversation_id?: string; error: string }[];
}
export interface CriterionDraft {
  id: string;
  code?: string;
  section?: string | null;
  title: string;
  type: 'binary' | 'scale' | 'flag';
  weight: number;
  description: string;
  na_allowed?: boolean;
  na_condition?: string;
  scale?: { value: number; description: string }[];
}
export interface ChecklistDraft {
  id: string;
  name: string;
  version: number;
  rounding: number;
  notes?: string;
  updated_at?: string;
  sections: { id: string; name: string }[];
  criteria: CriterionDraft[];
  history?: { version: number; updated_at: string; criteria: string[] }[];
}
export interface CriterionStats {
  id: string;
  code?: string;
  title: string;
  applicable: number;
  na: number;
  invalid: number;
  rate: number | null;
  by_language?: Record<string, number | null>;
}
export interface OperatorStats {
  name: string;
  unnamed: boolean;
  dialogs: number;
  avg: number | null;
  min: number | null;
  gross: number;
  gross_unknown: number;
  languages: string[];
  weakest?: { title: string; rate: number } | null;
  criteria: CriterionStats[];
  coaching: { text: string; criterion_id: string; conversation_id: string }[];
  conversations: {
    id: string;
    total: number | null;
    eval_id: string;
    language: string;
    channel: string;
    gross: boolean;
    gross_unknown: boolean;
  }[];
}
export interface Analytics {
  group_id: string;
  checklist?: { id: string; name: string; version: number };
  evaluated: number;
  avg: number | null;
  median: number | null;
  models: string[];
  demo_count: number;
  gross_count: number;
  gross_unknown_count: number;
  appeals_open: number;
  appeals_total: number;
  changed_by_appeal: number;
  cost_usd: number | null;
  known_cost_usd?: number;
  billing_complete?: boolean;
  unknown_cost_count?: number;
  unknown_call_count?: number;
  low_confidence: number;
  languages: string[];
  by_language: Record<string, { avg: number | null; n: number }>;
  by_channel: Record<string, { avg: number | null; n: number }>;
  distribution: { from: number; to: number; count: number }[];
  criteria: CriterionStats[];
  operators: OperatorStats[];
  gross: { conversation_id: string; eval_id: string; operator?: string; explanation: string }[];
  worst: {
    conversation_id: string;
    eval_id: string;
    total: number | null;
    operator?: string;
    summary: string;
  }[];
}
export interface Answer {
  answer: string;
  value?: number | null;
  points?: number | null;
  explanation?: string;
  na_reason?: string;
  evidence?: { msg: number; fragment?: string }[];
  missing_range?: { from: number; to: number };
  checked_range?: { from: number; to: number };
}
export interface Appeal {
  id: string;
  evaluation_id: string;
  conversation_id: string;
  group_id: string;
  criterion_id: string;
  criterion_title: string;
  status: string;
  comment: string;
  created_at: string;
  disputed: Answer;
  final_total: number | null;
  original_total: number | null;
  decision?: Answer & {
    action: string;
    reason: string;
    total_before: number | null;
    total_after: number | null;
  };
}
export interface AppealEvaluation {
  checklist_snapshot: ChecklistDraft;
  record_changed?: boolean;
  record_snapshot?: TranscriptRecord | null;
}
export interface TranscriptRecord {
  transcript: { speaker: string; timestamp?: string; text: string }[];
}
export type Readiness = WorkspaceReadiness;
