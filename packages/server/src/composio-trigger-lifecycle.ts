import type { PatternRecord } from "@finn/core";
import type { PatternStore, UpdatePatternParams } from "@finn/patterns";

interface ComposioTriggerClient {
  enableTrigger(triggerId: string): Promise<void>;
  disableTrigger(triggerId: string): Promise<void>;
  deleteTrigger(triggerId: string): Promise<void>;
}

type LockablePatternStore = Pick<
  PatternStore,
  | "getById"
  | "update"
  | "setActive"
  | "remove"
  | "hasComposioTriggerUsers"
  | "hasOtherActiveComposioTriggerUsers"
  | "hasOtherComposioTriggerUsers"
> & Partial<Pick<PatternStore, "withComposioTriggerLock" | "withPatternLock">>;

async function withComposioTriggerLock<T>(
  patternStore: LockablePatternStore,
  triggerId: string,
  operation: (store: LockablePatternStore) => Promise<T>,
): Promise<T> {
  if (patternStore.withComposioTriggerLock) {
    return patternStore.withComposioTriggerLock(triggerId, (lockedStore) => operation(lockedStore));
  }
  return operation(patternStore);
}

async function withPatternLock<T>(
  patternStore: LockablePatternStore,
  patternId: string,
  operation: (store: LockablePatternStore) => Promise<T>,
): Promise<T> {
  if (patternStore.withPatternLock) {
    return patternStore.withPatternLock(patternId, (lockedStore) => operation(lockedStore));
  }
  return operation(patternStore);
}

async function withComposioTriggerLocks<T>(
  patternStore: LockablePatternStore,
  triggerIds: Array<string | undefined>,
  operation: (store: LockablePatternStore) => Promise<T>,
): Promise<T> {
  const lockIds = [...new Set(triggerIds.filter((triggerId): triggerId is string => Boolean(triggerId)))].sort();
  const lockNext = (store: LockablePatternStore, remainingLockIds: string[]): Promise<T> => {
    const [triggerId, ...rest] = remainingLockIds;
    if (!triggerId) {
      return operation(store);
    }
    return withComposioTriggerLock(store, triggerId, (lockedStore) => lockNext(lockedStore, rest));
  };

  return lockNext(patternStore, lockIds);
}

function getComposioTriggerId(pattern: PatternRecord | null | undefined): string | undefined {
  return pattern?.triggerConfig.type === "composio" ? pattern.triggerConfig.triggerId : undefined;
}

function getUpdateComposioTriggerId(params: UpdatePatternParams): string | undefined {
  return params.triggerConfig?.type === "composio" ? params.triggerConfig.triggerId : undefined;
}

async function syncActiveComposioTrigger(
  patternStore: LockablePatternStore,
  composio: ComposioTriggerClient,
  pattern: PatternRecord,
): Promise<void> {
  const triggerId = getComposioTriggerId(pattern);
  if (!triggerId) {
    return;
  }

  if (pattern.active) {
    await composio.enableTrigger(triggerId);
    return;
  }

  if (!await patternStore.hasOtherActiveComposioTriggerUsers(triggerId, pattern.id)) {
    await composio.disableTrigger(triggerId);
  }
}

export async function setPatternActiveWithComposioTriggerLifecycle(input: {
  patternStore: LockablePatternStore;
  composio?: ComposioTriggerClient;
  patternId: string;
  active: boolean;
}): Promise<PatternRecord | null> {
  const composio = input.composio;
  if (!composio) {
    return input.patternStore.setActive(input.patternId, input.active);
  }

  return withPatternLock(
    input.patternStore,
    input.patternId,
    async (patternLockedStore) => {
      const current = await patternLockedStore.getById(input.patternId);
      return withComposioTriggerLocks(patternLockedStore, [getComposioTriggerId(current)], async (lockedStore) => {
        const pattern = await lockedStore.setActive(input.patternId, input.active);
        if (pattern) {
          await syncActiveComposioTrigger(lockedStore, composio, pattern);
        }
        return pattern;
      });
    },
  );
}

export async function updatePatternWithComposioTriggerLifecycle(input: {
  patternStore: LockablePatternStore;
  composio?: ComposioTriggerClient;
  patternId: string;
  params: UpdatePatternParams;
}): Promise<PatternRecord | null> {
  const touchesComposioLifecycle = input.params.active !== undefined
    || input.params.triggerType !== undefined
    || input.params.triggerConfig !== undefined;
  if (!touchesComposioLifecycle) {
    return input.patternStore.update(input.patternId, input.params);
  }

  const composio = input.composio;
  if (!composio) {
    return input.patternStore.update(input.patternId, input.params);
  }

  return withPatternLock(
    input.patternStore,
    input.patternId,
    async (patternLockedStore) => {
      const current = await patternLockedStore.getById(input.patternId);
      return withComposioTriggerLocks(
        patternLockedStore,
        [getComposioTriggerId(current), getUpdateComposioTriggerId(input.params)],
        async (lockedStore) => {
          const pattern = await lockedStore.update(input.patternId, input.params);
          if (pattern && input.params.active !== undefined) {
            await syncActiveComposioTrigger(lockedStore, composio, pattern);
          }
          return pattern;
        },
      );
    },
  );
}

export async function removePatternWithComposioTriggerLifecycle(input: {
  patternStore: LockablePatternStore;
  composio?: ComposioTriggerClient;
  patternId: string;
}): Promise<PatternRecord | null> {
  const composio = input.composio;
  if (!composio) {
    return input.patternStore.remove(input.patternId);
  }

  return withPatternLock(
    input.patternStore,
    input.patternId,
    async (patternLockedStore) => {
      const current = await patternLockedStore.getById(input.patternId);
      const triggerId = getComposioTriggerId(current);
      return withComposioTriggerLocks(patternLockedStore, [triggerId], async (lockedStore) => {
        const deleted = await lockedStore.remove(input.patternId);
        if (deleted && triggerId && !await lockedStore.hasOtherComposioTriggerUsers(triggerId, deleted.id)) {
          await composio.deleteTrigger(triggerId);
        }
        return deleted;
      });
    },
  );
}

export async function deleteUnusedComposioTrigger(input: {
  patternStore: LockablePatternStore;
  composio?: ComposioTriggerClient;
  triggerId: string;
  excludedPatternId?: string;
}): Promise<void> {
  const composio = input.composio;
  if (!composio) {
    return;
  }

  await withComposioTriggerLock(input.patternStore, input.triggerId, async (lockedStore) => {
    const hasOtherUsers = input.excludedPatternId
      ? await lockedStore.hasOtherComposioTriggerUsers(input.triggerId, input.excludedPatternId)
      : await lockedStore.hasComposioTriggerUsers(input.triggerId);
    if (!hasOtherUsers) {
      await composio.deleteTrigger(input.triggerId);
    }
  });
}
