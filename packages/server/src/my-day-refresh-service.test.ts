import { describe, expect, it } from "bun:test";
import type { MyDayTodoRecord, MyDayTodoSourceType, UserContext } from "@finn/core";
import { buildMyDayRefreshSystemPromptForTest, createMyDayRefreshTools, shouldRunMyDayRefresh } from "./my-day-refresh-service.js";
import type { MyDayPageRecord, MyDayStore } from "./my-day-store.js";

const user: UserContext = {
  tenantId: "tenant_default",
  userId: "usr_123",
  phoneNumber: "+15555550123",
  timezone: "America/New_York",
  timezoneSource: "manual",
  kidsMode: false,
};

function makeTodo(title: string, status: MyDayTodoRecord["status"] = "open", sourceType: MyDayTodoSourceType | null = "my_day_refresh"): MyDayTodoRecord {
  const now = new Date("2026-05-12T12:00:00.000Z");
  return {
    id: `todo_${title}`,
    tenantId: user.tenantId,
    userId: user.userId,
    myDayId: "day_123",
    title,
    notes: null,
    status,
    source: sourceType ? { type: sourceType, label: sourceType } : null,
    handoffAt: null,
    handoffWorkerId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
    deletedAt: null,
  };
}

describe("createMyDayRefreshTools", () => {
  it("exposes only My Day refresh internal tools", () => {
    const tools = createMyDayRefreshTools({
      store: makeStore(),
      user,
      userLocalDate: "2026-05-12",
      page: makePage(),
    }).tools;

    expect(Object.keys(tools).sort()).toEqual([
      "archive_my_day_todo",
      "create_my_day_todo",
      "edit_my_day_todo",
      "update_my_day_summary",
    ]);
  });

  it("creates only high-confidence non-duplicate todos and records skipped reasons", async () => {
    const createdTodos: MyDayTodoRecord[] = [];
    const page = makePage({ todos: [makeTodo("Call Sam")] });
    const tools = createMyDayRefreshTools({
      store: makeStore({ createdTodos }),
      user,
      userLocalDate: "2026-05-12",
      page,
    });

    const duplicate = await tools.tools.create_my_day_todo.execute?.(makeCandidate({ title: "Call Sam", confidence: 0.99, sourceId: "email_1", evidence: "Sam asked for a call", reason: "Duplicate should not be added" }), { toolCallId: "call_1", messages: [] });
    const lowConfidence = await tools.tools.create_my_day_todo.execute?.(makeCandidate({ title: "Check email", confidence: 0.4, sourceId: "email_2", evidence: "inbox exists", reason: "Too generic" }), { toolCallId: "call_2", messages: [] });
    const accepted = await tools.tools.create_my_day_todo.execute?.(makeCandidate({ title: "Send the signed lease", notes: "Due by 5pm", confidence: 0.9, sourceId: "email_3", evidence: "Lease email asks for signature by 5pm", reason: "Specific deadline today" }), { toolCallId: "call_3", messages: [] });

    expect(duplicate).toEqual({ ok: false, skipped: true, reason: "duplicate_recent_todo" });
    expect(lowConfidence).toEqual({ ok: false, skipped: true, reason: "confidence_below_threshold" });
    expect(accepted).toEqual({ ok: true, todoId: "todo_created_1" });
    expect(createdTodos.map((todo) => todo.title)).toEqual(["Send the signed lease"]);
    expect(tools.getResult().skippedReasons).toEqual({
      "gmail:email:email_1": "duplicate_recent_todo",
      "gmail:email:email_2": "confidence_below_threshold",
    });
  });

  it("caps active refresh-created todos while ignoring user-created todos", async () => {
    const createdTodos: MyDayTodoRecord[] = [];
    const page = makePage({
      todos: [
        ...Array.from({ length: 10 }, (_, index) => makeTodo(`LLM todo ${index + 1}`)),
        makeTodo("User todo", "open", "user"),
      ],
    });
    const tools = createMyDayRefreshTools({ store: makeStore({ createdTodos }), user, userLocalDate: "2026-05-12", page });

    const result = await tools.tools.create_my_day_todo.execute?.(makeCandidate({ title: "New source-backed todo", confidence: 0.9, sourceId: "email_11", evidence: "Important source", reason: "High-value action" }), { toolCallId: "call_1", messages: [] });

    expect(result).toEqual({ ok: false, skipped: true, reason: "active_llm_todo_limit_reached" });
    expect(createdTodos).toHaveLength(0);
  });

  it("archives stale refresh-created todos but not user-created or handed-off todos", async () => {
    const archivedTodoIds: string[] = [];
    const refreshTodo = makeTodo("Old refresh todo");
    const userTodo = makeTodo("User todo", "open", "user");
    const handedOffTodo = { ...makeTodo("Handed off refresh todo"), handoffAt: new Date("2026-05-12T13:00:00.000Z") };
    const page = makePage({ todos: [refreshTodo, userTodo, handedOffTodo] });
    const tools = createMyDayRefreshTools({
      store: makeStore({ archivedTodoIds }),
      user,
      userLocalDate: "2026-05-12",
      page,
    });

    const archived = await tools.tools.archive_my_day_todo.execute?.({ todoId: refreshTodo.id, reason: "Source is resolved." }, { toolCallId: "call_1", messages: [] });
    const userArchive = await tools.tools.archive_my_day_todo.execute?.({ todoId: userTodo.id, reason: "No longer relevant." }, { toolCallId: "call_2", messages: [] });
    const handedOffArchive = await tools.tools.archive_my_day_todo.execute?.({ todoId: handedOffTodo.id, reason: "No longer relevant." }, { toolCallId: "call_3", messages: [] });

    expect(archived).toEqual({ ok: true, todoId: refreshTodo.id });
    expect(userArchive).toEqual({ ok: false, error: "todo_not_archivable_by_refresh" });
    expect(handedOffArchive).toEqual({ ok: false, error: "todo_not_archivable_by_refresh" });
    expect(archivedTodoIds).toEqual([refreshTodo.id]);
    expect(tools.getResult().archivedTodoIds).toEqual([refreshTodo.id]);
  });

  it("blocks recreating recently archived todos", async () => {
    const createdTodos: MyDayTodoRecord[] = [];
    const archivedTodo = {
      ...makeTodo("Submit repair docs", "archived"),
      deletedAt: new Date("2026-05-12T12:00:00.000Z"),
    };
    const tools = createMyDayRefreshTools({
      store: makeStore({ createdTodos }),
      user,
      userLocalDate: "2026-05-12",
      page: makePage({ archivedTodos: [archivedTodo] }),
    });

    const result = await tools.tools.create_my_day_todo.execute?.(makeCandidate({ title: "Submit repair docs", confidence: 0.95, sourceId: "email_99", evidence: "Same source", reason: "Same task" }), { toolCallId: "call_1", messages: [] });

    expect(result).toEqual({ ok: false, skipped: true, reason: "duplicate_recent_todo" });
    expect(createdTodos).toHaveLength(0);
  });
});

