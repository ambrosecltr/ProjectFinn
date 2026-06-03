import { createLogger, type EventBus, type PatternConnectorIssue, type PatternRecord, type PatternTriggerConfig } from "@finn/core";
import type { UserConnectorConfig } from "@finn/db";
import type { ComposioClient } from "@finn/integrations";
import { addComposioConnectorIssue, replaceComposioConnectorAccount, patternUsesComposioConnector } from "@finn/patterns";
import type { PatternStore } from "@finn/patterns";
import { emitPatternActivity } from "./activity-feed.js";

const logger = createLogger("composio-pattern-lifecycle");

export interface PatternConnectorIssueView extends PatternConnectorIssue {
  toolkitName?: string;
}

export interface ConnectorPatternImpactItem {
  id: string;
  name: string;
  triggerType: PatternRecord["triggerType"];
}

export interface ConnectorDisconnectImpact {
  toolkitSlug: string;
  toolkitName?: string;
  patterns: ConnectorPatternImpactItem[];
  scheduledPatterns: ConnectorPatternImpactItem[];
  triggerPatterns: ConnectorPatternImpactItem[];
}

function summarizePattern(pattern: PatternRecord): ConnectorPatternImpactItem {
  return {
    id: pattern.id,
    name: pattern.name,
    triggerType: pattern.triggerType,
  };
}

function triggerConfigWithoutId(triggerConfig: Extract<PatternTriggerConfig, { type: "composio" }>): Extract<PatternTriggerConfig, { type: "composio" }> {
  const { triggerId: _triggerId, ...nextTriggerConfig } = triggerConfig;
  return nextTriggerConfig;
}

function dedupeIssues(issues: PatternConnectorIssueView[]): PatternConnectorIssueView[] {
  const deduped = new Map<string, PatternConnectorIssueView>();
  for (const issue of issues) {
    const key = `${issue.toolkitSlug}:${issue.connectedAccountId ?? ""}`;
    deduped.set(key, issue);
  }
  return [...deduped.values()];
}

function findReconnectIssue(
  issues: PatternConnectorIssue[] | undefined,
  toolkitSlug: string,
  previousConnectedAccountId?: string | null,
): PatternConnectorIssue | undefined {
  return issues?.find((issue) => {
    if (issue.toolkitSlug !== toolkitSlug) {
      return false;
    }
    return !previousConnectedAccountId || !issue.connectedAccountId || issue.connectedAccountId === previousConnectedAccountId;
  });
}

export async function getComposioConnectorDisconnectImpact(
  patternStore: PatternStore,
  input: { toolkitSlug: string; toolkitName?: string; connectedAccountId?: string | null },
): Promise<ConnectorDisconnectImpact> {
  const patterns = input.connectedAccountId
    ? await patternStore.listByComposioConnector(input.toolkitSlug, input.connectedAccountId)
    : await patternStore.listByComposioConnector(input.toolkitSlug);
  const impactPatterns = patterns.filter((pattern) => pattern.workerType !== "reminder");
  return {
    toolkitSlug: input.toolkitSlug,
    ...(input.toolkitName ? { toolkitName: input.toolkitName } : {}),
    patterns: impactPatterns.map(summarizePattern),
    scheduledPatterns: impactPatterns.filter((pattern) => pattern.triggerConfig.type === "schedule").map(summarizePattern),
    triggerPatterns: impactPatterns.filter((pattern) => pattern.triggerConfig.type === "composio").map(summarizePattern),
  };
}

