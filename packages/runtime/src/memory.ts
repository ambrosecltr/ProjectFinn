import type { UserContext } from "@finn/core";
import { MemoryRecorder, type MemoryClient, type MemoryProfileContextInput, type MemoryRecorderUser, type MemoryReflectInput, type MemorySearchInput } from "@finn/integrations";

export type MemoryRuntimeUser = Pick<UserContext, "tenantId" | "userId" | "timezone">;

export interface MemoryRuntimeService {
  readonly kind: "finn-memory-runtime";
  readonly provider: string;
  readonly user: MemoryRuntimeUser;
  readonly recorder: MemoryRecorder;
  readonly reflectAvailable: boolean;
  searchDocuments(input: Omit<MemorySearchInput, "user">): ReturnType<MemoryClient["searchDocuments"]>;
  buildContext?: (input: Omit<MemorySearchInput, "user">) => ReturnType<NonNullable<MemoryClient["buildContext"]>>;
  buildProfileContext?: (input: Omit<MemoryProfileContextInput, "user">) => ReturnType<NonNullable<MemoryClient["buildProfileContext"]>>;
  reflectMemory?: (input: Omit<MemoryReflectInput, "user">) => ReturnType<NonNullable<MemoryClient["reflectMemory"]>>;
}

const profileContextTtlMs = 10 * 60_000;

export function createMemoryRuntimeService(input: {
  client: MemoryClient;
  user: MemoryRuntimeUser;
}): MemoryRuntimeService {
  const memoryUser = toMemoryRecorderUser(input.user);
  const recorder = new MemoryRecorder({ client: input.client, user: memoryUser });
  let profileCache: {
    expiresAt: number;
    value: Awaited<ReturnType<NonNullable<MemoryClient["buildProfileContext"]>>>;
  } | null = null;

  return {
    kind: "finn-memory-runtime",
    provider: input.client.provider,
    user: memoryUser,
    recorder,
    reflectAvailable: Boolean(input.client.reflectMemory),
    searchDocuments: (params) => input.client.searchDocuments({
      ...params,
        user: memoryUser,
    }),
    ...(input.client.buildContext
      ? {
          buildContext: (params) => input.client.buildContext!({
            ...params,
            user: memoryUser,
          }),
        }
      : {}),
    ...(input.client.buildProfileContext
      ? {
          buildProfileContext: async (params) => {
            const now = Date.now();
            if (profileCache && profileCache.expiresAt > now) {
              return profileCache.value;
            }

            const value = await input.client.buildProfileContext!({
              ...params,
              user: memoryUser,
            });
            if (value.ok) {
              profileCache = {
                value,
                expiresAt: now + profileContextTtlMs,
              };
            }
            return value;
          },
        }
      : {}),
    ...(input.client.reflectMemory
      ? {
          reflectMemory: (params) => input.client.reflectMemory!({
            ...params,
            user: memoryUser,
          }),
        }
      : {}),
  };
}

function toMemoryRecorderUser(user: MemoryRuntimeUser): MemoryRecorderUser {
  return {
    tenantId: user.tenantId,
    userId: user.userId,
    timezone: user.timezone || "UTC",
  };
}
