import { createLogger, getTracer, withSpan } from "@finn/core";

const logger = createLogger("elevenlabs");
const tracer = getTracer("elevenlabs");

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
}

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly defaultModelId: string;

  constructor(config: ElevenLabsConfig) {
    this.apiKey = config.apiKey;
    this.defaultVoiceId = config.voiceId ?? "21m00Tcm4TlvDq8ikWAM"; // Rachel — ElevenLabs default
    this.defaultModelId = config.modelId ?? "eleven_turbo_v2_5";
    logger.info("ElevenLabsClient initialized");
  }

  /**
   * Synthesize text to speech audio.
   * Returns a Buffer containing the audio data (MP3 format by default).
   */
  async synthesize(text: string, options?: {
    voiceId?: string;
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
    outputFormat?: string;
  }): Promise<Buffer> {
    const voiceId = options?.voiceId ?? this.defaultVoiceId;
    const modelId = options?.modelId ?? this.defaultModelId;
    const stability = options?.stability ?? 0.5;
    const similarityBoost = options?.similarityBoost ?? 0.75;
    const outputFormat = options?.outputFormat ?? "mp3_44100_128";

    return withSpan(
      tracer,
      "elevenlabs.synthesize",
      { "elevenlabs.voiceId": voiceId, "elevenlabs.modelId": modelId },
      async () => {
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "xi-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: {
              stability,
              similarity_boost: similarityBoost,
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "Unknown error");
          logger.error({ status: response.status, body: errorBody }, "ElevenLabs synthesis failed");
          throw new Error(`ElevenLabs synthesis failed: ${response.status} ${errorBody}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());

        if (audioBuffer.length === 0) {
          logger.warn("ElevenLabs returned empty audio buffer");
          throw new Error("ElevenLabs returned empty audio response");
        }

        logger.debug({ bytes: audioBuffer.length, voiceId, modelId }, "TTS synthesis complete");
        return audioBuffer;
      },
    );
  }
}
