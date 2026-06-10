import { createLogger, type Attachment } from "@finn/core";
import { convertAudioToWav } from "./audio.js";
import { buildStoredFileUrl } from "./file-url.js";
import { extractDocument } from "./document-extractor.js";
import type { FileStorage } from "./file-storage.js";
import type { SpeechToTextOptions } from "./speech.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";

const logger = createLogger("attachment-processor");
const IMAGE_COMPRESSION_THRESHOLD_BYTES = 1_500_000;

export interface ProcessedAttachment {
  attachment: Attachment;
  processedContent: string;
  isVoiceNote: boolean;
  isTranscribedVoiceNote: boolean;
  audioKind: "voice_note" | "audio" | null;
}

export interface AttachmentProcessorDeps {
  fileStorage: FileStorage;
  publicUrl: string;
  tempRoot: string;
  transcribe?: (audioBuffer: Buffer, options?: SpeechToTextOptions) => Promise<string>;
  shouldConvertAudioToWav?: (input: { mimeType: string; filename: string }) => boolean;
  convertAudioToWav?: (audioBuffer: Buffer) => Promise<Buffer>;
  compressImage?: (input: { buffer: Buffer; mimeType: string; filename: string }) => Promise<{ buffer: Buffer; mimeType: string; filename: string }>;
}

export class AttachmentProcessor {
  private readonly deps: AttachmentProcessorDeps;

  constructor(deps: AttachmentProcessorDeps) {
    this.deps = deps;
    logger.info("AttachmentProcessor initialized");
  }

  async process(attachment: Attachment): Promise<ProcessedAttachment> {
    logger.debug({ url: attachment.url, mimeType: attachment.mimeType }, "Loading attachment");

    const loaded = await this.loadAttachment(attachment);
    const downloadedBuffer = loaded.buffer;
    const downloadedMimeType = loaded.mimeType;
    const normalized = await this.normalizeAttachment({
      attachment,
      buffer: downloadedBuffer,
      mimeType: downloadedMimeType,
    });

    const stored = await this.deps.fileStorage.store({
      filename: normalized.filename,
      mimeType: normalized.mimeType,
      data: normalized.buffer,
      userVisible: true,
      origin: "message_attachment",
    });

    let processedContent: string;
    let isTranscribedVoiceNote = false;
    const audioKind = normalized.mimeType.startsWith("audio/")
      ? this.resolveAudioKind(normalized.filename, normalized.mimeType)
      : null;
    const isVoiceNote = audioKind === "voice_note";

    try {
      if (normalized.mimeType.startsWith("image/")) {
        processedContent = await this.processImage(normalized.buffer, normalized.mimeType, normalized.filename);
      } else if (this.isExtractableDocument(normalized.filename, normalized.mimeType)) {
        processedContent = await this.processDocument(normalized.buffer, normalized.mimeType, normalized.filename);
      } else if (normalized.mimeType.startsWith("audio/")) {
        processedContent = await this.processAudio(normalized.buffer, audioKind ?? "audio", normalized.mimeType, normalized.filename);
        isTranscribedVoiceNote = this.isSpeechTranscript(processedContent);
      } else if (normalized.mimeType.startsWith("video/")) {
        processedContent = await this.processVideo(normalized.buffer);
      } else {
        processedContent = `[File: ${normalized.filename}, ${normalized.mimeType}, ${normalized.buffer.length} bytes]`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error: message, mimeType: normalized.mimeType }, "Attachment processing failed");
      processedContent = `[Processing failed for ${normalized.filename}: ${message}]`;
    }

    logger.info({ fileId: stored.id, mimeType: normalized.mimeType, isVoiceNote }, "Attachment processed");
    const { data: _inlineData, ...attachmentMetadata } = attachment;

