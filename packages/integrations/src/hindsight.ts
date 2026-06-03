import { createHash } from "node:crypto";
import { createLogger, type UserContext } from "@finn/core";
import type {
  MemoryAddDocumentInput,
  MemoryAddDocumentResponse,
  MemoryConversationMessage,
  MemoryClient,
  MemoryContextResponse,
  MemoryContextResult,
  MemoryFactType,
  MemoryMetadata,
  MemoryProfileContextInput,
  MemoryProfileContextResponse,
  MemoryReflectEvidence,
  MemoryReflectInput,
  MemoryReflectResponse,
  MemorySearchInput,
  MemorySearchResponse,
  MemorySearchResult,
} from "./memory.js";
import { getDefaultMemoryOperation, getMemoryLogContext, getSafeMemoryFailureReason } from "./memory.js";

const logger = createLogger("hindsight");

const booleanMetadataKeys = new Set(["delivered", "notified", "oneShot", "surfaced"]);

const userRetainMission = [
  "Extract source-grounded understanding that helps Finn know the user as a whole person and a real daily life, like an attentive personal intelligence.",
  "Prioritize stable identity/profile facts, important relationships, family and household context, pets, responsibilities, work and personal projects,",
  "long-lived commitments, meaningful preferences, routines, constraints, support needs, communication style, explicit corrections, and what Finn has already told the user.",
  "Also notice the smaller, telling details of everyday life that build a richer picture over time: interests, hobbies, tastes, likes and dislikes, recurring habits, places they go, and things they care about, even when minor. These are valuable signal, not noise.",
  "Capture each as what it is: durable facts as stable understanding, and evolving day-to-day texture as lighter, time-stamped context rather than permanent identity claims.",
  "Use source metadata for provenance and attribution, but do not treat connector names, raw IDs, or Finn process names as personality facts.",
  "Treat Finn operational records like Patterns, reminders, My Day todos, runs, setup confirmations, cancellations, pauses, and archives as operational state; retain only the current state or durable user preference they prove.",
  "Preserve uncertainty: when the exact relationship label is not proven, retain the narrower supported fact rather than overclaiming.",
  "Do not classify vendors, support representatives, automated senders, companies, or one-off correspondents as important personal relationships unless sources show an ongoing personal relationship.",
  "Treat health, legal, financial, insurance, family-member, mental-health, security, and identity-document material as sensitive: keep it narrow, factual, and directly source-grounded.",
  "Ignore greetings, filler, jokes, sarcasm, memes, teasing, banter, hyperbole, speculative comments, hypothetical scenarios, assistant jokes, tool/process chatter, internal implementation details, marketing, boilerplate, tracking, and raw identifiers unless they support understanding of the user.",
  "Routine logistics exchanges such as shopping lists, errands, and one-word replies (for example \"skim x\", \"steakhouse x\") are usually transient: do not store the literal message as a durable fact, but you may extract a durable preference or habit it reveals (for example a recurring grocery store or dietary preference).",
  "A passing mood or one-off state is fine to note as transient context, but do not convert it, or a humorous or hypothetical remark, into a durable trait, real relationship status, scheduled future event, commitment, or crisis. When in doubt about durability, retain it as transient rather than as a permanent fact.",
].join(" ");

const userObservationsMission = [
  "Build a coherent, evidence-grounded portrait of the user as a person and their daily life: relationships, family and household life, pets, responsibilities, routines, projects, preferences, interests, habits, constraints, support needs, communication style, and contradictions.",
  "Maintain ONE canonical observation per distinct person, relationship, topic, interest, or constraint. When new evidence relates to something you already track, strengthen, correct, or extend that existing observation instead of creating another near-duplicate. The user should be described by a small set of evolving observations, not many overlapping fragments.",
  "For example, all evidence about one person belongs in that person's single relationship observation; repeated mentions of the same constraint, interest, or habit belong in one observation that deepens over time.",
  "Consolidate all health, accessibility, and life-constraint evidence into a single clear standing-constraints observation that states the constraint and what it means in practice for how Finn should help, rather than scattering related medical or accessibility facts across many observations.",
  "Preserve uncertainty. If evidence supports a close relationship but not the exact label, say close household or family connection rather than inventing spouse, child, or parent.",
  "Keep relationship observations limited to people with evidence of personal significance; vendors, service providers, automated senders, and companies should remain service/contact context unless clearly personal.",
  "Value the smaller, recurring details of everyday life: tastes, hobbies, places, routines, and what the user enjoys or avoids are part of knowing them well. Capture these, but as durable patterns only once they recur or are clearly stable, not from a single passing mention.",
  "Do not promote ephemeral states to durable observations. Passing moods, one-off errands, a single day's plans, momentary stress, and daily logistics are transient: reflect them only as current/temporary context if at all, and never as standing traits.",
  "Operational Finn state belongs in narrow state observations, not user-profile conclusions, and is not a personal interest or goal. Do not turn archived todos, cancelled Patterns, reminders, test tasks, or run history into active goals, hobbies, or personality.",
  "Keep sensitive domains narrow and factual. Do not turn marketing, boilerplate, raw transaction details, jokes, sarcasm, temporary states, or internal process artifacts into personality conclusions.",
].join(" ");

const userReflectMission = [
  "You are Finn's personal intelligence memory layer. Help Finn understand the user like a close, observant companion who knows both the big picture and the small details of their daily life,",
  "using memories as evidence while distinguishing durable personal truth from jokes, banter, temporary emotions, and uncertainty.",
  "Always synthesize the best-supported picture of the user from the available memories, and note your confidence when evidence is thin or mixed.",
  "When the user has standing health, accessibility, or life constraints, surface them prominently, because they shape how Finn should help; never bury them.",
  "Draw on the smaller, telling details too: interests, routines, tastes, and recurring habits are part of knowing someone well and make the picture specific and human.",
  "Only say information is unavailable when there is genuinely no relevant memory; do not refuse to answer simply because evidence is partial or indirect.",
  "Be warm, specific, and contextual rather than hedging everything into vagueness.",
].join(" ");

interface FinnManagedMentalModelDefinition {
  id: string;
  name: string;
  sourceQuery: string;
  surface: "static" | "dynamic";
}

