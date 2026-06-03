import type { WebContent, WebRuntimeService } from "@finn/runtime";
import { webFetchInputSchema, webSearchInputSchema, type WebFetchInput } from "./schemas.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function formatContentsForMode(contents: WebContent[], mode: WebFetchInput["mode"]): WebContent[] {
  if (mode === "text") {
    return contents.map(({ highlights: _highlights, ...content }) => content);
  }

  if (mode === "highlights") {
    return contents.map(({ text: _text, ...content }) => content);
  }

  return contents;
}

export async function webSearchCommand(runtime: WebRuntimeService, input: unknown) {
  const parsed = webSearchInputSchema.parse(input);
  try {
    const results = await runtime.search({
      query: parsed.query,
      numResults: parsed.numResults,
      maxAgeHours: parsed.maxAgeHours,
      vertical: parsed.vertical,
    });
    return { results };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

export async function webFetchCommand(runtime: WebRuntimeService, input: unknown) {
  const parsed = webFetchInputSchema.parse(input);
  try {
    const contents = await runtime.fetch(parsed.url, {
      includeText: parsed.mode === "highlights" ? undefined : true,
    });
    return {
      mode: parsed.mode,
      contents: formatContentsForMode(contents, parsed.mode),
    };
  } catch (error) {
    return { error: getErrorMessage(error) };
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