export function resolvePatternConnectorIssues(
  pattern: PatternRecord,
  connectors: ReadonlyMap<string, UserConnectorConfig>,
): PatternConnectorIssueView[] {
  const now = new Date().toISOString();
  const references = [
    ...pattern.connectorScope.composio.map((scope) => ({
      toolkitSlug: scope.toolkitSlug,
      connectedAccountId: scope.connectedAccountId,
    })),
    ...(pattern.triggerConfig.type === "composio"
      ? [{
          toolkitSlug: pattern.triggerConfig.toolkitSlug,
          connectedAccountId: pattern.triggerConfig.connectedAccountId,
        }]
      : []),
  ];
  const computedIssues = references.flatMap((reference): PatternConnectorIssueView[] => {
    const connector = connectors.get(reference.toolkitSlug);
    const base = {
      type: "composio_connector_unavailable" as const,
      toolkitSlug: reference.toolkitSlug,
      ...(reference.connectedAccountId ? { connectedAccountId: reference.connectedAccountId } : {}),
      pausedAt: now,
      resumeOnReconnect: false,
      ...(connector?.toolkitName ? { toolkitName: connector.toolkitName } : {}),
    };

    if (!connector?.connected) {
      return [{ ...base, reason: "disconnected" }];
    }
    if (reference.connectedAccountId && connector.connectedAccountId !== reference.connectedAccountId) {
      return [{ ...base, reason: "account_replaced" }];
    }
    return [];
  });
  const persistedIssues = (pattern.connectorScope.issues ?? []).map((issue) => {
    const connector = connectors.get(issue.toolkitSlug);
    return {
      ...issue,
      ...(connector?.toolkitName ? { toolkitName: connector.toolkitName } : {}),
    };
  });
  return dedupeIssues([...persistedIssues, ...computedIssues]);
}

export async function pausePatternsForComposioConnector(
  deps: {
    patternStore: PatternStore;
    composio?: ComposioClient;
    eventBus?: EventBus;
  },
  input: {
    toolkitSlug: string;
    connectedAccountId?: string | null;
    reason: PatternConnectorIssue["reason"];
    origin?: "web" | "system";
  },
): Promise<PatternRecord[]> {
  const patterns = input.connectedAccountId
    ? await deps.patternStore.listByComposioConnector(input.toolkitSlug, input.connectedAccountId)
    : await deps.patternStore.listByComposioConnector(input.toolkitSlug);
  const updatedPatterns: PatternRecord[] = [];
  const deletedTriggerIds = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.workerType === "reminder") {
      continue;
    }

    if (pattern.triggerConfig.type === "composio" && pattern.triggerConfig.triggerId && deps.composio && !deletedTriggerIds.has(pattern.triggerConfig.triggerId)) {
      try {
        await deps.composio.deleteTrigger(pattern.triggerConfig.triggerId);
        deletedTriggerIds.add(pattern.triggerConfig.triggerId);
      } catch (error) {
        logger.warn({ error, patternId: pattern.id, triggerId: pattern.triggerConfig.triggerId }, "Failed to delete Composio trigger while pausing Pattern");
      }
    }

    const updated = await deps.patternStore.update(pattern.id, {
      active: false,
      nextRunAt: null,
      connectorScope: addComposioConnectorIssue(pattern.connectorScope, {
        toolkitSlug: input.toolkitSlug,
        ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
        reason: input.reason,
        resumeOnReconnect: pattern.active,
      }),
      ...(pattern.triggerConfig.type === "composio"
        ? { triggerConfig: triggerConfigWithoutId(pattern.triggerConfig) }
        : {}),
    });
    if (updated) {
      updatedPatterns.push(updated);
      if (deps.eventBus && pattern.active) {
        emitPatternActivity({ eventBus: deps.eventBus, pattern: updated, action: "paused", origin: input.origin ?? "system" });
      }
    }
  }

  return updatedPatterns;
}

