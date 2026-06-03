import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import {
  patternsCreateInputSchema,
  patternsDeleteInputSchema,
  patternsEditInputSchema,
  patternsInspectInputSchema,
  patternsListInputSchema,
  patternsSetActiveInputSchema,
  patternsTriggerTypeInputSchema,
  patternsTriggerTypesInputSchema,
} from "./schemas.js";

export interface PatternsManifestOptions {
  processTypes: ToolsetProcessType[];
}

export function createPatternsManifest(options: PatternsManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [
    {
      name: "list",
      description: "List saved Pattern automations, five summaries at a time.",
      effects: ["read"],
      inputSchema: patternsListInputSchema,
      argumentGuidance: [
        "This returns summaries only: Pattern ID, name, and user-facing description.",
        "Use cursor with a cursor returned by a previous list response to page.",
      ],
      examples: [
        { purpose: "List the first page of Patterns", code: "await finn.patterns.list({})" },
        { purpose: "List the next page", code: "await finn.patterns.list({ cursor: \"ptn_cursor\" })" },
      ],
      outputGuidance: [
        "Use finn.patterns.inspect by ID before editing, deleting, pausing, resuming, or replacing a Pattern.",
      ],
    },
    {
      name: "inspect",
      description: "Inspect a Pattern by ID, including trigger, connector scope, filters, notify policy, and worker prompt.",
      effects: ["read"],
      inputSchema: patternsInspectInputSchema,
      argumentGuidance: [
        "id must be a Pattern ID returned by finn.patterns.list or already present in context.",
      ],
      examples: [
        { purpose: "Inspect a Pattern before editing", code: "await finn.patterns.inspect({ id: \"ptn_123\" })" },
      ],
    },
    {
      name: "create",
      description: "Create a scheduled or Composio-triggered Pattern automation. Complex schedule, composio, connectorScope, triggerFilters, and notifyCondition inputs accept structured objects.",
      effects: ["write"],
      inputSchema: patternsCreateInputSchema,
      argumentGuidance: [
        "name is a short internal/user-facing title. userDescription says what Finn will do for the user. prompt is the standalone worker task.",
        "Keep userDescription free of delivery style or internal mechanics. Do not mention prose, bullets, markdown, tone, workers, tools, or how Finn should word the result.",
        "Keep prompt operational: what to inspect, decide, and return as facts. Do not include suggested user replies or presentation rules unless the Pattern explicitly drafts external content.",
        "For scheduled Patterns, pass schedule as an object, such as {\"kind\":\"daily\",\"time\":\"09:00\"}.",
        "Scheduled Patterns do not inherit your current Composio tools. If the future worker needs Gmail, Outlook, Slack, Linear, or another connected service, also pass connectorScope with the needed connected account IDs.",
        "Connector scope is source/action access, not delivery. Do not add or request iMessage/Messages connector scope for Pattern notifications; Finn handles delivery from notify outcomes.",
        "Example connector scope: {\"composio\":[{\"toolkitSlug\":\"gmail\",\"connectedAccountId\":\"acct_123\"}],\"mcpServerIds\":[]}. Use the connected account IDs shown in the runtime Composio toolkit scope.",
        "For Composio-triggered Patterns, pass composio as an object with toolkitSlug, triggerSlug, connectedAccountId, and optional triggerConfig.",
        "triggerFilters is an array of {path, operator, value}. notifyCondition is an object.",
      ],
      examples: [
        { purpose: "Create a daily scheduled Pattern that uses Gmail", code: "await finn.patterns.create({ name: \"Morning brief\", userDescription: \"Check important Gmail and AI news every weekday morning.\", prompt: \"Inspect recent Gmail for important non-promotional emails and find current AI news headlines. Return notable email and headline facts with source names and URLs.\", schedule: { kind: \"daily\", time: \"08:00\" }, connectorScope: { composio: [{ toolkitSlug: \"gmail\", connectedAccountId: \"acct_123\" }], mcpServerIds: [] }, notifyCondition: { type: \"always\" } })" },
        { purpose: "Create a daily web-only scheduled Pattern", code: "await finn.patterns.create({ name: \"AI news brief\", userDescription: \"Check top AI news every morning.\", prompt: \"Find current top AI news headlines. Return the notable headline facts with source names and URLs.\", schedule: { kind: \"daily\", time: \"08:00\" }, notifyCondition: { type: \"always\" } })" },
        { purpose: "Create an email-triggered Pattern with a sender filter", code: "await finn.patterns.create({ name: \"Alex email watch\", userDescription: \"Watch for emails from Alex.\", prompt: \"Check whether the new email from Alex is important enough to notify about. Return the sender, subject, and concise reason if it is notable.\", composio: { toolkitSlug: \"gmail\", triggerSlug: \"GMAIL_NEW_GMAIL_MESSAGE\", connectedAccountId: \"acct_123\" }, triggerFilters: [{ path: \"sender\", operator: \"contains\", value: \"alex\" }] })" },
      ],
      outputGuidance: [
        "Return the created Pattern ID, name, triggerType, and persisted nextRun exactly as provided by the tool result.",
        "If runtimeAccessWarning appears and the task needs connected services, immediately edit the Pattern in place with connectorScope before reporting success.",
      ],
    },
    {
      name: "edit",
      description: "Edit an existing Pattern in place while preserving Pattern ID and run history. Complex object inputs accept structured objects.",
      effects: ["write"],
      inputSchema: patternsEditInputSchema,
      argumentGuidance: [
        "id is required. Include only fields that should change.",
        "Use userDescriptionEdit or promptEdit with a reason when asking the runtime to revise existing copy/instructions rather than replacing them verbatim.",
        "Use active true/false only when pausing/resuming through edit is explicitly desired; otherwise prefer finn.patterns.pause or finn.patterns.resume.",
        "Complex schedule, connectorScope, triggerFilters, notifyCondition, and composio inputs accept structured objects.",
        "Do not add delivery style, suggested reply text, or internal mechanics to userDescription or prompt.",
        "Do not add connector scope for delivering Pattern notifications. Connector scope is only for source/action tools the future worker needs.",
        "Do not remove connector scope during schedule-only edits. If the worker prompt needs connected services, ensure connectorScope includes those Composio or MCP accounts.",
      ],
      examples: [
        { purpose: "Rename a Pattern", code: "await finn.patterns.edit({ id: \"ptn_123\", name: \"Updated email watch\" })" },
        { purpose: "Replace the schedule", code: "await finn.patterns.edit({ id: \"ptn_123\", schedule: { kind: \"weekly\", daysOfWeek: [\"monday\"], time: \"09:00\" } })" },
        { purpose: "Add Gmail access to an existing scheduled Pattern", code: "await finn.patterns.edit({ id: \"ptn_123\", connectorScope: { composio: [{ toolkitSlug: \"gmail\", connectedAccountId: \"acct_123\" }], mcpServerIds: [] } })" },
        { purpose: "Ask the runtime to revise the worker prompt with context", code: "await finn.patterns.edit({ id: \"ptn_123\", promptEdit: { reason: \"Also ignore newsletters and marketing emails.\" } })" },
      ],
      outputGuidance: [
        "Use the returned Pattern record as the source of truth. Do not invent next run times.",
        "If runtimeAccessWarning appears and the task needs connected services, immediately edit the Pattern in place with connectorScope before reporting success.",
      ],
    },
    {
      name: "pause",
      description: "Pause an active Pattern by ID.",
      effects: ["write"],
      inputSchema: patternsSetActiveInputSchema,
      argumentGuidance: [
        "id must identify the Pattern to pause. Inspect first when there is ambiguity.",
      ],
      examples: [
        { purpose: "Pause one Pattern", code: "await finn.patterns.pause({ id: \"ptn_123\" })" },
      ],
    },
    {
      name: "resume",
      description: "Resume a paused Pattern by ID.",
      effects: ["write"],
      inputSchema: patternsSetActiveInputSchema,
      argumentGuidance: [
        "id must identify the Pattern to resume. Inspect first when there is ambiguity.",
      ],
      examples: [
        { purpose: "Resume one Pattern", code: "await finn.patterns.resume({ id: \"ptn_123\" })" },
      ],
    },
    {
      name: "delete",
      description: "Delete a Pattern by ID.",
      effects: ["write"],
      inputSchema: patternsDeleteInputSchema,
      argumentGuidance: [
        "id must identify the Pattern to delete. Inspect first and delete only when replacement/removal is explicitly intended.",
      ],
      examples: [
        { purpose: "Delete one Pattern after confirmation/scope is clear", code: "await finn.patterns.delete({ id: \"ptn_123\" })" },
      ],
    },
    {
      name: "trigger_types",
      description: "List Composio trigger types dynamically for connected toolkits.",
      effects: ["read"],
      inputSchema: patternsTriggerTypesInputSchema,
      argumentGuidance: [
        "toolkitSlug narrows results to one connected toolkit such as gmail or linear.",
      ],
      examples: [
        { purpose: "List trigger types for Gmail", code: "await finn.patterns.triggerTypes({ toolkitSlug: \"gmail\" })" },
        { purpose: "List trigger types across connected toolkits", code: "await finn.patterns.triggerTypes({})" },
      ],
      outputGuidance: [
        "Use the returned triggerSlug exactly in finn.patterns.triggerType or the composio input.",
      ],
    },
    {
      name: "trigger_type",
      description: "Inspect a Composio trigger type's setup config schema and webhook payload schema before creating filters.",
      effects: ["read"],
      inputSchema: patternsTriggerTypeInputSchema,
      argumentGuidance: [
        "triggerSlug must be a trigger slug returned by finn.patterns.triggerTypes.",
      ],
      examples: [
        { purpose: "Inspect one Composio trigger type", code: "await finn.patterns.triggerType({ triggerSlug: \"GMAIL_NEW_GMAIL_MESSAGE\" })" },
      ],
      outputGuidance: [
        "Use payload schema paths to build triggerFilters. Do not guess filter paths.",
      ],
    },
  ];

  return {
    slug: "patterns",
    displayName: "Patterns",
    description: "Finn JS workspace access to Finn's Pattern automation management runtime.",
    capability: "write",
    effects: ["read", "write"],
    runtimeRequirements: ["patterns"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset only for Pattern automation management: list, inspect, create, edit, pause, resume, delete, and trigger schema discovery.",
        "Update existing Patterns in place whenever possible so the Pattern ID and run history survive.",
      ],
      referenceFormats: [
        "Pattern IDs look like ptn_123 and come from finn.patterns.list, inspect results, or runtime context.",
        "Composio trigger slugs come from finn.patterns.triggerTypes.",
        "Complex inputs use JavaScript objects or arrays matching the schema.",
      ],
      syntaxRules: [
        "Pass complex objects as JavaScript object values that match the schema.",
        "Do not guess trigger filter paths; inspect the trigger type schema first.",
      ],
      safetyRules: [
        "Inspect a Pattern before edits/deletes/replacements unless the exact Pattern and change are already unambiguous.",
        "Do not invent nextRun values. Use the persisted tool result.",
      ],
    },
    defaultLimit: 5,
    maxLimit: 5,
    commands,
  };
}