const finnManagedUserMentalModels: readonly FinnManagedMentalModelDefinition[] = [
  {
    id: "user-identity",
    name: "User identity",
    surface: "static",
    sourceQuery: "Summarize who this user is as a person: name they go by, age or life stage, location and home base, household makeup, pets, occupation, and other stable biographical facts. State only what the memories support, and note when something is uncertain.",
  },
  {
    id: "user-relationships",
    name: "User relationships",
    surface: "static",
    sourceQuery: "Summarize the important people in this user's life: partner, family members, close friends, coworkers, and pets, including how they relate to the user and any relationship context. Only include people with evidence of personal significance, and keep relationship labels as precise as the evidence allows.",
  },
  {
    id: "user-health-constraints",
    name: "User health and constraints",
    surface: "static",
    sourceQuery: "Summarize the user's DURABLE health, accessibility, and standing life constraints that Finn should always keep in mind when helping: medical and mental-health conditions, disabilities, mobility or leaving-home limits, sensitivities, dietary needs, and other long-standing requirements. For each, state what it means in practice for how Finn should help or what Finn should avoid suggesting. Exclude transient or admin items such as device problems, bills, deadlines, subscriptions, and one-off tasks, which are current concerns rather than standing constraints. Keep it factual and narrow.",
  },
  {
    id: "user-work-professional",
    name: "User work and professional life",
    surface: "static",
    sourceQuery: "Summarize the user's work and professional context: role, employer or business, responsibilities, ongoing professional projects, and durable career goals.",
  },
  {
    id: "user-personality-style",
    name: "User personality and communication style",
    surface: "dynamic",
    sourceQuery: "Summarize how this user communicates and how Finn should interact with them: tone preferences, humor, directness, how much detail they want, sensitivities, and recurring communication patterns.",
  },
  {
    id: "user-current-concerns",
    name: "User current concerns and open loops",
    surface: "dynamic",
    sourceQuery: "Summarize what is currently active in the user's life: ongoing projects, commitments, deadlines, open loops, recent worries, and things Finn is helping with right now. Focus on what is current rather than historical.",
  },
  {
    id: "user-interests-aspirations",
    name: "User interests and aspirations",
    surface: "dynamic",
    sourceQuery: "Summarize the user's interests, tastes, hobbies, and longer-term aspirations or goals, including the smaller everyday things they enjoy, places they like, and recurring habits, as well as topics they care about and things they want to do or become.",
  },
] as const;

const finnManagedUserDirectives: ReadonlyArray<{ name: string; content: string; priority: number }> = [
  {
    name: "Synthesize from available evidence",
    priority: 10,
    content: "Always attempt a synthesized answer grounded in the available memories, noting confidence when evidence is partial. Only state that information is unavailable when there is genuinely no relevant memory to draw on.",
  },
  {
    name: "Standing constraints are always relevant",
    priority: 9,
    content: "Treat the user's health, accessibility, dietary, and life constraints as standing context that applies to any recommendation or plan, even when the user does not restate them.",
  },
  {
    name: "Preserve relationship precision",
    priority: 8,
    content: "Use the most precise relationship label the evidence supports. When the exact label is unproven, describe the narrower supported relationship rather than inventing spouse, child, or parent.",
  },
];

const patternRetainMission = [
  "Extract durable cross-run Pattern outcomes, changed states, decisions, previously surfaced or intentionally unsurfaced findings,",
  "and facts needed to dedupe future runs for this Pattern.",
  "Ignore worker process chatter, raw tool traces, and one-shot incidental details.",
].join(" ");

const patternObservationsMission = [
  "Identify recurring outcomes, stable external state, trend changes, and dedupe-relevant patterns for this Pattern only.",
  "Maintain one canonical observation per distinct outcome or trend: strengthen or update the existing observation instead of creating near-duplicate variants across runs.",
  "Ignore isolated low-signal run noise.",
].join(" ");

const patternReflectMission = [
  "You are Finn's Pattern memory layer. Reason only over terminal outcomes for this single Pattern's isolated run history.",
  "Use Pattern memory for cross-run trends, temporal reasoning, and dedupe. Do not infer broad user preferences or personal facts from Pattern runs.",
  "Distinguish found, notified, and surfaced states. Surfaced means Finn queued the result for user delivery, not proof the user understood it.",
].join(" ");

const userMemoryEntityLabels = [
  {
    key: "memory_domain",
    description: "The personal-understanding domain this memory belongs to. Assign the single best-fit domain. Add a second domain only when the memory genuinely and substantially belongs to both; do not add weakly or tangentially related domains. Use 'operational' for Finn operational/Pattern state and do not combine it with personal-understanding domains.",
    type: "multi-values",
    tag: true,
    values: [
      { value: "identity", description: "Stable identity, profile, or biographical context" },
      { value: "relationships", description: "Important people and relationship context" },
      { value: "family_household", description: "Family, household, dependents, pets, and home life" },
      { value: "projects", description: "Ongoing work or personal projects and responsibilities" },
      { value: "commitments", description: "Durable commitments, deadlines, obligations, or open loops" },
      { value: "preferences", description: "Stable preferences, tastes, and decisions" },
      { value: "daily_life", description: "Everyday life texture: interests, hobbies, places, errands, and small recurring habits" },
      { value: "communication_style", description: "How the user likes to communicate or be communicated with" },
      { value: "routines", description: "Recurring routines, habits, or schedule patterns" },
      { value: "constraints", description: "Long-lived constraints, limitations, or requirements" },
      { value: "sensitive", description: "Health, legal, financial, security, identity, or emotionally sensitive context" },
      { value: "operational", description: "Finn operational or Pattern lifecycle state, not a personal-understanding fact about the user" },
    ],
  },
  {
    key: "source_kind",
    description: "The source category that produced this memory.",
    type: "value",
    optional: true,
    tag: true,
    values: [
      { value: "imessage", description: "Finn/user iMessage conversation" },
      { value: "email", description: "Email or mailbox source" },
      { value: "calendar", description: "Calendar or event source" },
      { value: "chat", description: "Chat or messaging source" },
      { value: "task", description: "Task, issue, ticket, or project-management source" },
      { value: "document", description: "Document, note, file, or knowledge source" },
      { value: "other", description: "Other connected-app source" },
    ],
  },
  {
    key: "durability",
    description: "How durable this memory appears to be. Reserve 'durable' for stable identity, relationships, constraints, and clearly established preferences. Use 'transient' for daily logistics, shopping lists, errands, one-word replies, single-day plans, and passing moods, which should not become standing facts.",
    type: "value",
    optional: true,
    tag: true,
    values: [
      { value: "durable", description: "Stable or long-lived personal context: identity, relationships, constraints, established preferences and habits" },
      { value: "evolving", description: "Active context that may change over time, such as current projects or ongoing concerns" },
      { value: "transient", description: "Short-lived context that should not become a durable observation: daily logistics, errands, one-off plans, and passing moods" },
    ],
  },
  {
    key: "sensitivity",
    description: "Whether the memory contains sensitive personal material.",
    type: "value",
    optional: true,
    tag: true,
    values: [
      { value: "normal", description: "Ordinary personalization context" },
      { value: "sensitive", description: "Health, legal, financial, security, identity, or family-sensitive context" },
    ],
  },
];

