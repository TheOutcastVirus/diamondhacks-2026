import { AssemblyAI } from "assemblyai";
import type { AppConfig } from "./config";

export class SttService {
  private readonly client: AssemblyAI;

  constructor(private readonly config: AppConfig) {
    this.client = new AssemblyAI({ apiKey: config.assemblyAi.apiKey });
  }

  async transcribe(audio: File | Blob | Buffer): Promise<string> {
    const transcript = await this.client.transcripts.transcribe({
      audio,
      speech_models: ["universal-2"],
    });

    if (transcript.status === "error") {
      // AssemblyAI returns this when the audio contains no speech — treat it
      // the same as an empty transcript rather than a hard failure.
      if (transcript.error?.includes("no spoken audio")) {
        return "";
      }
      throw new Error(transcript.error ?? "AssemblyAI transcription failed");
    }

    return transcript.text ?? "";
  }
}
