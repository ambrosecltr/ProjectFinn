import { wrapToolsWithOutputArtifacts } from "@finn/agents";
import { createFinnTelemetry, createLogger, type AppConfig, type AutomationRunRecord, type MyDayTodoRecord, type MyDayTodoSource, type UserContext } from "@finn/core";
import type { Database } from "@finn/db";
import { getAbortErrorMessage, withLLMTimeout, type LLMManager } from "@finn/llm";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { createProcessRuntimeServices, type UserRuntimeServices } from "@finn/runtime";
import type { UserRegistry } from "./user-registry.js";
import { createSearchMemoryTool } from "./automation-memory-tools.js";
import { AutomationRunStore } from "./automation-run-store.js";
import { buildConnectorStatusItems, type AutomationSourceItem } from "./automation-sources.js";
import { MyDayStore, type MyDayPageRecord } from "./my-day-store.js";
import { createUserFilesCodeModeTools, createUserToolOutputArtifactStore } from "./tool-output-artifacts.js";
import type { UserRuntimeRegistry } from "./user-runtime.js";

const logger = createLogger("my-day-refresh");

const schedulerTickMs = 60_000;
const maxTodosFromRefresh = 5;
const maxActiveLlmTodos = 10;
const minTodoConfidence = 0.8;
const failedRefreshCooldownMs = 15 * 60 * 1000;
const recentArchivedTodoContextDays = 2;
const recentArchivedTodoContextLimit = 30;

const myDayTodoCandidateSchema = z.object({
  title: z.string().trim().min(1).max(180),
  notes: z.string().trim().max(700).optional().default(""),
  confidence: z.number().min(0).max(1),
  sourceId: z.string().trim().min(1),
  toolkitSlug: z.string().trim().min(1).max(80),
  connectedAccountId: z.string().trim().min(1).max(300).optional(),
  sourceType: z.string().trim().min(1).max(80),
  messageId: z.string().trim().min(1).max(300).optional(),
  threadId: z.string().trim().min(1).max(300).optional(),
  eventId: z.string().trim().min(1).max(300).optional(),
  timestamp: z.string().trim().min(1).max(80).optional(),
  sourceUrl: z.string().trim().min(1).max(1000).optional(),
  evidence: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
});

export type MyDayTodoCandidate = z.infer<typeof myDayTodoCandidateSchema>;

export interface MyDayRefreshResult {
  summary: string;
  sourceSummary: string;
  acceptedTodoIds: string[];
  archivedTodoIds: string[];
  skippedReasons: Record<string, unknown>;
}

export interface MyDayRefreshServiceStatus {
  enabled: boolean;
  running: boolean;
  refreshTimes: string[];
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
}

export type MyDayRefreshReason = "scheduled" | "manual";

export interface MyDayRefreshDecision {
  refresh: boolean;
  reason?: MyDayRefreshReason;
  skipReason?: "no_enabled_sources" | "already_running" | "recent_failure" | "not_due";
}

export interface MyDayDueRefreshJob {
  tenantId: string;
  userId: string;
  scheduledAt: string;
  jobKey: string;
}

