import { createLogger, getTracer, withSpan } from "@finn/core";
import type { SpeechToTextOptions } from "./speech.js";

const logger = createLogger("deepgram");
const tracer = getTracer("deepgram");

export interface DeepgramConfig {
  apiKey: string;
}

export class DeepgramClient {
  private readonly apiKey: string;

  constructor(config: DeepgramConfig) {
    this.apiKey = config.apiKey;
    logger.info("DeepgramClient initialized");
  }

  /**
   * Transcribe audio buffer to text using Deepgram's Nova-2 model.
   * Uses the prerecorded API endpoint.
   */
  async transcribe(
    audioBuffer: Buffer,
    options?: SpeechToTextOptions & { model?: string; language?: string; smartFormat?: boolean },
  ): Promise<string> {
    const model = options?.model ?? "nova-3";
    const language = options?.language ?? "en";
    const smartFormat = options?.smartFormat ?? true;

    return withSpan(
      tracer,
      "deepgram.transcribe",
      { "deepgram.model": model, "deepgram.language": language, "audio.bytes": audioBuffer.length },
      async () => {
        const url = new URL("https://api.deepgram.com/v1/listen");
        url.searchParams.set("model", model);
        url.searchParams.set("language", language);
        if (smartFormat) {
          url.searchParams.set("smart_format", "true");
        }

        let response: Response;

        try {
          response = await fetch(url.toString(), {
            method: "POST",
            headers: {
              "Authorization": `Token ${this.apiKey}`,
               "Content-Type": options?.contentType ?? "application/octet-stream",
             },
            body: new Uint8Array(audioBuffer),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          logger.error({ error: message }, "Deepgram request failed");
          throw new Error(`Deepgram request failed: ${message}`);
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "Unknown error");
          logger.error({ status: response.status, body: errorBody }, "Deepgram transcription failed");
          throw new Error(`Deepgram transcription failed: ${response.status} ${errorBody}`);
        }

        let result: DeepgramResponse;

        try {
          result = (await response.json()) as DeepgramResponse;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          logger.error({ error: message }, "Deepgram returned invalid JSON");
          throw new Error(`Deepgram returned invalid JSON: ${message}`);
        }

        const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

        if (!transcript) {
          logger.warn("Deepgram returned empty transcript");
        }

        return transcript;
      },
    );
  }
}

/** Minimal type for Deepgram prerecorded response */
interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
      }>;
    }>;
  };
}