export async function rehydratePatternsForComposioConnector(
  deps: {
    patternStore: PatternStore;
    composio?: ComposioClient;
    eventBus?: EventBus;
  },
  input: {
    composioUserId: string;
    toolkitSlug: string;
    connectedAccountId: string;
    previousConnectedAccountId?: string | null;
    origin?: "web" | "system";
  },
): Promise<PatternRecord[]> {
  const patterns = await deps.patternStore.listByComposioConnector(input.toolkitSlug);
  const updatedPatterns: PatternRecord[] = [];
  const deletedStaleTriggerIds = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.workerType === "reminder") {
      continue;
    }
    const issue = findReconnectIssue(pattern.connectorScope.issues, input.toolkitSlug, input.previousConnectedAccountId);
    const previousConnectedAccountId = input.previousConnectedAccountId ?? issue?.connectedAccountId ?? null;
    const hasStoredIssue = Boolean(issue);
    const hasPreviousAccountReference = previousConnectedAccountId
      ? patternUsesComposioConnector(pattern, input.toolkitSlug, previousConnectedAccountId)
      : false;
    const hasUnpinnedToolkitReference = !previousConnectedAccountId
      && (
        pattern.connectorScope.composio.some((scope) => scope.toolkitSlug === input.toolkitSlug && !scope.connectedAccountId)
      );

    if (!hasStoredIssue && !hasPreviousAccountReference && !hasUnpinnedToolkitReference) {
      continue;
    }

    const resumeOnReconnect = issue ? issue.resumeOnReconnect === true : pattern.active;
    let triggerConfig = pattern.triggerConfig;
    if (pattern.triggerConfig.type === "composio") {
      if (!deps.composio) {
        const updated = await deps.patternStore.update(pattern.id, {
          active: false,
          nextRunAt: null,
          connectorScope: addComposioConnectorIssue(pattern.connectorScope, {
            toolkitSlug: input.toolkitSlug,
            ...(previousConnectedAccountId ? { connectedAccountId: previousConnectedAccountId } : {}),
            reason: "account_replaced",
            resumeOnReconnect,
          }),
          triggerConfig: triggerConfigWithoutId(pattern.triggerConfig),
        });
        if (updated) {
          updatedPatterns.push(updated);
          if (deps.eventBus && pattern.active) {
            emitPatternActivity({ eventBus: deps.eventBus, pattern: updated, action: "paused", origin: input.origin ?? "system" });
          }
        }
        continue;
      }

      try {
        if (pattern.triggerConfig.triggerId && !deletedStaleTriggerIds.has(pattern.triggerConfig.triggerId)) {
          await deps.composio.deleteTrigger(pattern.triggerConfig.triggerId).catch((error: unknown) => {
            logger.warn({ error, patternId: pattern.id, triggerId: pattern.triggerConfig.type === "composio" ? pattern.triggerConfig.triggerId : undefined }, "Failed to delete stale Composio trigger while rehydrating Pattern");
          });
          deletedStaleTriggerIds.add(pattern.triggerConfig.triggerId);
        }
        const createdTrigger = await deps.composio.createTrigger(input.composioUserId, pattern.triggerConfig.triggerSlug, {
          connectedAccountId: input.connectedAccountId,
          ...(pattern.triggerConfig.triggerConfig ? { triggerConfig: pattern.triggerConfig.triggerConfig } : {}),
        });
        const trigger = createdTrigger as { triggerId?: string; id?: string };
        const triggerId = trigger.triggerId ?? trigger.id;
        if (!triggerId) {
          throw new Error("Composio did not return a trigger ID.");
        }
        triggerConfig = {
          ...pattern.triggerConfig,
          connectedAccountId: input.connectedAccountId,
          triggerId,
        };
      } catch (error) {
        logger.error({ error, patternId: pattern.id, toolkitSlug: input.toolkitSlug }, "Failed to recreate Composio trigger while rehydrating Pattern");
        const updated = await deps.patternStore.update(pattern.id, {
          active: false,
          nextRunAt: null,
          connectorScope: addComposioConnectorIssue(pattern.connectorScope, {
            toolkitSlug: input.toolkitSlug,
            ...(previousConnectedAccountId ? { connectedAccountId: previousConnectedAccountId } : {}),
            reason: "account_replaced",
            resumeOnReconnect,
          }),
          triggerConfig: triggerConfigWithoutId(pattern.triggerConfig),
        });
        if (updated) {
          updatedPatterns.push(updated);
          if (deps.eventBus && pattern.active) {
            emitPatternActivity({ eventBus: deps.eventBus, pattern: updated, action: "paused", origin: input.origin ?? "system" });
          }
        }
        continue;
      }
    }

    const updated = await deps.patternStore.update(pattern.id, {
      connectorScope: replaceComposioConnectorAccount(pattern.connectorScope, input.toolkitSlug, input.connectedAccountId, {
        ensureToolkitScope: pattern.triggerConfig.type === "composio" && pattern.triggerConfig.toolkitSlug === input.toolkitSlug,
        previousConnectedAccountId,
      }),
      ...(triggerConfig !== pattern.triggerConfig ? { triggerConfig } : {}),
      ...(resumeOnReconnect ? { active: true } : {}),
    });
    if (updated) {
      updatedPatterns.push(updated);
      if (deps.eventBus && resumeOnReconnect) {
        emitPatternActivity({ eventBus: deps.eventBus, pattern: updated, action: "resumed", origin: input.origin ?? "system" });
      }
    }
  }

  return updatedPatterns;
}
