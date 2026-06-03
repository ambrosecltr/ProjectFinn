import { describe, expect, it } from "bun:test";
import type { MyDayTodoRecord, UserContext } from "@finn/core";
import { shouldShowTodoOnDate } from "./my-day-store.js";

const user: UserContext = {
  tenantId: "tenant_default",
  userId: "usr_123",
  phoneNumber: "+15555550123",
  timezone: "America/New_York",
  timezoneSource: "manual",
  kidsMode: false,
};

describe("shouldShowTodoOnDate", () => {
  it("carries open todos forward across days", () => {
    expect(shouldShowTodoOnDate(makeTodo({ status: "open" }), "2026-05-14", user.timezone)).toBe(true);
  });

  it("does not show open todos before their local creation day", () => {
    expect(shouldShowTodoOnDate(makeTodo({ status: "open" }), "2026-05-12", user.timezone)).toBe(false);
  });

  it("shows completed todos only on their local completion day", () => {
    const todo = makeTodo({
      status: "done",
      completedAt: new Date("2026-05-13T15:30:00.000Z"),
    });

    expect(shouldShowTodoOnDate(todo, "2026-05-13", user.timezone)).toBe(true);
    expect(shouldShowTodoOnDate(todo, "2026-05-14", user.timezone)).toBe(false);
  });

  it("uses the user's local timezone for completion day", () => {
    const todo = makeTodo({
      status: "done",
      completedAt: new Date("2026-05-14T03:30:00.000Z"),
    });

    expect(shouldShowTodoOnDate(todo, "2026-05-13", user.timezone)).toBe(true);
    expect(shouldShowTodoOnDate(todo, "2026-05-14", user.timezone)).toBe(false);
  });
});

function makeTodo(input: {
  status: MyDayTodoRecord["status"];
  completedAt?: Date | null;
}): MyDayTodoRecord {
  const now = new Date("2026-05-13T12:00:00.000Z");
  return {
    id: "todo_123",
    tenantId: user.tenantId,
    userId: user.userId,
    myDayId: "day_123",
    title: "Test todo",
    notes: null,
    status: input.status,
    source: null,
    handoffAt: null,
    handoffWorkerId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: input.completedAt ?? null,
    deletedAt: null,
  };
}
