import type { WebProvider } from "@finn/runtime";
import type { ToolsetCommandDefinition, ToolsetManifest, ToolsetProcessType } from "../../types.js";
import { webFetchInputSchema, webSearchInputSchema } from "./schemas.js";

export interface WebManifestOptions {
  processTypes: ToolsetProcessType[];
  search?: boolean;
  fetch?: boolean;
  provider?: WebProvider;
}

export function createWebManifest(options: WebManifestOptions): ToolsetManifest {
  const commands: ToolsetCommandDefinition[] = [];
  const provider = options.provider ?? "exa";
  const providerLabel = provider === "parallel" ? "Parallel Search and Extract" : "Exa";
  const hasFetch = options.fetch !== false;

  if (options.search !== false) {
    commands.push({
      name: "search",
      description: provider === "parallel"
        ? "Search the web with Parallel and return focused markdown excerpts plus session metadata."
        : "Search the web and return relevant excerpted results.",
      effects: ["read"],
      inputSchema: webSearchInputSchema,
      argumentGuidance: [
        provider === "parallel"
          ? "Use objective for the self-contained research goal and searchQueries for 2-3 concise keyword queries of 3-6 words each."
          : "query should be specific and semantic. Include names, dates, locations, product names, or the exact question when known.",
        provider === "parallel"
          ? "mode defaults to advanced for quality. Use basic only when low latency matters more than exhaustive retrieval."
          : "vertical supports only company or people. Omit it for normal web, news, docs, articles, code, and factual searches.",
        "numResults defaults to 5. Increase only when comparing options or coverage matters.",
        provider === "parallel"
          ? "Use sourcePolicy.includeDomains / excludeDomains / afterDate to constrain sources. Use fetchPolicy only when freshness is worth extra latency."
          : "maxAgeHours limits recency. Use 24 for last day, 168 for last week, and omit it for stable/background facts.",
        provider === "parallel"
          ? `Search responses include sessionId. Pass it to related ${hasFetch ? "finn.web.fetch or " : ""}finn.web.search calls during the same task.`
          : "Fetch a result URL when snippets are insufficient or exact source detail is needed.",
      ],
      examples: [
        provider === "parallel"
          ? { purpose: "Search for a current factual update", code: "await finn.web.search({ objective: \"Find the latest official OpenAI API model release details\", searchQueries: [\"OpenAI API latest model\", \"OpenAI model release\"], numResults: 5, sourcePolicy: { afterDate: \"2026-05-01\" } })" }
          : { purpose: "Search for a current factual update", code: "await finn.web.search({ query: \"OpenAI API latest model release May 2026\", numResults: 5, maxAgeHours: 168 })" },
        provider === "parallel"
          ? { purpose: "Search trusted domains only", code: "await finn.web.search({ objective: \"Compare current Postgres generated column behavior from official docs\", searchQueries: [\"Postgres generated columns\", \"PostgreSQL generated columns docs\"], sourcePolicy: { includeDomains: [\"postgresql.org\"] }, maxCharsTotal: 6000 })" }
          : { purpose: "Search for a company profile/discovery result", code: "await finn.web.search({ query: \"Series A fintech companies Switzerland\", vertical: \"company\", numResults: 5 })" },
        provider === "parallel"
          ? { purpose: "Prefer lower latency for a straightforward lookup", code: "await finn.web.search({ objective: \"Find the current npm package page for parallel-web\", searchQueries: [\"parallel-web npm\"], mode: \"basic\", numResults: 3 })" }
          : { purpose: "Search for background docs without recency filtering", code: "await finn.web.search({ query: \"Postgres generated columns official documentation\" })" },
      ],
      outputGuidance: [
        "Results include excerpt arrays suitable for direct citation/reasoning.",
        provider === "parallel"
          ? "Use returned sessionId in follow-up web calls. Check warnings when present, and inspect usage only for operational awareness."
          : "Fetch a result URL when excerpts are insufficient or exact source detail is needed.",
      ],
    });
  }
  if (options.fetch !== false) {
    commands.push({
      name: "fetch",
      description: provider === "parallel"
        ? "Extract focused markdown excerpts or full markdown content from one or more URLs through Parallel Extract."
        : "Fetch page excerpts by URL, optionally including page text when mode is full/text or both.",
      effects: ["read"],
      inputSchema: webFetchInputSchema,
      argumentGuidance: [
        "url must be a full http(s) URL from a search result or trusted source. Use urls for batch extraction when supported.",
        "mode excerpts is the default. Use full or both only when exact page text is needed and worth the token cost.",
        provider === "parallel"
          ? "Use objective and searchQueries to focus excerpts on the relevant part of long pages, PDFs, or JavaScript-heavy pages."
          : "Exa-backed fetch ignores Parallel-only objective, source, session, and fullContent controls.",
        provider === "parallel"
          ? "Use fullContent: true or { maxCharsPerResult } when full markdown content is required. Otherwise prefer excerpts."
          : "Use mode both for highlights plus page text when excerpts are ambiguous.",
        provider === "parallel"
          ? "Pass sessionId from the related search result so Parallel can keep context across Search and Extract."
          : "Fetch only public/trusted pages; use connected app or files tools for private user data.",
      ],
      examples: [
        provider === "parallel"
          ? { purpose: "Search, then extract focused excerpts from one result", code: "const search = await finn.web.search({ objective: \"Find the official pricing update\", searchQueries: [\"official pricing update\"] }); await finn.web.fetch({ url: search.results[0].url, objective: \"Extract the pricing changes and effective dates\", mode: \"excerpts\", sessionId: search.sessionId })" }
          : { purpose: "Fetch excerpts for one search result", code: "await finn.web.fetch({ url: \"https://example.com/article\" })" },
        provider === "parallel"
          ? { purpose: "Extract multiple URLs together", code: "await finn.web.fetch({ urls: [\"https://example.com/a\", \"https://example.com/b\"], objective: \"Compare the stated launch dates\", mode: \"both\", fullContent: { maxCharsPerResult: 12000 } })" }
          : { purpose: "Fetch excerpts plus page text for source-specific analysis", code: "await finn.web.fetch({ url: \"https://example.com/docs/page\", mode: \"both\" })" },
      ],
      outputGuidance: [
        "Prefer excerpts for broad research. Use full/both for exact details, structured docs, or when the excerpts are ambiguous.",
        provider === "parallel"
          ? "Fetch responses may include per-URL errors as errors, plus sessionId, warnings, and usage. Results may be partial when some URLs fail."
          : "The contents array contains one entry per fetched URL.",
      ],
    });
  }

  return {
    slug: "web",
    displayName: "Web",
    description: `Finn JS workspace access to Finn's gated web research runtime backed by ${providerLabel}.`,
    capability: "read",
    effects: ["read"],
    runtimeRequirements: ["web"],
    processTypes: options.processTypes,
    instructions: {
      overview: [
        `Use this toolset for public web research through Finn's gated ${providerLabel} runtime.`,
        provider === "parallel"
          ? hasFetch
            ? "Use search for discovery, then fetch for focused extraction from one or more specific URLs. Reuse sessionId across related calls."
            : "Use search for discovery and reuse sessionId across related searches in the same task."
          : hasFetch
            ? "Use search for discovery and fetch for a specific URL when source detail is needed."
            : "Use search for discovery when current public web context is needed.",
      ],
      syntaxRules: [
        "Quote queries and URLs. Pass arrays for searchQueries, urls, includeDomains, and excludeDomains.",
        provider === "parallel"
          ? "Use camelCase option names in the JS sandbox: searchQueries, sourcePolicy, fetchPolicy, sessionId, maxCharsTotal, maxCharsPerResult, fullContent."
          : "Do not invent unsupported verticals; only company and people are accepted.",
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