describe("myDayRefreshSystemPrompt", () => {
  it("discourages audit-style summaries", () => {
    const prompt = buildMyDayRefreshSystemPromptForTest();

    expect(prompt).toContain("Do not mention empty sources, checked apps with no results, location, or time of day");
    expect(prompt).toContain("Light day today");
    expect(prompt).toContain("Update My Day with the provided tools");
    expect(prompt).toContain("Done todos are visible only on the local date they were completed");
    expect(prompt).toContain("Recent archived todos are explicit dedupe context");
    expect(prompt).toContain("raw IDs, exact quoted reply instructions, or internal matter/reference numbers");
    expect(prompt).toContain("Use finn.files.extract");
    expect(prompt).not.toContain("Secure Exec");
    expect(prompt).not.toContain("not a shell");
    expect(prompt).not.toContain("Return strict JSON only");
  });
});

describe("shouldRunMyDayRefresh", () => {
  const refreshTimes = [{ hour: 8, minute: 0 }];
  const now = new Date("2026-05-12T12:00:00.000Z");
  const timezone = "America/New_York";

  it("skips empty days when no My Day sources are enabled", () => {
    expect(shouldRunMyDayRefresh({
      hasEnabledSources: false,
      lastRefreshedAt: null,
      latestRun: null,
      now,
      timezone,
      refreshTimes,
    })).toEqual({ refresh: false, skipReason: "no_enabled_sources" });
  });

  it("refreshes when the current local minute matches a configured refresh time", () => {
    expect(shouldRunMyDayRefresh({
      hasEnabledSources: true,
      lastRefreshedAt: null,
      latestRun: null,
      now,
      timezone,
      refreshTimes,
    })).toEqual({ refresh: true, reason: "scheduled" });
  });

  it("waits outside configured refresh times and after a successful refresh in the same slot", () => {
    expect(shouldRunMyDayRefresh({
      hasEnabledSources: true,
      lastRefreshedAt: new Date("2026-05-12T08:00:00.000Z"),
      latestRun: null,
      now: new Date("2026-05-12T12:01:00.000Z"),
      timezone,
      refreshTimes,
    })).toEqual({ refresh: false, skipReason: "not_due" });

    expect(shouldRunMyDayRefresh({
      hasEnabledSources: true,
      lastRefreshedAt: new Date("2026-05-12T12:00:00.000Z"),
      latestRun: null,
      now,
      timezone,
      refreshTimes,
    })).toEqual({ refresh: false, skipReason: "not_due" });
  });

  it("does not start another run when today's refresh is already running", () => {
    expect(shouldRunMyDayRefresh({
      hasEnabledSources: true,
      lastRefreshedAt: null,
      latestRun: {
        id: "arun_running",
        tenantId: user.tenantId,
        userId: user.userId,
        runType: "my_day_refresh",
        state: "running",
        userLocalDate: "2026-05-12",
        toolkitSlug: null,
        accountScopeId: null,
        connectedAccountId: null,
        windowStart: null,
        windowEnd: null,
        contributorStatus: null,
        resultSummary: null,
        acceptedTodoIds: null,
        retainedDocumentIds: null,
        skippedReasons: null,
        error: null,
        createdAt: now,
        completedAt: null,
      },
      now,
      timezone,
      refreshTimes,
    })).toEqual({ refresh: false, skipReason: "already_running" });
  });
});

