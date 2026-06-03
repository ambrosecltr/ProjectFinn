// ---------------------------------------------------------------------------
// @finn/core — public API
// ---------------------------------------------------------------------------

// Config
export { buildCapabilities, loadConfig, loadIdentityFile, requiredComposioToolkits, resetConfig } from "./config.js";
export type { AppConfig, MemoryMode, MemoryProvider } from "./config.js";
export { publicPatternScheduleSchema } from "./schedules.js";
export type { PublicPatternSchedule } from "./schedules.js";
export { sanitizePostgresJson, sanitizePostgresJsonValue, sanitizePostgresText } from "./postgres-json.js";
export type { PostgresJsonSanitizationResult } from "./postgres-json.js";

// Types
export type {
  ProcessType,
  WorkerType,
  WorkerState,
  MessageSource,
  ConversationMessageSource,
  TapbackType,
  ConnectorPermissionMode,
  TenantRecord,
  FinnUserRecord,
  UserContext,
  UserTimezoneSource,
  Attachment,
  UserMessage,
  UserMessagePart,
  WorkerResult,
  WorkerRunMessage,
  WorkerMessage,
  TriggerMessage,
  InboundMessage,
  ProcessEvent,
  StatusBlock,
  PatternTriggerType,
  PatternRunTrigger,
  PatternRunState,
  PatternRunSkipReason,
  PatternComposioConnectorScope,
  PatternConnectorIssue,
  PatternConnectorIssueReason,
  PatternConnectorScope,
  PatternTriggerFilterOperator,
  PatternTriggerFilter,
  PatternNotifyCondition,
  PatternNotifyOutcome,
  PatternReminderContext,
  PatternRunToolScope,
  PatternWeekday,
  PatternSchedule,
  OncePatternSchedule,
  IntervalPatternSchedule,
  DailyPatternSchedule,
  WeeklyPatternSchedule,
  MonthlyPatternSchedule,
  InternalCronPatternSchedule,
  SchedulePatternTriggerConfig,
  ComposioPatternTriggerConfig,
  PatternTriggerConfig,
  PatternRecord,
  ActivityFeedEntityType,
  ActivityFeedPatternAction,
  ActivityFeedPatternDetails,
  ActivityFeedEvent,
  PatternRunRecord,
  AutomationRunRecord,
  AutomationRunState,
  AutomationRunType,
  PersonalIntelligenceCheckpointRecord,
  MyDayRecord,
  MyDayTodoRecord,
  MyDayTodoSource,
  MyDayTodoSourceType,
  MyDayTodoStatus,
  ConversationTurn,
  ConversationRecord,
  WorkerRecord,
  WorkerOriginSource,
  SpawnWorkerOpts,
  SpawnWorkerFn,
  UpdateWorkerStatusFn,
} from "./types.js";

// Errors
export {
  FinnError,
  ConfigError,
  DatabaseError,
  LLMError,
  MessagingError,
  WorkerError,
  ToolError,
  WebhookError,
  MemoryError,
  ContextError,
  IntegrationError,
  StorageError,
} from "./errors.js";

// Logger
export {
  logger,
  createLogger,
  createProcessLogger,
  hotPathLogger,
  workerLogger,
  compactorLogger,
} from "./logger.js";

// Utilities
export {
  generateId,
  sleep,
  randomBetween,
  estimateTokens,
  truncate,
  formatInternalMessage,
  formatComposioUserId,
  formatUserProfileContext,
  EventBus,
} from "./utils.js";
export { normalizeOutgoingAssistantText } from "./text.js";
export { normalizePhoneNumber } from "./phone.js";
export { isValidTimeZone, listSupportedTimeZones, resolveTimeZone } from "./timezone.js";
export { RateLimiter, type RateLimiterOpts } from "./rate-limiter.js";

// Tracing (OpenTelemetry)
export { getTracer, withSpan, SpanStatusCode } from "./tracing.js";
export type { Span, Tracer } from "./tracing.js";
export {
  createFinnTelemetry,
  createFinnTelemetryContext,
  isFinnTelemetryEnabled,
  setFinnTelemetrySpanAttributes,
} from "./telemetry.js";
export type { FinnTelemetryContext, FinnTelemetryInput } from "./telemetry.js";
export {
  activeToolNamesForCategories,
  toolCategoriesForName,
  toolCategoryTools,
  toolNamesForCategories,
} from "./tool-categories.js";
export type { ToolCategory, ToolName } from "./tool-categories.js";
export { WorkerToolOutputArtifactStore } from "./worker-tool-output-artifacts.js";
export type {
  WorkerToolOutputArtifact,
  WorkerToolOutputArtifactStoreOptions,
  WriteWorkerToolOutputArtifactOptions,
} from "./worker-tool-output-artifacts.js";

// PostHog AI SDK telemetry bootstrap (import early — activates only when configured)
export { otelSdk } from "./otel-bootstrap.js";
