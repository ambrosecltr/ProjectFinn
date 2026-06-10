export interface SpeechToTextOptions {
  contentType?: string;
  filename?: string;
}

export interface SpeechToTextClient {
  transcribe(audioBuffer: Buffer, options?: SpeechToTextOptions): Promise<string>;
}

export interface TextToSpeechClient {
  synthesize(text: string): Promise<Buffer>;
}
