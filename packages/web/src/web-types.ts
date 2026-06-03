export interface UserProfile {
  id: string;
  phoneNumber: string;
  displayName: string;
  timezone: string;
  timezoneSource: "server" | "browser" | "manual";
  location: string;
  kidsMode: boolean;
  onboarding: {
    completedAt: string | null;
    requiredConnectorSlugs: string[];
  };
  profileImageUrl?: string | null;
}

export type ActiveSheet = "my-day" | "patterns" | "library" | "connectors" | "settings" | "onboarding" | null;
export type AppThemeName = "morning" | "afternoon" | "night";

export interface AppTheme {
  name: AppThemeName;
  backgroundUrl: string;
  imageScale: number;
  chromeColor: string;
  chromeRgb: readonly [number, number, number];
  foregroundColor: string;
  foregroundMutedColor: string;
  menuTextColor: string;
  menuSurfaceColor: string;
  menuBorderColor: string;
  topbarDateColor: string;
  logoFilter: string;
  sceneFilter: string;
}

export type CountryCode = "AU" | "CN" | "US" | "CA";
export type SettingsView = "menu" | "profile" | "settings";
export type ProfileFieldName = keyof Pick<UserProfile, "displayName" | "phoneNumber" | "timezone" | "location" | "kidsMode">;
export type ProfilePatch = Partial<Pick<UserProfile, "displayName" | "phoneNumber" | "timezone" | "timezoneSource" | "location" | "kidsMode">>;

export interface LibraryFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  folderId: string | null;
  userVisible: boolean;
  url: string;
  createdAt: string;
}

export interface LibraryFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryPage {
  folder: LibraryFolder | null;
  breadcrumbs: LibraryFolder[];
  folders: LibraryFolder[];
  files: LibraryFile[];
}

export interface MyDayTodo {
  id: string;
  title: string;
  notes: string | null;
  status: "open" | "done" | "archived";
  source: { type: string; id?: string; label?: string } | null;
  handoffAt: string | null;
  handoffWorkerId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface MyDayPage {
  day: {
    id: string;
    userLocalDate: string;
    timezone: string;
    summary: string | null;
    sourceSummary: string | null;
    lastRefreshedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  todos: MyDayTodo[];
}

export interface Pattern {
  id: string;
  name: string;
  description: string | null;
  userDescription: string | null;
  triggerType: "schedule" | "composio";
  triggerConfig: {
    type: "schedule";
    schedule: PatternSchedule;
    timezoneSource?: "user" | "fixed";
  } | {
    type: "composio";
    toolkitSlug: string;
    toolkitName?: string;
    triggerSlug: string;
    connectedAccountId: string;
    triggerId?: string;
    triggerConfig?: Record<string, unknown>;
  };
  connectorScope: {
    composio: Array<{ toolkitSlug: string; connectedAccountId?: string; allowedTools?: string[] }>;
    mcpServerIds: string[];
    issues?: Array<{
      type: "composio_connector_unavailable";
      toolkitSlug: string;
      connectedAccountId?: string;
      reason: "disconnected" | "account_replaced";
      pausedAt: string;
      resumeOnReconnect: boolean;
    }>;
  };
  connectorIssues?: Array<{
    type: "composio_connector_unavailable";
    toolkitSlug: string;
    toolkitName?: string;
    connectedAccountId?: string;
    reason: "disconnected" | "account_replaced";
    pausedAt: string;
    resumeOnReconnect: boolean;
  }>;
  triggerFilters: Array<{ path: string; operator: "equals" | "not_equals" | "contains" | "exists"; value?: string | number | boolean | null }>;
  notifyCondition: { type: "always" } | { type: "never" } | { type: "worker_decision"; instruction: string };
  taskPrompt: string;
  reminderContext: {
    reminderText: string;
    reason: string;
    supportingContext?: string | null;
  } | null;
  workerType: string;
  timezone: string;
  active: boolean;
  failureCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PatternWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type PatternSchedule =
  | { kind: "once"; localDateTime: string }
  | { kind: "interval"; every: number; unit: "minutes" | "hours" | "days"; anchorLocalDateTime?: string }
  | { kind: "daily"; time: string; startDate?: string }
  | { kind: "weekly"; daysOfWeek: PatternWeekday[]; time: string; startDate?: string }
  | { kind: "monthly"; dayOfMonth: number | "last"; time: string; startDate?: string };

export interface PatternPage {
  patterns: Pattern[];
}

export interface PatternRun {
  id: string;
  patternId: string;
  triggeredBy: "schedule" | "composio" | "manual";
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  result: { summary: string; error?: string } | null;
  error: string | null;
  skipReason: string | null;
  notifyOutcome: { notify: boolean; summary: string; reason?: string; evidence?: unknown; data?: unknown } | null;
  surfacedAt: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface PatternRunPage {
  runs: PatternRun[];
}

export interface PatternConnector {
  slug: string;
  name: string;
  logo?: string;
}

export interface Connector {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  requiresAuth: boolean;
  connected: boolean;
  enabled: boolean;
  connectionStatus?: string;
  connectedAccountId?: string;
  config: ConnectorConfig;
}

export interface ConnectorPage {
  connectors: Connector[];
  nextCursor?: string;
  configured: boolean;
}

export interface ConnectorDisconnectImpact {
  toolkitSlug: string;
  toolkitName?: string;
  patterns: Array<{ id: string; name: string; triggerType: "schedule" | "composio" }>;
  scheduledPatterns: Array<{ id: string; name: string; triggerType: "schedule" | "composio" }>;
  triggerPatterns: Array<{ id: string; name: string; triggerType: "schedule" | "composio" }>;
}

export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  logo?: string;
  authMode: "none" | "api_key" | "oauth";
  transport: {
    type: string;
    url?: string;
    command?: string;
    hasAuthToken: boolean;
  };
  alwaysOn: boolean;
  active: boolean;
  connected: boolean;
  toolCount: number;
  resourceCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerPage {
  servers: McpServer[];
}

export interface McpServerDraft {
  name: string;
  url: string;
  description: string;
  authMode: "none" | "api_key" | "oauth";
  authHeaderName: string;
  authHeaderValue: string;
  authToken: string;
}

export interface PuterSourceAvailability {
  available: boolean;
  message: string;
  missingAccess: string[];
}

export type ConnectorPermissionMode = "read_only" | "all";

export interface ConnectorConfig {
  permissionMode: ConnectorPermissionMode;
  myDayEnabled: boolean;
  personalIntelligenceAvailable: boolean;
  personalIntelligenceEnabled: boolean;
  personalIntelligenceIdentityStatus?: "unsupported" | "pending" | "resolved" | "failed";
  personalIntelligenceAccount?: {
    accountScopeId: string;
    displayName?: string;
    email?: string;
    handle?: string;
    providerWorkspaceId?: string;
    providerWorkspaceName?: string;
    verifiedAt?: string;
  } | null;
  enabledTools: string[];
  puter?: {
    imessageEnabled: boolean;
    imessagePersonalIntelligenceEnabled: boolean;
    notesEnabled: boolean;
    notesPersonalIntelligenceEnabled: boolean;
    sources?: {
      imessage?: PuterSourceAvailability;
      notes?: PuterSourceAvailability;
    };
  };
}

export type ConnectorDetails = Connector;
export type ConnectorConfigPatch = Omit<Partial<ConnectorConfig>, "puter"> & {
  puter?: Partial<NonNullable<ConnectorConfig["puter"]>>;
};
