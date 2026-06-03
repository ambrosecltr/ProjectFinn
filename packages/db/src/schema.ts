import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  ConversationRecord,
  ConversationTurn,
  ConversationMessageSource,
  AutomationRunRecord,
  AutomationRunState,
  AutomationRunType,
  ConnectorPermissionMode,
  FinnUserRecord,
  PersonalIntelligenceCheckpointRecord,
  PatternRecord,
  PatternConnectorScope,
  PatternNotifyCondition,
  PatternNotifyOutcome,
  PatternReminderContext,
  PatternRunRecord,
  PatternRunSkipReason,
  PatternRunState,
  PatternRunToolScope,
  PatternRunTrigger,
  PatternTriggerFilter,
  PatternTriggerConfig,
  PatternTriggerType,
  MyDayRecord,
  MyDayTodoRecord,
  MyDayTodoSource,
  MyDayTodoStatus,
  ProcessEvent,
  TenantRecord,
  WorkerRecord,
  WorkerResult,
  WorkerRunMessage,
  WorkerState,
  WorkerType,
} from "@finn/core";

export type ConversationMetadata = Record<string, unknown>;
export type ConversationRole = ConversationTurn["role"];
export type ConversationChapterMetadata = ConversationMetadata & {
  channel?: string;
};

const conversationRoles = ["user", "assistant", "system"] as const satisfies readonly ConversationRole[];
const messageSources = ["user", "worker", "trigger", "system"] as const satisfies readonly ConversationMessageSource[];
const workerTypes = ["general", "pattern_management", "pattern_worker", "reminder"] as const satisfies readonly WorkerType[];
const workerStates = ["created", "running", "done", "failed", "cancelled"] as const satisfies readonly WorkerState[];
const automationRunTypes = ["my_day_refresh", "personal_intelligence"] as const satisfies readonly AutomationRunType[];
const automationRunStates = ["running", "done", "failed"] as const satisfies readonly AutomationRunState[];
const patternTriggerTypes = ["schedule", "composio"] as const satisfies readonly PatternTriggerType[];
const patternRunTriggers = ["schedule", "composio", "manual"] as const satisfies readonly PatternRunTrigger[];
const patternRunStates = ["queued", "running", "done", "failed", "cancelled"] as const satisfies readonly PatternRunState[];
const myDayTodoStatuses = ["open", "done", "archived", "deleted"] as const satisfies readonly MyDayTodoStatus[];

export const roleEnum = pgEnum("message_role", conversationRoles);
export const sourceEnum = pgEnum("message_source", messageSources);
export const workerTypeEnum = pgEnum("worker_type", workerTypes);
export const workerStateEnum = pgEnum("worker_state", workerStates);
export const automationRunTypeEnum = pgEnum("automation_run_type", automationRunTypes);
export const automationRunStateEnum = pgEnum("automation_run_state", automationRunStates);
export const patternTriggerTypeEnum = pgEnum("pattern_trigger_type", patternTriggerTypes);
export const patternRunTriggerEnum = pgEnum("pattern_run_trigger", patternRunTriggers);
export const patternRunStateEnum = pgEnum("pattern_run_state", patternRunStates);
export const myDayTodoStatusEnum = pgEnum("my_day_todo_status", myDayTodoStatuses);

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  phoneNumber: text("phone_number").notNull(),
  displayName: text("display_name"),
  timezone: text("timezone").notNull().default("UTC"),
  location: text("location"),
  identity: text("identity").notNull().default(""),
  kidsMode: boolean("kids_mode").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  tenantIdIdx: index("users_tenant_id_idx").on(table.tenantId),
  phoneNumberUniqueIdx: uniqueIndex("users_tenant_phone_number_unique_idx").on(table.tenantId, table.phoneNumber),
}));

export const webLoginCodes = pgTable("web_login_codes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  phoneNumber: text("phone_number").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  phoneIdx: index("web_login_codes_phone_idx").on(table.tenantId, table.phoneNumber),
  expiresAtIdx: index("web_login_codes_expires_at_idx").on(table.expiresAt),
}));

