import { createLogger, getTracer, withSpan } from "@finn/core";
import type { SpeechToTextClient, SpeechToTextOptions, TextToSpeechClient } from "./speech.js";

const logger = createLogger("xai-media");
const tracer = getTracer("xai-media");

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_TTS_VOICE = "eve";
const DEFAULT_TTS_LANGUAGE = "en";

export interface XaiMediaConfig {
  apiKey: string;
  baseUrl?: string;
  ttsVoiceId?: string;
  ttsLanguage?: string;
  ttsOutputCodec?: "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
  ttsSampleRate?: number;
  ttsBitRate?: number;
  sttLanguage?: string;
  sttFormat?: boolean;
}

interface XaiSpeechToTextResponse {
  text?: string;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function getFilename(options: SpeechToTextOptions | undefined, contentType: string): string {
  if (options?.filename) {
    return options.filename;
  }

  switch (contentType) {
    case "audio/wav":
      return "audio.wav";
    case "audio/mpeg":
      return "audio.mp3";
    case "audio/ogg":
      return "audio.ogg";
    case "audio/flac":
      return "audio.flac";
    case "audio/aac":
      return "audio.aac";
    case "audio/mp4":
    case "audio/x-m4a":
      return "audio.m4a";
    default:
      return "audio";
  }
}

export class XaiMediaClient implements SpeechToTextClient, TextToSpeechClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly ttsVoiceId: string;
  private readonly ttsLanguage: string;
  private readonly ttsOutputCodec: NonNullable<XaiMediaConfig["ttsOutputCodec"]>;
  private readonly ttsSampleRate?: number;
  private readonly ttsBitRate?: number;
  private readonly sttLanguage: string;
  private readonly sttFormat: boolean;

  constructor(config: XaiMediaConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.ttsVoiceId = config.ttsVoiceId ?? DEFAULT_TTS_VOICE;
    this.ttsLanguage = config.ttsLanguage ?? DEFAULT_TTS_LANGUAGE;
    this.ttsOutputCodec = config.ttsOutputCodec ?? "mp3";
    this.ttsSampleRate = config.ttsSampleRate;
    this.ttsBitRate = config.ttsBitRate;
    this.sttLanguage = config.sttLanguage ?? "en";
    this.sttFormat = config.sttFormat ?? true;
    logger.info("XaiMediaClient initialized");
  }

  async transcribe(audioBuffer: Buffer, options?: SpeechToTextOptions): Promise<string> {
    return withSpan(tracer, "xai.stt", { "audio.bytes": audioBuffer.length }, async () => {
      const contentType = options?.contentType ?? "application/octet-stream";
      const formData = new FormData();
      formData.append("format", String(this.sttFormat));
      if (this.sttFormat) {
        formData.append("language", this.sttLanguage);
      }
      formData.append("file", new File(
        [new Uint8Array(audioBuffer)],
        getFilename(options, contentType),
        { type: contentType },
      ));

      const response = await fetch(buildUrl(this.baseUrl, "/stt"), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        logger.error({ status: response.status, body: errorBody }, "xAI transcription failed");
        throw new Error(`xAI transcription failed: ${response.status} ${errorBody}`);
      }

      const result = await response.json() as XaiSpeechToTextResponse;
      const transcript = result.text ?? "";
      if (!transcript) {
        logger.warn("xAI returned empty transcript");
      }
      return transcript;
    });
  }

  async synthesize(text: string): Promise<Buffer> {
    return withSpan(tracer, "xai.tts", { "xai.voice": this.ttsVoiceId }, async () => {
      const response = await fetch(buildUrl(this.baseUrl, "/tts"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voice_id: this.ttsVoiceId,
          language: this.ttsLanguage,
          output_format: {
            codec: this.ttsOutputCodec,
            ...(this.ttsSampleRate ? { sample_rate: this.ttsSampleRate } : {}),
            ...(this.ttsBitRate ? { bit_rate: this.ttsBitRate } : {}),
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "Unknown error");
        logger.error({ status: response.status, body: errorBody }, "xAI synthesis failed");
        throw new Error(`xAI synthesis failed: ${response.status} ${errorBody}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (audioBuffer.length === 0) {
        throw new Error("xAI returned empty audio response");
      }
      return audioBuffer;
    });
  }
}
