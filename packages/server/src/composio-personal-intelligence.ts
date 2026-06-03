import type { ComposioClient } from "@finn/integrations";
import type { PersonalIntelligenceAccountIdentity } from "./personal-intelligence-account-store.js";

export interface ComposioPersonalIntelligenceIdentity {
  accountScopeId: string;
  providerAccountType: string;
  providerAccountId: string;
  providerWorkspaceType?: string | null;
  providerWorkspaceId?: string | null;
  displayName?: string | null;
  email?: string | null;
  handle?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

interface ResolverInput {
  composio: ComposioClient;
  composioUserId: string;
  toolkitSlug: string;
  connectedAccountId: string;
}

interface PersonalIntelligenceToolkitDefinition {
  toolkitSlug: string;
  sourceTypes: readonly string[];
  displayName: string;
  resolver: (input: ResolverInput) => Promise<ComposioPersonalIntelligenceIdentity>;
}

const registry = new Map<string, PersonalIntelligenceToolkitDefinition>([
  ["gmail", {
    toolkitSlug: "gmail",
    sourceTypes: ["records"],
    displayName: "Gmail",
    resolver: resolveGmailIdentity,
  }],
  ["outlook", {
    toolkitSlug: "outlook",
    sourceTypes: ["records"],
    displayName: "Outlook",
    resolver: resolveOutlookIdentity,
  }],
  ["slack", {
    toolkitSlug: "slack",
    sourceTypes: ["records"],
    displayName: "Slack",
    resolver: resolveSlackIdentity,
  }],
  ["github", {
    toolkitSlug: "github",
    sourceTypes: ["records"],
    displayName: "GitHub",
    resolver: resolveGitHubIdentity,
  }],
  ["linear", {
    toolkitSlug: "linear",
    sourceTypes: ["records"],
    displayName: "Linear",
    resolver: resolveLinearIdentity,
  }],
]);

export function isComposioPersonalIntelligenceToolkitSupported(toolkitSlug: string): boolean {
  return registry.has(normalizeSlug(toolkitSlug));
}

export function getComposioPersonalIntelligenceToolkitDefinition(toolkitSlug: string): PersonalIntelligenceToolkitDefinition | null {
  return registry.get(normalizeSlug(toolkitSlug)) ?? null;
}

export async function resolveComposioPersonalIntelligenceIdentity(input: ResolverInput): Promise<PersonalIntelligenceAccountIdentity> {
  const definition = getComposioPersonalIntelligenceToolkitDefinition(input.toolkitSlug);
  if (!definition) {
    throw new Error(`Personal Intelligence is not supported for ${input.toolkitSlug}.`);
  }

  const resolved = await definition.resolver({
    ...input,
    toolkitSlug: definition.toolkitSlug,
  });
  return {
    toolkitSlug: definition.toolkitSlug,
    currentConnectedAccountId: input.connectedAccountId,
    identityStatus: "resolved",
    ...resolved,
    metadata: sanitizeIdentityMetadata(resolved.metadata),
  };
}

async function resolveGmailIdentity(input: ResolverInput): Promise<ComposioPersonalIntelligenceIdentity> {
  const profile = unwrapRecord(await input.composio.executeToolForConnectedAccount({
    userId: input.composioUserId,
    toolkitSlug: "gmail",
    connectedAccountId: input.connectedAccountId,
    toolSlug: "GMAIL_GET_PROFILE",
  }));
  const email = requireString(getFirst(profile, ["emailAddress", "email", "mail"]), "Gmail profile email").toLowerCase();
  return {
    accountScopeId: `gmail:email:${email}`,
    providerAccountType: "gmail_email",
    providerAccountId: email,
    email,
    displayName: getOptionalString(getFirst(profile, ["displayName", "name"])),
    metadata: {
      historyId: getOptionalString(profile.historyId) ?? null,
    },
  };
}

async function resolveOutlookIdentity(input: ResolverInput): Promise<ComposioPersonalIntelligenceIdentity> {
  let profile: Record<string, unknown>;
  try {
    profile = unwrapRecord(await input.composio.executeToolForConnectedAccount({
      userId: input.composioUserId,
      toolkitSlug: "outlook",
      connectedAccountId: input.connectedAccountId,
      toolSlug: "OUTLOOK_GET_PROFILE",
    }));
  } catch {
    profile = unwrapRecord(await input.composio.proxyExecuteForConnectedAccount({
      userId: input.composioUserId,
      toolkitSlug: "outlook",
      connectedAccountId: input.connectedAccountId,
      method: "GET",
      endpoint: "/me?$select=id,displayName,userPrincipalName,mail",
    }));
  }
  const id = requireString(profile.id, "Outlook user id");
  const mail = getOptionalString(profile.mail);
  const userPrincipalName = getOptionalString(profile.userPrincipalName);
  return {
    accountScopeId: `outlook:user:${id}`,
    providerAccountType: "microsoft_graph_user",
    providerAccountId: id,
    displayName: getOptionalString(profile.displayName),
    email: mail ?? userPrincipalName,
    metadata: {
      userPrincipalName: userPrincipalName ?? null,
      mail: mail ?? null,
    },
  };
}

async function resolveSlackIdentity(input: ResolverInput): Promise<ComposioPersonalIntelligenceIdentity> {
  const auth = unwrapRecord(await input.composio.executeToolForConnectedAccount({
    userId: input.composioUserId,
    toolkitSlug: "slack",
    connectedAccountId: input.connectedAccountId,
    toolSlug: "SLACK_TEST_AUTH",
  }));
  const teamId = requireString(getFirst(auth, ["team_id", "teamId"]), "Slack team id");
  const userId = getOptionalString(getFirst(auth, ["user_id", "userId", "user"]));
  const botId = getOptionalString(getFirst(auth, ["bot_id", "botId"]));
  const enterpriseId = getOptionalString(getFirst(auth, ["enterprise_id", "enterpriseId"]));
  const principalKind = userId ? "user" : "bot";
  const principalId = userId ?? requireString(botId, "Slack principal id");
  const accountScopeId = `slack:team:${teamId}:${principalKind}:${principalId}`;
  return {
    accountScopeId,
    providerAccountType: `slack_${principalKind}`,
    providerAccountId: principalId,
    providerWorkspaceType: "slack_team",
    providerWorkspaceId: teamId,
    displayName: getOptionalString(getFirst(auth, ["user", "bot", "team"])) ?? null,
    metadata: {
      teamId,
      enterpriseId: enterpriseId ?? null,
      principalKind,
    },
  };
}

async function resolveGitHubIdentity(input: ResolverInput): Promise<ComposioPersonalIntelligenceIdentity> {
  let user: Record<string, unknown>;
  try {
    user = unwrapRecord(await input.composio.executeToolForConnectedAccount({
      userId: input.composioUserId,
      toolkitSlug: "github",
      connectedAccountId: input.connectedAccountId,
      toolSlug: "GITHUB_GET_THE_AUTHENTICATED_USER",
    }));
  } catch {
    user = unwrapRecord(await input.composio.proxyExecuteForConnectedAccount({
      userId: input.composioUserId,
      toolkitSlug: "github",
      connectedAccountId: input.connectedAccountId,
      method: "GET",
      endpoint: "/user",
    }));
  }
  const id = String(requireString(user.id, "GitHub user id"));
  return {
    accountScopeId: `github:user:${id}`,
    providerAccountType: "github_user",
    providerAccountId: id,
    displayName: getOptionalString(user.name) ?? getOptionalString(user.login),
    email: getOptionalString(user.email),
    handle: getOptionalString(user.login),
    metadata: {
      nodeId: getOptionalString(user.node_id) ?? null,
    },
  };
}

async function resolveLinearIdentity(input: ResolverInput): Promise<ComposioPersonalIntelligenceIdentity> {
  const viewer = unwrapRecord(await input.composio.executeToolForConnectedAccount({
    userId: input.composioUserId,
    toolkitSlug: "linear",
    connectedAccountId: input.connectedAccountId,
    toolSlug: "LINEAR_GET_CURRENT_USER",
  }));
  const viewerId = requireString(getFirst(viewer, ["id", "viewerId"]), "Linear viewer id");
  let organization: Record<string, unknown> | null = null;
  try {
    organization = unwrapRecord(await input.composio.executeToolForConnectedAccount({
      userId: input.composioUserId,
      toolkitSlug: "linear",
      connectedAccountId: input.connectedAccountId,
      toolSlug: "LINEAR_RUN_QUERY_OR_MUTATION",
      arguments: {
        query: "query { viewer { id name email } organization { id name urlKey } }",
      },
    })).organization as Record<string, unknown> | null;
  } catch {
    organization = null;
  }
  const organizationId = getOptionalString(organization?.id);
  return {
    accountScopeId: organizationId
      ? `linear:org:${organizationId}:user:${viewerId}`
      : `linear:user:${viewerId}`,
    providerAccountType: "linear_user",
    providerAccountId: viewerId,
    providerWorkspaceType: organizationId ? "linear_organization" : null,
    providerWorkspaceId: organizationId,
    displayName: getOptionalString(getFirst(viewer, ["name", "displayName"])),
    email: getOptionalString(viewer.email),
    metadata: {
      organizationName: getOptionalString(organization?.name) ?? null,
      organizationUrlKey: getOptionalString(organization?.urlKey) ?? null,
    },
  };
}

function unwrapRecord(value: unknown): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      break;
    }
    const record = current as Record<string, unknown>;
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      current = record.data;
      continue;
    }
    if (record.response && typeof record.response === "object" && !Array.isArray(record.response)) {
      current = record.response;
      continue;
    }
    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      current = record.result;
      continue;
    }
    return record;
  }
  throw new Error("Identity resolver returned an invalid response.");
}

function getFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function requireString(value: unknown, label: string): string {
  const normalized = getOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is missing from Personal Intelligence identity resolver response.`);
  }
  return normalized;
}

function getOptionalString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function sanitizeIdentityMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}
