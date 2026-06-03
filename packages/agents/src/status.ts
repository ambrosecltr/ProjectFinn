import type { EventBus, MyDayRecord, MyDayTodoRecord, PatternRecord, StatusBlock, UserContext, WorkerRecord, WorkerResult } from "@finn/core";
import type { WorkerManager } from "./worker-manager.js";
import { escapePromptAttributeValue, escapePromptContentValue } from "./prompt-envelopes.js";

interface StatusWorkerSource {
  getActive(): Promise<WorkerRecord[]>;
  getFollowUpEnabled?(): Promise<WorkerRecord[]>;
}

async function getOptionalMyDay(deps: Pick<StatusBlockDeps, "getMyDay">): Promise<{ day: MyDayRecord; todos: MyDayTodoRecord[] } | undefined> {
  try {
    return await deps.getMyDay?.();
  } catch {
    return undefined;
  }
}

function createWorkerRecord(params: {
  tenantId: string;
  userId: string;
  id: string;
  task: string;
  state: WorkerRecord["state"];
  statusDetail: string | null;
  toolCallsUsed?: number;
  result?: WorkerResult | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
  originMessageId?: string | null;
  completionDeliveredAt?: Date | null;
}): WorkerRecord {
  return {
    id: params.id,
    tenantId: params.tenantId,
    userId: params.userId,
    type: "general",
    task: params.task,
    state: params.state,
    runSequence: 1,
    statusDetail: params.statusDetail,
    toolCallsUsed: params.toolCallsUsed ?? 0,
    result: params.result ?? null,
    modelMessages: null,
    followUpExpiresAt: null,
    parentConversationId: null,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
    completedAt: params.completedAt ?? null,
    originMessageId: params.originMessageId ?? null,
    completionDeliveredAt: params.completionDeliveredAt ?? null,
  };
}

export class StatusCache implements StatusWorkerSource {
  private readonly activeWorkers = new Map<string, WorkerRecord>();
  private readonly unsubscribeFns: Array<() => void>;

  constructor(
    eventBus: Pick<EventBus, "on">,
    private readonly user?: UserContext,
  ) {
    this.unsubscribeFns = [
      eventBus.on("worker_started", (event) => {
        if (!this.isUserEvent(event)) {
          return;
        }
        const existing = this.activeWorkers.get(event.workerId);
        const now = new Date();

        this.activeWorkers.set(
          event.workerId,
          createWorkerRecord({
            id: event.workerId,
            tenantId: event.tenantId,
            userId: event.userId,
            task: event.task,
            state: "running",
            statusDetail: existing?.statusDetail ?? null,
            result: null,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }),
        );
      }),
      eventBus.on("worker_status", (event) => {
        if (!this.isUserEvent(event)) {
          return;
        }
        const existing = this.activeWorkers.get(event.workerId);
        if (!existing) {
          return;
        }

        this.activeWorkers.set(event.workerId, {
          ...existing,
          statusDetail: event.detail,
          updatedAt: new Date(),
        });
      }),
      eventBus.on("worker_completed", (event) => {
        if (!this.isUserEvent(event)) {
          return;
        }
        this.activeWorkers.delete(event.workerId);
      }),
      eventBus.on("worker_failed", (event) => {
        if (!this.isUserEvent(event)) {
          return;
        }
        this.activeWorkers.delete(event.workerId);
      }),
      eventBus.on("worker_cancelled", (event) => {
        if (!this.isUserEvent(event)) {
          return;
        }
        this.activeWorkers.delete(event.workerId);
      }),
    ];
  }

  async getActive(): Promise<WorkerRecord[]> {
    return [...this.activeWorkers.values()].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
  }

  private isUserEvent(event: { tenantId: string; userId: string }): boolean {
    if (!this.user) {
      return true;
    }

    return event.tenantId === this.user.tenantId && event.userId === this.user.userId;
  }
}

export interface StatusBlockDeps {
  workerManager?: WorkerManager;
  statusCache?: StatusCache;
  getActivePatternCount?: () => Promise<number>;
  listActivePatterns?: () => Promise<PatternRecord[]>;
  getMyDay?: () => Promise<{ day: MyDayRecord; todos: MyDayTodoRecord[] }>;
}

function summarizePattern(pattern: PatternRecord): NonNullable<StatusBlock["activePatternSummaries"]>[number] {
  return {
    id: pattern.id,
    name: pattern.name,
    workerType: pattern.workerType,
    triggerType: pattern.triggerType,
    scheduleType: pattern.triggerConfig.type === "schedule" ? pattern.triggerConfig.schedule.kind : null,
    nextRunAt: pattern.triggerConfig.type === "schedule" ? pattern.nextRunAt : null,
    userDescription: pattern.userDescription,
  };
}