export const webSessions = pgTable("web_sessions", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  tokenHashUniqueIdx: uniqueIndex("web_sessions_token_hash_unique_idx").on(table.tokenHash),
  userIdx: index("web_sessions_user_idx").on(table.tenantId, table.userId),
  expiresAtIdx: index("web_sessions_expires_at_idx").on(table.expiresAt),
}));

export const userChannels = pgTable("user_channels", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  externalAddress: text("external_address").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  userIdIdx: index("user_channels_user_id_idx").on(table.userId),
  addressUniqueIdx: uniqueIndex("user_channels_provider_address_unique_idx").on(table.tenantId, table.provider, table.externalAddress),
}));

export const userConnectorConfigs = pgTable("user_connector_configs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  toolkitSlug: text("toolkit_slug").notNull(),
  toolkitName: text("toolkit_name"),
  connected: boolean("connected").notNull().default(false),
  connectedAccountId: text("connected_account_id"),
  connectionStatus: text("connection_status"),
  permissionMode: text("permission_mode").$type<ConnectorPermissionMode>().notNull().default("all"),
  myDayEnabled: boolean("my_day_enabled").notNull().default(false),
  personalIntelligenceEnabled: boolean("personal_intelligence_enabled").notNull().default(false),
  enabledTools: jsonb("enabled_tools").$type<string[]>(),
  lastNotifiedConnectedAccountId: text("last_notified_connected_account_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("user_connector_configs_owner_idx").on(table.tenantId, table.userId),
  toolkitUniqueIdx: uniqueIndex("user_connector_configs_owner_toolkit_unique_idx").on(table.tenantId, table.userId, table.toolkitSlug),
}));

export const connectorCatalog = pgTable("connector_catalog", {
  toolkitSlug: text("toolkit_slug").primaryKey(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  logoPath: text("logo_path"),
  logoUrl: text("logo_url"),
  source: text("source").$type<"admin" | "composio">().notNull().default("admin"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  sourceCheck: check("connector_catalog_source_check", sql`${table.source} IN ('admin', 'composio')`),
}));

export const personalIntelligenceAccounts = pgTable("personal_intelligence_accounts", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  toolkitSlug: text("toolkit_slug").notNull(),
  accountScopeId: text("account_scope_id").notNull(),
  providerAccountType: text("provider_account_type").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  providerWorkspaceType: text("provider_workspace_type"),
  providerWorkspaceId: text("provider_workspace_id"),
  currentConnectedAccountId: text("current_connected_account_id"),
  identityStatus: text("identity_status").$type<"resolved" | "pending" | "failed" | "unsupported">().notNull(),
  displayName: text("display_name"),
  email: text("email"),
  handle: text("handle"),
  verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("personal_intelligence_accounts_owner_idx").on(table.tenantId, table.userId),
  scopeUniqueIdx: uniqueIndex("personal_intelligence_accounts_scope_unique_idx").on(table.tenantId, table.userId, table.toolkitSlug, table.accountScopeId),
  currentConnectedAccountIdx: index("personal_intelligence_accounts_current_connected_idx").on(table.tenantId, table.userId, table.toolkitSlug, table.currentConnectedAccountId),
}));

export const myDayEntries = pgTable("my_day_entries", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  userLocalDate: text("user_local_date").notNull(),
  timezone: text("timezone").notNull(),
  summary: text("summary"),
  sourceSummary: text("source_summary"),
  lastRefreshedAt: timestamp("last_refreshed_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("my_day_entries_owner_idx").on(table.tenantId, table.userId),
  ownerDateUniqueIdx: uniqueIndex("my_day_entries_owner_date_unique_idx").on(table.tenantId, table.userId, table.userLocalDate),
  idOwnerUniqueIdx: uniqueIndex("my_day_entries_id_owner_unique_idx").on(table.id, table.tenantId, table.userId),
}));