export type HindsightMetadata = MemoryMetadata;

export type HindsightSearchResult = MemorySearchResult;

export type HindsightSearchResponse = MemorySearchResponse;

export type HindsightAddDocumentInput = MemoryAddDocumentInput;

export interface HindsightClientOptions {
  baseUrl: string;
  apiKey?: string;
  provisionMentalModels?: boolean;
}

interface HindsightRetainResponse {
  success?: unknown;
  bank_id?: unknown;
  items_count?: unknown;
  async?: unknown;
  operation_id?: unknown;
}

interface HindsightRecallResponse {
  results?: unknown;
}

interface HindsightMentalModelListResponse {
  items?: unknown;
}

interface HindsightMentalModelItem {
  id?: unknown;
  name?: unknown;
  content?: unknown;
  source_query?: unknown;
}

interface HindsightDirectiveListResponse {
  items?: unknown;
}

interface HindsightDirectiveItem {
  id?: unknown;
  name?: unknown;
  content?: unknown;
  priority?: unknown;
}

interface HindsightReflectFact {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  context?: unknown;
  occurred_start?: unknown;
  occurred_end?: unknown;
}

interface HindsightReflectMentalModel {
  id?: unknown;
  text?: unknown;
  context?: unknown;
}

interface HindsightReflectDirective {
  id?: unknown;
  name?: unknown;
  content?: unknown;
}

interface HindsightReflectBasedOn {
  memories?: unknown;
  mental_models?: unknown;
  directives?: unknown;
}

interface HindsightReflectResponse {
  text?: unknown;
  based_on?: unknown;
}

interface HindsightRecallResult {
  id?: unknown;
  text?: unknown;
  type?: unknown;
  entities?: unknown;
  context?: unknown;
  occurred_start?: unknown;
  occurred_end?: unknown;
  mentioned_at?: unknown;
  document_id?: unknown;
  metadata?: unknown;
  chunk_id?: unknown;
  tags?: unknown;
}

type HindsightBankKind = "user" | "pattern";

interface HindsightScope {
  bankId: string;
  bankKind: HindsightBankKind;
  tags: string[];
  observationScopes: string[][];
  tagGroups?: HindsightTagGroup[];
}

type HindsightTagGroupLeaf = {
  tags: string[];
  match: "any" | "all" | "any_strict" | "all_strict";
};

type HindsightTagGroup = HindsightTagGroupLeaf
  | { and: HindsightTagGroup[] }
  | { or: HindsightTagGroup[] }
  | { not: HindsightTagGroup };

type HindsightScopeFilter = {
  tags?: string[];
  tags_match?: "all_strict";
  tag_groups?: HindsightTagGroup[];
};

const defaultRecallTypes: MemoryFactType[] = ["world", "experience", "observation"];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function isLocalhostBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function getHindsightConnectivityHint(baseUrl: string): string | undefined {
  return isLocalhostBaseUrl(baseUrl)
    ? "HINDSIGHT_BASE_URL points at localhost. If Finn runs in Docker and Hindsight runs on the host, use http://host.docker.internal:8888 or a Docker Compose service URL."
    : undefined;
}

function sanitizeIdPart(value: string, maxLength: number): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^_+|_+$/g, "");
  return (sanitized || "unknown").slice(0, maxLength);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildStablePart(value: string, maxLength: number): string {
  const hash = stableHash(value);
  const sanitized = sanitizeIdPart(value, Math.max(1, maxLength - hash.length - 1));
  return `${sanitized}_${hash}`.slice(0, maxLength);
}

function buildCompactBankId(prefix: string, parts: string[]): string {
  return `${prefix}_${stableHash(parts.join("\0"))}`;
}

function sanitizeTagValue(value: string): string {
  return buildStablePart(value, 96);
}

function sanitizeTagLiteral(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "unknown";
}

function buildBankId(prefix: string, parts: string[]): string {
  return buildCompactBankId(prefix, parts);
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getMetadataString(metadata: MemoryMetadata, key: string): string | null {
  return toStringOrNull(metadata[key]);
}

function getFirstMetadataString(metadata: MemoryMetadata, keys: string[]): string | null {
  for (const key of keys) {
    const value = getMetadataString(metadata, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function stringifyMetadataValue(value: MemoryMetadata[string]): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function buildHindsightMetadata(metadata: MemoryMetadata): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, stringifyMetadataValue(value)]));
}

// Allowlist of metadata keys retained into Hindsight. Keeps provenance, source-scope,
// and dedup-critical fields (accountScopeId/sourceId/messageId/threadId are read back on
// recall by Personal Intelligence dedup) while dropping raw blobs and unrelated noise the
// extractor should not treat as personal facts.
const retainMetadataAllowlist = new Set<string>([
  "kind",
  "source",
  "sourceType",
  "sourceId",
  "process",
  "tenantId",
  "userId",
  "conversationId",
  "day",
  "timestamp",
  "completedAt",
  "inboundSource",
  "messageId",
  "threadId",
  "eventId",
  "patternId",
  "entityType",
  "entityId",
  "accountScopeId",
  "connectedAccountId",
  "sourceProvider",
  "sourcePerspective",
  "sourceDirection",
  "sourceAccountUserId",
  "sourceAccountDisplayName",
  "sourceUrl",
  "supportingSourceIds",
  "supportingMessageIds",
  "supportingThreadIds",
  "recipientEmails",
]);

