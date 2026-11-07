export type Speaker = 'operator' | 'client' | 'bot' | 'system';
export type AnswerValue = 'YES' | 'NO' | 'NA' | 'SCORE' | 'INVALID';
export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';
export interface Criterion {
  id: string;
  code?: string;
  section?: string | null;
  title: string;
  type: 'binary' | 'scale' | 'flag';
  weight: number;
  na_allowed: boolean;
  description: string;
  na_condition?: string;
  scale?: { value: number; description: string }[];
}
export interface Checklist {
  id: string;
  name: string;
  version: number;
  criteria: Criterion[];
  sections: { id: string; name: string }[];
  rounding: number;
  updated_at?: string;
  history?: { version: number; updated_at?: string; criteria: string[] }[];
}
export interface TranscriptTurn {
  speaker: Speaker;
  timestamp: string | number;
  text: string;
}
export interface Evidence {
  msg: number;
  fragment?: string | null;
}
export interface TurnRange {
  from: number;
  to: number;
}
export interface Answer {
  answer: AnswerValue;
  value?: number | null;
  explanation: string;
  evidence: Evidence[];
  missing_range?: TurnRange | null;
  checked_range?: TurnRange | null;
  na_reason?: string | null;
  issues?: string[];
  review_required?: boolean;
  unverified_claims?: string[];
  agreement?: { agree: number; runs: number };
}
export interface CriterionResult {
  id: string;
  type: Criterion['type'];
  answer: AnswerValue;
  value: number | null;
  weight: number;
  section: string | null;
  scored: boolean;
  raw: number;
  points: number | null;
  contribution: number | null;
  max_contribution: number;
  effective_weight: number;
}
export interface SectionResult {
  id: string;
  name: string;
  points: number | null;
  max: number | null;
  percent: number | null;
}
export interface ScoreResult {
  total: number | null;
  total_exact?: number | null;
  max?: number | null;
  applicable_weight: number;
  earned_weight: number;
  redistribution_factor: number;
  gross_error: boolean;
  gross_error_criteria: string[];
  invalid_criteria: string[];
  criteria: CriterionResult[];
  sections: SectionResult[];
  note?: string | null;
}
export interface AppealDecision {
  action: 'confirm' | 'change';
  answer: AnswerValue | null;
  value: number | null;
  reason: string;
  reviewer: string;
  decided_at: string;
  total_before?: number | null;
  total_after?: number | null;
}
export interface Appeal {
  id: string;
  criterion_id: string;
  comment: string;
  status: 'open' | 'resolved';
  created_at: string;
  disputed: Answer;
  decision?: AppealDecision;
  evaluation_id?: string;
  conversation_id?: string;
  group_id?: string;
  checklist?: Pick<Checklist, 'id' | 'name' | 'version'>;
  final_total?: number | null;
  original_total?: number | null;
}
export interface Coaching {
  type: 'required' | 'optional';
  criterion_id: string;
  text: string;
  evidence?: Evidence[];
}
export interface EvaluationSummary {
  id: string;
  conversation_id: string;
  group_id: string;
  channel: string;
  language: string;
  checklist: Pick<Checklist, 'id' | 'name' | 'version'>;
  created_at: string;
  provider: string;
  model: string;
  status: 'ok' | 'needs_review' | 'error';
  original_total: number | null;
  final_total: number | null;
  gross_error: boolean;
  gross_error_unknown: boolean;
  operator_name?: string | null;
  appeals_open: number;
  appeals_total: number;
  stale?: boolean;
  record_changed?: boolean;
  stale_reasons?: string[];
}
export interface EvaluationFailureSummary {
  id: string;
  conversation_id: string;
  group_id: string;
  status: 'error';
  created_at: string;
  checklist: Pick<Checklist, 'id' | 'version'>;
  reason: string;
  error_status?: string | number;
}
export interface Conversation {
  conversation_id: string;
  channel: string;
  language: string;
  transcript: TranscriptTurn[];
  audio_url?: string | null;
  audio_segments?: ({ start: number; end: number } | null)[];
  messages?: number;
  evaluations?: EvaluationSummary[];
  failures?: EvaluationFailureSummary[];
}
export interface ConversationSummary extends Omit<Conversation, 'transcript'> {
  transcript?: TranscriptTurn[];
  evaluations: EvaluationSummary[];
  messages: number;
}
export interface DatasetSummary {
  group_id: string;
  total_records: number;
  fetched_at?: string;
  source?: string;
}
export interface Dataset {
  group_id: string;
  total_records?: number;
  records: ConversationSummary[];
}
export interface TokenUsage {
  input: number;
  output: number;
  thoughts: number;
}
export interface Evaluation {
  id: string;
  conversation_id: string;
  group_id: string;
  channel: string;
  language: string;
  checklist: Pick<Checklist, 'id' | 'name' | 'version'>;
  checklist_snapshot: Checklist;
  record_snapshot?: Conversation | null;
  provider: string;
  model: string;
  prompt_version?: string;
  created_at: string;
  status: 'ok' | 'needs_review' | 'error';
  criteria: Record<string, Answer>;
  final_criteria: Record<string, Answer>;
  original_result: ScoreResult;
  final_result: ScoreResult;
  summary?: string;
  coaching: Coaching[];
  original_coaching?: Coaching[];
  appeals: Appeal[];
  validation_errors: string[];
  global_validation_errors?: string[];
  duration_ms: number;
  cost_usd: number | null;
  usage: TokenUsage | null;
  known_usage?: TokenUsage;
  known_cost_usd?: number;
  billing_complete?: boolean;
  unknown_call_count?: number;
  timing?: {
    total_ms: number;
    llm_ms: number;
    http_attempts: number;
    retry_wait_ms: number;
    queue_ms: number;
    calls: unknown[];
  };
  operator_name?: string | null;
  stale?: boolean;
  record_changed?: boolean;
  stale_reasons?: string[];
  cached?: boolean;
}
export interface Config {
  provider: string;
  model: string;
  data_api_configured: boolean;
  concurrency: number;
  timeout_ms: number;
  max_attempts: number;
  repair_attempts: number;
  thinking_level: string | null;
  temperature: number | null;
  samples: number;
  price_in_per_m: number;
  price_out_per_m: number;
}
export interface BatchJob {
  id: string;
  execution_mode?: 'stepped';
  group_id: string;
  checklist_id?: string;
  checklist_version?: number;
  total: number;
  done: number;
  skipped: number;
  cost_usd: number | null;
  known_cost_usd?: number;
  billing_complete?: boolean;
  unknown_cost_count?: number;
  unknown_call_count?: number;
  status: 'running' | 'finished' | 'failed' | 'cancelled';
  errors: { conversation_id?: string; error: string }[];
  counts?: Record<string, number>;
  started_at?: string;
  finished_at?: string;
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
  weakest: { title: string; rate: number } | null;
  criteria: {
    id: string;
    code?: string;
    title: string;
    applicable: number;
    na: number;
    invalid: number;
    rate: number | null;
  }[];
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
  checklist: Pick<Checklist, 'id' | 'name' | 'version'> | null;
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
  criteria: {
    id: string;
    code?: string;
    title: string;
    applicable: number;
    na: number;
    invalid: number;
    rate: number | null;
    by_language: Record<string, number | null>;
  }[];
  operators: OperatorStats[];
  gross: { conversation_id: string; eval_id: string; operator?: string; explanation?: string }[];
  worst: {
    conversation_id: string;
    eval_id: string;
    total: number;
    operator?: string;
    summary?: string;
  }[];
}
export interface SubmissionState {
  split: string;
  state: string;
  path: string;
  expected: number;
  total: number;
  ok: number;
  errors: number;
  message: string;
}
export interface BenchmarkCoverage {
  cases: number;
  labels: number;
  languages: Record<string, number>;
  channels?: Record<string, number>;
  label_distribution?: Record<string, Record<string, number>>;
  critical_by_language?: Record<
    string,
    { positive: number; negative: number; types: Record<string, number> }
  >;
  source_turns?: number;
  max_source_turns?: number;
  measured?: boolean;
}
export interface BenchmarkStatus {
  state: string;
  quality_state?: string;
  runtime_state?: string;
  suite?: string;
  message: string;
  model?: string;
  case_count?: number;
  generated_at?: string;
  independent_expert_validation?: boolean;
  coverage?: BenchmarkCoverage;
  reference_review?: {
    state: string;
    summary?: string;
    disputed_label_count?: number;
    case_count?: number;
    findings_by_category?: Record<string, number>;
  };
  runtime?: {
    state: string;
    complete?: boolean;
    differences?: string[];
    note?: string;
    recorded?: Record<string, unknown>;
    current?: Record<string, unknown>;
  };
  metrics?: {
    criterion_match: { rate: number | null; matched: number; total: number };
    by_language: Record<string, { matched: number; total: number }>;
    cases: { failed: number; invalid: number };
    critical: { tp: number; expected_positive: number; fp: number; unknown: number };
    timing: { p50_ms: number | null };
    cost: {
      total_usd: number | null;
      known_total_usd?: number;
      complete: boolean;
      unknown_call_count?: number;
    };
  };
}
export interface Readiness {
  benchmark: BenchmarkStatus;
  benchmarks?: { regression?: BenchmarkStatus; challenge?: BenchmarkStatus };
  submissions: SubmissionState[];
  publication: { state: string; message: string };
  demo: { total_seconds: number; steps: { seconds: number; title: string; detail: string }[] };
}

declare global {
  interface Window {
    CQA_CONFIG?: { apiBase?: string; mount?: string; embedded?: boolean };
  }
}
