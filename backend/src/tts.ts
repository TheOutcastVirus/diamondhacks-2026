import { ElevenLabsClient } from "elevenlabs";
import type { AppConfig } from "./config";

export class TtsService {
  private readonly client: ElevenLabsClient;

  constructor(private readonly config: AppConfig) {
    this.client = new ElevenLabsClient({ apiKey: config.elevenLabs.apiKey });
  }

  async synthesize(text: string): Promise<Buffer> {
    const stream = await this.client.textToSpeech.convert(
      this.config.elevenLabs.voiceId,
      {
        text,
        model_id: "eleven_turbo_v2_5",
        output_format: "mp3_44100_128",
      },
    );

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }
}
