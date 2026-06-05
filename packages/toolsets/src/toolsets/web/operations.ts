import type { WebContent, WebRuntimeService } from "@finn/runtime";
import { formatToolsetError } from "../../utils.js";
import { webFetchInputSchema, webSearchInputSchema, type WebFetchInput } from "./schemas.js";

function formatContentsForMode(contents: WebContent[], mode: WebFetchInput["mode"]): WebContent[] {
  if (mode === "text" || mode === "full") {
    return contents.map(({ highlights: _highlights, excerpts: _excerpts, ...content }) => content);
  }

  if (mode === "highlights" || mode === "excerpts") {
    return contents.map(({ text: _text, fullContent: _fullContent, ...content }) => content);
  }

  return contents;
}

function getFetchTarget(parsed: WebFetchInput): string | string[] {
  return parsed.urls ?? parsed.url ?? [];
}

export async function webSearchCommand(runtime: WebRuntimeService, input: unknown) {
  const parsed = webSearchInputSchema.parse(input);
  try {
    return await runtime.search({
      query: parsed.query,
      objective: parsed.objective,
      searchQueries: parsed.searchQueries,
      numResults: parsed.numResults,
      maxAgeHours: parsed.maxAgeHours,
      vertical: parsed.vertical,
      mode: parsed.mode,
      maxCharsTotal: parsed.maxCharsTotal,
      sessionId: parsed.sessionId,
      sourcePolicy: parsed.sourcePolicy,
      fetchPolicy: parsed.fetchPolicy,
      maxCharsPerResult: parsed.maxCharsPerResult,
      location: parsed.location,
    });
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function webFetchCommand(runtime: WebRuntimeService, input: unknown) {
  const parsed = webFetchInputSchema.parse(input);
  try {
    const response = await runtime.fetch(getFetchTarget(parsed), {
      includeText: parsed.mode === "text" || parsed.mode === "full" || parsed.mode === "both",
      objective: parsed.objective,
      searchQueries: parsed.searchQueries,
      maxCharsTotal: parsed.maxCharsTotal,
      sessionId: parsed.sessionId,
      fetchPolicy: parsed.fetchPolicy,
      maxCharsPerResult: parsed.maxCharsPerResult,
      fullContent: parsed.fullContent,
    });
    return {
      mode: parsed.mode,
      ...response,
      contents: formatContentsForMode(response.contents, parsed.mode),
    };
  } catch (error) {
    return { error: formatToolsetError(error) };
  }
}

export async function executeWebCommand(runtime: WebRuntimeService, command: string, args: unknown): Promise<unknown> {
  switch (command) {
    case "search":
      return webSearchCommand(runtime, args);
    case "fetch":
      return webFetchCommand(runtime, args);
    default:
      throw new Error(`Unsupported web command: ${command}`);
  }
}
