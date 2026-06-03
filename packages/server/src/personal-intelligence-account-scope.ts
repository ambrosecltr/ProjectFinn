import type { UserConnectorConfig } from "@finn/db";
import { puterPersonalIntelligenceAccountScopeId, puterToolkitSlug } from "./puter-connector.js";

export interface PersonalIntelligenceConnectorScope {
  toolkitSlug: string;
  accountScopeId: string;
  connectedAccountId: string;
}

export interface PersonalIntelligenceScopedConnectorConfig extends UserConnectorConfig {
  personalIntelligenceAccountScopeId?: string | null;
  personalIntelligenceIdentityStatus?: "unsupported" | "pending" | "resolved" | "failed";
}

export function getPersonalIntelligenceAccountScopeId(
  connector: Pick<UserConnectorConfig, "toolkitSlug" | "connectedAccountId"> & {
    personalIntelligenceAccountScopeId?: string | null;
    accountScopeId?: string | null;
  },
): string | null {
  const toolkitSlug = normalizeSlug(connector.toolkitSlug);
  if (toolkitSlug === puterToolkitSlug) {
    return puterPersonalIntelligenceAccountScopeId;
  }

  const explicitScope = connector.personalIntelligenceAccountScopeId?.trim() || connector.accountScopeId?.trim();
  if (explicitScope) {
    return explicitScope;
  }

  return null;
}

export function getPersonalIntelligenceConnectorScope(
  connector: Pick<UserConnectorConfig, "toolkitSlug" | "connectedAccountId"> & {
    personalIntelligenceAccountScopeId?: string | null;
    accountScopeId?: string | null;
  },
): PersonalIntelligenceConnectorScope | null {
  const connectedAccountId = connector.connectedAccountId?.trim();
  const accountScopeId = getPersonalIntelligenceAccountScopeId(connector);
  if (!connectedAccountId || !accountScopeId) {
    return null;
  }

  return {
    toolkitSlug: normalizeSlug(connector.toolkitSlug),
    accountScopeId,
    connectedAccountId,
  };
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