export const myDayTodos = pgTable("my_day_todos", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  myDayId: text("my_day_id").notNull(),
  title: text("title").notNull(),
  notes: text("notes"),
  status: myDayTodoStatusEnum("status").notNull().default("open"),
  source: jsonb("source").$type<MyDayTodoSource>(),
  handoffAt: timestamp("handoff_at", { mode: "date", withTimezone: true }),
  handoffWorkerId: text("handoff_worker_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
}, (table) => ({
  ownerIdx: index("my_day_todos_owner_idx").on(table.tenantId, table.userId),
  dayIdx: index("my_day_todos_day_idx").on(table.myDayId),
  workerIdx: index("my_day_todos_handoff_worker_idx").on(table.handoffWorkerId),
  ownerDayFk: foreignKey({
    columns: [table.myDayId, table.tenantId, table.userId],
    foreignColumns: [myDayEntries.id, myDayEntries.tenantId, myDayEntries.userId],
    name: "my_day_todos_owner_day_fk",
  }),
}));

export const automationRuns = pgTable("automation_runs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  runType: automationRunTypeEnum("run_type").notNull(),
  state: automationRunStateEnum("state").notNull(),
  userLocalDate: text("user_local_date"),
  toolkitSlug: text("toolkit_slug"),
  accountScopeId: text("account_scope_id"),
  connectedAccountId: text("connected_account_id"),
  windowStart: timestamp("window_start", { mode: "date", withTimezone: true }),
  windowEnd: timestamp("window_end", { mode: "date", withTimezone: true }),
  contributorStatus: jsonb("contributor_status").$type<Record<string, unknown>>(),
  resultSummary: text("result_summary"),
  acceptedTodoIds: jsonb("accepted_todo_ids").$type<string[]>(),
  retainedDocumentIds: jsonb("retained_document_ids").$type<string[]>(),
  skippedReasons: jsonb("skipped_reasons").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
}, (table) => ({
  ownerIdx: index("automation_runs_owner_idx").on(table.tenantId, table.userId),
  typeCreatedIdx: index("automation_runs_type_created_idx").on(table.runType, table.createdAt),
  ownerTypeCreatedIdx: index("automation_runs_owner_type_created_idx").on(table.tenantId, table.userId, table.runType, table.createdAt),
  ownerTypeConnectorCompletedIdx: index("automation_runs_owner_type_connector_completed_idx").on(table.tenantId, table.userId, table.runType, table.toolkitSlug, table.connectedAccountId, table.completedAt),
  ownerTypeAccountScopeCompletedIdx: index("automation_runs_owner_type_account_scope_completed_idx").on(table.tenantId, table.userId, table.runType, table.toolkitSlug, table.accountScopeId, table.completedAt),
}));

