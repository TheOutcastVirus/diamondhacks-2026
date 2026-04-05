import { AssemblyAI } from "assemblyai";
import type { AppConfig } from "./config";

export interface RealtimeSession {
  sendAudio: (chunk: Buffer) => void;
  finalize: () => Promise<string>;
}

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

  /**
   * Opens an AssemblyAI real-time streaming session.
   * Call `sendAudio` with PCM s16le chunks (16 kHz, mono) as they arrive,
   * then call `finalize` once recording stops to get the full transcript.
   */
  async createRealtimeSession(): Promise<RealtimeSession> {
    // AssemblyAI's realtime WebSocket requires a short-lived token rather than
    // the raw API key on the connection URL.
    const tokenRes = await fetch("https://api.assemblyai.com/v2/realtime/token", {
      method: "POST",
      headers: {
        Authorization: this.config.assemblyAi.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_in: 60 }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Failed to get AssemblyAI realtime token: ${tokenRes.status}`);
    }
    const { token } = (await tokenRes.json()) as { token: string };

    const transcriber = this.client.realtime.transcriber({
      sampleRate: 16000,
      encoding: "pcm_s16le",
      token,
    });

    const finalParts: string[] = [];

    transcriber.on("transcript", (t) => {
      if (t.message_type === "FinalTranscript" && t.text?.trim()) {
        finalParts.push(t.text.trim());
      }
    });

    transcriber.on("error", (err: Error) => {
      console.error("[stt] Realtime error:", err.message);
    });

    await transcriber.connect();

    return {
      sendAudio: (chunk: Buffer) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (transcriber.sendAudio as (data: any) => void)(chunk);
        } catch {
          // ignore sends after the session is already closing
        }
      },
      finalize: async () => {
        await transcriber.close();
        return finalParts.join(" ");
      },
    };
  }
}
