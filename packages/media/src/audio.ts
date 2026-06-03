import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AudioConversionOptions {
  tempRoot?: string;
}

async function transcodeAudio(
  input: Buffer,
  outputFilename: string,
  ffmpegArgs: string[],
  formatName: string,
  options: AudioConversionOptions = {},
): Promise<Buffer> {
  const tempRoot = options.tempRoot ?? "/tmp";
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, ".finn-audio-"));
  const inputPath = join(tempDir, "input.audio");
  const outputPath = join(tempDir, outputFilename);

  try {
    await writeFile(inputPath, input);

    const proc = Bun.spawn([
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-vn",
      ...ffmpegArgs,
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

    return Buffer.from(await Bun.file(outputPath).arrayBuffer());
  } catch (error) {
    throw new Error(`Failed to convert audio to ${formatName}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function convertAudioToCaf(input: Buffer, options?: AudioConversionOptions): Promise<Buffer> {
  return transcodeAudio(input, "output.caf", [
    "-acodec",
    "libopus",
    "-b:a",
    "24k",
    "-f",
    "caf",
  ], "CAF", options);
}

export async function convertAudioToWav(input: Buffer, options?: AudioConversionOptions): Promise<Buffer> {
  return transcodeAudio(input, "output.wav", [
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "wav",
  ], "WAV", options);
}