export const personalIntelligenceSources = pgTable("personal_intelligence_sources", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  runId: text("run_id").references(() => automationRuns.id),
  toolkitSlug: text("toolkit_slug").notNull(),
  accountScopeId: text("account_scope_id").notNull(),
  connectedAccountId: text("connected_account_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceHash: text("source_hash").notNull(),
  retainedDocumentId: text("retained_document_id").notNull(),
  title: text("title"),
  sourceUrl: text("source_url"),
  sourceTimestamp: timestamp("source_timestamp", { mode: "date", withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("personal_intelligence_sources_owner_idx").on(table.tenantId, table.userId),
  ownerCreatedIdx: index("personal_intelligence_sources_owner_created_idx").on(table.tenantId, table.userId, table.createdAt),
  sourceHashIdx: index("personal_intelligence_sources_source_hash_idx").on(table.tenantId, table.userId, table.sourceHash),
  accountScopeSourceUniqueIdx: uniqueIndex("personal_intelligence_sources_account_scope_source_unique_idx").on(table.tenantId, table.userId, table.toolkitSlug, table.accountScopeId, table.sourceType, table.sourceId),
}));

export const personalIntelligenceCheckpoints = pgTable("personal_intelligence_checkpoints", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  toolkitSlug: text("toolkit_slug").notNull(),
  accountScopeId: text("account_scope_id").notNull(),
  connectedAccountId: text("connected_account_id").notNull(),
  sourceType: text("source_type").notNull(),
  coverageStart: timestamp("coverage_start", { mode: "date", withTimezone: true }),
  coverageEnd: timestamp("coverage_end", { mode: "date", withTimezone: true }),
  lastProcessedSourceTimestamp: timestamp("last_processed_source_timestamp", { mode: "date", withTimezone: true }),
  sourceCursor: text("source_cursor"),
  initialBackfillCompletedAt: timestamp("initial_backfill_completed_at", { mode: "date", withTimezone: true }),
  lastSuccessfulRunId: text("last_successful_run_id").references(() => automationRuns.id),
  lastExploredEntities: jsonb("last_explored_entities").$type<Record<string, unknown>[]>(),
  knownGaps: jsonb("known_gaps").$type<Record<string, unknown>[]>(),
  handoffSummary: text("handoff_summary"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("personal_intelligence_checkpoints_owner_idx").on(table.tenantId, table.userId),
  ownerAccountScopeUniqueIdx: uniqueIndex("personal_intelligence_checkpoints_owner_account_scope_unique_idx").on(table.tenantId, table.userId, table.toolkitSlug, table.accountScopeId, table.sourceType),
}));

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  transport: jsonb("transport").$type<Record<string, unknown>>().notNull(),
  alwaysOn: boolean("always_on").notNull().default(true),
  active: boolean("active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("mcp_servers_owner_idx").on(table.tenantId, table.userId),
  nameUniqueIdx: uniqueIndex("mcp_servers_owner_name_unique_idx").on(table.tenantId, table.userId, table.name),
}));

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  rootConversationId: text("root_conversation_id").notNull(),
  previousConversationId: text("previous_conversation_id"),
  chapterIndex: integer("chapter_index").notNull().default(1),
  userLocalDate: text("user_local_date").notNull(),
  handoffSummary: text("handoff_summary"),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull(),
  lastMessageAt: timestamp("last_message_at", { mode: "date", withTimezone: true }).notNull(),
  active: boolean("active").notNull().default(true),
  archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
  metadata: jsonb("metadata").$type<ConversationChapterMetadata>(),
}, (table) => ({
  ownerIdx: index("conversations_owner_idx").on(table.tenantId, table.userId),
  rootConversationIdIdx: index("conversations_root_conversation_id_idx").on(table.rootConversationId),
  activeIdx: index("conversations_active_idx").on(table.tenantId, table.userId, table.active),
  userLocalDateIdx: index("conversations_user_local_date_idx").on(table.userLocalDate),
}));

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: roleEnum("role").notNull(),
    content: text("content").notNull(),
    source: sourceEnum("source").notNull(),
    sourceMessageId: text("source_message_id"),
    toolCalls: jsonb("tool_calls").$type<ConversationTurn["toolCalls"]>(),
    tokenEstimate: integer("token_estimate").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    compacted: boolean("compacted").notNull().default(false),
    compactionGroup: text("compaction_group"),
  },
  (table) => ({
    ownerIdx: index("messages_owner_idx").on(table.tenantId, table.userId),
    conversationIdIdx: index("messages_conversation_id_idx").on(table.conversationId),
    sourceMessageIdIdx: index("messages_source_message_id_idx").on(table.tenantId, table.userId, table.sourceMessageId),
  }),
);

export const workers = pgTable(
  "workers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    userId: text("user_id").notNull().references(() => users.id),
    type: workerTypeEnum("type").notNull(),
    task: text("task").notNull(),
    state: workerStateEnum("state").notNull(),
    runSequence: integer("run_sequence").notNull().default(1),
    originMessageId: text("origin_message_id"),
    completionDeliveredAt: timestamp("completion_delivered_at", { mode: "date", withTimezone: true }),
    statusDetail: text("status_detail"),
    toolCallsUsed: integer("tool_calls_used").notNull().default(0),
    result: jsonb("result").$type<WorkerResult>(),
    modelMessages: jsonb("model_messages").$type<WorkerRunMessage[]>(),
    followUpExpiresAt: timestamp("follow_up_expires_at", { mode: "date", withTimezone: true }),
    parentConversationId: text("parent_conversation_id").references(() => conversations.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    ownerIdx: index("workers_owner_idx").on(table.tenantId, table.userId),
    originMessageIdIdx: index("workers_origin_message_id_idx").on(table.tenantId, table.userId, table.originMessageId),
    stateIdx: index("workers_state_idx").on(table.tenantId, table.userId, table.state),
    followUpExpiresAtIdx: index("workers_follow_up_expires_at_idx").on(table.tenantId, table.userId, table.followUpExpiresAt),
  }),
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    userId: text("user_id").references(() => users.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<ProcessEvent>().notNull(),
    processed: boolean("processed").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (table) => ({
    ownerIdx: index("events_owner_idx").on(table.tenantId, table.userId),
    processedIdx: index("events_processed_idx").on(table.processed),
  }),
);

