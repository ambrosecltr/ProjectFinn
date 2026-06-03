// ---------------------------------------------------------------------------
// Core types shared across all Finn packages
// ---------------------------------------------------------------------------

// --- Process types ---

export type ProcessType = "hot-path" | "worker" | "compactor";

export type WorkerType = "general" | "pattern_management" | "pattern_worker" | "reminder";

export type WorkerState = "created" | "running" | "done" | "failed" | "cancelled";

// --- Message sources ---

export type MessageSource = "user" | "worker" | "trigger";

export type ConversationMessageSource = MessageSource | "system";

export type TapbackType = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export type ConnectorPermissionMode = "read_only" | "all";

// --- Tenancy ---

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinnUserRecord {
  id: string;
  tenantId: string;
  phoneNumber: string;
  displayName: string | null;
  timezone: string;
  location: string | null;
  identity: string;
  kidsMode: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserTimezoneSource = "server" | "browser" | "manual";

export interface UserContext {
  tenantId: string;
  userId: string;
  phoneNumber: string;
  displayName?: string | null;
  timezone: string;
  timezoneSource: UserTimezoneSource;
  location?: string | null;
  kidsMode: boolean;
}

// --- Inbound messages ---

export interface Attachment {
  id: string;
  url: string;
  mimeType: string;
  filename: string;
  size?: number;
  data?: Buffer;
  fileId?: string;
  storagePath?: string;
  originalUrl?: string;
  contextText?: string;
  audioKind?: "voice_note" | "audio";
}

export interface UserMessage {
  source: "user";
  tenantId: string;
  userId: string;
  phoneNumber: string;
  content: string;
  attachments?: Attachment[];
  context?: {
    myDayHandoffTodoId?: string;
  };
  messageId: string;
  replyToMessageId?: string;
  timestamp: Date;
  parts?: UserMessagePart[];
}

export interface UserMessagePart {
  content: string;
  attachments?: Attachment[];
  messageId: string;
  replyToMessageId?: string;
  timestamp: Date;
}

export interface WorkerResult {
  summary: string;
  data?: unknown;
  error?: string;
}

export type WorkerOriginSource = "user" | "pattern" | "trigger";

export interface WorkerRunMessage {
  role: string;
  content: unknown;
}

export interface PatternNotifyOutcome {
  notify: boolean;
  summary: string;
  reason?: string;
  data?: unknown;
}

export interface PatternReminderContext {
  reminderText: string;
  reason: string;
  supportingContext?: string | null;
}

export interface WorkerMessage {
  source: "worker";
  tenantId: string;
  userId: string;
  workerId: string;
  task: string;
  result: WorkerResult;
  originSource?: WorkerOriginSource;
  originMessageId?: string | null;
  pattern?: {
    id: string;
    name: string;
    triggeredBy: PatternRunTrigger;
    triggerPayload?: Record<string, unknown> | null;
    notifyOutcome?: PatternNotifyOutcome | null;
    surfacedAt?: Date | null;
  };
}

export interface TriggerMessage {
  source: "trigger";
  tenantId: string;
  userId: string;
  triggerId: string;
  triggerType: string;
  details: Record<string, unknown>;
}

export type InboundMessage =
  | UserMessage
  | WorkerMessage
  | TriggerMessage;

// --- Event bus ---

export type ProcessEvent =
  | { type: "worker_started"; tenantId: string; userId: string; workerId: string; task: string }
  | { type: "worker_status"; tenantId: string; userId: string; workerId: string; status: string; detail: string }
  | {
      type: "worker_completed";
      tenantId: string;
      userId: string;
      workerId: string;
      task: string;
      result: WorkerResult;
      patternNotifyOutcome?: PatternNotifyOutcome;
      source?: "user" | "pattern";
      originSource?: WorkerOriginSource;
      originMessageId?: string | null;
    }
  | {
      type: "worker_failed";
      tenantId: string;
      userId: string;
      workerId: string;
      task: string;
      error: string;
      source?: "user" | "pattern";
      originSource?: WorkerOriginSource;
      originMessageId?: string | null;
    }
  | { type: "worker_cancelled"; tenantId: string; userId: string; workerId: string; task?: string; source?: "user" | "pattern"; originMessageId?: string | null; reason?: string }
  | { type: "compaction_complete"; tenantId: string; userId: string; turnsSummarized: number }
  | { type: "trigger_received"; tenantId: string; userId: string; triggerId: string; triggerType: string; details: Record<string, unknown>; urgent: boolean }
  | { type: "connector_enabled"; tenantId: string; userId: string; triggerId: string; toolkitSlug: string; toolkitName?: string; connectedAccountId?: string; connectionStatus?: string }
  | { type: "reminder_triggered"; tenantId: string; userId: string; patternId: string; patternName: string; runId: string; triggeredBy: PatternRunTrigger; triggerPayload?: Record<string, unknown> | null; reminder: PatternReminderContext; summary: string }
  | { type: "pattern_run_started"; tenantId: string; userId: string; patternId: string; runId: string; workerId: string }
  | { type: "pattern_run_completed"; tenantId: string; userId: string; patternId: string; patternName: string; runId: string; workerId: string; task: string; triggeredBy: PatternRunTrigger; triggerPayload?: Record<string, unknown> | null; result: WorkerResult; notifyOutcome: PatternNotifyOutcome }
  | { type: "pattern_run_failed"; tenantId: string; userId: string; patternId: string; runId: string; workerId?: string; error: string }
  | ActivityFeedEvent
  | { type: "hot_path_turn"; tenantId: string; userId: string; source: MessageSource; messageId: string };

// --- Status block (injected into hot path context) ---

export interface StatusBlock {
  activeWorkers: Array<{
    id: string;
    task: string;
    status: string;
    startedAt: Date;
  }>;
  followUpWorkers: Array<{
    id: string;
    task: string;
    status: string;
    completedAt: Date;
    expiresAt: Date;
  }>;
  pendingConfirmations: Array<{
    id: string;
    type: "email_draft" | "calendar_event" | "other";
    summary: string;
  }>;
  activePatterns: number;
  myDay?: {
    userLocalDate: string;
    summary: string | null;
    todos: Array<{
      id: string;
      title: string;
      status: Extract<MyDayTodoStatus, "open" | "done">;
      handoffWorkerId: string | null;
    }>;
  };
  activePatternSummaries?: Array<{
    id: string;
    name: string;
    workerType: WorkerType;
    triggerType: PatternTriggerType;
    scheduleType: PatternSchedule["kind"] | null;
    nextRunAt: Date | null;
    userDescription: string | null;
  }>;
}

// --- Patterns ---

export type PatternTriggerType = "schedule" | "composio";

export type PatternRunTrigger = PatternTriggerType | "manual";

export type PatternRunState = "queued" | "running" | "done" | "failed" | "cancelled";

export type PatternRunSkipReason = "trigger_filter_no_match";

export interface PatternComposioConnectorScope {
  toolkitSlug: string;
  connectedAccountId?: string;
  allowedTools?: string[];
}

export type PatternConnectorIssueReason = "disconnected" | "account_replaced";

export interface PatternConnectorIssue {
  type: "composio_connector_unavailable";
  toolkitSlug: string;
  connectedAccountId?: string;
  reason: PatternConnectorIssueReason;
  pausedAt: string;
  resumeOnReconnect: boolean;
}

export interface PatternConnectorScope {
  composio: PatternComposioConnectorScope[];
  mcpServerIds: string[];
  issues?: PatternConnectorIssue[];
}

export type PatternTriggerFilterOperator = "equals" | "not_equals" | "contains" | "exists";

export interface PatternTriggerFilter {
  path: string;
  operator: PatternTriggerFilterOperator;
  value?: string | number | boolean | null;
}

export type PatternNotifyCondition =
  | { type: "always" }
  | { type: "never" }
  | { type: "worker_decision"; instruction: string };

export interface PatternRunToolScope {
  connectorScope: PatternConnectorScope;
}

export type PatternWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface OncePatternSchedule {
  kind: "once";
  localDateTime: string;
}

export interface IntervalPatternSchedule {
  kind: "interval";
  every: number;
  unit: "minutes" | "hours" | "days";
  anchorLocalDateTime?: string;
}

export interface DailyPatternSchedule {
  kind: "daily";
  time: string;
  startDate?: string;
}

export interface WeeklyPatternSchedule {
  kind: "weekly";
  daysOfWeek: PatternWeekday[];
  time: string;
  startDate?: string;
}

export interface MonthlyPatternSchedule {
  kind: "monthly";
  dayOfMonth: number | "last";
  time: string;
  startDate?: string;
}

export interface InternalCronPatternSchedule {
  kind: "internal_cron";
  expression: string;
  oneShot?: boolean;
}

export type PatternSchedule =
  | OncePatternSchedule
  | IntervalPatternSchedule
  | DailyPatternSchedule
  | WeeklyPatternSchedule
  | MonthlyPatternSchedule
  | InternalCronPatternSchedule;

export interface SchedulePatternTriggerConfig {
  type: "schedule";
  schedule: PatternSchedule;
  timezoneSource?: "user" | "fixed";
}

export interface ComposioPatternTriggerConfig {
  type: "composio";
  toolkitSlug: string;
  triggerSlug: string;
  connectedAccountId: string;
  triggerId?: string;
  triggerConfig?: Record<string, unknown>;
}

export type PatternTriggerConfig = SchedulePatternTriggerConfig | ComposioPatternTriggerConfig;

export interface PatternRecord {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string | null;
  userDescription: string | null;
  triggerType: PatternTriggerType;
  triggerConfig: PatternTriggerConfig;
  connectorScope: PatternConnectorScope;
  triggerFilters: PatternTriggerFilter[];
  notifyCondition: PatternNotifyCondition;
  workerType: WorkerType;
  taskPrompt: string;
  reminderContext: PatternReminderContext | null;
  timezone: string;
  active: boolean;
  failureCount: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ActivityFeedEntityType = "pattern";

export type ActivityFeedPatternAction = "created" | "edited" | "paused" | "resumed" | "deleted";

export interface ActivityFeedPatternDetails {
  patternId: string;
  patternName: string;
  workerType: WorkerType;
  triggerType: PatternTriggerType;
  active: boolean;
  userDescription: string | null;
  nextRunAt: string | null;
}

export type ActivityFeedEvent = {
  type: "activity_feed_event";
  tenantId: string;
  userId: string;
  eventId: string;
  occurredAt: string;
  source: "finn";
  origin: "hot_path" | "pattern_management" | "web" | "system";
  entityType: "pattern";
  action: ActivityFeedPatternAction;
  summary: string;
  details: ActivityFeedPatternDetails;
};

export interface PatternRunRecord {
  id: string;
  tenantId: string;
  userId: string;
  patternId: string;
  triggeredBy: PatternRunTrigger;
  triggerPayload: Record<string, unknown> | null;
  workerId: string | null;
  state: PatternRunState;
  result: WorkerResult | null;
  error: string | null;
  skipReason: PatternRunSkipReason | null;
  notifyOutcome: PatternNotifyOutcome | null;
  surfacedAt: Date | null;
  toolScope: PatternRunToolScope | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

// --- My Day ---

export type MyDayTodoStatus = "open" | "done" | "archived" | "deleted";

export type MyDayTodoSourceType = "user" | "assistant" | "worker" | "pattern" | "my_day_refresh";

export interface MyDayTodoSource {
  type: MyDayTodoSourceType;
  id?: string;
  label?: string;
  evidence?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type AutomationRunType = "my_day_refresh" | "personal_intelligence";

export type AutomationRunState = "running" | "done" | "failed";

export interface AutomationRunRecord {
  id: string;
  tenantId: string;
  userId: string;
  runType: AutomationRunType;
  state: AutomationRunState;
  userLocalDate: string | null;
  toolkitSlug: string | null;
  accountScopeId: string | null;
  connectedAccountId: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  contributorStatus: Record<string, unknown> | null;
  resultSummary: string | null;
  acceptedTodoIds: string[] | null;
  retainedDocumentIds: string[] | null;
  skippedReasons: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface PersonalIntelligenceCheckpointRecord {
  id: string;
  tenantId: string;
  userId: string;
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
  sourceType: string;
  coverageStart: Date | null;
  coverageEnd: Date | null;
  lastProcessedSourceTimestamp: Date | null;
  sourceCursor: string | null;
  initialBackfillCompletedAt: Date | null;
  lastSuccessfulRunId: string | null;
  lastExploredEntities: Record<string, unknown>[] | null;
  knownGaps: Record<string, unknown>[] | null;
  handoffSummary: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MyDayRecord {
  id: string;
  tenantId: string;
  userId: string;
  userLocalDate: string;
  timezone: string;
  summary: string | null;
  sourceSummary: string | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MyDayTodoRecord {
  id: string;
  tenantId: string;
  userId: string;
  myDayId: string;
  title: string;
  notes: string | null;
  status: MyDayTodoStatus;
  source: MyDayTodoSource | null;
  handoffAt: Date | null;
  handoffWorkerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  deletedAt: Date | null;
}

// --- Conversation ---

export interface ConversationTurn {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  source: ConversationMessageSource;
  toolCalls?: unknown[];
  tokenEstimate: number;
  createdAt: Date;
}

export interface ConversationRecord {
  id: string;
  tenantId: string;
  userId: string;
  rootConversationId: string;
  previousConversationId: string | null;
  chapterIndex: number;
  userLocalDate: string;
  handoffSummary: string | null;
  startedAt: Date;
  lastMessageAt: Date;
  active: boolean;
  archivedAt: Date | null;
}

// --- Worker manager callbacks (used by tools to interact with worker system) ---

export interface SpawnWorkerOpts {
  tenantId: string;
  userId: string;
  task: string;
  /** Existing completed worker to resume for a short follow-up window. */
  workerId?: string;
  type?: WorkerType;
  context?: string;
  parentConversationId?: string;
  /** Worker runtime mode and delivery path */
  source?: "user" | "pattern";
  /** Original hot-path source that requested this worker, used for downstream tool policy */
  originSource?: WorkerOriginSource;
  pattern?: {
    patternId: string;
    runId?: string;
    connectorScope: PatternConnectorScope;
  };
  originMessageId?: string;
}

/** Spawns a background worker and returns the worker ID */
export type SpawnWorkerFn = (opts: SpawnWorkerOpts) => Promise<string>;

/** Updates a running worker's status (progress or final outcome) */
export type UpdateWorkerStatusFn = (
  workerId: string,
  kind: "working" | "outcome",
  detail: string | WorkerResult | PatternNotifyOutcome,
) => Promise<void>;

// --- Worker record ---

export interface WorkerRecord {
  id: string;
  tenantId: string;
  userId: string;
  type: WorkerType;
  task: string;
  state: WorkerState;
  runSequence: number;
  statusDetail: string | null;
  toolCallsUsed: number;
  result: WorkerResult | null;
  modelMessages: WorkerRunMessage[] | null;
  followUpExpiresAt: Date | null;
  parentConversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  originMessageId?: string | null;
  completionDeliveredAt?: Date | null;
}
