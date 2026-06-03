import { resolveBrowserTimeZone } from "./lib/timezones";
import { connectorNameForSlug } from "./onboarding-utils";
import type { Connector, McpServer, MyDayPage, Pattern, PatternRun, UserProfile } from "./web-types";

export const demoSpectrumAssignedPhoneNumber = "+15550104240";
export const testDashboardUser: UserProfile = {
  id: "test-dashboard",
  phoneNumber: "+61 412 345 678",
  displayName: "Alex",
  timezone: "Australia/Brisbane",
  timezoneSource: "manual",
  location: "Brisbane, Australia",
  kidsMode: false,
  onboarding: {
    completedAt: new Date().toISOString(),
    requiredConnectorSlugs: ["gmail", "outlook"],
  },
  profileImageUrl: null,
};
export function createOnboardingDemoUser(): UserProfile {
  return {
    id: "onboarding-demo",
    phoneNumber: "+61 412 345 678",
    displayName: "",
    timezone: resolveBrowserTimeZone(undefined),
    timezoneSource: "browser",
    location: "",
    kidsMode: false,
    onboarding: {
      completedAt: null,
      requiredConnectorSlugs: ["gmail", "outlook"],
    },
    profileImageUrl: null,
  };
}

function createDemoMailConnector(slug: "gmail" | "outlook", connected: boolean): Connector {
  return {
    slug,
    name: connectorNameForSlug(slug),
    logo: slug === "gmail"
      ? "https://www.google.com/s2/favicons?domain=gmail.com&sz=64"
      : "https://www.google.com/s2/favicons?domain=outlook.live.com&sz=64",
    description: slug === "gmail"
      ? "Send, read, and organize emails and drafts."
      : "Read and organize Outlook mail and calendar context.",
    requiresAuth: true,
    connected,
    enabled: connected,
    ...(connected ? { connectionStatus: "connected", connectedAccountId: `demo-${slug}-account` } : {}),
    config: {
      permissionMode: "read_only",
      myDayEnabled: connected,
      personalIntelligenceAvailable: true,
      personalIntelligenceEnabled: connected,
      personalIntelligenceIdentityStatus: connected ? "resolved" : "pending",
      personalIntelligenceAccount: connected ? { accountScopeId: `${slug}:demo` } : null,
      enabledTools: [],
    },
  };
}

export const demoConnector: Connector = createDemoMailConnector("gmail", true);

export function createOnboardingDemoConnectors(): Connector[] {
  return [
    createDemoMailConnector("gmail", false),
    createDemoMailConnector("outlook", false),
  ];
}

