import { describe, expect, it, mock } from "bun:test";

import type { MyDayTodoRecord } from "@finn/core";
import { createFilesRuntime, createProcessRuntimeServices, createUserRuntimeServices } from "@finn/runtime";
import { createHotPathTools } from "./index.js";

const user = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: "Test User",
  timezone: "UTC",
  timezoneSource: "server" as const,
  location: null,
  kidsMode: false,
};

const sender = {
  sendText: async () => undefined,
  sendMedia: async () => undefined,
  sendVoiceMessage: async () => undefined,
  sendReaction: async () => undefined,
  sendTypingIndicator: async () => undefined,
  markRead: async () => undefined,
} as never;

const runtime = createProcessRuntimeServices(createUserRuntimeServices({
  workspace: "/tmp/finn-hot-path-my-day-test",
  files: createFilesRuntime({ workspaceRoot: "/tmp/finn-hot-path-my-day-test" }),
}), {
  processType: "hot_path",
  filesAccess: "write",
});

function createTodo(overrides: Partial<MyDayTodoRecord> = {}): MyDayTodoRecord {
  return {
    id: "todo_123",
    tenantId: "tenant_test",
    userId: "usr_test",
    myDayId: "day_123",
    title: "Reply to Sam",
    notes: null,
    status: "open",
    source: { type: "user", label: "My Day" },
    handoffAt: null,
    handoffWorkerId: null,
    createdAt: new Date("2026-05-12T00:00:00.000Z"),
    updatedAt: new Date("2026-05-12T00:00:00.000Z"),
    completedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("createMyDayTools", () => {
  it("omits My Day tools when My Day deps are absent", () => {
    const tools = createHotPathTools({ sender, runtime });

    expect(tools.list_my_day_todos).toBeUndefined();
    expect(tools.add_my_day_todo).toBeUndefined();
  });

  it("exposes only hot-path My Day todo tools", () => {
    const store = {
      getForDate: mock(async () => ({ day: {}, todos: [] })),
      createTodo: mock(async () => createTodo()),
      updateTodo: mock(async () => null),
      deleteTodo: mock(async () => null),
    };
    const tools = createHotPathTools({
      sender,
      runtime,
      myDay: { user, getTodayLocalDate: () => "2026-05-12", store },
    });

    expect(tools.list_my_day_todos).toBeDefined();
    expect(tools.add_my_day_todo).toBeDefined();
    expect(tools.update_my_day_todo).toBeDefined();
    expect(tools.delete_my_day_todo).toBeDefined();
    expect(tools.update_my_day_summary).toBeUndefined();
    expect(tools.create_my_day_todo).toBeUndefined();
    expect(tools.edit_my_day_todo).toBeUndefined();
    expect(tools.archive_my_day_todo).toBeUndefined();
  });

  it("creates assistant-sourced todos for today", async () => {
    const createdTodo = createTodo({ title: "Book haircut", source: { type: "assistant", label: "Finn" } });
    const store = {
      getForDate: mock(async () => ({ day: {}, todos: [] })),
      createTodo: mock(async () => createdTodo),
      updateTodo: mock(async () => null),
      deleteTodo: mock(async () => null),
    };
    const tools = createHotPathTools({
      sender,
      runtime,
      myDay: { user, getTodayLocalDate: () => "2026-05-12", store },
    });

    const result = await tools.add_my_day_todo.execute?.({ title: "Book haircut", notes: null }, {} as never);

    expect(store.createTodo).toHaveBeenCalledWith("2026-05-12", "UTC", {
      title: "Book haircut",
      notes: null,
      source: { type: "assistant", label: "Finn" },
    });
    expect(result).toEqual({
      todo: {
        id: "todo_123",
        title: "Book haircut",
        notes: null,
        status: "open",
        source: { type: "assistant", label: "Finn" },
        handoffAt: null,
        handoffWorkerId: null,
        createdAt: "2026-05-12T00:00:00.000Z",
        updatedAt: "2026-05-12T00:00:00.000Z",
        completedAt: null,
        archivedAt: null,
      },
    });
  });

  it("returns a not-found result when updating a missing todo", async () => {
    const store = {
      getForDate: mock(async () => ({ day: {}, todos: [] })),
      createTodo: mock(async () => createTodo()),
      updateTodo: mock(async () => null),
      deleteTodo: mock(async () => null),
    };
    const tools = createHotPathTools({
      sender,
      runtime,
      myDay: { user, getTodayLocalDate: () => "2026-05-12", store },
    });

    const result = await tools.update_my_day_todo.execute?.({ todo_id: "todo_missing", status: "done" }, {} as never);

    expect(result).toEqual({ updated: false, error: "Todo not found." });
  });

  it("archives todos instead of hard-deleting them", async () => {
    const archivedTodo = createTodo({ status: "archived", deletedAt: new Date("2026-05-12T00:05:00.000Z") });
    const store = {
      getForDate: mock(async () => ({ day: {}, todos: [] })),
      createTodo: mock(async () => createTodo()),
      updateTodo: mock(async () => null),
      deleteTodo: mock(async () => archivedTodo),
    };
    const tools = createHotPathTools({
      sender,
      runtime,
      myDay: { user, getTodayLocalDate: () => "2026-05-12", store },
    });

    const result = await tools.delete_my_day_todo.execute?.({ todo_id: "todo_123" }, {} as never);

    expect(result).toEqual({
      archived: true,
      todo: expect.objectContaining({
        id: "todo_123",
        status: "archived",
        archivedAt: "2026-05-12T00:05:00.000Z",
      }),
    });
  });
});