function buildAllowlistedHindsightMetadata(metadata: MemoryMetadata): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata)
    .filter(([key, value]) => retainMetadataAllowlist.has(key) && value !== undefined && value !== null && stringifyMetadataValue(value).length > 0)
    .map(([key, value]) => [key, stringifyMetadataValue(value)]));
}

function buildHindsightRetainMetadata(input: HindsightAddDocumentInput): Record<string, string> {
  if (getMetadataString(input.metadata, "kind") === "activity_feed_event") {
    const stableMetadata: MemoryMetadata = {
      kind: "activity_feed_event",
      source: "finn_activity_feed",
      sourceType: "pattern_activity_timeline",
      process: "activity_feed",
      tenantId: input.user.tenantId,
      userId: input.user.userId,
      ...(getMetadataString(input.metadata, "entityType") ? { entityType: getMetadataString(input.metadata, "entityType")! } : {}),
      ...(getMetadataString(input.metadata, "entityId") ? { entityId: getMetadataString(input.metadata, "entityId")! } : {}),
      ...(getMetadataString(input.metadata, "patternId") ? { patternId: getMetadataString(input.metadata, "patternId")! } : {}),
    };
    return buildAllowlistedHindsightMetadata(stableMetadata);
  }

  return {
    ...buildAllowlistedHindsightMetadata(input.metadata),
    ...(input.source ? {
      sourceProvider: input.source.provider,
      sourceType: input.source.type,
      sourceId: input.source.id,
    } : {}),
  };
}

function normalizeReturnedMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, rawValue]) => {
    if (booleanMetadataKeys.has(key) && typeof rawValue === "string") {
      if (rawValue === "true") {
        return [key, true];
      }
      if (rawValue === "false") {
        return [key, false];
      }
    }
    return [key, rawValue];
  }));
}