export async function buildStatusBlock(deps: StatusBlockDeps = {}): Promise<StatusBlock> {
  const { workerManager, statusCache, getActivePatternCount, listActivePatterns, getMyDay } = deps;
  const workerStatusSource: StatusWorkerSource | undefined = workerManager ?? statusCache;

  const [activeWorkers, followUpWorkers, activePatternSummaries, myDayPage] = await Promise.all([
    workerStatusSource?.getActive() ?? Promise.resolve([]),
    workerStatusSource?.getFollowUpEnabled?.() ?? Promise.resolve([]),
    listActivePatterns?.().then((patterns) => patterns.map(summarizePattern)) ?? Promise.resolve(undefined),
    getOptionalMyDay({ getMyDay }),
  ]);
  const activePatterns = activePatternSummaries?.length ?? await (getActivePatternCount?.() ?? Promise.resolve(0));

  return {
    activeWorkers: activeWorkers.map((worker) => ({
      id: worker.id,
      task: worker.task,
      status: worker.statusDetail ?? worker.state,
      startedAt: worker.createdAt,
    })),
    followUpWorkers: followUpWorkers.map((worker) => ({
      id: worker.id,
      task: worker.task,
      status: worker.statusDetail ?? worker.state,
      completedAt: worker.completedAt ?? worker.updatedAt,
      expiresAt: worker.followUpExpiresAt ?? worker.updatedAt,
    })),
    pendingConfirmations: [],
    activePatterns,
    ...(myDayPage ? {
      myDay: {
        userLocalDate: myDayPage.day.userLocalDate,
        summary: myDayPage.day.summary,
        todos: myDayPage.todos.slice(0, 8).map((todo) => ({
          id: todo.id,
          title: todo.title,
          status: todo.status === "done" ? "done" : "open",
          handoffWorkerId: todo.handoffWorkerId,
        })),
      },
    } : {}),
    ...(activePatternSummaries ? { activePatternSummaries } : {}),
  };
}

function formatActivePattern(pattern: NonNullable<StatusBlock["activePatternSummaries"]>[number]): string {
  const attributes = [
    `id="${escapePromptAttributeValue(pattern.id)}"`,
    `name="${escapePromptAttributeValue(pattern.name)}"`,
    `type="${escapePromptAttributeValue(pattern.workerType === "reminder" ? "reminder" : pattern.triggerType)}"`,
    pattern.scheduleType ? `schedule="${escapePromptAttributeValue(pattern.scheduleType)}"` : null,
    pattern.nextRunAt ? `next_run="${escapePromptAttributeValue(pattern.nextRunAt.toISOString())}"` : null,
  ].filter((value): value is string => Boolean(value)).join(" ");
  const description = pattern.userDescription ? escapePromptContentValue(pattern.userDescription) : "";
  return `<pattern ${attributes}>${description}</pattern>`;
}

export function formatStatusBlock(status: StatusBlock): string {
  const lines = [
    "<status>",
    `<counts active_workers="${status.activeWorkers.length}" follow_up_workers="${status.followUpWorkers.length}" pending_confirmations="${status.pendingConfirmations.length}" active_patterns="${status.activePatterns}" />`,
  ];

  if (status.activeWorkers.length > 0) {
    lines.push(`<active_workers count="${status.activeWorkers.length}">`);
    for (const worker of status.activeWorkers) {
      lines.push(`<worker id="${escapePromptAttributeValue(worker.id)}" status="${escapePromptAttributeValue(worker.status)}">${escapePromptContentValue(worker.task)}</worker>`);
    }
    lines.push("</active_workers>");
  }

  if (status.followUpWorkers.length > 0) {
    lines.push(`<follow_up_workers count="${status.followUpWorkers.length}">`);
    for (const worker of status.followUpWorkers) {
      lines.push(`<worker id="${escapePromptAttributeValue(worker.id)}" status="${escapePromptAttributeValue(worker.status)}" expires_at="${escapePromptAttributeValue(worker.expiresAt.toISOString())}">${escapePromptContentValue(worker.task)}</worker>`);
    }
    lines.push("</follow_up_workers>");
  }

  if (status.pendingConfirmations.length > 0) {
    lines.push(`<pending_confirmations count="${status.pendingConfirmations.length}">`);
    for (const confirmation of status.pendingConfirmations) {
      lines.push(`<confirmation id="${escapePromptAttributeValue(confirmation.id)}">${escapePromptContentValue(confirmation.summary)}</confirmation>`);
    }
    lines.push("</pending_confirmations>");
  }

  if (status.myDay && (status.myDay.summary || status.myDay.todos.length > 0)) {
    lines.push(`<my_day date="${escapePromptAttributeValue(status.myDay.userLocalDate)}">`);
    if (status.myDay.summary) {
      lines.push(`<summary>${escapePromptContentValue(status.myDay.summary)}</summary>`);
    }
    if (status.myDay.todos.length > 0) {
      lines.push(`<todos count="${status.myDay.todos.length}">`);
      for (const todo of status.myDay.todos) {
        const marker = todo.status === "done" ? "done" : "open";
        const handoff = todo.handoffWorkerId ? ` handoff_worker_id="${escapePromptAttributeValue(todo.handoffWorkerId)}"` : "";
        lines.push(`<todo id="${escapePromptAttributeValue(todo.id)}" status="${marker}"${handoff}>${escapePromptContentValue(todo.title)}</todo>`);
      }
      lines.push("</todos>");
    }
    lines.push("</my_day>");
  }

  if (status.activePatternSummaries && status.activePatternSummaries.length > 0) {
    lines.push(`<active_patterns count="${status.activePatternSummaries.length}">`);
    for (const pattern of status.activePatternSummaries.slice(0, 12)) {
      lines.push(formatActivePattern(pattern));
    }
    if (status.activePatternSummaries.length > 12) {
      lines.push(`<more count="${status.activePatternSummaries.length - 12}">Use list_active_patterns before editing or creating similar patterns.</more>`);
    }
    lines.push("</active_patterns>");
  }

  lines.push("</status>");
  return lines.join("\n");
}
