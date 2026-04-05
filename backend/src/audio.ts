import { spawn } from "node:child_process";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink, readFile } from "node:fs/promises";

function inputArgs(): string[] {
  return platform() === "darwin"
    ? ["-f", "avfoundation", "-i", ":0"]
    : ["-f", "alsa", "-i", "default"];
}

function recordingArgs(outputPath: string): { cmd: string; args: string[] } {
  return {
    cmd: "ffmpeg",
    args: [...inputArgs(), "-ar", "16000", "-ac", "1", outputPath, "-y"],
  };
}

function recordingArgsWithSilence(
  outputPath: string,
  silenceDb: number,
  silenceDuration: number,
): { cmd: string; args: string[] } {
  // silencedetect logs "silence_start: <t>" to stderr when audio drops below
  // the noise floor for the given duration; we parse that to auto-stop.
  const filter = `silencedetect=noise=${silenceDb}dB:duration=${silenceDuration}`;
  return {
    cmd: "ffmpeg",
    args: [...inputArgs(), "-af", filter, "-ar", "16000", "-ac", "1", outputPath, "-y"],
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

  /**
   * Start recording and automatically stop once ffmpeg detects `silenceDuration`
   * consecutive seconds of audio below `silenceDb` dB.  A hard `maxDuration`
   * cap prevents runaway recordings if silence is never reached.
   */
  async recordUntilSilence(options?: {
    silenceDb?: number;
    silenceDuration?: number;
    maxDuration?: number;
  }): Promise<Buffer> {
    if (this.proc) {
      throw new Error("Already recording.");
    }

    const silenceDb       = options?.silenceDb       ?? -30;
    const silenceDuration = options?.silenceDuration ?? 4;
    const maxDuration     = options?.maxDuration      ?? 30;

    const outPath = join(tmpdir(), `voice-in-${Date.now()}.wav`);
    const { cmd, args } = recordingArgsWithSilence(outPath, silenceDb, silenceDuration);

    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      this.proc          = child;
      this.recordingPath = outPath;

      let maxTimer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      let stderrTail = "";

      const stop = () => {
        if (stopped) return;
        stopped = true;

        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        this.proc          = null;
        this.recordingPath = null;

        child.kill("SIGTERM");

        const afterClose = async () => {
          try {
            const buf = await readFile(outPath);
            unlink(outPath).catch(() => {});
            resolve(buf);
          } catch (e) {
            unlink(outPath).catch(() => {});
            reject(e);
          }
        };

        child.once("close", afterClose);
        setTimeout(afterClose, 4000); // safety: don't wait forever
      };

      child.on("error", (err) => {
        this.proc          = null;
        this.recordingPath = null;
        reject(new Error(`Failed to start recording: ${err.message}`));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail += chunk.toString();

        // Set the max-duration timer on first stderr output (ffmpeg is running)
        if (!maxTimer && !stopped) {
          maxTimer = setTimeout(stop, maxDuration * 1000);
        }

        // ffmpeg silencedetect emits "silence_start: <timestamp>" when the
        // configured silence duration has elapsed.  Stop as soon as we see it.
        if (stderrTail.includes("silence_start")) {
          stop();
        }

        // Trim the buffer so it doesn't grow indefinitely
        const nl = stderrTail.lastIndexOf("\n");
        if (nl !== -1) stderrTail = stderrTail.slice(nl + 1);
      });

      // Fallback: treat ffmpeg as started after 600 ms even with no stderr
      setTimeout(() => {
        if (!maxTimer && !stopped) {
          maxTimer = setTimeout(stop, maxDuration * 1000);
        }
      }, 600);
    });
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
