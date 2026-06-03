import type { ProcessRuntimeServices } from "@finn/runtime";
import { viewImageCommand, viewImageInputSchema } from "@finn/toolsets";
import { tool, type ToolResultPart, type ToolSet } from "ai";

type ToolResultOutput = ToolResultPart["output"];
type JsonToolResultOutput = Extract<ToolResultOutput, { type: "json" }>;

function toJsonToolOutput(value: unknown): JsonToolResultOutput {
  return { type: "json", value: value as JsonToolResultOutput["value"] };
}

function toViewImageModelOutput({ output }: { output: unknown }): ToolResultOutput {
  if (typeof output !== "object" || output === null) {
    return toJsonToolOutput(output);
  }

  const result = output as Record<string, unknown>;
  const data = result["dataBase64"];
  const mediaType = result["mimeType"];
  if (result["success"] !== true || typeof data !== "string" || typeof mediaType !== "string" || !mediaType.startsWith("image/")) {
    return toJsonToolOutput(output);
  }

  return {
    type: "content",
    value: [
      {
        type: "text",
        text: JSON.stringify({
          ...result,
          dataBase64: `[base64 omitted from text view: ${data.length} chars]`,
        }, null, 2),
      },
      {
        type: "image-data",
        data,
        mediaType,
      },
    ],
  };
}

export function createViewImageTools(runtime: ProcessRuntimeServices): ToolSet {
  const files = runtime.files;
  if (!files) {
    return {};
  }

  return {
    view_image: tool({
      description: "Inspect an image from a stored Finn file ID, /workspace/... path, or /artifacts/... path. Workspace-relative paths are also accepted as an input convenience. Use this native tool for image pixels instead of file text APIs.",
      inputSchema: viewImageInputSchema,
      toModelOutput: toViewImageModelOutput,
      execute: (input) => viewImageCommand(files, input),
    }),
  };
}