export const patterns = pgTable("patterns", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  userDescription: text("user_description"),
  triggerType: patternTriggerTypeEnum("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config").$type<PatternTriggerConfig>().notNull(),
  connectorScope: jsonb("connector_scope").$type<PatternConnectorScope>().notNull(),
  triggerFilters: jsonb("trigger_filters").$type<PatternTriggerFilter[]>().notNull(),
  notifyCondition: jsonb("notify_condition").$type<PatternNotifyCondition>().notNull(),
  workerType: workerTypeEnum("worker_type").notNull(),
  taskPrompt: text("task_prompt").notNull(),
  reminderContext: jsonb("reminder_context").$type<PatternReminderContext>(),
  timezone: text("timezone").notNull().default("UTC"),
  active: boolean("active").notNull().default(true),
  failureCount: integer("failure_count").notNull().default(0),
  lastRunAt: timestamp("last_run_at", { mode: "date", withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("patterns_owner_idx").on(table.tenantId, table.userId),
  dueIdx: index("patterns_due_idx").on(table.active, table.nextRunAt),
  composioTriggerIdx: index("patterns_composio_trigger_idx").using("btree", sql`(${table.triggerConfig}->>'triggerId')`),
  connectedAccountIdx: index("patterns_connected_account_idx").using("btree", sql`(${table.triggerConfig}->>'connectedAccountId')`),
}));

export const patternRuns = pgTable("pattern_runs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  patternId: text("pattern_id").notNull().references(() => patterns.id, { onDelete: "cascade" }),
  triggeredBy: patternRunTriggerEnum("triggered_by").notNull(),
  triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
  workerId: text("worker_id").references(() => workers.id),
  state: patternRunStateEnum("state").notNull(),
  result: jsonb("result").$type<WorkerResult>(),
  notifyOutcome: jsonb("notify_outcome").$type<PatternNotifyOutcome>(),
  surfacedAt: timestamp("surfaced_at", { mode: "date", withTimezone: true }),
  toolScope: jsonb("tool_scope").$type<PatternRunToolScope>(),
  error: text("error"),
  skipReason: text("skip_reason").$type<PatternRunSkipReason>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
}, (table) => ({
  ownerIdx: index("pattern_runs_owner_idx").on(table.tenantId, table.userId),
  patternIdx: index("pattern_runs_pattern_idx").on(table.patternId),
  workerIdx: index("pattern_runs_worker_idx").on(table.workerId),
}));

export const fileFolders = pgTable("file_folders", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  parentId: text("parent_id"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("file_folders_owner_idx").on(table.tenantId, table.userId),
  parentIdx: index("file_folders_parent_idx").on(table.parentId),
  idOwnerUniqueIdx: uniqueIndex("file_folders_id_owner_unique_idx").on(table.id, table.tenantId, table.userId),
  rootNameUniqueIdx: uniqueIndex("file_folders_root_name_unique_idx")
    .on(table.tenantId, table.userId, table.name)
    .where(sql`${table.parentId} is null`),
  childNameUniqueIdx: uniqueIndex("file_folders_child_name_unique_idx")
    .on(table.tenantId, table.userId, table.parentId, table.name)
    .where(sql`${table.parentId} is not null`),
  ownerParentFk: foreignKey({
    columns: [table.parentId, table.tenantId, table.userId],
    foreignColumns: [table.id, table.tenantId, table.userId],
    name: "file_folders_owner_parent_fk",
  }).onDelete("cascade"),
}));

