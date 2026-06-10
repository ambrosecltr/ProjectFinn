import { describe, expect, it, mock } from "bun:test";

import { AttachmentProcessor } from "./attachment-processor.js";

const originalFetch = globalThis.fetch;

function createFileStorage() {
  return {
    store: mock(async (input: { filename: string; mimeType: string; data: Buffer }) => ({
      id: "file_test",
      tenantId: "tenant_test",
      userId: "usr_test",
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.data.length,
      storagePath: `/tmp/${input.filename}`,
      createdAt: new Date("2026-04-21T01:02:03.000Z"),
    })),
  };
}

function mockFetchResponse(contentType: string): void {
  globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": contentType },
  })) as unknown as typeof fetch;
}

describe("AttachmentProcessor HEIC detection", () => {
  it("detects HEIC and HEIF attachments by mime type or filename", () => {
    const processor = new AttachmentProcessor({
      fileStorage: {} as never,
      publicUrl: "https://example.com",
      tempRoot: "/tmp/finn-test",
    });

    expect(processor["isHeicLike"]("photo.HEIC", "application/octet-stream")).toBe(true);
    expect(processor["isHeicLike"]("photo.jpg", "image/heic")).toBe(true);
    expect(processor["isHeicLike"]("photo.heif", "image/heif")).toBe(true);
    expect(processor["isHeicLike"]("photo.jpg", "image/jpeg")).toBe(false);
  });
});

describe("AttachmentProcessor image compression", () => {
  it("compresses large image attachments before storage", async () => {
    const original = Buffer.alloc(1_600_000, 1);
    const compressed = Buffer.from("compressed-image");
    const fileStorage = createFileStorage();
    const compressImage = mock(async () => ({
      buffer: compressed,
      mimeType: "image/jpeg",
      filename: "photo.jpg",
    }));

    const processor = new AttachmentProcessor({
      fileStorage: fileStorage as never,
      publicUrl: "https://example.com",
      tempRoot: "/tmp/finn-test",
      compressImage,
    });

    const result = await processor.process({
      id: "att_test",
      url: "spectrum:att_test",
      mimeType: "image/jpeg",
      filename: "photo.jpeg",
      size: original.length,
      data: original,
    });

    expect(compressImage).toHaveBeenCalledWith({ buffer: original, mimeType: "image/jpeg", filename: "photo.jpeg" });
    expect(fileStorage.store).toHaveBeenCalledWith({ filename: "photo.jpg", mimeType: "image/jpeg", data: compressed, userVisible: true, origin: "message_attachment" });
    expect(result.attachment.filename).toBe("photo.jpg");
    expect(result.attachment.size).toBe(compressed.length);
    expect(result.attachment.data).toBeUndefined();
  });

  it("keeps original image when compression does not reduce size", async () => {
    const original = Buffer.alloc(1_600_000, 1);
    const larger = Buffer.alloc(1_700_000, 2);
    const fileStorage = createFileStorage();
    const compressImage = mock(async () => ({
      buffer: larger,
      mimeType: "image/jpeg",
      filename: "photo.jpg",
    }));

    const processor = new AttachmentProcessor({
      fileStorage: fileStorage as never,
      publicUrl: "https://example.com",
      tempRoot: "/tmp/finn-test",
      compressImage,
    });

    const result = await processor.process({
      id: "att_test",
      url: "spectrum:att_test",
      mimeType: "image/jpeg",
      filename: "photo.jpeg",
      size: original.length,
      data: original,
    });

    expect(fileStorage.store).toHaveBeenCalledWith({ filename: "photo.jpeg", mimeType: "image/jpeg", data: original, userVisible: true, origin: "message_attachment" });
    expect(result.attachment.filename).toBe("photo.jpeg");
    expect(result.attachment.size).toBe(original.length);
    expect(result.attachment.data).toBeUndefined();
  });

  it("does not compress small image attachments", async () => {
    const original = Buffer.alloc(32_000, 1);
    const fileStorage = createFileStorage();
    const compressImage = mock(async () => ({
      buffer: Buffer.from("compressed-image"),
      mimeType: "image/jpeg",
      filename: "photo.jpg",
    }));

    const processor = new AttachmentProcessor({
      fileStorage: fileStorage as never,
      publicUrl: "https://example.com",
      tempRoot: "/tmp/finn-test",
      compressImage,
    });

    await processor.process({
      id: "att_test",
      url: "spectrum:att_test",
      mimeType: "image/jpeg",
      filename: "photo.jpeg",
      size: original.length,
      data: original,
    });

    expect(compressImage).not.toHaveBeenCalled();
    expect(fileStorage.store).toHaveBeenCalledWith({ filename: "photo.jpeg", mimeType: "image/jpeg", data: original, userVisible: true, origin: "message_attachment" });
  });
});

