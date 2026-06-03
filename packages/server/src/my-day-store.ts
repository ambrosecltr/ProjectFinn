import { generateId, type MyDayRecord, type MyDayTodoRecord, type MyDayTodoSource, type MyDayTodoStatus, type UserContext } from "@finn/core";
import type { Database } from "@finn/db";
import * as schema from "@finn/db";
import { and, asc, eq, isNull, ne } from "drizzle-orm";

export interface MyDayPageRecord {
  day: MyDayRecord;
  todos: MyDayTodoRecord[];
  archivedTodos: MyDayTodoRecord[];
}

export interface MyDayTodoCreateParams {
  title: string;
  notes?: string | null;
  source?: MyDayTodoSource | null;
}

export interface MyDayTodoUpdateParams {
  title?: string;
  notes?: string | null;
  status?: Extract<MyDayTodoStatus, "open" | "done">;
  handoffAt?: Date | null;
  handoffWorkerId?: string | null;
}

type MyDayOwner = Pick<UserContext, "tenantId" | "userId">;

export class MyDayStore {
  constructor(
    private readonly deps: {
      db: Database;
      user?: MyDayOwner;
    },
  ) {}

  async getForDate(userLocalDate: string, timezone: string): Promise<MyDayPageRecord> {
    const day = await this.ensureDay(userLocalDate, timezone);
    const [todos, archivedTodos] = await Promise.all([
      this.listTodos(userLocalDate, timezone),
      this.listArchivedTodos(),
    ]);
    return { day, todos, archivedTodos };
  }

  async getForDateForUser(user: MyDayOwner, userLocalDate: string, timezone: string): Promise<MyDayPageRecord> {
    return new MyDayStore({ db: this.deps.db, user }).getForDate(userLocalDate, timezone);
  }

  async updateSummary(userLocalDate: string, timezone: string, params: {
    summary?: string | null;
    sourceSummary?: string | null;
    lastRefreshedAt?: Date | null;
  }): Promise<MyDayPageRecord> {
    const day = await this.ensureDay(userLocalDate, timezone);
    const now = new Date();
    const [updated] = await this.deps.db
      .update(schema.myDayEntries)
      .set({
        timezone,
        ...(params.summary !== undefined ? { summary: normalizeOptionalText(params.summary) } : {}),
        ...(params.sourceSummary !== undefined ? { sourceSummary: normalizeOptionalText(params.sourceSummary) } : {}),
        ...(params.lastRefreshedAt !== undefined ? { lastRefreshedAt: params.lastRefreshedAt } : {}),
        updatedAt: now,
      })
      .where(and(this.ownerWhere(schema.myDayEntries), eq(schema.myDayEntries.id, day.id)))
      .returning();

    return {
      day: updated as MyDayRecord,
      todos: await this.listTodos(userLocalDate, timezone),
      archivedTodos: await this.listArchivedTodos(),
    };
  }

  async updateSummaryForUser(user: MyDayOwner, userLocalDate: string, timezone: string, params: {
    summary?: string | null;
    sourceSummary?: string | null;
    lastRefreshedAt?: Date | null;
  }): Promise<MyDayPageRecord> {
    return new MyDayStore({ db: this.deps.db, user }).updateSummary(userLocalDate, timezone, params);
  }