export const files = pgTable("files", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  userId: text("user_id").notNull().references(() => users.id),
  folderId: text("folder_id").references(() => fileFolders.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storage_path").notNull(),
  userVisible: boolean("user_visible").notNull().default(false),
  origin: text("origin").notNull().default("system"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => ({
  ownerIdx: index("files_owner_idx").on(table.tenantId, table.userId),
  folderIdx: index("files_folder_idx").on(table.folderId),
  ownerUpdatedIdx: index("files_owner_updated_idx").on(table.tenantId, table.userId, table.updatedAt, table.createdAt, table.id),
}));

export type Tenant = InferSelectModel<typeof tenants>;
export type NewTenant = InferInsertModel<typeof tenants>;
export type StoredTenant = InferSelectModel<typeof tenants> & TenantRecord;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type StoredUser = InferSelectModel<typeof users> & FinnUserRecord;

export type WebLoginCode = InferSelectModel<typeof webLoginCodes>;
export type NewWebLoginCode = InferInsertModel<typeof webLoginCodes>;

export type WebSession = InferSelectModel<typeof webSessions>;
export type NewWebSession = InferInsertModel<typeof webSessions>;

export type UserChannel = InferSelectModel<typeof userChannels>;
export type NewUserChannel = InferInsertModel<typeof userChannels>;

export type UserConnectorConfig = InferSelectModel<typeof userConnectorConfigs>;
export type NewUserConnectorConfig = InferInsertModel<typeof userConnectorConfigs>;
export type ConnectorCatalog = InferSelectModel<typeof connectorCatalog>;
export type NewConnectorCatalog = InferInsertModel<typeof connectorCatalog>;
export type StoredPersonalIntelligenceAccount = InferSelectModel<typeof personalIntelligenceAccounts>;
export type NewPersonalIntelligenceAccount = InferInsertModel<typeof personalIntelligenceAccounts>;

export type StoredMyDay = InferSelectModel<typeof myDayEntries> & MyDayRecord;
export type NewMyDay = InferInsertModel<typeof myDayEntries>;
export type StoredMyDayTodo = InferSelectModel<typeof myDayTodos> & MyDayTodoRecord;
export type NewMyDayTodo = InferInsertModel<typeof myDayTodos>;
export type StoredAutomationRun = InferSelectModel<typeof automationRuns> & AutomationRunRecord;
export type NewAutomationRun = InferInsertModel<typeof automationRuns>;
export type StoredPersonalIntelligenceSource = InferSelectModel<typeof personalIntelligenceSources>;
export type NewPersonalIntelligenceSource = InferInsertModel<typeof personalIntelligenceSources>;
export type StoredPersonalIntelligenceCheckpoint = InferSelectModel<typeof personalIntelligenceCheckpoints> & PersonalIntelligenceCheckpointRecord;
export type NewPersonalIntelligenceCheckpoint = InferInsertModel<typeof personalIntelligenceCheckpoints>;

export type McpServer = InferSelectModel<typeof mcpServers>;
export type NewMcpServer = InferInsertModel<typeof mcpServers>;

export type Conversation = InferSelectModel<typeof conversations>;
export type NewConversation = InferInsertModel<typeof conversations>;
export type StoredConversation = InferSelectModel<typeof conversations> & ConversationRecord;

export type Message = InferSelectModel<typeof messages>;
export type NewMessage = InferInsertModel<typeof messages>;

export type Worker = InferSelectModel<typeof workers>;
export type NewWorker = InferInsertModel<typeof workers>;

export type Event = InferSelectModel<typeof events>;
export type NewEvent = InferInsertModel<typeof events>;

export type StoredPattern = InferSelectModel<typeof patterns> & PatternRecord;
export type NewPattern = InferInsertModel<typeof patterns>;
export type StoredPatternRun = InferSelectModel<typeof patternRuns> & PatternRunRecord;
export type NewPatternRun = InferInsertModel<typeof patternRuns>;

export type StoredConversationTurn = InferSelectModel<typeof messages> & ConversationTurn;
export type StoredWorkerRecord = InferSelectModel<typeof workers> & WorkerRecord;

export type StoredFile = InferSelectModel<typeof files>;
export type NewStoredFile = InferInsertModel<typeof files>;
export type StoredFileFolder = InferSelectModel<typeof fileFolders>;
export type NewStoredFileFolder = InferInsertModel<typeof fileFolders>;