function makeCandidate(input: {
  title: string;
  notes?: string;
  confidence: number;
  sourceId: string;
  evidence: string;
  reason: string;
}) {
  return {
    notes: "",
    toolkitSlug: "gmail",
    sourceType: "email",
    ...input,
  };
}

function makePage(input: { todos?: MyDayTodoRecord[]; archivedTodos?: MyDayTodoRecord[] } = {}): MyDayPageRecord {
  const now = new Date("2026-05-12T12:00:00.000Z");
  return {
    day: {
      id: "day_123",
      tenantId: user.tenantId,
      userId: user.userId,
      userLocalDate: "2026-05-12",
      timezone: user.timezone,
      summary: "Existing summary",
      sourceSummary: null,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    todos: input.todos ?? [],
    archivedTodos: input.archivedTodos ?? [],
  };
}

function makeStore(state: {
  createdTodos?: MyDayTodoRecord[];
  archivedTodoIds?: string[];
} = {}): MyDayStore {
  const createdTodos = state.createdTodos ?? [];
  const archivedTodoIds = state.archivedTodoIds ?? [];
  return {
    createTodo: async (_userLocalDate: string, _timezone: string, params: { title: string; notes?: string | null; source?: MyDayTodoRecord["source"] }) => {
      const todo = {
        ...makeTodo(params.title),
        id: `todo_created_${createdTodos.length + 1}`,
        notes: params.notes ?? null,
        source: params.source ?? null,
      };
      createdTodos.push(todo);
      return todo;
    },
    updateTodo: async (id: string, params: { title?: string; notes?: string | null }) => ({
      ...makeTodo(params.title ?? "Updated todo"),
      id,
      notes: params.notes ?? null,
    }),
    deleteTodo: async (id: string) => {
      archivedTodoIds.push(id);
      return { ...makeTodo("Archived todo", "archived"), id };
    },
  } as unknown as MyDayStore;
}
