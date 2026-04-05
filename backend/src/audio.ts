import { spawn } from "node:child_process";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink, readFile } from "node:fs/promises";

function recordingArgs(outputPath: string): { cmd: string; args: string[] } {
  const os = platform();
  if (os === "darwin") {
    return {
      cmd: "ffmpeg",
      args: ["-f", "avfoundation", "-i", ":0", "-ar", "16000", "-ac", "1", outputPath, "-y"],
    };
  }
  // Linux (ALSA); works with PulseAudio via the ALSA plugin
  return {
    cmd: "ffmpeg",
    args: ["-f", "alsa", "-i", "default", "-ar", "16000", "-ac", "1", outputPath, "-y"],
  };
}

function playbackArgs(audioPath: string): { cmd: string; args: string[] } {
  const os = platform();
  if (os === "darwin") {
    return { cmd: "afplay", args: [audioPath] };
  }
  return {
    cmd: "ffplay",
    args: ["-nodisp", "-autoexit", "-loglevel", "quiet", audioPath],
  };
}

export class AudioService {
  private proc: ReturnType<typeof spawn> | null = null;
  private recordingPath: string | null = null;

  async startRecording(): Promise<void> {
    if (this.proc) {
      throw new Error("Already recording.");
    }

    const outPath = join(tmpdir(), `voice-in-${Date.now()}.wav`);
    const { cmd, args } = recordingArgs(outPath);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

      let resolved = false;
      const done = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        if (err) {
          this.recordingPath = null;
          reject(err);
        } else {
          resolve();
        }
      };

      child.on("error", (err) => done(new Error(`Failed to start recording: ${err.message}`)));

      // ffmpeg writes startup lines to stderr; first output means it's running
      child.stderr?.once("data", () => {
        this.proc = child;
        this.recordingPath = outPath;
        done();
      });

      // Fallback: assume started after 600 ms
      setTimeout(() => {
        if (!this.proc && !resolved) {
          this.proc = child;
          this.recordingPath = outPath;
        }
        done();
      }, 600);
    });
  }

  async stopRecording(): Promise<Buffer> {
    const child = this.proc;
    const outPath = this.recordingPath;

    if (!child || !outPath) {
      throw new Error("Not recording.");
    }

    this.proc = null;
    this.recordingPath = null;

    // SIGTERM causes ffmpeg to flush and close the output file cleanly
    child.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      child.on("close", resolve);
      setTimeout(resolve, 4000); // safety timeout
    });

    const buf = await readFile(outPath);
    unlink(outPath).catch(() => {});
    return buf;
  }

  async playAudio(audioBuffer: Buffer): Promise<void> {
    const audioPath = join(tmpdir(), `voice-out-${Date.now()}.mp3`);
    await writeFile(audioPath, audioBuffer);

    const { cmd, args } = playbackArgs(audioPath);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("error", (err) => {
        unlink(audioPath).catch(() => {});
        reject(new Error(`Playback failed: ${err.message}`));
      });
      child.on("close", () => {
        unlink(audioPath).catch(() => {});
        resolve();
      });
    });
  }

  get isRecording(): boolean {
    return this.proc !== null;
  }
}