export class MyDayRefreshService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastStartedAt: Date | null = null;
  private lastCompletedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly deps: {
      config: AppConfig;
      db: Database;
      llmManager: LLMManager;
      users: UserRegistry;
      runtimes: UserRuntimeRegistry;
    },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.refreshDueUsers().catch((error: unknown) => {
        this.lastError = getErrorMessage(error);
        logger.error({ error }, "My Day refresh scheduler tick failed");
      });
    }, schedulerTickMs);
    void this.refreshDueUsers();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): MyDayRefreshServiceStatus {
    return {
      enabled: true,
      running: this.running,
      refreshTimes: this.deps.config.intervals.myDayRefreshTimes.map(formatRefreshTime),
      lastStartedAt: this.lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: this.lastCompletedAt?.toISOString() ?? null,
      lastError: this.lastError,
    };
  }

  async refreshDueUsers(now = new Date()): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastStartedAt = now;
    try {
      const dueJobs = await this.listDueRefreshJobs(now);
      for (const dueJob of dueJobs) {
        try {
          const user = await this.deps.users.requireUser(dueJob.userId);
          await this.refreshDueUser(user, new Date(dueJob.scheduledAt));
        } catch (error) {
          this.lastError = getErrorMessage(error);
          logger.error({ error, tenantId: dueJob.tenantId, userId: dueJob.userId }, "My Day refresh failed for user");
        }
      }
      this.lastCompletedAt = new Date();
    } finally {
      this.running = false;
    }
  }

  async listDueRefreshJobs(now = new Date()): Promise<MyDayDueRefreshJob[]> {
    await this.failStaleRuns(now);
    const users = await this.deps.users.listExistingUsers();
    const dueJobs: MyDayDueRefreshJob[] = [];
    for (const user of users) {
      const decision = await this.shouldRefreshUser(user, now);
      if (!decision.refresh) {
        continue;
      }

      dueJobs.push({
        tenantId: user.tenantId,
        userId: user.userId,
        scheduledAt: now.toISOString(),
        jobKey: buildMyDayRefreshJobKey(user, now),
      });
    }

    return dueJobs;
  }

  async refreshDueUser(user: UserContext, scheduledAt = new Date()): Promise<{ runId: string; acceptedTodoIds: string[] } | null> {
    const decision = await this.shouldRefreshUser(user, scheduledAt);
    if (!decision.refresh) {
      return null;
    }

    return this.refreshUser(user, { now: new Date(), reason: decision.reason });
  }

  private async shouldRefreshUser(user: UserContext, now: Date): Promise<MyDayRefreshDecision> {
    const userLocalDate = getLocalDate(now, user.timezone);
    const connectors = await this.getEnabledMyDayConnectors(user);
    if (connectors.length === 0) {
      return { refresh: false, skipReason: "no_enabled_sources" };
    }

    const page = await new MyDayStore({ db: this.deps.db, user }).getForDate(userLocalDate, user.timezone);
    const latestRun = await new AutomationRunStore({ db: this.deps.db, user }).getLatestForDate("my_day_refresh", userLocalDate);
    return shouldRunMyDayRefresh({
      hasEnabledSources: connectors.length > 0,
      lastRefreshedAt: page.day.lastRefreshedAt,
      latestRun,
      now,
      timezone: user.timezone,
      refreshTimes: this.deps.config.intervals.myDayRefreshTimes,
    });
  }

  private async failStaleRuns(now: Date): Promise<void> {
    const failedCount = await new AutomationRunStore({ db: this.deps.db }).failRunningOlderThan(
      ["my_day_refresh"],
      new Date(now.getTime() - this.deps.config.backgroundLlmTimeoutMs),
      `My Day refresh exceeded ${this.deps.config.backgroundLlmTimeoutMs}ms background LLM timeout.`,
    );
    if (failedCount > 0) {
      logger.warn({ failedCount }, "Marked stale My Day refresh runs failed");
    }
  }

  async refreshUser(user: UserContext, options: { now?: Date; reason?: MyDayRefreshReason } = {}): Promise<{ runId: string; acceptedTodoIds: string[] }> {
    const now = options.now ?? new Date();
    const userLocalDate = getLocalDate(now, user.timezone);
    const runtime = await this.deps.runtimes.getAutomationRuntimeServices(user);
    const runStore = new AutomationRunStore({ db: this.deps.db, user });
    const previousRun = await runStore.getLatest("my_day_refresh");
    const previousRefreshCompletedAt = previousRun?.state === "done" ? previousRun.completedAt : null;
    const windowStart = laterDate(startOfLocalDayApprox(now, user.timezone), previousRefreshCompletedAt);
    const run = await runStore.start({
      runType: "my_day_refresh",
      userLocalDate,
      windowStart,
      windowEnd: now,
      contributorStatus: { state: "started", reason: options.reason ?? "manual" },
    });

    try {
      const store = new MyDayStore({ db: this.deps.db, user });
      const page = await store.getForDate(userLocalDate, user.timezone);
      const connectors = await this.getEnabledMyDayConnectors(user);
      const tools = await this.loadScopedComposioTools(user, connectors);
      const connectorStatusItems = buildConnectorStatusItems(connectors);
      const result = await this.synthesize(user, userLocalDate, now, previousRefreshCompletedAt, windowStart, page, connectorStatusItems, tools, store, run.id, runtime);

      await store.updateSummary(userLocalDate, user.timezone, {
        summary: result.summary,
        sourceSummary: result.sourceSummary || null,
        lastRefreshedAt: new Date(),
      });

      await runStore.complete(run.id, {
        state: "done",
        contributorStatus: buildContributorStatus(connectors.map((connector) => connector.toolkitSlug), connectorStatusItems),
        resultSummary: result.summary,
        acceptedTodoIds: result.acceptedTodoIds,
        skippedReasons: result.skippedReasons,
      });
      logger.info({ runId: run.id, tenantId: user.tenantId, userId: user.userId, acceptedTodoCount: result.acceptedTodoIds.length, archivedTodoCount: result.archivedTodoIds.length }, "My Day refresh completed");
      return { runId: run.id, acceptedTodoIds: result.acceptedTodoIds };
    } catch (error) {
      await runStore.complete(run.id, {
        state: "failed",
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  private async synthesize(
    user: UserContext,
    userLocalDate: string,
    now: Date,
    previousRefreshCompletedAt: Date | null,
    windowStart: Date,
    page: MyDayPageRecord,
    connectorStatusItems: AutomationSourceItem[],
    tools: ToolSet,
    store: MyDayStore,
    runId: string,
    runtime: UserRuntimeServices,
  ): Promise<MyDayRefreshResult> {
    const existingTodoLines = page.todos
      .filter((todo) => todo.status !== "deleted" && todo.status !== "archived")
      .map((todo) => `- ${todo.id} [${todo.status}] ${todo.title}${todo.notes ? ` (${todo.notes})` : ""}${todo.source?.type ? ` source: ${todo.source.type}` : ""}${todo.handoffAt ? " handed off" : ""}`)
      .join("\n") || "none";
    const archivedTodoLines = page.archivedTodos
      .filter((todo) => isTodoDedupeContext(todo, userLocalDate, user.timezone))
      .slice(-recentArchivedTodoContextLimit)
      .map((todo) => `- ${todo.id} ${todo.title}${todo.source?.type ? ` source: ${todo.source.type}` : ""}${todo.source?.reason ? ` reason: ${todo.source.reason}` : ""}`)
      .join("\n") || "none";
    const refreshTools = createMyDayRefreshTools({
      store,
      user,
      userLocalDate,
      page,
    });

    const processRuntime = createProcessRuntimeServices(runtime, {
      processType: "my_day",
      runId,
      filesAccess: "read",
      grants: ["memory"],
    });
    if (!processRuntime.files) {
      throw new Error("My Day files runtime is not available.");
    }
    const toolOutputArtifacts = createUserToolOutputArtifactStore(runtime, runId);
    const fileCodeModeTools = createUserFilesCodeModeTools(processRuntime as typeof processRuntime & { files: NonNullable<typeof processRuntime.files> }, {
      access: "read",
      processType: "my_day",
      artifacts: toolOutputArtifacts,
    });
    try {
      await withLLMTimeout({
        timeoutMs: this.deps.config.backgroundLlmTimeoutMs,
        timeoutMessage: `My Day refresh timed out after ${this.deps.config.backgroundLlmTimeoutMs}ms.`,
      }, (abortSignal) => generateText({
        model: this.deps.llmManager.getModel("worker"),
        system: myDayRefreshSystemPrompt,
        prompt: [
          `Current local time: ${formatLocalDateTime(now, user.timezone)}`,
          `Current UTC time: ${now.toISOString()}`,
          previousRefreshCompletedAt ? `Previous My Day refresh completed at: ${previousRefreshCompletedAt.toISOString()}` : "Previous My Day refresh completed at: never",
          `Primary inspection window starts at: ${windowStart.toISOString()}`,
          `Timezone: ${user.timezone}`,
          `Timezone source: ${user.timezoneSource}`,
          user.location ? `Location: ${user.location}` : null,
          "Current My Day summary:",
          page.day.summary || "none",
          "Existing todos:",
          existingTodoLines,
          "Open todos carry forward until completed or archived. Done todos are shown only on the local day they were completed, so any done todo listed here is same-day completion context and should not be recreated.",
          "Recent archived todo dedupe context:",
          archivedTodoLines,
          `Enabled My Day toolkits: ${connectorStatusItems.map((item) => item.toolkitSlug).join(", ") || "none"}`,
          fileCodeModeTools.summaries.length > 0 ? `Enabled Finn JS workspace toolsets: ${fileCodeModeTools.summaries.map((summary) => `${summary.slug} (${summary.effects.join("/")}): ${summary.commands.length} API(s)`).join("; ")}` : null,
          "Use search_memory when user understanding would help decide whether something matters today. Connector inspection should stay focused on the current local day and primarily on records changed since the primary inspection window unless an older source is needed to clarify today's item.",
          "Update My Day by calling update_my_day_summary. Use create_my_day_todo, edit_my_day_todo, and archive_my_day_todo only when warranted. Do not return JSON.",
        ].filter((line): line is string => line !== null).join("\n\n"),
        tools: {
          ...wrapToolsWithOutputArtifacts({
            ...fileCodeModeTools.tools,
            ...tools,
            search_memory: createSearchMemoryTool({ memory: processRuntime.memory, maxResults: 5 }),
            ...refreshTools.tools,
          }, toolOutputArtifacts),
        },
        ...this.deps.llmManager.getRequestOptions("worker", runId),
        stopWhen: stepCountIs(this.deps.llmManager.getMaxSteps("worker")),
        experimental_telemetry: createFinnTelemetry({
          functionId: "my-day.refresh",
          processType: "my_day_refresh",
          user,
          runId,
        }),
        abortSignal,
      }));
    } finally {
      await fileCodeModeTools.cleanup().catch((error: unknown) => {
        logger.warn({ error, runId }, "My Day Finn JS workspace cleanup failed");
      });
      await toolOutputArtifacts.cleanup().catch((error: unknown) => {
        logger.warn({ error, runId }, "My Day tool output artifact cleanup failed");
      });
    }

    return refreshTools.getResult();
  }

  private async getEnabledMyDayConnectors(user: UserContext) {
    const composio = await this.deps.runtimes.getComposioService(user);
    return composio?.listConfiguredConnectorConfigs({ feature: "my_day" }) ?? [];
  }

  private async loadScopedComposioTools(user: UserContext, connectors: Array<{ toolkitSlug: string; connectedAccountId: string | null }>): Promise<ToolSet> {
    const composio = await this.deps.runtimes.getComposioService(user);
    const configuredToolkits = connectors
      .filter((connector) => connector.connectedAccountId)
      .map((connector) => ({
        slug: connector.toolkitSlug,
        connectedAccountId: connector.connectedAccountId!,
        permissionMode: "read_only" as const,
      }));

    if (!composio || configuredToolkits.length === 0) {
      return {};
    }

    return composio.getToolsForConfiguredToolkits(configuredToolkits);
  }
}

function normalizeTodoCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const sourceId = typeof value.sourceId === "string"
    ? value.sourceId
    : typeof value.source_id === "string"
      ? value.source_id
      : "";
  const [toolkitFromSource, typeFromSource] = sourceId.split(":", 3);

  return {
    ...value,
    sourceId,
    toolkitSlug: value.toolkitSlug ?? value.toolkit_slug ?? (toolkitFromSource || "unknown"),
    connectedAccountId: value.connectedAccountId ?? value.connected_account_id,
    sourceType: value.sourceType ?? value.source_type ?? (typeFromSource || "record"),
    messageId: value.messageId ?? value.message_id,
    threadId: value.threadId ?? value.thread_id,
    eventId: value.eventId ?? value.event_id,
    sourceUrl: value.sourceUrl ?? value.source_url,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createMyDayRefreshTools(input: {
  store: MyDayStore;
  user: UserContext;
  userLocalDate: string;
  page: MyDayPageRecord;
}) {
  let summary = input.page.day.summary?.trim() ?? "";
  let sourceSummary = input.page.day.sourceSummary?.trim() ?? "";
  const acceptedTodoIds: string[] = [];
  const archivedTodoIds: string[] = [];
  const skippedReasons: Record<string, unknown> = {};
  const activeTodos = [...input.page.todos];
  const blockedTitles = new Set([...activeTodos, ...input.page.archivedTodos]
    .filter((todo) => isTodoDedupeContext(todo, input.userLocalDate, input.user.timezone))
    .map((todo) => normalizeTodoTitle(todo.title)));
  let activeLlmTodoCount = activeTodos.filter(isLlmCreatedOpenTodo).length;

  return {
    tools: {
      update_my_day_summary: tool({
        description: "Set the concise My Day summary after inspecting the connected sources. Use this exactly once near the end. Keep sourceSummary as a terse internal audit of meaningful sources checked.",
        inputSchema: z.object({
          summary: z.string().trim().min(1).max(900),
          sourceSummary: z.string().trim().max(1200).optional().default(""),
        }),
        execute: async ({ summary: nextSummary, sourceSummary: nextSourceSummary }) => {
          summary = nextSummary;
          sourceSummary = nextSourceSummary;
          return { ok: true };
        },
      }),
      create_my_day_todo: tool({
        description: `Create one high-value, source-backed My Day todo. This is capped to ${maxTodosFromRefresh} new todos per refresh and ${maxActiveLlmTodos} active LLM-created todos total. Prefer no todo over a noisy todo.`,
        inputSchema: myDayTodoCandidateSchema,
        execute: async (rawCandidate) => {
          const candidate = myDayTodoCandidateSchema.parse(normalizeTodoCandidate(rawCandidate));
          const sourceKey = buildTodoSourceKey(candidate);
          if (candidate.confidence < minTodoConfidence) {
            skippedReasons[sourceKey] = "confidence_below_threshold";
            return { ok: false, skipped: true, reason: "confidence_below_threshold" };
          }
          if (acceptedTodoIds.length >= maxTodosFromRefresh) {
            skippedReasons[sourceKey] = "run_todo_limit_reached";
            return { ok: false, skipped: true, reason: "run_todo_limit_reached" };
          }
          if (activeLlmTodoCount >= maxActiveLlmTodos) {
            skippedReasons[sourceKey] = "active_llm_todo_limit_reached";
            return { ok: false, skipped: true, reason: "active_llm_todo_limit_reached" };
          }

          const normalizedTitle = normalizeTodoTitle(candidate.title);
          if (blockedTitles.has(normalizedTitle)) {
            skippedReasons[sourceKey] = "duplicate_recent_todo";
            return { ok: false, skipped: true, reason: "duplicate_recent_todo" };
          }

          const todo = await input.store.createTodo(input.userLocalDate, input.user.timezone, {
            title: candidate.title,
            notes: candidate.notes || null,
            source: buildMyDayTodoSource(candidate),
          });
          acceptedTodoIds.push(todo.id);
          activeTodos.push(todo);
          blockedTitles.add(normalizedTitle);
          activeLlmTodoCount += 1;
          return { ok: true, todoId: todo.id };
        },
      }),
      edit_my_day_todo: tool({
        description: "Edit title or notes only for My Day refresh-created todos that have not been handed off. Do not edit user-created todos.",
        inputSchema: z.object({
          todoId: z.string().trim().min(1),
          title: z.string().trim().min(1).max(180).optional(),
          notes: z.string().trim().max(700).nullable().optional(),
        }).refine((value) => value.title !== undefined || value.notes !== undefined, {
          message: "Provide title or notes.",
        }),
        execute: async ({ todoId, title, notes }) => {
          const existing = activeTodos.find((todo) => todo.id === todoId);
          if (!existing) {
            skippedReasons[todoId] = "todo_not_found";
            return { ok: false, error: "todo_not_found" };
          }
          if (!canRefreshModifyTodo(existing)) {
            skippedReasons[todoId] = "todo_not_editable_by_refresh";
            return { ok: false, error: "todo_not_editable_by_refresh" };
          }
          const updated = await input.store.updateTodo(todoId, { title, notes });
          if (!updated) {
            skippedReasons[todoId] = "todo_not_found";
            return { ok: false, error: "todo_not_found" };
          }
          const index = activeTodos.findIndex((todo) => todo.id === todoId);
          if (index >= 0) {
            activeTodos[index] = updated;
          }
          return { ok: true, todoId: updated.id };
        },
      }),
      archive_my_day_todo: tool({
        description: "Archive a stale My Day refresh-created todo only when current source inspection shows it is no longer relevant. Never archive user-created todos or handed-off todos.",
        inputSchema: z.object({
          todoId: z.string().trim().min(1),
          reason: z.string().trim().min(1).max(500),
        }),
        execute: async ({ todoId, reason }) => {
          const existing = activeTodos.find((todo) => todo.id === todoId);
          if (!existing) {
            skippedReasons[todoId] = "todo_not_found";
            return { ok: false, error: "todo_not_found" };
          }
          if (!canRefreshModifyTodo(existing)) {
            skippedReasons[todoId] = "todo_not_archivable_by_refresh";
            return { ok: false, error: "todo_not_archivable_by_refresh" };
          }
          const archived = await input.store.deleteTodo(todoId);
          if (!archived) {
            skippedReasons[todoId] = "todo_not_found";
            return { ok: false, error: "todo_not_found" };
          }
          archivedTodoIds.push(archived.id);
          skippedReasons[todoId] = `archived_stale: ${reason}`;
          const index = activeTodos.findIndex((todo) => todo.id === todoId);
          if (index >= 0) {
            activeTodos[index] = archived;
          }
          if (existing.status === "open" && isLlmCreatedOpenTodo(existing)) {
            activeLlmTodoCount = Math.max(0, activeLlmTodoCount - 1);
          }
          return { ok: true, todoId: archived.id };
        },
      }),
    },
    getResult(): MyDayRefreshResult {
      const finalSummary = summary || "No meaningful day context found yet.";
      return {
        summary: finalSummary,
        sourceSummary,
        acceptedTodoIds,
        archivedTodoIds,
        skippedReasons,
      };
    },
  };
}

export function shouldRunMyDayRefresh(input: {
  hasEnabledSources: boolean;
  lastRefreshedAt: Date | null;
  latestRun: AutomationRunRecord | null;
  now: Date;
  timezone: string;
  refreshTimes: AppConfig["intervals"]["myDayRefreshTimes"];
}): MyDayRefreshDecision {
  if (!input.hasEnabledSources) {
    return { refresh: false, skipReason: "no_enabled_sources" };
  }
  if (input.latestRun?.state === "running") {
    return { refresh: false, skipReason: "already_running" };
  }
  if (input.latestRun?.state === "failed" && input.latestRun.createdAt.getTime() > input.now.getTime() - failedRefreshCooldownMs) {
    return { refresh: false, skipReason: "recent_failure" };
  }
  const currentSlot = getCurrentRefreshSlot(input.now, input.timezone, input.refreshTimes);
  if (!currentSlot) {
    return { refresh: false, skipReason: "not_due" };
  }
  if (input.lastRefreshedAt && input.lastRefreshedAt >= currentSlot.start) {
    return { refresh: false, skipReason: "not_due" };
  }
  return { refresh: true, reason: "scheduled" };
}

const myDayRefreshSystemPrompt = `You are Finn's My Day refresh process. Your job is to traverse the user's connected life for the current local day and produce a useful day summary plus only high-value todos.

How to inspect sources:
- If connector tools are available directly, use them.
- If Composio meta tools are available, first use the search tool to find the right read tools, then execute only the needed read-only tools.
- Use Finn JS workspace when a tool result includes full_output_path, tool_output_artifact.path, or a /artifacts/... path. Search for the relevant finn.files APIs with workspace_search, then inspect artifacts with workspace_execute using modest limits before finalizing.
- User workspace files use /workspace/... paths.
- Temporary run artifacts are mounted at /artifacts; use /artifacts/... paths exactly as returned by tool results.
- The files APIs accept only workspace-relative, /workspace/..., and /artifacts/... paths. /workspace may be read-only, so use /artifacts for temporary downloads or outputs when workspace writes fail.
- Use finn.files.extract for readable current-day attachment/document URLs or downloaded paths when the document itself is needed to confirm a high-value todo; extraction is local-only and can OCR scanned PDFs.
- Connector source inspection must stay anchored to the user's current local date. Prefer today's records, today's calendar events, and items with deadlines or actions due today.
- Mail tools: inspect important/unread inbox mail and recent sent mail only when it is likely to affect today. Use targeted queries and hydrate only likely high-signal messages.
- Calendar tools: inspect today's events, tomorrow morning's events, and any all-day items. Include local start/end times.
- Other connected app tools: inspect current-day or explicitly due-today actionable records only. Avoid broad exports and low-signal activity streams.
- Memory search: use search_memory for understanding the user, relationships, responsibilities, and preferences. Do not create a todo from memory alone; todos need current-day source evidence or an existing open todo.

Decision rules:
- Summary should sound natural and concise, like Finn is briefing the user. Do not mention the time of day, location, checked apps, empty/no-result sources, raw IDs, exact quoted reply instructions, or internal matter/reference numbers unless the user needs that exact detail to act.
- Prefer phrasing like "Light day today. Two things need your attention: ..." over audit-style summaries.
- Summary should explain what needs attention today in 1-3 concise sentences.
- Add a todo only for a specific, actionable, high-confidence obligation, deadline, follow-up, appointment prep, or important life/admin task.
- Favor obligations that affect the user's time, relationships, decisions, money, health, home, or active work. Skip routine account hygiene and low-impact admin unless there is a deadline, dependency, or consequence.
- Avoid creating or summarizing low-value account/security hygiene, verification emails, routine alerts, marketing, newsletters, FYIs, and generic inbox cleanup.
- Treat yesterday/older content as background unless it clearly creates an action for the current local day.
- Do not add generic todos like "check email", newsletters, marketing, FYIs, passive reading, invoices unless action is required, or low-confidence guesses.
- Open todos persist across days until completed or archived. Done todos are visible only on the local date they were completed; use visible done todos as same-day dedupe context.
- Recent archived todos are explicit dedupe context. Never recreate the same or substantially similar todo from archived context unless a clearly new source creates a materially new high-value obligation.
- Preserve user-created todos. You may edit or archive stale My Day refresh-created todos only through the provided tools, and only if they have not been handed off.
- Every todo must include toolkitSlug, sourceType, stable sourceId, evidence, and reason.
- Include connectedAccountId, messageId, threadId, eventId, timestamp, and sourceUrl whenever the app provides them.
- Do not mention empty sources, checked apps with no results, location, or time of day just to prove the check happened. Put that detail in sourceSummary if needed, not summary.
- Prefer no todo over a noisy todo.
- Update My Day with the provided tools. Do not return JSON.`;

export function buildMyDayRefreshSystemPromptForTest(): string {
  return myDayRefreshSystemPrompt;
}

function buildMyDayTodoSourceMetadata(candidate: MyDayTodoCandidate): Record<string, unknown> {
  return {
    toolkitSlug: candidate.toolkitSlug,
    sourceType: candidate.sourceType,
    ...(candidate.connectedAccountId ? { connectedAccountId: candidate.connectedAccountId } : {}),
    ...(candidate.messageId ? { messageId: candidate.messageId } : {}),
    ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
    ...(candidate.eventId ? { eventId: candidate.eventId } : {}),
    ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
  };
}

function buildMyDayTodoSource(candidate: MyDayTodoCandidate): MyDayTodoSource {
  return {
    type: "my_day_refresh",
    id: candidate.sourceId,
    label: "My Day refresh",
    evidence: candidate.evidence,
    reason: candidate.reason,
    metadata: buildMyDayTodoSourceMetadata(candidate),
  };
}

function buildTodoSourceKey(candidate: MyDayTodoCandidate): string {
  return `${candidate.toolkitSlug}:${candidate.sourceType}:${candidate.sourceId}`;
}

function isLlmCreatedOpenTodo(todo: MyDayTodoRecord): boolean {
  return todo.status === "open" && todo.source?.type === "my_day_refresh";
}

function isTodoDedupeContext(todo: MyDayTodoRecord, userLocalDate: string, timezone: string): boolean {
  if (todo.status === "open") {
    return true;
  }
  if (todo.status === "done" && todo.completedAt) {
    return getLocalDate(todo.completedAt, timezone) === userLocalDate;
  }
  if (todo.status === "archived" && todo.deletedAt) {
    return daysBetweenLocalDates(getLocalDate(todo.deletedAt, timezone), userLocalDate) <= recentArchivedTodoContextDays;
  }
  return false;
}

function canRefreshModifyTodo(todo: MyDayTodoRecord): boolean {
  return todo.source?.type === "my_day_refresh" && !todo.handoffAt && !todo.handoffWorkerId && todo.status !== "archived" && todo.status !== "deleted";
}

function getLocalDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup("hour")}:${lookup("minute")}:${lookup("second")} ${lookup("timeZoneName")}`.trim();
}

function getLocalTimeParts(date: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: getPart("hour"), minute: getPart("minute") };
}

function getCurrentRefreshSlot(now: Date, timezone: string, refreshTimes: AppConfig["intervals"]["myDayRefreshTimes"]): { start: Date } | null {
  const localTime = getLocalTimeParts(now, timezone);
  const nowMinutes = localTime.hour * 60 + localTime.minute;
  const currentTime = refreshTimes.find((time) => time.hour * 60 + time.minute === nowMinutes);
  if (!currentTime) {
    return null;
  }

  return { start: new Date(now.getTime() - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds()) };
}

function formatRefreshTime(time: { hour: number; minute: number }): string {
  return `${time.hour.toString().padStart(2, "0")}${time.minute.toString().padStart(2, "0")}`;
}

function buildMyDayRefreshJobKey(user: UserContext, now: Date): string {
  const userLocalDate = getLocalDate(now, user.timezone);
  const slot = formatRefreshTime(getLocalTimeParts(now, user.timezone));
  return `finn:my-day:${user.tenantId}:${user.userId}:${userLocalDate}:${slot}`;
}

function daysBetweenLocalDates(fromLocalDate: string, toLocalDate: string): number {
  const from = Date.parse(`${fromLocalDate}T00:00:00.000Z`);
  const to = Date.parse(`${toLocalDate}T00:00:00.000Z`);
  return Math.floor((to - from) / 86_400_000);
}

function startOfLocalDayApprox(date: Date, timeZone: string): Date {
  const [year, month, day] = getLocalDate(date, timeZone).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function laterDate(first: Date, second: Date | null): Date {
  if (!second || first > second) {
    return first;
  }
  return second;
}

function normalizeTodoTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildContributorStatus(enabledToolkits: string[], sourceItems: AutomationSourceItem[]): Record<string, unknown> {
  const sourceCounts = sourceItems.reduce<Record<string, number>>((counts, item) => ({
    ...counts,
    [item.toolkitSlug]: (counts[item.toolkitSlug] ?? 0) + 1,
  }), {});

  return {
    enabledToolkits,
    sourceCounts,
  };
}

function getErrorMessage(error: unknown): string {
  const abortMessage = getAbortErrorMessage(error);
  if (abortMessage) {
    return abortMessage;
  }

  return error instanceof Error && error.message.length > 0 ? error.message : "unknown";
}
