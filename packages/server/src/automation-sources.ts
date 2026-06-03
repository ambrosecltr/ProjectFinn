import type { UserConnectorConfig } from "@finn/db";
import type { PatternStore } from "@finn/patterns";
import { puterToolkitSlug } from "./puter-connector.js";

export type AutomationConnectorFeature = "my_day" | "personal_intelligence";

export interface AutomationSourceItem {
  id: string;
  toolkitSlug: string;
  type: "mail" | "calendar" | "pattern_run" | "memory" | "connector";
  title: string;
  timestamp?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

const maxSummaryLength = 900;

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3).trim()}...`;
}

export function getEnabledAutomationConnectors(input: {
  configs: UserConnectorConfig[];
  feature: AutomationConnectorFeature;
}): UserConnectorConfig[] {
  return input.configs.filter((config) => config.connected
    && Boolean(config.connectedAccountId)
    && (input.feature === "my_day" ? config.myDayEnabled : isPersonalIntelligenceConnectorRunnable(config)));
}

function isPersonalIntelligenceConnectorRunnable(config: UserConnectorConfig): boolean {
  if (!config.personalIntelligenceEnabled) {
    return false;
  }
  if (config.toolkitSlug === puterToolkitSlug) {
    return true;
  }

  const enriched = config as UserConnectorConfig & {
    personalIntelligenceAccountScopeId?: string | null;
    personalIntelligenceIdentityStatus?: string | null;
  };
  return enriched.personalIntelligenceIdentityStatus === "resolved"
    && Boolean(enriched.personalIntelligenceAccountScopeId?.trim());
}

export function buildConnectorStatusItems(connectors: UserConnectorConfig[]): AutomationSourceItem[] {
  return connectors.map((connector) => ({
    id: `connector:${connector.toolkitSlug}:${connector.connectedAccountId ?? "connected"}`,
    toolkitSlug: connector.toolkitSlug,
    type: "connector",
    title: `${connector.toolkitName ?? connector.toolkitSlug} connected`,
    summary: `${connector.toolkitName ?? connector.toolkitSlug} is enabled for automation. Use scoped read tools for this toolkit when available; skip noisy promotional or low-signal material.`,
    metadata: {
      toolkitSlug: connector.toolkitSlug,
      connectedAccountId: connector.connectedAccountId,
      permissionMode: connector.permissionMode,
    },
  }));
}

export async function collectPatternRunItems(input: {
  patternStore: PatternStore;
  limit?: number;
}): Promise<AutomationSourceItem[]> {
  const patterns = await input.patternStore.listActive();
  const limit = input.limit ?? 10;
  const runItems = await Promise.all(patterns.map(async (pattern): Promise<AutomationSourceItem | null> => {
    const [run] = await input.patternStore.listRuns({ patternId: pattern.id, limit: 1 });
    if (!run) {
      return null;
    }

    const summary = run.notifyOutcome?.summary ?? run.result?.summary ?? run.error ?? run.skipReason ?? "Pattern run recorded.";
    return {
      id: run.id,
      toolkitSlug: "finn",
      type: "pattern_run" as const,
      title: pattern.name,
      timestamp: (run.completedAt ?? run.startedAt ?? run.createdAt).toISOString(),
      summary: truncate(summary, maxSummaryLength),
      metadata: {
        patternId: pattern.id,
        state: run.state,
        triggeredBy: run.triggeredBy,
        notified: run.notifyOutcome?.notify ?? null,
      },
    };
  }));
  const runs = runItems
    .filter((item): item is AutomationSourceItem => item !== null)
    .sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""));

  return runs.slice(0, limit);
}