export const demoMyDayPage = (): MyDayPage => {
  const now = new Date().toISOString();
  return {
    day: {
      id: "demo-my-day",
      userLocalDate: new Intl.DateTimeFormat("en-CA").format(new Date()),
      timezone: testDashboardUser.timezone,
      summary: "A focused day: one calendar commitment, a couple of admin follow-ups, and room for project work before the evening.",
      sourceSummary: "Demo data from calendar, mail, and open todos.",
      lastRefreshedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    todos: [
      { id: "demo-todo-1", title: "Reply to Sam about Friday", notes: null, status: "open", source: { type: "my_day_refresh", label: "Email" }, handoffAt: null, handoffWorkerId: null, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null },
      { id: "demo-todo-2", title: "Check renewal notice", notes: null, status: "open", source: { type: "my_day_refresh", label: "Gmail" }, handoffAt: null, handoffWorkerId: null, createdAt: now, updatedAt: now, completedAt: null, archivedAt: null },
      { id: "demo-todo-3", title: "Morning planning", notes: null, status: "done", source: { type: "user", label: "My Day" }, handoffAt: null, handoffWorkerId: null, createdAt: now, updatedAt: now, completedAt: now, archivedAt: null },
    ],
  };
};
export const demoMcpServers: McpServer[] = [
  {
    id: "demo-browser-use-mcp",
    name: "browser-use",
    description: "Browser automation tools exposed through a remote MCP endpoint.",
    authMode: "api_key",
    transport: {
      type: "http",
      url: "https://api.browser-use.com/v3/mcp",
      hasAuthToken: true,
    },
    alwaysOn: true,
    active: true,
    connected: true,
    toolCount: 7,
    resourceCount: 0,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 9).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
  },
  {
    id: "demo-signal-mcp",
    name: "demo-signal-2",
    description: "Local signal watcher tunnel.",
    authMode: "oauth",
    transport: {
      type: "sse",
      url: "https://demo-signal.example.com/mcp",
      hasAuthToken: false,
    },
    alwaysOn: true,
    active: true,
    connected: true,
    toolCount: 3,
    resourceCount: 0,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 21).toISOString(),
  },
];
const demoPattern: Pattern = {
  id: "demo-important-email-pattern",
  name: "Text important emails",
  description: "Texts you when important emails arrive, including bills, personal notes, and time-sensitive updates.",
  userDescription: "I will watch for important emails and let you know when one arrives.",
  triggerType: "composio",
  triggerConfig: {
    type: "composio",
    toolkitSlug: "gmail",
    triggerSlug: "new_email",
    connectedAccountId: "demo-gmail-account",
    triggerId: "demo-gmail-new-email",
  },
  connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "demo-gmail-account" }], mcpServerIds: [] },
  triggerFilters: [],
  notifyCondition: { type: "worker_decision", instruction: "Notify only when the email is important or time-sensitive." },
  taskPrompt: "Watch for important personal email and text me a short summary with the sender, subject, and why it matters.",
  reminderContext: null,
  workerType: "general",
  timezone: "Australia/Brisbane",
  active: true,
  failureCount: 0,
  lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  nextRunAt: null,
  createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
  updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
};

export const demoPatterns: Pattern[] = [
  demoPattern,
  {
    id: "demo-daily-briefing-pattern",
    name: "Morning briefing",
    description: "Sends a morning summary of calendar events, weather, and priority tasks.",
    userDescription: "Each morning I'll send you a quick rundown of your day ahead.",
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "daily", time: "07:00" } },
    connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "demo-gmail-account" }], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    taskPrompt: "Compile a brief morning summary covering today's calendar, weather, and top priority tasks.",
    reminderContext: null,
    workerType: "general",
    timezone: "Australia/Brisbane",
    active: true,
    failureCount: 0,
    lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 14).toISOString(),
    nextRunAt: new Date(Date.now() + 1000 * 60 * 60 * 10).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 14).toISOString(),
  },
  {
    id: "demo-weekly-recap-pattern",
    name: "Weekly recap",
    description: "Sends a weekly summary every Sunday evening of what happened and what's ahead.",
    userDescription: "Every Sunday evening I'll recap your week and preview the one ahead.",
    triggerType: "schedule",
    triggerConfig: { type: "schedule", schedule: { kind: "weekly", daysOfWeek: ["sunday"], time: "18:00" } },
    connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "demo-gmail-account" }], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "always" },
    taskPrompt: "Write a concise weekly recap covering highlights, completed tasks, and priorities for the coming week.",
    reminderContext: null,
    workerType: "general",
    timezone: "Australia/Brisbane",
    active: true,
    failureCount: 0,
    lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    nextRunAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 4).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  },
  {
    id: "demo-slack-mentions-pattern",
    name: "Slack direct mentions",
    description: "Alerts you when someone mentions you directly in Slack.",
    userDescription: "I'll let you know when someone tags you in a Slack message.",
    triggerType: "composio",
    triggerConfig: {
      type: "composio",
      toolkitSlug: "slack",
      triggerSlug: "new_mention",
      connectedAccountId: "demo-slack-account",
      triggerId: "demo-slack-mention",
    },
    connectorScope: { composio: [{ toolkitSlug: "slack", connectedAccountId: "demo-slack-account" }], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "worker_decision", instruction: "Notify only for direct mentions, not channel-wide announcements." },
    taskPrompt: "Check the Slack mention and text me the sender, channel, and a short summary of the message.",
    reminderContext: null,
    workerType: "general",
    timezone: "Australia/Brisbane",
    active: false,
    failureCount: 0,
    lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    nextRunAt: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 21).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
  {
    id: "demo-bill-tracker-pattern",
    name: "Track upcoming bills",
    description: "Scans email for upcoming bills and payment reminders and texts a heads-up.",
    userDescription: "I'll watch for bills and payment due dates so nothing sneaks up on you.",
    triggerType: "composio",
    triggerConfig: {
      type: "composio",
      toolkitSlug: "gmail",
      triggerSlug: "new_email",
      connectedAccountId: "demo-gmail-account",
      triggerId: "demo-gmail-bills",
    },
    connectorScope: { composio: [{ toolkitSlug: "gmail", connectedAccountId: "demo-gmail-account" }], mcpServerIds: [] },
    triggerFilters: [],
    notifyCondition: { type: "worker_decision", instruction: "Notify only when the email contains a bill, invoice, or payment reminder." },
    taskPrompt: "Check if this email is a bill or payment reminder. If so, text me the amount, due date, and who it's from.",
    reminderContext: null,
    workerType: "general",
    timezone: "Australia/Brisbane",
    active: true,
    failureCount: 0,
    lastRunAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    nextRunAt: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
  },
];

