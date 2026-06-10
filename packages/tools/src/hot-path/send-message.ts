import { tool } from "ai";
import { getTracer, normalizeOutgoingAssistantText, withSpan } from "@finn/core";
import { convertAudioToM4a, probeAudioDuration, type TextToSpeechClient } from "@finn/media";
import type { FilesRuntime } from "@finn/runtime";
import { z } from "zod";

const tracer = getTracer("hot-path-tools");

const baseSendMessageParameters = z.object({
  text: z.string().trim().min(1),
  replyToMessageHandle: z.string().trim().min(1).optional().describe("Use rarely. Exact handle attribute value from the relevant <message> element when a delayed result directly answers that earlier message."),
});

const voiceSendMessageParameters = baseSendMessageParameters.extend({
  voice_message: z.boolean().optional().describe("Set true only when sending this reply as an iMessage voice note is appropriate. Default false."),
});

type SendMessageInput = z.infer<typeof voiceSendMessageParameters>;

const outboundDeliveryReceiptInstruction = "This is an outbound delivery receipt, not a user reply. Continue only if this same response still has unsent content; otherwise call finish_turn.";

interface MessageSender {
  sendText(text: string, options?: { replyToMessageHandle?: string }): Promise<unknown> | unknown;
  sendMedia(fileId: string, caption?: string): Promise<void> | void;
  sendVoiceMessage(fileId: string, options?: { duration?: number; replyToMessageHandle?: string }): Promise<unknown> | unknown;
}

export interface SendMessageToolDeps {
  sender: MessageSender;
  voice?: {
    tts: TextToSpeechClient;
    files: FilesRuntime;
    tempRoot: string;
    convertAudioToM4a?: (input: Buffer) => Promise<Buffer>;
    probeAudioDuration?: (input: Buffer) => Promise<number | undefined>;
  };
}

function getStoredFiles(runtime: FilesRuntime): NonNullable<FilesRuntime["storedFiles"]> | undefined {
  return runtime.storedFiles;
}

function getOutboundMessageHandles(sendResult: unknown): string[] {
  if (!sendResult || typeof sendResult !== "object" || !("messageIds" in sendResult) || !Array.isArray(sendResult.messageIds)) {
    return [];
  }

  return sendResult.messageIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function createOutboundDeliveryReceipt(input: {
  messageCount: number;
  voiceMessage: boolean;
  sendResult?: unknown;
  fileId?: string;
  replyToMessageHandle?: string;
}) {
  return {
    sent: true,
    deliveredToUser: true,
    userReplyReceived: false,
    receiptType: "outbound_delivery_receipt" as const,
    messageCount: input.messageCount,
    voiceMessage: input.voiceMessage,
    ...(input.fileId ? { fileId: input.fileId } : {}),
    outboundMessageHandles: getOutboundMessageHandles(input.sendResult),
    ...(input.replyToMessageHandle ? { replyToMessageHandle: input.replyToMessageHandle } : {}),
    ...(input.sendResult !== undefined ? { sendResult: input.sendResult } : {}),
    instruction: outboundDeliveryReceiptInstruction,
  };
}

export function createSendMessageTool(deps: SendMessageToolDeps) {
  const canSendVoice = Boolean(deps.voice && getStoredFiles(deps.voice.files));
  const inputSchema = canSendVoice ? voiceSendMessageParameters : baseSendMessageParameters;

  return tool({
    description:
      canSendVoice
        ? "Send one message bubble to the user via iMessage. Set voice_message true only when the user asked for audio or a voice-note reply is clearly the best fit. Voice replies send audio only, with no text bubble."
        : "Send one message bubble to the user via iMessage. Call this multiple times when you want multiple separate messages.",
    inputSchema,
    execute: async (input: SendMessageInput, options) => {
      return withSpan(tracer, "tool.send_message", {}, async () => {
        void options;
        const normalizedText = normalizeOutgoingAssistantText(input.text);

        if ("voice_message" in input && input.voice_message === true) {
          const storedFiles = deps.voice ? getStoredFiles(deps.voice.files) : undefined;
          if (!deps.voice || !storedFiles) {
            throw new Error("Voice replies are not configured.");
          }

          const synthesized = await deps.voice.tts.synthesize(normalizedText);
          const m4aAudio = deps.voice.convertAudioToM4a
            ? await deps.voice.convertAudioToM4a(synthesized)
            : await convertAudioToM4a(synthesized, { tempRoot: deps.voice.tempRoot });
          const duration = deps.voice.probeAudioDuration
            ? await deps.voice.probeAudioDuration(m4aAudio)
            : await probeAudioDuration(m4aAudio, { tempRoot: deps.voice.tempRoot });
          const stored = await storedFiles.store({
            filename: `voice-response-${Date.now()}.m4a`,
            mimeType: "audio/mp4",
            data: m4aAudio,
            origin: "assistant_generated",
          });

          const sendResult = await deps.sender.sendVoiceMessage(stored.id, {
            ...(duration ? { duration } : {}),
            replyToMessageHandle: input.replyToMessageHandle,
          });

          return createOutboundDeliveryReceipt({
            messageCount: 1,
            voiceMessage: true,
            fileId: stored.id,
            replyToMessageHandle: input.replyToMessageHandle,
            sendResult,
          });
        }

        const sendResult = await deps.sender.sendText(normalizedText, {
          replyToMessageHandle: input.replyToMessageHandle,
        });

        return createOutboundDeliveryReceipt({
          messageCount: 1,
          voiceMessage: false,
          replyToMessageHandle: input.replyToMessageHandle,
          sendResult,
        });
      });
    },
  });
}

const sendMediaParameters = z.object({
  fileId: z.string().trim().min(1),
  caption: z.string().optional(),
});

export function createSendMediaTool(sender: MessageSender, files: FilesRuntime) {
  return tool({
    description:
      "Send a stored file to the user by file ID. Use this for images, videos, audio, or documents that already exist in Finn's local file storage.",
    inputSchema: sendMediaParameters,
    execute: async ({ fileId, caption }, options) => {
      return withSpan(tracer, "tool.send_media", { "media.fileId": fileId }, async () => {
        void options;
        const storedFiles = getStoredFiles(files);
        if (!storedFiles) {
          return {
            sent: false,
            fileId,
            error: "Stored file runtime is not available.",
          };
        }
        const file = await storedFiles.getMetadata(fileId);
        if (!file) {
          return {
            sent: false,
            fileId,
            error: `Stored file not found for current user: ${fileId}`,
          };
        }

        await storedFiles.setUserVisible(fileId, true);
        await sender.sendMedia(fileId, caption);

        return {
          sent: true,
          fileId,
        };
      });
    },
  });
}