const emptyProfileContentPatterns = [
  /\bi (?:cannot|can't|could not|couldn't|do not|don't) find\b/i,
  /\bno (?:relevant |available )?(?:information|memories|memory|evidence|data)\b/i,
  /\bnot enough (?:information|evidence)\b/i,
  /\binsufficient (?:information|evidence)\b/i,
  /\bnothing (?:is )?(?:known|recorded|available)\b/i,
];

// Strips mental-model generation scaffolding so placeholder text from delta-mode
// seeding (e.g. "Generating content...") and empty section headers never reach the
// hot-path profile envelope.
function stripMentalModelScaffolding(content: string): string {
  return content
    .replace(/^\s*#{1,6}\s*overview\s*$/gim, "")
    .replace(/\bgenerating content\.\.\.?/gi, "")
    .replace(/^\s*#{1,6}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeProfileEntry(name: string, content: string): string | null {
  const cleaned = stripMentalModelScaffolding(content);
  if (cleaned.length === 0) {
    return null;
  }
  if (emptyProfileContentPatterns.some((pattern) => pattern.test(cleaned))) {
    return null;
  }
  const normalized = cleaned.replace(/\s+/g, " ");
  return `${name}: ${normalized}`;
}

function buildUserBaseTags(user: Pick<UserContext, "tenantId" | "userId">): string[] {
  return [
    `tenant:${sanitizeTagValue(user.tenantId)}`,
    `user:${sanitizeTagValue(user.userId)}`,
    "scope:personal",
  ];
}

function buildUserPolicyTags(metadata: MemoryMetadata): string[] {
  const policyFields = [
    ["sensitivity", ["sensitivity"]],
    ["retention_policy", ["retention_policy", "retentionPolicy"]],
    ["memory_domain", ["memory_domain", "memoryDomain"]],
    ["evidence_strength", ["evidence_strength", "evidenceStrength"]],
    ["relationship_certainty", ["relationship_certainty", "relationshipCertainty"]],
  ] as const;

  return policyFields.flatMap(([tagName, keys]) => {
    const value = getFirstMetadataString(metadata, [...keys]);
    return value ? [`${tagName}:${sanitizeTagLiteral(value)}`] : [];
  });
}

function buildUserVisibilityTags(policyTags: string[]): string[] {
  return isPolicyRestricted(policyTags) ? ["visibility:restricted"] : ["visibility:ordinary"];
}

function buildUserSourceTags(input: HindsightAddDocumentInput): string[] {
  const kind = getMetadataString(input.metadata, "kind");
  if (kind === "hot_path_turn") {
    return ["source:imessage", "source_kind:imessage"];
  }

  if (kind === "activity_feed_event") {
    return ["source:finn_activity_feed", "source_kind:other"];
  }

  const sourceProvider = input.source?.provider ?? getMetadataString(input.metadata, "source");
  const sourceType = input.source?.type ?? getMetadataString(input.metadata, "sourceType");
  const accountScopeId = getMetadataString(input.metadata, "accountScopeId");
  const connectedAccountId = getMetadataString(input.metadata, "connectedAccountId");
  return [
    ...(sourceProvider ? [`source:${sanitizeTagLiteral(sourceProvider)}`] : []),
    ...(sourceType ? [`source_type:${sanitizeTagLiteral(sourceType)}`, `source_kind:${normalizeSourceKind(sourceType)}`] : []),
    ...(accountScopeId ? [`account_scope:${sanitizeTagValue(accountScopeId)}`] : []),
    ...(connectedAccountId ? [`connected_account:${sanitizeTagValue(connectedAccountId)}`] : []),
  ];
}

function normalizeSourceKind(sourceType: string): string {
  const normalized = sanitizeTagLiteral(sourceType);
  if (["email", "mail", "message", "thread"].includes(normalized)) {
    return "email";
  }
  if (["calendar", "event", "meeting"].includes(normalized)) {
    return "calendar";
  }
  if (["chat", "slack", "conversation", "dm"].includes(normalized)) {
    return "chat";
  }
  if (["issue", "ticket", "task", "project"].includes(normalized)) {
    return "task";
  }
  if (["document", "doc", "note", "file"].includes(normalized)) {
    return "document";
  }
  return "other";
}

function buildUserObservationScopes(baseTags: string[], retainTags: string[]): string[][] {
  const restrictiveTags = retainTags.filter((tag) => tag === "sensitivity:sensitive"
    || tag === "retention_policy:default_hidden"
    || tag === "retention_policy:requires_user_consent");
  return [restrictiveTags.length > 0 ? [...baseTags, ...restrictiveTags] : baseTags];
}

function isPolicyRestricted(tags: string[]): boolean {
  return tags.includes("sensitivity:sensitive")
    || tags.includes("retention_policy:default_hidden")
    || tags.includes("retention_policy:requires_user_consent")
    || tags.includes("visibility:restricted");
}

function buildUserRecallTagGroups(baseTags: string[]): HindsightTagGroup[] {
  return [{
    and: [
      { tags: baseTags, match: "all_strict" },
      { not: { tags: ["sensitivity:sensitive"], match: "any_strict" } },
      { not: { tags: ["retention_policy:default_hidden", "retention_policy:requires_user_consent"], match: "any_strict" } },
      { not: { tags: ["visibility:restricted"], match: "any_strict" } },
    ],
  }];
}

function buildHindsightScopeFilter(scope: HindsightScope): HindsightScopeFilter {
  if (scope.tagGroups) {
    return { tag_groups: scope.tagGroups };
  }

  return { tags: scope.tags, tags_match: "all_strict" };
}

function buildRecallRequest(input: MemorySearchInput, scope: HindsightScope, options: {
  budget: "low" | "mid" | "high";
  maxTokens: number;
}): Record<string, unknown> {
  return {
    budget: options.budget,
    max_tokens: options.maxTokens,
    query: input.query,
    ...buildHindsightScopeFilter(scope),
    ...(input.queryTimestamp ? { query_timestamp: input.queryTimestamp } : {}),
    trace: false,
    types: input.types ?? defaultRecallTypes,
  };
}

function buildHotPathSessionTags(metadata: MemoryMetadata): string[] {
  const conversationId = getMetadataString(metadata, "conversationId");
  const day = getMetadataString(metadata, "day");

  return [
    ...(conversationId ? [`session:${sanitizeTagValue(conversationId)}`] : []),
    ...(day ? [`day:${sanitizeTagValue(day)}`] : []),
  ];
}

function getHotPathSessionDocumentId(input: HindsightAddDocumentInput): string {
  const conversationId = getMetadataString(input.metadata, "conversationId");
  const day = getMetadataString(input.metadata, "day");
  if (!conversationId || !day) {
    return input.customId;
  }

  return `hot-path-session_${buildStablePart(`${conversationId}_${day}`, 80)}`.slice(0, 100);
}

function formatHindsightConversationMessage(message: MemoryConversationMessage): string {
  return JSON.stringify(message);
}

function getHindsightContent(input: HindsightAddDocumentInput, scope: HindsightScope): string {
  if (scope.bankKind === "user" && input.conversationMessages && input.conversationMessages.length > 0) {
    return input.conversationMessages.map(formatHindsightConversationMessage).join("\n");
  }

  return input.content;
}

function getHindsightRetainContext(input: HindsightAddDocumentInput, scope: HindsightScope): string {
  if (scope.bankKind === "pattern") {
    return "Finn Pattern worker run outcome";
  }

  if (getMetadataString(input.metadata, "kind") === "personal_intelligence_source") {
    return [
      "Selected, normalized external source evidence retained for Finn's personal understanding of the user.",
      "Use source metadata for provenance, attribution, actors, timestamps, and confidence.",
      "Extract source-grounded personal context, including the smaller everyday details that reveal interests, habits, and daily life, while distinguishing durable facts from transient day-to-day texture; ignore boilerplate, raw identifiers, and connector/process noise.",
    ].join(" ");
  }

  if (getMetadataString(input.metadata, "kind") === "activity_feed_event") {
    return [
      "Finn Pattern lifecycle timeline retained as user-scoped operational runtime state.",
      "Each appended entry is a distinct Pattern lifecycle event; extract pauses, resumes, edits, creates, and deletes as state changes even if a later event supersedes an earlier one.",
      "Do not convert these lifecycle events into durable user preferences, goals, or commitments unless the event content explicitly proves one.",
    ].join(" ");
  }

  return [
    "Finn iMessage conversation session retained as newline-delimited JSON messages with role, timestamp, messageId, delivery state, and attachment context.",
    "This is casual personal chat, where jokes, sarcasm, teasing, hyperbole, and Finn's playful replies are common.",
    "Extract user memory that is clearly factual in context, including the smaller everyday details that reveal who the user is and how they live.",
    "Treat routine logistics such as shopping lists, errands, and one-word replies as transient: capture a durable preference or habit they reveal, but not the literal message as a standing fact.",
  ].join(" ");
}

function getHindsightDocumentId(input: HindsightAddDocumentInput, scope: HindsightScope): string {
  if (scope.bankKind === "user" && getMetadataString(input.metadata, "kind") === "activity_feed_event") {
    const patternId = getMetadataString(input.metadata, "patternId") ?? getMetadataString(input.metadata, "entityId");
    return patternId ? `pattern-activity_${buildStablePart(patternId, 72)}`.slice(0, 100) : input.customId;
  }

  return scope.bankKind === "user" ? getHotPathSessionDocumentId(input) : input.customId;
}

function getHindsightUpdateMode(scope: HindsightScope): "replace" | "append" {
  return scope.bankKind === "user" && (scope.tags.includes("source:imessage") || scope.tags.includes("source:finn_activity_feed")) ? "append" : "replace";
}

function buildPatternTags(input: {
  user: Pick<UserContext, "tenantId" | "userId">;
  patternId: string;
  patternRunId?: string;
  triggeredBy?: string;
  notified?: boolean;
  surfaced?: boolean;
}): string[] {
  return [
    `tenant:${sanitizeTagValue(input.user.tenantId)}`,
    `user:${sanitizeTagValue(input.user.userId)}`,
    "scope:pattern",
    "source:pattern-run",
    `pattern:${sanitizeTagValue(input.patternId)}`,
    ...(input.patternRunId ? [`run:${sanitizeTagValue(input.patternRunId)}`] : []),
    ...(input.triggeredBy ? [`trigger:${sanitizeTagValue(input.triggeredBy)}`] : []),
    ...(typeof input.notified === "boolean" ? [`notified:${input.notified}`] : []),
    ...(typeof input.surfaced === "boolean" ? [`surfaced:${input.surfaced}`] : []),
  ];
}

function normalizeSearchResult(result: HindsightRecallResult): HindsightSearchResult | null {
  const id = toStringOrNull(result.id);
  const text = toStringOrNull(result.text);
  if (!id || !text) {
    return null;
  }

  const tags = toStringArray(result.tags);
  const entities = toStringArray(result.entities);
  const metadata = {
    ...normalizeReturnedMetadata(result.metadata),
    memoryId: id,
    memoryType: toStringOrNull(result.type),
    memoryContext: toStringOrNull(result.context),
    memoryTags: tags,
    memoryEntities: entities,
  };

  return {
    documentId: toStringOrNull(result.document_id) ?? id,
    title: toStringOrNull(result.context),
    summary: null,
    content: text,
    score: null,
    createdAt: toStringOrNull(result.mentioned_at) ?? toStringOrNull(result.occurred_start),
    updatedAt: toStringOrNull(result.occurred_end),
    metadata,
    chunks: [{ content: text, score: null, isRelevant: true }],
  };
}

function normalizeContextResult(result: HindsightRecallResult): MemoryContextResult | null {
  const text = toStringOrNull(result.text);
  if (!text) {
    return null;
  }

  return {
    text,
    type: toStringOrNull(result.type),
    occurredAt: toStringOrNull(result.mentioned_at) ?? toStringOrNull(result.occurred_start),
  };
}

function normalizeReflectFact(value: HindsightReflectFact): MemoryReflectEvidence["memories"][number] | null {
  const text = toStringOrNull(value.text);
  if (!text) {
    return null;
  }

  return {
    id: toStringOrNull(value.id),
    text,
    type: toStringOrNull(value.type),
    context: toStringOrNull(value.context),
    occurredStart: toStringOrNull(value.occurred_start),
    occurredEnd: toStringOrNull(value.occurred_end),
  };
}

function normalizeReflectMentalModel(value: HindsightReflectMentalModel): MemoryReflectEvidence["mentalModels"][number] | null {
  const id = toStringOrNull(value.id);
  const text = toStringOrNull(value.text);
  if (!id || !text) {
    return null;
  }

  return {
    id,
    text,
    context: toStringOrNull(value.context),
  };
}

function normalizeReflectDirective(value: HindsightReflectDirective): MemoryReflectEvidence["directives"][number] | null {
  const id = toStringOrNull(value.id);
  const name = toStringOrNull(value.name);
  const content = toStringOrNull(value.content);
  if (!id || !name || !content) {
    return null;
  }

  return { id, name, content };
}

function normalizeReflectEvidence(value: unknown): MemoryReflectEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const basedOn = value as HindsightReflectBasedOn;
  return {
    memories: Array.isArray(basedOn.memories)
      ? basedOn.memories.map((item) => normalizeReflectFact(item as HindsightReflectFact)).filter((item): item is MemoryReflectEvidence["memories"][number] => Boolean(item))
      : [],
    mentalModels: Array.isArray(basedOn.mental_models)
      ? basedOn.mental_models.map((item) => normalizeReflectMentalModel(item as HindsightReflectMentalModel)).filter((item): item is MemoryReflectEvidence["mentalModels"][number] => Boolean(item))
      : [],
    directives: Array.isArray(basedOn.directives)
      ? basedOn.directives.map((item) => normalizeReflectDirective(item as HindsightReflectDirective)).filter((item): item is MemoryReflectEvidence["directives"][number] => Boolean(item))
      : [],
  };
}

export class HindsightClient implements MemoryClient {
  readonly provider = "hindsight";

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly provisionMentalModels: boolean;
  private readonly configuredBanks = new Set<string>();
  private readonly configuringBanks = new Map<string, Promise<void>>();

  constructor(options: HindsightClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.provisionMentalModels = options.provisionMentalModels ?? true;
  }

  getUserBankId(user: Pick<UserContext, "tenantId" | "userId">): string {
    return buildBankId("finn_user", [user.tenantId, user.userId]);
  }

  getPatternBankId(user: Pick<UserContext, "tenantId" | "userId">, patternId: string): string {
    return buildBankId("finn_pattern", [user.tenantId, user.userId, patternId]);
  }

  buildHotPathTurnCustomId(messageId: string): string {
    return `hot-path-turn_${buildStablePart(messageId, 72)}`.slice(0, 100);
  }

  buildPatternRunCustomId(patternRunId: string): string {
    return `pattern-run_${buildStablePart(patternRunId, 72)}`.slice(0, 100);
  }

  async addDocument(input: HindsightAddDocumentInput): Promise<MemoryAddDocumentResponse | null> {
    try {
      const scope = this.resolveDocumentScope(input);
      await this.ensureBankConfigured(scope);

      const timestamp = getMetadataString(input.metadata, "completedAt") ?? getMetadataString(input.metadata, "timestamp") ?? input.source?.timestamp;
      const documentId = getHindsightDocumentId(input, scope);
      const response = await this.request<HindsightRetainResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories`, "POST", {
        items: [{
          content: getHindsightContent(input, scope),
          context: getHindsightRetainContext(input, scope),
          document_id: documentId,
          metadata: buildHindsightRetainMetadata(input),
          observation_scopes: scope.observationScopes,
          tags: scope.tags,
          timestamp,
          update_mode: getHindsightUpdateMode(scope),
        }],
        async: true,
      });

      if (response.success !== true) {
        throw new Error("Hindsight retain returned an unsuccessful response");
      }

      return {
        id: documentId,
        status: response.async === true ? toStringOrNull(response.operation_id) ?? "queued" : "retained",
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? getDefaultMemoryOperation(input.metadata, "retain"),
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
          customId: input.customId,
        }),
        failureReason: getSafeMemoryFailureReason(error),
        connectivityHint: getHindsightConnectivityHint(this.baseUrl),
      }, "Memory retain failed");
      return null;
    }
  }

  async searchDocuments(input: MemorySearchInput): Promise<HindsightSearchResponse> {
    try {
      const scope = this.resolveSearchScope(input);
      await this.ensureBankConfigured(scope);
      const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
      const response = await this.request<HindsightRecallResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories/recall`, "POST", buildRecallRequest(input, scope, {
        budget: limit <= 3 ? "low" : "mid",
        maxTokens: Math.max(512, limit * 300),
      }));

      if (!Array.isArray(response.results)) {
        return { ok: true, results: [] };
      }

      return {
        ok: true,
        results: response.results
          .map((result) => normalizeSearchResult(result as HindsightRecallResult))
          .filter((result): result is HindsightSearchResult => Boolean(result))
          .slice(0, limit),
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? getDefaultMemoryOperation(input.metadata, "search"),
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
        connectivityHint: getHindsightConnectivityHint(this.baseUrl),
      }, "Memory search failed");
      return { ok: false, results: [], error: "memory search is unavailable right now" };
    }
  }

  async buildContext(input: MemorySearchInput): Promise<MemoryContextResponse> {
    try {
      const scope = this.resolveSearchScope(input);
      await this.ensureBankConfigured(scope);
      const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
      const observationResponse = await this.request<HindsightRecallResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories/recall`, "POST", buildRecallRequest({
        ...input,
        types: ["observation"],
      }, scope, {
        budget: "low",
        maxTokens: Math.max(512, limit * 220),
      }));

      if (!Array.isArray(observationResponse.results)) {
        return { ok: true, results: [] };
      }

      const observations = observationResponse.results
        .map((result) => normalizeContextResult(result as HindsightRecallResult))
        .filter((result): result is MemoryContextResult => Boolean(result));

      if (observations.length > 0) {
        return { ok: true, results: observations.slice(0, limit) };
      }

      const rawResponse = await this.request<HindsightRecallResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/memories/recall`, "POST", buildRecallRequest({
        ...input,
        types: ["world", "experience"],
      }, scope, {
        budget: "low",
        maxTokens: Math.max(512, limit * 220),
      }));

      if (!Array.isArray(rawResponse.results)) {
        return { ok: true, results: [] };
      }

      const rawFacts = rawResponse.results
        .map((result) => normalizeContextResult(result as HindsightRecallResult))
        .filter((result): result is MemoryContextResult => Boolean(result));

      return { ok: true, results: rawFacts.slice(0, limit) };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "search_memory",
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
        connectivityHint: getHindsightConnectivityHint(this.baseUrl),
      }, "Memory context recall failed");
      return { ok: false, results: [], error: "memory context is unavailable right now" };
    }
  }

  async reflectMemory(input: MemoryReflectInput): Promise<MemoryReflectResponse> {
    try {
      const scope = this.resolveSearchScope(input);
      await this.ensureBankConfigured(scope);
      const response = await this.request<HindsightReflectResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/reflect`, "POST", {
        budget: input.budget ?? "mid",
        exclude_mental_models: true,
        fact_types: ["world", "experience", "observation"],
        include: { facts: {} },
        max_tokens: Math.max(256, Math.min(input.maxTokens ?? 1500, 4000)),
        query: input.query,
        ...buildHindsightScopeFilter(scope),
      });

      const answer = toStringOrNull(response.text) ?? "";
      return {
        ok: true,
        answer,
        evidence: normalizeReflectEvidence(response.based_on),
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "reflect_memory",
          user: input.user,
          metadata: input.metadata,
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
        connectivityHint: getHindsightConnectivityHint(this.baseUrl),
      }, "Memory reflect failed");
      return { ok: false, answer: null, evidence: null, error: "memory reflection is unavailable right now" };
    }
  }

  async provisionUserBank(user: Pick<UserContext, "tenantId" | "userId">): Promise<void> {
    const bankId = this.getUserBankId(user);
    try {
      await this.ensureBankConfigured({
        bankId,
        bankKind: "user",
        tags: buildUserBaseTags(user),
        observationScopes: [buildUserBaseTags(user)],
      });
    } catch (error) {
      logger.warn({ bankId, failureReason: getSafeMemoryFailureReason(error), connectivityHint: getHindsightConnectivityHint(this.baseUrl) }, "Hindsight user bank provisioning failed");
    }
  }

  async buildProfileContext(input: MemoryProfileContextInput): Promise<MemoryProfileContextResponse> {
    try {
      const bankId = this.getUserBankId(input.user);
      await this.ensureBankConfigured({
        bankId,
        bankKind: "user",
        tags: buildUserBaseTags(input.user),
        observationScopes: [buildUserBaseTags(input.user)],
      });

      const response = await this.request<HindsightMentalModelListResponse>(`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models?detail=content&limit=1000`, "GET");
      const items = Array.isArray(response.items) ? (response.items as HindsightMentalModelItem[]) : [];
      const contentById = new Map<string, string>();
      for (const item of items) {
        const id = toStringOrNull(item.id);
        const content = toStringOrNull(item.content);
        if (id && content) {
          contentById.set(id, content);
        }
      }

      const staticEntries: string[] = [];
      const dynamicEntries: string[] = [];
      for (const model of finnManagedUserMentalModels) {
        const content = contentById.get(model.id);
        if (!content) {
          continue;
        }
        const entry = sanitizeProfileEntry(model.name, content);
        if (!entry) {
          continue;
        }
        (model.surface === "static" ? staticEntries : dynamicEntries).push(entry);
      }

      return {
        ok: true,
        profile: {
          static: staticEntries,
          dynamic: dynamicEntries,
        },
      };
    } catch (error) {
      logger.error({
        ...getMemoryLogContext({
          provider: this.provider,
          operation: input.observability?.operation ?? "build_profile_context",
          user: input.user,
          metadata: {},
          observability: input.observability,
        }),
        failureReason: getSafeMemoryFailureReason(error),
        connectivityHint: getHindsightConnectivityHint(this.baseUrl),
      }, "Memory profile context failed");
      return { ok: false, profile: null, error: "memory profile is unavailable right now" };
    }
  }

  private resolveDocumentScope(input: HindsightAddDocumentInput): HindsightScope {
    const kind = getMetadataString(input.metadata, "kind");
    if (kind === "pattern_run_outcome") {
      const patternId = getMetadataString(input.metadata, "patternId");
      const patternRunId = getMetadataString(input.metadata, "patternRunId");
      const triggeredBy = getMetadataString(input.metadata, "triggeredBy");
      const notified = typeof input.metadata["notified"] === "boolean" ? input.metadata["notified"] : undefined;
      const surfaced = typeof input.metadata["surfaced"] === "boolean" ? input.metadata["surfaced"] : undefined;
      if (!patternId || !patternRunId) {
        throw new Error("Hindsight Pattern memory requires patternId and patternRunId metadata.");
      }
      const observationScopeTags = buildPatternTags({ user: input.user, patternId });
      return {
        bankId: this.getPatternBankId(input.user, patternId),
        bankKind: "pattern",
        tags: buildPatternTags({ user: input.user, patternId, patternRunId, triggeredBy: triggeredBy ?? undefined, notified, surfaced }),
        observationScopes: [observationScopeTags],
      };
    }

    const baseTags = buildUserBaseTags(input.user);
    const policyTags = buildUserPolicyTags(input.metadata);
    const tags = [...baseTags, ...buildUserSourceTags(input), ...policyTags, ...buildUserVisibilityTags(policyTags), ...buildHotPathSessionTags(input.metadata)];
    return {
      bankId: this.getUserBankId(input.user),
      bankKind: "user",
      tags,
      observationScopes: buildUserObservationScopes(baseTags, tags),
    };
  }

  private resolveSearchScope(input: MemorySearchInput): HindsightScope {
    const kind = getMetadataString(input.metadata, "kind");
    if (kind === "pattern_run_outcome") {
      const patternId = getMetadataString(input.metadata, "patternId");
      if (!patternId) {
        throw new Error("Hindsight Pattern memory search requires patternId metadata.");
      }
      const tags = buildPatternTags({ user: input.user, patternId });
      return {
        bankId: this.getPatternBankId(input.user, patternId),
        bankKind: "pattern",
        tags,
        observationScopes: [tags],
      };
    }

    const tags = buildUserBaseTags(input.user);
    return {
      bankId: this.getUserBankId(input.user),
      bankKind: "user",
      tags,
      observationScopes: [tags],
      tagGroups: buildUserRecallTagGroups(tags),
    };
  }

  private async ensureBankConfigured(scope: HindsightScope): Promise<void> {
    if (this.configuredBanks.has(scope.bankId)) {
      return;
    }

    const existing = this.configuringBanks.get(scope.bankId);
    if (existing) {
      await existing;
      return;
    }

    const configurePromise = this.configureBank(scope)
      .then(() => {
        this.configuredBanks.add(scope.bankId);
      })
      .finally(() => {
        this.configuringBanks.delete(scope.bankId);
      });
    this.configuringBanks.set(scope.bankId, configurePromise);
    await configurePromise;
  }

  private async configureBank(scope: HindsightScope): Promise<void> {
    await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}`, "PUT", {
      name: scope.bankKind === "pattern" ? "Finn Pattern memory" : "Finn user memory",
    });
    await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/config`, "PATCH", {
      updates: {
        ...(scope.bankKind === "user" ? { entity_labels: userMemoryEntityLabels } : {}),
        enable_observations: true,
        observations_mission: scope.bankKind === "pattern" ? patternObservationsMission : userObservationsMission,
        disposition_empathy: scope.bankKind === "pattern" ? 2 : 4,
        disposition_literalism: scope.bankKind === "pattern" ? 3 : 2,
        disposition_skepticism: scope.bankKind === "pattern" ? 3 : 3,
        reflect_mission: scope.bankKind === "pattern" ? patternReflectMission : userReflectMission,
        retain_extraction_mode: "concise",
        retain_mission: scope.bankKind === "pattern" ? patternRetainMission : userRetainMission,
      },
    });

    if (scope.bankKind === "user" && this.provisionMentalModels) {
      await this.ensureFinnManagedUserMentalModels(scope);
      await this.ensureFinnManagedUserDirectives(scope);
    }
  }

  private async ensureFinnManagedUserMentalModels(scope: HindsightScope): Promise<void> {
    try {
      const existing = await this.request<HindsightMentalModelListResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/mental-models?detail=content&limit=1000`, "GET");
      const existingById = new Map<string, HindsightMentalModelItem>();
      if (Array.isArray(existing.items)) {
        for (const item of existing.items as HindsightMentalModelItem[]) {
          const id = toStringOrNull(item.id);
          if (id) {
            existingById.set(id, item);
          }
        }
      }

      await Promise.all(finnManagedUserMentalModels.map(async (model) => {
        const current = existingById.get(model.id);
        if (!current) {
          await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/mental-models`, "POST", {
            id: model.id,
            name: model.name,
            source_query: model.sourceQuery,
            trigger: {
              mode: "delta",
              refresh_after_consolidation: true,
            },
          });
          return;
        }

        const queryDrifted = toStringOrNull(current.source_query) !== model.sourceQuery;
        const nameDrifted = toStringOrNull(current.name) !== model.name;
        if (!queryDrifted && !nameDrifted) {
          return;
        }

        await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/mental-models/${encodeURIComponent(model.id)}`, "PATCH", {
          name: model.name,
          source_query: model.sourceQuery,
        });
        if (queryDrifted) {
          await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/mental-models/${encodeURIComponent(model.id)}/refresh`, "POST");
        }
      }));
    } catch (error) {
      logger.warn({ bankId: scope.bankId, failureReason: getSafeMemoryFailureReason(error) }, "Hindsight user mental model provisioning failed");
    }
  }

  private async ensureFinnManagedUserDirectives(scope: HindsightScope): Promise<void> {
    try {
      const existing = await this.request<HindsightDirectiveListResponse>(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/directives`, "GET");
      const existingByName = new Map<string, HindsightDirectiveItem>();
      if (Array.isArray(existing.items)) {
        for (const item of existing.items as HindsightDirectiveItem[]) {
          const name = toStringOrNull(item.name);
          if (name) {
            existingByName.set(name, item);
          }
        }
      }

      await Promise.all(finnManagedUserDirectives.map(async (directive) => {
        const current = existingByName.get(directive.name);
        if (!current) {
          await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/directives`, "POST", {
            name: directive.name,
            content: directive.content,
            priority: directive.priority,
          });
          return;
        }

        const directiveId = toStringOrNull(current.id);
        const contentDrifted = toStringOrNull(current.content) !== directive.content;
        const priorityDrifted = typeof current.priority === "number" && current.priority !== directive.priority;
        if (!directiveId || (!contentDrifted && !priorityDrifted)) {
          return;
        }

        await this.request(`/v1/default/banks/${encodeURIComponent(scope.bankId)}/directives/${encodeURIComponent(directiveId)}`, "PATCH", {
          content: directive.content,
          priority: directive.priority,
        });
      }));
    } catch (error) {
      logger.warn({ bankId: scope.bankId, failureReason: getSafeMemoryFailureReason(error) }, "Hindsight user directive provisioning failed");
    }
  }

  private async request<T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(`provider_http_${response.status}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }
}