describe("AttachmentProcessor voice gating", () => {
  it("does not treat untranscribed audio placeholders as transcribed voice notes", async () => {
    mockFetchResponse("application/octet-stream");

    try {
      const processor = new AttachmentProcessor({
        fileStorage: createFileStorage() as never,
        publicUrl: "https://example.com",
        tempRoot: "/tmp/finn-test",
      });

      const result = await processor.process({
        id: "att_test",
        url: "https://cdn.example.com/voice.caf",
        mimeType: "audio/x-caf",
        filename: "voice.caf",
      });

      expect(result.isVoiceNote).toBe(true);
      expect(result.isTranscribedVoiceNote).toBe(false);
      expect(result.audioKind).toBe("voice_note");
      expect(result.processedContent).toBe("[The user sent a voice message, but speech-to-text is not configured. Finn cannot hear what they said.]");
      expect(result.attachment.audioKind).toBe("voice_note");
      expect(result.attachment.mimeType).toBe("audio/x-caf");
      expect(result.attachment.url).toBe("https://example.com/files/tenant_test/usr_test/file_test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks audio as transcribed only when STT returns transcript text", async () => {
    mockFetchResponse("audio/x-caf");
    const transcribe = mock(async () => "meet me at 5");
    const convertAudioToWav = mock(async () => Buffer.from("wav-audio"));

    try {
      const processor = new AttachmentProcessor({
        fileStorage: createFileStorage() as never,
        publicUrl: "https://example.com",
        tempRoot: "/tmp/finn-test",
        transcribe,
        convertAudioToWav,
      });

      const result = await processor.process({
        id: "att_test",
        url: "https://cdn.example.com/voice.caf",
        mimeType: "audio/x-caf",
        filename: "voice.caf",
      });

      expect(result.isVoiceNote).toBe(true);
      expect(result.isTranscribedVoiceNote).toBe(true);
      expect(result.audioKind).toBe("voice_note");
      expect(result.processedContent).toBe("meet me at 5");
      expect(convertAudioToWav).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
      expect(transcribe).toHaveBeenCalledTimes(1);
      expect(transcribe).toHaveBeenCalledWith(Buffer.from("wav-audio"), {
        contentType: "audio/wav",
        filename: "voice.wav",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes generic Spectrum CAF attachments before audio processing", async () => {
    const cafData = Buffer.concat([Buffer.from("caff", "ascii"), Buffer.alloc(8, 1)]);
    const fileStorage = createFileStorage();
    const transcribe = mock(async () => "voice transcript");
    const convertAudioToWav = mock(async () => Buffer.from("wav-audio"));
    const processor = new AttachmentProcessor({
      fileStorage: fileStorage as never,
      publicUrl: "https://example.com",
      tempRoot: "/tmp/finn-test",
      transcribe,
      convertAudioToWav,
    });

    const result = await processor.process({
      id: "att_test",
      url: "spectrum:att_test",
      mimeType: "application/octet-stream",
      filename: "Audio Message.caf",
      size: cafData.length,
      data: cafData,
    });

    expect(result.isVoiceNote).toBe(true);
    expect(result.isTranscribedVoiceNote).toBe(true);
    expect(result.audioKind).toBe("voice_note");
    expect(result.attachment.mimeType).toBe("audio/x-caf");
    expect(result.attachment.audioKind).toBe("voice_note");
    expect(fileStorage.store).toHaveBeenCalledWith({ filename: "Audio Message.caf", mimeType: "audio/x-caf", data: cafData, userVisible: true, origin: "message_attachment" });
    expect(convertAudioToWav).toHaveBeenCalledWith(cafData);
    expect(transcribe).toHaveBeenCalledWith(Buffer.from("wav-audio"), {
      contentType: "audio/wav",
      filename: "Audio Message.wav",
    });
  });

  it("distinguishes ordinary audio files from iMessage voice notes when STT is absent", async () => {
    mockFetchResponse("audio/mpeg");

    try {
      const processor = new AttachmentProcessor({
        fileStorage: createFileStorage() as never,
        publicUrl: "https://example.com",
        tempRoot: "/tmp/finn-test",
      });

      const result = await processor.process({
        id: "att_test",
        url: "https://cdn.example.com/song.mp3",
        mimeType: "audio/mpeg",
        filename: "song.mp3",
      });

      expect(result.isVoiceNote).toBe(false);
      expect(result.isTranscribedVoiceNote).toBe(false);
      expect(result.audioKind).toBe("audio");
      expect(result.processedContent).toBe("[The user sent an audio file, but speech-to-text is not configured. Finn cannot hear its contents.]");
      expect(result.attachment.audioKind).toBe("audio");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes non-CAF audio through to STT with its detected content type", async () => {
    mockFetchResponse("audio/mpeg");
    const transcribe = mock(async () => "podcast clip");

    try {
      const processor = new AttachmentProcessor({
        fileStorage: createFileStorage() as never,
        publicUrl: "https://example.com",
        tempRoot: "/tmp/finn-test",
        transcribe,
      });

      const result = await processor.process({
        id: "att_test",
        url: "https://cdn.example.com/song.mp3",
        mimeType: "audio/mpeg",
        filename: "song.mp3",
      });

      expect(result.processedContent).toBe("podcast clip");
      expect(transcribe).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), {
        contentType: "audio/mpeg",
        filename: "song.mp3",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