export function demoPatternRuns(patternId: string): PatternRun[] {
  const now = Date.now();
  const examples = [
    { minutesAgo: 8, durationSeconds: 0, state: "running" as const, notify: null, reason: null },
    { minutesAgo: 42, durationSeconds: 73, state: "done" as const, notify: true, reason: "Detected a time-sensitive renewal notice from RACQ." },
    { minutesAgo: 95, durationSeconds: 28, state: "done" as const, notify: false, reason: "Newsletter-style email did not meet the importance threshold." },
    { minutesAgo: 150, durationSeconds: 41, state: "done" as const, notify: true, reason: "Found a message about an upcoming appointment change." },
    { minutesAgo: 220, durationSeconds: 19, state: "done" as const, notify: false, reason: "Receipt was informational and did not need a text." },
    { minutesAgo: 310, durationSeconds: 64, state: "done" as const, notify: true, reason: "Flagged a payment reminder due soon." },
    { minutesAgo: 430, durationSeconds: 36, state: "done" as const, notify: false, reason: "Promotional message was ignored." },
    { minutesAgo: 570, durationSeconds: 49, state: "done" as const, notify: true, reason: "Personal email asked for a same-day response." },
    { minutesAgo: 760, durationSeconds: 23, state: "failed" as const, notify: null, reason: "Gmail trigger payload was missing the email body." },
    { minutesAgo: 1040, durationSeconds: 58, state: "done" as const, notify: false, reason: "Bank update was routine and already expected." },
    { minutesAgo: 1260, durationSeconds: 31, state: "done" as const, notify: true, reason: "Older run beyond the activity sheet limit." },
  ];

  return examples.map((example, index) => {
    const createdAtMs = now - example.minutesAgo * 60 * 1000;
    const completedAt = example.state === "running" ? null : new Date(createdAtMs + example.durationSeconds * 1000).toISOString();
    return {
      id: `demo-pattern-run-${index + 1}`,
      patternId,
      triggeredBy: "composio",
      state: example.state,
      result: example.state === "failed" ? { summary: "Run failed.", error: example.reason ?? undefined } : { summary: example.reason ?? "Pattern run completed." },
      error: example.state === "failed" ? example.reason : null,
      skipReason: null,
      notifyOutcome: example.notify === null ? null : { notify: example.notify, summary: example.reason ?? "Pattern run completed.", reason: example.reason ?? undefined },
      surfacedAt: example.notify ? new Date(createdAtMs + (example.durationSeconds + 20) * 1000).toISOString() : null,
      createdAt: new Date(createdAtMs).toISOString(),
      completedAt,
    };
  });
}
