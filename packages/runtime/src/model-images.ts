import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const maxModelImageBytes = 384 * 1024;
export const maxViewImageModelBytes = maxModelImageBytes;

export interface ModelImageInput {
  data: Buffer;
  filename: string;
  mimeType: string;
  tempRoot: string;
}

export interface PreparedModelImage {
  data: Buffer;
  mimeType: string;
  resizedForModel: boolean;
}

export function detectImageMimeType(data: Buffer, fallback: string): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  return fallback.startsWith("image/") ? fallback : null;
}

function extensionForImageMimeType(mimeType: string): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

function isExecutableMissingError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EACCES");
}

export async function prepareImageForModelInput(input: ModelImageInput): Promise<PreparedModelImage> {
  if (input.data.length <= maxModelImageBytes) {
    return {
      data: input.data,
      mimeType: input.mimeType,
      resizedForModel: false,
    };
  }

  await mkdir(input.tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(input.tempRoot, "finn-view-image-"));
  const inputExtension = extname(input.filename) || extensionForImageMimeType(input.mimeType);
  const inputPath = join(tempDir, `input${inputExtension}`);

  try {
    await writeFile(inputPath, input.data);

    const attempts = [
      { maxDimension: 1600, quality: 5 },
      { maxDimension: 1280, quality: 6 },
      { maxDimension: 1024, quality: 7 },
      { maxDimension: 768, quality: 8 },
      { maxDimension: 512, quality: 9 },
    ];

    let stderr = "";

    for (const attempt of attempts) {
      const outputPath = join(tempDir, `output-${attempt.maxDimension}.jpg`);
      let stdoutText: string;
      let stderrText: string;
      let exitCode: number;
      try {
        const proc = Bun.spawn([
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-vf",
          `scale='min(${attempt.maxDimension},iw)':'min(${attempt.maxDimension},ih)':force_original_aspect_ratio=decrease`,
          "-frames:v",
          "1",
          "-q:v",
          String(attempt.quality),
          outputPath,
        ], {
          stdout: "pipe",
          stderr: "pipe",
        });

        [stdoutText, stderrText, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isExecutableMissingError(error)) {
          throw new Error(`ffmpeg not found or not executable; please install ffmpeg. ${message}`);
        }
        throw error;
      }
      stderr = stderrText || stdoutText || stderr;
      if (exitCode !== 0) {
        continue;
      }

      const output = Buffer.from(await Bun.file(outputPath).arrayBuffer());
      if (output.length <= maxModelImageBytes) {
        return {
          data: output,
          mimeType: "image/jpeg",
          resizedForModel: true,
        };
      }
    }

    throw new Error(`Unable to prepare image under ${maxModelImageBytes} bytes for model input.${stderr ? ` ffmpeg: ${stderr}` : ""}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
