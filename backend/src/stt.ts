import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig } from "./config";

export interface RealtimeSession {
  sendAudio: (chunk: Buffer) => void;
  finalize: () => Promise<string>;
}

function buildWavHeader(pcmByteLength: number): Buffer {
  const header = Buffer.allocUnsafe(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmByteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);    // PCM
  header.writeUInt16LE(1, 22);    // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); // byteRate = 16000 * 1 * 2
  header.writeUInt16LE(2, 32);    // blockAlign = 1 * 2
  header.writeUInt16LE(16, 34);   // bitsPerSample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmByteLength, 40);
  return header;
}

export class SttService {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private ready = false;
  private closed = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readonly pending: Array<{
    resolve: (t: string) => void;
    reject: (e: Error) => void;
  }> = [];

  // config is kept for interface compatibility but no API key is needed
  constructor(_config: AppConfig) {
    this.readyPromise = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this._startSubprocess();
  }

  private _startSubprocess(): void {
    if (this.closed) {
      return;
    }
    const botDir = pathResolve(import.meta.dir, "../../bot");
    const script = pathResolve(botDir, "whisper_stt.py");
    const venvPython =
      process.platform === "win32"
        ? pathResolve(botDir, ".venv/Scripts/python.exe")
        : pathResolve(botDir, ".venv/bin/python3");
    const python = Bun.file(venvPython).size > 0 ? venvPython : "python3";

    const child = spawn(python, ["-u", script], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc = child;

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[whisper-stt] ${chunk.toString()}`);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      const lines = this.stdoutBuf.split("\n");
      this.stdoutBuf = lines[lines.length - 1] ?? "";
      for (const line of lines.slice(0, -1)) {
        this._handleLine(line.trim());
      }
    });

    child.on("error", (err) => {
      console.error("[whisper-stt] Process error:", err.message);
      if (!this.ready) this.readyReject(err);
      this._drainPendingWithError(err);
    });

    child.on("close", (code) => {
      if (this.closed) {
        this.proc = null;
        this.ready = false;
        return;
      }
      console.warn(`[whisper-stt] Process exited (code=${code}). Restarting in 3 s…`);
      this.proc = null;
      this.ready = false;
      this.readyPromise = new Promise<void>((res, rej) => {
        this.readyResolve = res;
        this.readyReject = rej;
      });
      this._drainPendingWithError(new Error(`whisper_stt.py exited (code=${code})`));
      setTimeout(() => this._startSubprocess(), 3000);
    });
  }

  close(): void {
    this.closed = true;
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    if (child) {
      try {
        child.kill();
      } catch {
        // Ignore shutdown races if the process already exited.
      }
    }
  }

  private _handleLine(line: string): void {
    if (!line) return;

    if (!this.ready) {
      if (line === "READY") {
        this.ready = true;
        this.readyResolve();
      }
      return;
    }

    const entry = this.pending.shift();
    if (!entry) {
      console.warn("[whisper-stt] Unexpected line from subprocess:", line);
      return;
    }

    try {
      const parsed = JSON.parse(line) as { transcript?: string; error?: string };
      if (parsed.error) {
        entry.reject(new Error(parsed.error));
      } else {
        entry.resolve(parsed.transcript ?? "");
      }
    } catch {
      entry.reject(new Error(`Malformed response from whisper_stt.py: ${line}`));
    }
  }

  private _drainPendingWithError(err: Error): void {
    let entry: (typeof this.pending)[number] | undefined;
    while ((entry = this.pending.shift())) {
      entry.reject(err);
    }
  }

  private _sendToSubprocess(wavPath: string): Promise<string> {
    if (!this.proc) {
      return Promise.reject(new Error("whisper_stt.py subprocess is not running"));
    }
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.proc!.stdin.write(JSON.stringify({ path: wavPath }) + "\n");
    });
  }

  async transcribe(audio: File | Blob | Buffer): Promise<string> {
    await this.readyPromise;

    const bytes: Buffer = Buffer.isBuffer(audio)
      ? audio
      : Buffer.from(await audio.arrayBuffer());

    const isWav =
      bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "RIFF";

    const wavBytes = isWav
      ? bytes
      : Buffer.concat([buildWavHeader(bytes.length), bytes]);

    const tmpPath = join(
      tmpdir(),
      `stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
    );

    try {
      await writeFile(tmpPath, wavBytes);
      return await this._sendToSubprocess(tmpPath);
    } finally {
      unlink(tmpPath).catch(() => {});
    }
  }

  async createRealtimeSession(): Promise<RealtimeSession> {
    const chunks: Buffer[] = [];

    return {
      sendAudio: (chunk: Buffer) => {
        chunks.push(chunk);
      },
      finalize: async (): Promise<string> => {
        if (chunks.length === 0) return "";
        const pcm = Buffer.concat(chunks);
        return this.transcribe(pcm);
      },
    };
  }
}