  async createTodo(userLocalDate: string, timezone: string, params: MyDayTodoCreateParams): Promise<MyDayTodoRecord> {
    const owner = this.requireUser();
    const day = await this.ensureDay(userLocalDate, timezone);
    const now = new Date();
    const [created] = await this.deps.db
      .insert(schema.myDayTodos)
      .values({
        id: generateId("todo"),
        tenantId: owner.tenantId,
        userId: owner.userId,
        myDayId: day.id,
        title: params.title.trim(),
        notes: normalizeOptionalText(params.notes),
        status: "open",
        source: params.source ?? null,
        handoffAt: null,
        handoffWorkerId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return created as MyDayTodoRecord;
  }

  async createTodoForUser(user: MyDayOwner, userLocalDate: string, timezone: string, params: MyDayTodoCreateParams): Promise<MyDayTodoRecord> {
    return new MyDayStore({ db: this.deps.db, user }).createTodo(userLocalDate, timezone, params);
  }

  async updateTodo(id: string, params: MyDayTodoUpdateParams): Promise<MyDayTodoRecord | null> {
    const existing = await this.getTodo(id);
    if (!existing || existing.status === "deleted" || existing.status === "archived") {
      return null;
    }

    const now = new Date();
    const nextStatus = params.status ?? existing.status;
    const [updated] = await this.deps.db
      .update(schema.myDayTodos)
      .set({
        ...(params.title !== undefined ? { title: params.title.trim() } : {}),
        ...(params.notes !== undefined ? { notes: normalizeOptionalText(params.notes) } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.handoffAt !== undefined ? { handoffAt: params.handoffAt } : {}),
        ...(params.handoffWorkerId !== undefined ? { handoffWorkerId: params.handoffWorkerId } : {}),
        completedAt: nextStatus === "done" ? existing.completedAt ?? now : null,
        updatedAt: now,
      })
      .where(and(
        this.ownerWhere(schema.myDayTodos),
        eq(schema.myDayTodos.id, id),
        ne(schema.myDayTodos.status, "deleted"),
      ))
      .returning();

    return updated ? updated as MyDayTodoRecord : null;
  }

  async updateTodoForUser(user: MyDayOwner, id: string, params: MyDayTodoUpdateParams): Promise<MyDayTodoRecord | null> {
    return new MyDayStore({ db: this.deps.db, user }).updateTodo(id, params);
  }

  async markTodoHandoffQueued(id: string): Promise<MyDayTodoRecord | null> {
    const existing = await this.getTodo(id);
    if (!existing || existing.status !== "open" || existing.handoffAt) {
      return null;
    }

    const now = new Date();
    const [updated] = await this.deps.db
      .update(schema.myDayTodos)
      .set({
        handoffAt: now,
        updatedAt: now,
      })
      .where(and(
        this.ownerWhere(schema.myDayTodos),
        eq(schema.myDayTodos.id, id),
        eq(schema.myDayTodos.status, "open"),
        isNull(schema.myDayTodos.handoffAt),
      ))
      .returning();

    return updated ? updated as MyDayTodoRecord : null;
  }

  async markTodoHandoffQueuedForUser(user: MyDayOwner, id: string): Promise<MyDayTodoRecord | null> {
    return new MyDayStore({ db: this.deps.db, user }).markTodoHandoffQueued(id);
  }

  async markTodoHandedOff(id: string, workerId: string): Promise<MyDayTodoRecord | null> {
    const existing = await this.getTodo(id);
    if (!existing || existing.status !== "open" || !existing.handoffAt || existing.handoffWorkerId) {
      return null;
    }

    const [updated] = await this.deps.db
      .update(schema.myDayTodos)
      .set({
        handoffWorkerId: workerId,
        updatedAt: new Date(),
      })
      .where(and(
        this.ownerWhere(schema.myDayTodos),
        eq(schema.myDayTodos.id, id),
        eq(schema.myDayTodos.status, "open"),
        isNull(schema.myDayTodos.handoffWorkerId),
      ))
      .returning();

    return updated ? updated as MyDayTodoRecord : null;
  }

  async deleteTodo(id: string): Promise<MyDayTodoRecord | null> {
    const existing = await this.getTodo(id);
    if (!existing || existing.status === "deleted" || existing.status === "archived") {
      return null;
    }

    const now = new Date();
    const [updated] = await this.deps.db
      .update(schema.myDayTodos)
      .set({
        status: "archived",
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(this.ownerWhere(schema.myDayTodos), eq(schema.myDayTodos.id, id)))
      .returning();

    return updated ? updated as MyDayTodoRecord : null;
  }

  async deleteTodoForUser(user: MyDayOwner, id: string): Promise<MyDayTodoRecord | null> {
    return new MyDayStore({ db: this.deps.db, user }).deleteTodo(id);
  }

  private async ensureDay(userLocalDate: string, timezone: string): Promise<MyDayRecord> {
    const owner = this.requireUser();
    const existing = await this.getDay(userLocalDate);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const [created] = await this.deps.db
      .insert(schema.myDayEntries)
      .values({
        id: generateId("day"),
        tenantId: owner.tenantId,
        userId: owner.userId,
        userLocalDate,
        timezone,
        summary: null,
        sourceSummary: null,
        lastRefreshedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      return created as MyDayRecord;
    }

    const day = await this.getDay(userLocalDate);
    if (!day) {
      throw new Error("Failed to create My Day entry.");
    }

    return day;
  }

  private async getDay(userLocalDate: string): Promise<MyDayRecord | null> {
    const [day] = await this.deps.db
      .select()
      .from(schema.myDayEntries)
      .where(and(this.ownerWhere(schema.myDayEntries), eq(schema.myDayEntries.userLocalDate, userLocalDate)))
      .limit(1);

    return day ? day as MyDayRecord : null;
  }

  async getTodo(id: string): Promise<MyDayTodoRecord | null> {
    const [todo] = await this.deps.db
      .select()
      .from(schema.myDayTodos)
      .where(and(this.ownerWhere(schema.myDayTodos), eq(schema.myDayTodos.id, id)))
      .limit(1);

    return todo ? todo as MyDayTodoRecord : null;
  }

  private async listTodos(userLocalDate: string, timezone: string): Promise<MyDayTodoRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.myDayTodos)
      .where(and(
        this.ownerWhere(schema.myDayTodos),
        ne(schema.myDayTodos.status, "deleted"),
        ne(schema.myDayTodos.status, "archived"),
      ))
      .orderBy(asc(schema.myDayTodos.createdAt));

    return (rows as MyDayTodoRecord[]).filter((todo) => shouldShowTodoOnDate(todo, userLocalDate, timezone));
  }

  private async listArchivedTodos(): Promise<MyDayTodoRecord[]> {
    const rows = await this.deps.db
      .select()
      .from(schema.myDayTodos)
      .where(and(
        this.ownerWhere(schema.myDayTodos),
        eq(schema.myDayTodos.status, "archived"),
      ))
      .orderBy(asc(schema.myDayTodos.updatedAt));

    return rows as MyDayTodoRecord[];
  }

  private ownerWhere(table: typeof schema.myDayEntries | typeof schema.myDayTodos) {
    const owner = this.requireUser();
    return and(
      eq(table.tenantId, owner.tenantId),
      eq(table.userId, owner.userId),
    );
  }

  private requireUser(): MyDayOwner {
    if (!this.deps.user) {
      throw new Error("MyDayStore requires a user for user-scoped operations.");
    }

    return this.deps.user;
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function shouldShowTodoOnDate(todo: MyDayTodoRecord, userLocalDate: string, timezone: string): boolean {
  if (todo.status === "open") {
    return getLocalDate(todo.createdAt, timezone) <= userLocalDate;
  }
  if (todo.status !== "done" || !todo.completedAt) {
    return false;
  }

  return getLocalDate(todo.completedAt, timezone) === userLocalDate;
}

function getLocalDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
