import type { MyDayTodoRecord, MyDayTodoSource, UserContext } from "@finn/core";
import { tool } from "ai";
import { z } from "zod";

const todoIdSchema = z.string().trim().min(1);

export interface MyDayToolStore {
  getForDate(userLocalDate: string, timezone: string): Promise<{ day: unknown; todos: MyDayTodoRecord[] }>;
  createTodo(userLocalDate: string, timezone: string, params: { title: string; notes?: string | null; source?: MyDayTodoSource | null }): Promise<MyDayTodoRecord>;
  updateTodo(id: string, params: { title?: string; notes?: string | null; status?: "open" | "done" }): Promise<MyDayTodoRecord | null>;
  deleteTodo(id: string): Promise<MyDayTodoRecord | null>;
}

export interface MyDayToolsDeps {
  user: UserContext;
  getTodayLocalDate: () => string;
  store: MyDayToolStore;
}

function serializeTodo(todo: MyDayTodoRecord) {
  return {
    id: todo.id,
    title: todo.title,
    notes: todo.notes,
    status: todo.status === "done" ? "done" : todo.status === "archived" ? "archived" : "open",
    source: todo.source,
    handoffAt: todo.handoffAt?.toISOString() ?? null,
    handoffWorkerId: todo.handoffWorkerId,
    createdAt: todo.createdAt.toISOString(),
    updatedAt: todo.updatedAt.toISOString(),
    completedAt: todo.completedAt?.toISOString() ?? null,
    archivedAt: todo.deletedAt?.toISOString() ?? null,
  };
}

export function createMyDayTools(deps: MyDayToolsDeps) {
  return {
    list_my_day_todos: tool({
      description: "List today's My Day todos. Use before editing or deleting todos unless the relevant todo ID is already visible in runtime status.",
      inputSchema: z.object({}),
      execute: async () => {
        const page = await deps.store.getForDate(deps.getTodayLocalDate(), deps.user.timezone);
        return { todos: page.todos.map(serializeTodo) };
      },
    }),
    add_my_day_todo: tool({
      description: "Add a high-confidence useful todo to today's My Day list. Use for explicit user requests or clear actionable follow-ups. Do not add noisy or speculative todos.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(300).describe("Short todo title."),
        notes: z.string().trim().max(2000).nullable().optional().describe("Optional supporting notes."),
      }),
      execute: async ({ title, notes }) => {
        const todo = await deps.store.createTodo(deps.getTodayLocalDate(), deps.user.timezone, {
          title,
          notes,
          source: { type: "assistant", label: "Finn" },
        });
        return { todo: serializeTodo(todo) };
      },
    }),
    update_my_day_todo: tool({
      description: "Edit a My Day todo title or notes, or mark it done/open only when the user explicitly asks or a user-assigned worker completed it.",
      inputSchema: z.object({
        todo_id: todoIdSchema.describe("Todo ID from runtime status or list_my_day_todos."),
        title: z.string().trim().min(1).max(300).optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
        status: z.enum(["open", "done"]).optional(),
      }).refine((input) => input.title !== undefined || input.notes !== undefined || input.status !== undefined, {
        message: "Provide at least one todo update.",
      }),
      execute: async ({ todo_id, title, notes, status }) => {
        const todo = await deps.store.updateTodo(todo_id, { title, notes, status });
        if (!todo) {
          return { updated: false, error: "Todo not found." };
        }
        return { updated: true, todo: serializeTodo(todo) };
      },
    }),
    delete_my_day_todo: tool({
      description: "Archive a My Day todo only when the user explicitly asks to delete/remove it. Do not use for automated cleanup. Archived todos are hidden from the UI but retained as dedupe context so similar tasks are not recreated casually.",
      inputSchema: z.object({
        todo_id: todoIdSchema.describe("Todo ID from runtime status or list_my_day_todos."),
      }),
      execute: async ({ todo_id }) => {
        const todo = await deps.store.deleteTodo(todo_id);
        if (!todo) {
          return { deleted: false, error: "Todo not found." };
        }
        return { archived: true, todo: serializeTodo(todo) };
      },
    }),
  };
}
