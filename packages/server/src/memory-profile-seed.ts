import { createHash } from "node:crypto";

import type { UserContext } from "@finn/core";
import type { Database, StoredUser } from "@finn/db";
import * as schema from "@finn/db";
import { buildUserProfileSeedMemoryDocument, USER_PROFILE_SEED_CUSTOM_ID, type MemoryClient } from "@finn/integrations";
import { eq } from "drizzle-orm";

type MemoryProfileSeedState = {
  provider?: unknown;
  customId?: unknown;
  documentId?: unknown;
  status?: unknown;
  contentHash?: unknown;
  syncedAt?: unknown;
};

export type UserProfileSeedSyncResult =
  | { synced: true; contentHash: string; documentId: string; status: string }
  | { synced: false; reason: "memory_unavailable" | "unsupported_provider" | "empty_profile" | "unchanged" | "provider_failed" };

function hashSeedContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getMemoryProfileSeedState(metadata: Record<string, unknown> | null | undefined): MemoryProfileSeedState | null {
  const profile = isRecord(metadata?.profile) ? metadata.profile : null;
  const state = isRecord(profile?.memoryProfileSeed) ? profile.memoryProfileSeed : null;
  return state;
}

function withMemoryProfileSeedState(
  metadata: Record<string, unknown> | null | undefined,
  state: Required<Pick<MemoryProfileSeedState, "provider" | "customId" | "documentId" | "status" | "contentHash" | "syncedAt">>,
): Record<string, unknown> {
  const currentMetadata = isRecord(metadata) ? metadata : {};
  const currentProfile = isRecord(currentMetadata.profile) ? currentMetadata.profile : {};
  return {
    ...currentMetadata,
    profile: {
      ...currentProfile,
      memoryProfileSeed: state,
    },
  };
}

export async function syncUserProfileSeedToMemory(input: {
  db: Database;
  memory?: MemoryClient;
  storedUser: Pick<StoredUser, "id" | "metadata">;
  user: UserContext;
  now?: Date;
}): Promise<UserProfileSeedSyncResult> {
  const memory = input.memory;
  if (!memory) {
    return { synced: false, reason: "memory_unavailable" };
  }

  if (memory.provider !== "supermemory" && memory.provider !== "hindsight" && memory.provider !== "honcho") {
    return { synced: false, reason: "unsupported_provider" };
  }

  const document = buildUserProfileSeedMemoryDocument({
    user: input.user,
    timestamp: input.now,
  });
  if (!document) {
    return { synced: false, reason: "empty_profile" };
  }

  const contentHash = hashSeedContent(document.content);
  const existing = getMemoryProfileSeedState(input.storedUser.metadata);
  if (existing?.provider === memory.provider && existing.contentHash === contentHash) {
    return { synced: false, reason: "unchanged" };
  }

  const result = await memory.addDocument({
    user: input.user,
    customId: USER_PROFILE_SEED_CUSTOM_ID,
    content: document.content,
    source: document.source,
    metadata: document.metadata,
    observability: {
      operation: "retain_user_profile_seed",
    },
  });
  if (!result) {
    return { synced: false, reason: "provider_failed" };
  }

  const syncedAt = (input.now ?? new Date()).toISOString();
  await input.db
    .update(schema.users)
    .set({
      metadata: withMemoryProfileSeedState(input.storedUser.metadata, {
        provider: memory.provider,
        customId: USER_PROFILE_SEED_CUSTOM_ID,
        documentId: result.id,
        status: result.status,
        contentHash,
        syncedAt,
      }),
    })
    .where(eq(schema.users.id, input.storedUser.id));

  return {
    synced: true,
    contentHash,
    documentId: result.id,
    status: result.status,
  };
}
