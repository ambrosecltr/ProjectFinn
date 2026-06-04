import { describe, expect, it, mock } from "bun:test";

import type { UserContext } from "@finn/core";
import type { StoredUser } from "@finn/db";
import type { MemoryClient } from "@finn/integrations";
import { syncUserProfileSeedToMemory } from "./memory-profile-seed.js";

const user: UserContext = {
  tenantId: "tenant_test",
  userId: "usr_test",
  phoneNumber: "+15555555555",
  displayName: "Alex",
  timezone: "Australia/Brisbane",
  timezoneSource: "browser",
  location: "Brisbane, Australia",
  kidsMode: false,
};

function createStoredUser(metadata: Record<string, unknown> | null = null): Pick<StoredUser, "id" | "metadata"> {
  return {
    id: user.userId,
    metadata,
  };
}

function createDb() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: async () => [],
        };
      },
    }),
  };

  return { db: db as never, updates };
}

function createMemoryClient(provider = "supermemory"): MemoryClient {
  return {
    provider,
    addDocument: mock(async () => ({ id: "doc_profile", status: "queued" })),
    searchDocuments: mock(async () => ({ ok: true as const, results: [] })),
    buildHotPathTurnCustomId: (messageId) => `hot-path-turn_${messageId}`,
    buildPatternRunCustomId: (patternRunId) => `pattern-run_${patternRunId}`,
  };
}

describe("syncUserProfileSeedToMemory", () => {
  it("writes a Supermemory core profile seed and stores a content hash", async () => {
    const memory = createMemoryClient();
    const { db, updates } = createDb();

    const result = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(),
      user,
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(result.synced).toBe(true);
    expect(memory.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      user,
      customId: "user-profile-seed",
      content: expect.stringContaining("Timezone: Australia/Brisbane"),
      source: expect.objectContaining({
        provider: "finn",
        type: "user_profile_seed",
        id: "core_profile",
      }),
      metadata: expect.objectContaining({
        kind: "user_profile_seed",
        source: "finn_core_profile",
        timezoneSource: "browser",
      }),
      observability: {
        operation: "retain_user_profile_seed",
      },
    }));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.metadata).toMatchObject({
      profile: {
        memoryProfileSeed: {
          provider: "supermemory",
          customId: "user-profile-seed",
          documentId: "doc_profile",
          status: "queued",
          contentHash: expect.any(String),
          syncedAt: "2026-05-31T05:00:00.000Z",
        },
      },
    });
  });

  it("does not rewrite an unchanged profile seed", async () => {
    const memory = createMemoryClient();
    const { db, updates } = createDb();
    const first = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(),
      user,
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    const second = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(updates[0]?.metadata as Record<string, unknown>),
      user,
      now: new Date("2026-05-31T06:00:00.000Z"),
    });

    expect(first.synced).toBe(true);
    expect(second).toEqual({ synced: false, reason: "unchanged" });
    expect(memory.addDocument).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });

  it("writes a Hindsight core profile seed", async () => {
    const memory = createMemoryClient("hindsight");
    const { db, updates } = createDb();

    const result = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(),
      user,
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(result.synced).toBe(true);
    expect(memory.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "user-profile-seed",
      content: expect.stringContaining("Timezone: Australia/Brisbane"),
    }));
    expect(updates[0]?.metadata).toMatchObject({
      profile: {
        memoryProfileSeed: {
          provider: "hindsight",
        },
      },
    });
  });

  it("writes a Honcho core profile seed", async () => {
    const memory = createMemoryClient("honcho");
    const { db, updates } = createDb();

    const result = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(),
      user,
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(result.synced).toBe(true);
    expect(memory.addDocument).toHaveBeenCalledWith(expect.objectContaining({
      customId: "user-profile-seed",
      content: expect.stringContaining("Timezone: Australia/Brisbane"),
    }));
    expect(updates[0]?.metadata).toMatchObject({
      profile: {
        memoryProfileSeed: {
          provider: "honcho",
        },
      },
    });
  });

  it("skips unsupported providers", async () => {
    const memory = createMemoryClient("none");
    const { db, updates } = createDb();

    const result = await syncUserProfileSeedToMemory({
      db,
      memory,
      storedUser: createStoredUser(),
      user,
      now: new Date("2026-05-31T05:00:00.000Z"),
    });

    expect(result).toEqual({ synced: false, reason: "unsupported_provider" });
    expect(memory.addDocument).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