    return {
      attachment: {
        ...attachmentMetadata,
        url: buildStoredFileUrl(this.deps.publicUrl, stored),
        mimeType: normalized.mimeType,
        filename: normalized.filename,
        size: normalized.buffer.length,
        fileId: stored.id,
        storagePath: stored.storagePath,
        originalUrl: attachment.originalUrl ?? attachment.url,
        contextText: processedContent,
        ...(audioKind ? { audioKind } : {}),
      },
      processedContent,
      isVoiceNote,
      isTranscribedVoiceNote,
      audioKind,
    };
  }

  private resolveAudioKind(filename: string, mimeType: string): "voice_note" | "audio" {
    const lowerFilename = filename.toLowerCase();
    const lowerMimeType = mimeType.toLowerCase();
    if (lowerMimeType === "audio/x-caf" || lowerFilename.endsWith(".caf")) {
      return "voice_note";
    }

    return lowerMimeType.startsWith("audio/") && lowerFilename.includes("voice") ? "voice_note" : "audio";
  }

  private async loadAttachment(attachment: Attachment): Promise<{ buffer: Buffer; mimeType: string }> {
    if (attachment.data) {
      return {
        buffer: attachment.data,
        mimeType: attachment.mimeType,
      };
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: this.resolveMimeType(attachment.mimeType, response.headers.get("content-type")),
    };
  }

  private resolveMimeType(inferredMimeType: string, headerValue: string | null): string {
    const headerMimeType = headerValue?.split(";")[0]?.trim();

    if (headerMimeType === "application/octet-stream" && inferredMimeType !== "application/octet-stream") {
      return inferredMimeType;
    }

    if (headerMimeType && headerMimeType.length > 0) {
      return headerMimeType;
    }

    return inferredMimeType;
  }

  private isSpeechTranscript(content: string): boolean {
    return content.trim().length > 0 && !content.trim().startsWith("[");
  }

  private async prepareAudioForTranscription(buffer: Buffer, mimeType: string, filename: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const shouldConvert = this.deps.shouldConvertAudioToWav
      ? this.deps.shouldConvertAudioToWav({ mimeType, filename })
      : mimeType === "audio/x-caf";

    if (shouldConvert) {
      const wavBuffer = this.deps.convertAudioToWav
        ? await this.deps.convertAudioToWav(buffer)
        : await convertAudioToWav(buffer, { tempRoot: this.deps.tempRoot });
      return {
        buffer: wavBuffer,
        contentType: "audio/wav",
        filename: `${parse(filename).name || "audio"}.wav`,
      };
    }

    return {
      buffer,
      contentType: mimeType,
      filename,
    };
  }

  private async normalizeAttachment(input: {
    attachment: Attachment;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const resolvedMimeType = this.resolveAttachmentMimeType(input.attachment.filename, input.mimeType, input.buffer);
    const resolvedInput = {
      ...input,
      mimeType: resolvedMimeType,
    };

    if (!resolvedMimeType.startsWith("image/") && !this.isHeicLike(input.attachment.filename, resolvedMimeType)) {
      return this.toNormalizedAttachment(resolvedInput);
    }

    const normalized = this.isHeicLike(input.attachment.filename, resolvedMimeType)
      ? await this.normalizeHeicAttachment(resolvedInput)
      : this.toNormalizedAttachment(resolvedInput);

    return this.compressImageAttachment(normalized);
  }

  private resolveAttachmentMimeType(filename: string, mimeType: string, buffer: Buffer): string {
    const normalizedMimeType = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalizedMimeType && normalizedMimeType !== "application/octet-stream") {
      return normalizedMimeType;
    }

    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.endsWith(".caf") || this.hasMagic(buffer, "caff")) {
      return "audio/x-caf";
    }

    if (lowerFilename.endsWith(".m4a")) {
      return "audio/mp4";
    }

    if (lowerFilename.endsWith(".mp3")) {
      return "audio/mpeg";
    }

    if (lowerFilename.endsWith(".wav") || this.isRiffWave(buffer)) {
      return "audio/wav";
    }

    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return "image/png";
    }

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }

    return normalizedMimeType || "application/octet-stream";
  }

  private hasMagic(buffer: Buffer, magic: string): boolean {
    return buffer.subarray(0, magic.length).equals(Buffer.from(magic, "ascii"));
  }

  private isRiffWave(buffer: Buffer): boolean {
    return this.hasMagic(buffer, "RIFF") && buffer.subarray(8, 12).equals(Buffer.from("WAVE", "ascii"));
  }

  private toNormalizedAttachment(input: {
    attachment: Attachment;
    buffer: Buffer;
    mimeType: string;
  }): { buffer: Buffer; mimeType: string; filename: string } {
    return {
      buffer: input.buffer,
      mimeType: input.mimeType,
      filename: input.attachment.filename,
    };
  }

  private async normalizeHeicAttachment(input: {
    attachment: Attachment;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    logger.info({ filename: input.attachment.filename, mimeType: input.mimeType }, "Normalizing HEIC attachment to JPEG");
    const jpegBuffer = await this.convertHeicToJpeg(input.buffer);
    const baseName = parse(input.attachment.filename).name || "image";

    return {
      buffer: jpegBuffer,
      mimeType: "image/jpeg",
      filename: `${baseName}.jpg`,
    };
  }

  private async compressImageAttachment(input: { buffer: Buffer; mimeType: string; filename: string }): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    if (!this.canCompressImage(input) || input.buffer.length < IMAGE_COMPRESSION_THRESHOLD_BYTES) {
      return input;
    }

    try {
      const compressed = this.deps.compressImage
        ? await this.deps.compressImage(input)
        : await this.compressImageWithFfmpeg(input);
      if (compressed.buffer.length >= input.buffer.length) {
        return input;
      }

      logger.info({ filename: input.filename, originalSize: input.buffer.length, compressedSize: compressed.buffer.length }, "Compressed image attachment");
      return compressed;
    } catch (error) {
      logger.warn({ error, filename: input.filename, mimeType: input.mimeType }, "Image compression failed; storing original image");
      return input;
    }
  }

  private canCompressImage(input: { mimeType: string; filename: string }): boolean {
    const lowerFilename = input.filename.toLowerCase();
    const lowerMimeType = input.mimeType.toLowerCase();
    return lowerMimeType === "image/jpeg"
      || lowerMimeType === "image/png"
      || lowerFilename.endsWith(".jpg")
      || lowerFilename.endsWith(".jpeg")
      || lowerFilename.endsWith(".png");
  }

  private async compressImageWithFfmpeg(input: { buffer: Buffer; mimeType: string; filename: string }): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    await mkdir(this.deps.tempRoot, { recursive: true });
    const tempDir = await mkdtemp(join(this.deps.tempRoot, ".finn-image-"));
    const inputPath = join(tempDir, input.filename || "input.image");
    const outputPath = join(tempDir, "output.jpg");

    try {
      await writeFile(inputPath, input.buffer);

      const proc = Bun.spawn([
        "ffmpeg",
        "-y",
        "-i",
        inputPath,
        "-vf",
        "scale='min(1600,iw)':-2",
        "-frames:v",
        "1",
        "-q:v",
        "5",
        outputPath,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdoutText, stderrText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`ffmpeg exited with code ${exitCode}: ${stderrText || stdoutText}`.trim());
      }

      const baseName = parse(input.filename).name || "image";
      return {
        buffer: Buffer.from(await Bun.file(outputPath).arrayBuffer()),
        mimeType: "image/jpeg",
        filename: `${baseName}.jpg`,
      };
    } catch (error) {
      throw new Error(`Failed to compress image: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private isHeicLike(filename: string, mimeType: string): boolean {
    const lowerFilename = filename.toLowerCase();
    const lowerMimeType = mimeType.toLowerCase();

    return lowerMimeType === "image/heic"
      || lowerMimeType === "image/heif"
      || lowerFilename.endsWith(".heic")
      || lowerFilename.endsWith(".heif");
  }

  private async convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
    await mkdir(this.deps.tempRoot, { recursive: true });
    const tempDir = await mkdtemp(join(this.deps.tempRoot, ".finn-heic-"));
    const inputPath = join(tempDir, "input.heic");
    const outputPath = join(tempDir, "output.jpg");

    try {
      await writeFile(inputPath, buffer);

      const proc = Bun.spawn([
        "heif-convert",
        inputPath,
        outputPath,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdoutText, stderrText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`heif-convert exited with code ${exitCode}: ${stderrText || stdoutText}`.trim());
      }

      const converted = await Bun.file(outputPath).arrayBuffer();
      return Buffer.from(converted);
    } catch (error) {
      throw new Error(
        `Failed to convert HEIC image to JPEG: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async processImage(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    logger.debug("Preparing image attachment for multimodal input");
    void buffer;
    void mimeType;
    void filename;
    return "";
  }

  private isExtractableDocument(filename: string, mimeType: string): boolean {
    const lowerFilename = filename.toLowerCase();
    const lowerMimeType = mimeType.toLowerCase().split(";")[0] ?? "";
    return lowerMimeType === "application/pdf"
      || lowerMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || lowerMimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || lowerMimeType === "text/csv"
      || lowerMimeType === "text/html"
      || lowerFilename.endsWith(".pdf")
      || lowerFilename.endsWith(".docx")
      || lowerFilename.endsWith(".xlsx")
      || lowerFilename.endsWith(".csv")
      || lowerFilename.endsWith(".html")
      || lowerFilename.endsWith(".htm");
  }

  private async processDocument(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    logger.debug({ filename, mimeType }, "Processing document attachment for text extraction");
    const result = await extractDocument({
      filename,
      mimeType,
      data: buffer,
      maxCharacters: 10_000,
      ocrMode: "never",
      tempRoot: this.deps.tempRoot,
    });

    if (result.content.trim().length === 0) {
      return `[${result.kind.toUpperCase()} with no extractable text content${result.kind === "pdf" ? " — may need OCR" : ""}]`;
    }

    const warningText = result.extraction.warnings.length > 0
      ? `\n[Extraction notes: ${result.extraction.warnings.join("; ")}]`
      : "";
    return `[${result.kind.toUpperCase()} Content]\n${result.content}${warningText}`;
  }

  private async processAudio(buffer: Buffer, audioKind: "voice_note" | "audio", mimeType: string, filename: string): Promise<string> {
    if (!this.deps.transcribe) {
      return audioKind === "voice_note"
        ? "[The user sent a voice message, but speech-to-text is not configured. Finn cannot hear what they said.]"
        : "[The user sent an audio file, but speech-to-text is not configured. Finn cannot hear its contents.]";
    }

    logger.debug("Transcribing audio attachment");
    const transcriptionInput = await this.prepareAudioForTranscription(buffer, mimeType, filename);
    const transcript = await this.deps.transcribe(transcriptionInput.buffer, {
      contentType: transcriptionInput.contentType,
      filename: transcriptionInput.filename,
    });
    if (!transcript) {
      return "[Voice note with no recognizable speech]";
    }

    return transcript;
  }

  private async processVideo(buffer: Buffer): Promise<string> {
    logger.debug("Processing video — extracting audio for transcription");

    if (!this.deps.transcribe) {
      return "[Video received, but audio transcription is not configured]";
    }

    try {
      const transcript = await this.deps.transcribe(buffer, { contentType: "video/*" });
      if (!transcript) {
        return "[Video with no recognizable speech in audio track]";
      }

      return `[Video Transcript]\n${transcript}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn({ error: message }, "Video audio transcription failed");
      return "[Video — audio transcription not available]";
    }
  }
}
