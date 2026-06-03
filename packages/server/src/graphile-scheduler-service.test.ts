import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { AppConfig } from "@finn/core";
import type { AddJobFunction, Runner, RunnerOptions } from "graphile-worker";
import { GraphileSchedulerService, graphileSchedulerTasks } from "./graphile-scheduler-service.js";

function createConfig(): AppConfig {
  return {
    databaseUrl: "DATABASE_URL_PLACEHOLDER",
    scheduler: {
      graphile: {
        concurrency: 7,
        maxPoolSize: 11,
        pollIntervalMs: 1_500,
        patternTickMs: 60_000,
        myDayTickMs: 60_000,
        personalIntelligenceTickMs: 300_000,
        myDayScheduledJitterMs: 20 * 60_000,
        personalIntelligenceScheduledJitterMs: 60 * 60_000,
      },
    },
  } as AppConfig;
}

function createRunner(addJob: AddJobFunction): Runner {
  return {
    addJob,
    stop: async () => {},
    promise: new Promise<void>(() => {}),
    events: { on: () => undefined } as never,
  };
}

describe("GraphileSchedulerService", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("runs Graphile migrations, starts a task-list runner, and seeds recurring jobs", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; payload: unknown; spec: unknown }> = [];
    const migrations: RunnerOptions[] = [];
    const runs: RunnerOptions[] = [];
    const addJob: AddJobFunction = async (identifier, payload, spec) => {
      jobs.push({ identifier, payload, spec });
      return { id: jobs.length } as never;
    };
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: { tick: async () => {} },
      myDayRefreshService: { listDueRefreshJobs: async () => [], refreshDueUser: async () => null },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async (options) => {
          migrations.push(options);
        },
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });

    await service.start();

    expect(migrations).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.connectionString).toBe("DATABASE_URL_PLACEHOLDER");
    expect(runs[0]?.concurrency).toBe(7);
    expect(runs[0]?.maxPoolSize).toBe(11);
    expect(runs[0]?.pollInterval).toBe(1_500);
    expect(runs[0]?.logger).toBeDefined();
    expect(Object.keys(runs[0]?.taskList ?? {}).sort()).toEqual(Object.values(graphileSchedulerTasks).sort());
    expect(jobs.map((job) => job.identifier).sort()).toEqual([
      graphileSchedulerTasks.myDayTick,
      graphileSchedulerTasks.patternTick,
      graphileSchedulerTasks.personalIntelligenceTick,
    ].sort());
    expect(jobs.map((job) => job.spec)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobKey: `finn:${graphileSchedulerTasks.patternTick}:2026-05-16T04:00:00.000Z`,
        queueName: "finn_scheduler",
        maxAttempts: 1,
      }),
    ]));
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      running: true,
      migrated: true,
      concurrency: 7,
      maxPoolSize: 11,
      pollIntervalMs: 1_500,
    });
  });

  it("executes domain ticks and reschedules the recurring task", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; spec: { runAt?: Date; jobKey?: string } | undefined }> = [];
    const addJob: AddJobFunction = async (identifier, _payload, spec) => {
      jobs.push({ identifier, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    let patternTicks = 0;
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: {
        tick: async () => {
          patternTicks += 1;
        },
      },
      myDayRefreshService: { listDueRefreshJobs: async () => [], refreshDueUser: async () => null },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    jobs.length = 0;

    const task = runs[0]?.taskList?.[graphileSchedulerTasks.patternTick];
    expect(task).toBeDefined();
    await task?.({}, { addJob } as never);

    expect(patternTicks).toBe(1);
    expect(jobs).toEqual([
      {
        identifier: graphileSchedulerTasks.patternTick,
        spec: expect.objectContaining({
          jobKey: `finn:${graphileSchedulerTasks.patternTick}:2026-05-16T04:01:00.000Z`,
          runAt: new Date("2026-05-16T04:01:00.000Z"),
        }),
      },
    ]);
  });

  it("uses a fresh recurring job key when rescheduling from a locked job", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; spec: { jobKey?: string } | undefined }> = [];
    const addJob: AddJobFunction = async (identifier, _payload, spec) => {
      jobs.push({ identifier, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: { tick: async () => {} },
      myDayRefreshService: { listDueRefreshJobs: async () => [], refreshDueUser: async () => null },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    const currentJobKey = `finn:${graphileSchedulerTasks.patternTick}:2026-05-16T04:00:00.000Z`;
    jobs.length = 0;

    await runs[0]?.taskList?.[graphileSchedulerTasks.patternTick]?.({}, { addJob } as never);

    expect(jobs[0]?.spec?.jobKey).toBe(`finn:${graphileSchedulerTasks.patternTick}:2026-05-16T04:01:00.000Z`);
    expect(jobs[0]?.spec?.jobKey).not.toBe(currentJobKey);
  });

  it("does not reschedule duplicate recurring ticks inside the duplicate window", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; spec: { runAt?: Date; jobKey?: string } | undefined }> = [];
    const addJob: AddJobFunction = async (identifier, _payload, spec) => {
      jobs.push({ identifier, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    let patternTicks = 0;
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: {
        tick: async () => {
          patternTicks += 1;
        },
      },
      myDayRefreshService: { listDueRefreshJobs: async () => [], refreshDueUser: async () => null },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    jobs.length = 0;

    const task = runs[0]?.taskList?.[graphileSchedulerTasks.patternTick];
    expect(task).toBeDefined();
    await task?.({}, { addJob } as never);
    await task?.({}, { addJob } as never);

    expect(patternTicks).toBe(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.identifier).toBe(graphileSchedulerTasks.patternTick);
  });

  it("fans My Day and Personal Intelligence ticks out to scoped execution jobs", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; payload: unknown; spec: unknown }> = [];
    const addJob: AddJobFunction = async (identifier, payload, spec) => {
      jobs.push({ identifier, payload, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: { tick: async () => {} },
      myDayRefreshService: {
        listDueRefreshJobs: async () => [{
          tenantId: "tenant_default",
          userId: "usr_123",
          scheduledAt: "2026-05-16T04:00:00.000Z",
          jobKey: "finn:my-day:tenant_default:usr_123:2026-05-16:0400",
        }],
        refreshDueUser: async () => null,
      },
      personalIntelligenceService: {
        listDueConnectorJobs: async () => [{
          tenantId: "tenant_default",
          userId: "usr_123",
          toolkitSlug: "gmail",
          accountScopeId: "gmail:email:user@example.com",
          connectedAccountId: "acct_gmail",
          scheduledAt: "2026-05-16T04:00:00.000Z",
          jobKey: "finn:personal-intelligence:tenant_default:usr_123:gmail:gmail:email:user@example.com:2026-05-16",
        }],
        ingestDueConnector: async () => null,
      },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    jobs.length = 0;

    await runs[0]?.taskList?.[graphileSchedulerTasks.myDayTick]?.({}, { addJob } as never);
    await runs[0]?.taskList?.[graphileSchedulerTasks.personalIntelligenceTick]?.({}, { addJob } as never);

    const myDayJob = jobs.find((job) => job.identifier === graphileSchedulerTasks.myDayRefreshUser);
    const personalIntelligenceJob = jobs.find((job) => job.identifier === graphileSchedulerTasks.personalIntelligenceConnector);
    const myDayRunAt = (myDayJob?.spec as { runAt?: Date } | undefined)?.runAt;
    const personalIntelligenceRunAt = (personalIntelligenceJob?.spec as { runAt?: Date } | undefined)?.runAt;

    expect(jobs).toEqual(expect.arrayContaining([
      {
        identifier: graphileSchedulerTasks.myDayRefreshUser,
        payload: expect.objectContaining({ userId: "usr_123" }),
        spec: expect.objectContaining({
          jobKey: "finn:my-day:tenant_default:usr_123:2026-05-16:0400",
          queueName: "finn_automation",
          maxAttempts: 1,
          runAt: expect.any(Date),
        }),
      },
      {
        identifier: graphileSchedulerTasks.personalIntelligenceConnector,
        payload: expect.objectContaining({ userId: "usr_123", toolkitSlug: "gmail", accountScopeId: "gmail:email:user@example.com", connectedAccountId: "acct_gmail" }),
        spec: expect.objectContaining({
          jobKey: "finn:personal-intelligence:tenant_default:usr_123:gmail:gmail:email:user@example.com:2026-05-16",
          queueName: "finn_automation",
          maxAttempts: 1,
          runAt: expect.any(Date),
        }),
      },
    ]));
    expect(myDayRunAt?.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-05-16T04:00:00.000Z"));
    expect(myDayRunAt?.getTime()).toBeLessThanOrEqual(Date.parse("2026-05-16T04:20:00.000Z"));
    expect(personalIntelligenceRunAt?.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-05-16T04:00:00.000Z"));
    expect(personalIntelligenceRunAt?.getTime()).toBeLessThanOrEqual(Date.parse("2026-05-16T05:00:00.000Z"));
  });

  it("uses stable scheduled jitter for repeated fanout of the same due job", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; payload: unknown; spec: unknown }> = [];
    const addJob: AddJobFunction = async (identifier, payload, spec) => {
      jobs.push({ identifier, payload, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: { tick: async () => {} },
      myDayRefreshService: {
        listDueRefreshJobs: async () => [{
          tenantId: "tenant_default",
          userId: "usr_123",
          scheduledAt: "2026-05-16T04:00:00.000Z",
          jobKey: "finn:my-day:tenant_default:usr_123:2026-05-16:0400",
        }],
        refreshDueUser: async () => null,
      },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    jobs.length = 0;

    await runs[0]?.taskList?.[graphileSchedulerTasks.myDayTick]?.({}, { addJob } as never);
    const firstRunAt = (jobs.find((job) => job.identifier === graphileSchedulerTasks.myDayRefreshUser)?.spec as { runAt?: Date }).runAt;
    jobs.length = 0;
    setSystemTime(new Date("2026-05-16T04:00:31.000Z"));

    await runs[0]?.taskList?.[graphileSchedulerTasks.myDayTick]?.({}, { addJob } as never);
    const secondRunAt = (jobs.find((job) => job.identifier === graphileSchedulerTasks.myDayRefreshUser)?.spec as { runAt?: Date }).runAt;

    expect(secondRunAt).toEqual(firstRunAt);
  });

  it("records task errors without dropping the next recurring job", async () => {
    setSystemTime(new Date("2026-05-16T04:00:00.000Z"));
    const jobs: Array<{ identifier: string; spec: unknown }> = [];
    const addJob: AddJobFunction = async (identifier, _payload, spec) => {
      jobs.push({ identifier, spec });
      return { id: jobs.length } as never;
    };
    const runs: RunnerOptions[] = [];
    const service = new GraphileSchedulerService({
      config: createConfig(),
      patternScheduler: {
        tick: async () => {
          throw new Error("database unavailable");
        },
      },
      myDayRefreshService: { listDueRefreshJobs: async () => [], refreshDueUser: async () => null },
      personalIntelligenceService: { listDueConnectorJobs: async () => [], ingestDueConnector: async () => null },
      users: { requireUser: async () => ({ userId: "usr_123", tenantId: "tenant_default", phoneNumber: "+15555550123", timezone: "UTC", timezoneSource: "manual", kidsMode: false }) },
      graphile: {
        migrate: async () => {},
        run: async (options) => {
          runs.push(options);
          return createRunner(addJob);
        },
      },
    });
    await service.start();
    jobs.length = 0;

    const task = runs[0]?.taskList?.[graphileSchedulerTasks.patternTick];
    await expect(task?.({}, { addJob } as never)).resolves.toBeUndefined();

    expect(service.getStatus().lastError).toBe("database unavailable");
    expect(service.getStatus().tasks[graphileSchedulerTasks.patternTick].lastError).toBe("database unavailable");
    expect(jobs).toHaveLength(1);
  });
});
