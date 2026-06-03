import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import { webFetchInputSchema, webSearchInputSchema } from "./schemas.js";

export interface WebManifestOptions {
  processTypes: ToolsetProcessType[];
  search?: boolean;
  fetch?: boolean;
}

export function createWebManifest(options: WebManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [];
  if (options.search !== false) {
    commands.push({
      name: "search",
      description: "Search the web and return relevant highlighted results.",
      effects: ["read"],
      inputSchema: webSearchInputSchema,
      argumentGuidance: [
        "query should be specific and semantic. Include names, dates, locations, product names, or the exact question when known.",
        "numResults defaults to 5. Increase only when comparing options or coverage matters.",
        "maxAgeHours limits recency. Use 24 for last day, 168 for last week, and omit it for stable/background facts.",
        "vertical supports only company or people. Omit it for normal web, news, docs, articles, code, and factual searches.",
      ],
      examples: [
        { purpose: "Search for a current factual update", code: "await finn.web.search({ query: \"OpenAI API latest model release May 2026\", numResults: 5, maxAgeHours: 168 })" },
        { purpose: "Search for a company profile/discovery result", code: "await finn.web.search({ query: \"Series A fintech companies Switzerland\", vertical: \"company\", numResults: 5 })" },
        { purpose: "Search for background docs without recency filtering", code: "await finn.web.search({ query: \"Postgres generated columns official documentation\" })" },
      ],
      outputGuidance: [
        "Results include highlighted snippets. Fetch a result URL when snippets are insufficient or exact source detail is needed.",
      ],
    });
  }
  if (options.fetch !== false) {
    commands.push({
      name: "fetch",
      description: "Fetch page highlights by URL, optionally including page text when mode is text or both.",
      effects: ["read"],
      inputSchema: webFetchInputSchema,
      argumentGuidance: [
        "url must be a full http(s) URL from a search result or trusted source.",
        "mode highlights is the default. Use text or both only when page text is needed and likely worth the token cost.",
      ],
      examples: [
        { purpose: "Fetch highlights for one search result", code: "await finn.web.fetch({ url: \"https://example.com/article\" })" },
        { purpose: "Fetch highlights plus page text for source-specific analysis", code: "await finn.web.fetch({ url: \"https://example.com/docs/page\", mode: \"both\" })" },
      ],
      outputGuidance: [
        "Prefer highlights for broad research. Use text/both for exact details, structured docs, or when the highlighted snippets are ambiguous.",
      ],
    });
  }

  return {
    slug: "web",
    displayName: "Web",
    description: "Finn JS workspace access to Finn's gated web search and page fetch runtime.",
    capability: "read",
    effects: ["read"],
    runtimeRequirements: ["web"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        "Use this toolset for web research through Finn's gated Exa runtime.",
        "Use search for discovery and fetch for a specific URL when source detail is needed.",
      ],
      syntaxRules: [
        "Quote queries and URLs.",
        "Do not invent unsupported verticals; only company and people are accepted.",
      ],
      safetyRules: [
        "Prefer connected app tools over web research when the task asks about the user's private accounts or connected services.",
        "Use current web results for unstable facts such as news, prices, laws, schedules, software versions, and recommendations.",
      ],
    },
    defaultLimit: 5,
    maxLimit: 100,
    commands,
  };
}
