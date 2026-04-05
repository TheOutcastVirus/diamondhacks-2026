import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";

type AudioCommand = {
  cmd: string;
  args: string[];
};

function summarizeFfmpegStderr(chunks: string[]): string {
  const text = chunks.join("").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function unsupportedPlatformError(kind: "recording" | "playback", os: NodeJS.Platform): Error {
  return new Error(`Audio ${kind} is not supported on platform "${os}".`);
}

function openAlRecordingArgs(deviceName: string, outputPath: string): AudioCommand {
  return {
    cmd: "ffmpeg",
    args: [
      "-hide_banner",
      "-f",
      "openal",
      "-channels",
      "1",
      "-sample_size",
      "16",
      "-sample_rate",
      "44100",
      "-i",
      deviceName,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      outputPath,
    ],
  };
}

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

function dshowRecordingArgs(deviceName: string, outputPath: string): AudioCommand {
  return {
    cmd: "ffmpeg",
    args: [
      "-hide_banner",
      "-f",
      "dshow",
      "-audio_buffer_size",
      "50",
      "-i",
      `audio=${deviceName}`,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      outputPath,
    ],
  };
}

export function recordingArgsForPlatform(os: NodeJS.Platform, outputPath: string): AudioCommand {
  switch (os) {
    case "darwin":
      return {
        cmd: "ffmpeg",
        args: ["-hide_banner", "-f", "avfoundation", "-i", ":0", "-ar", "16000", "-ac", "1", "-y", outputPath],
      };
    case "linux":
      // Linux (ALSA); works with PulseAudio/PipeWire via the ALSA plugin on most deployments.
      return {
        cmd: "ffmpeg",
        args: ["-hide_banner", "-f", "alsa", "-i", "default", "-ar", "16000", "-ac", "1", "-y", outputPath],
      };
    case "win32":
      return openAlRecordingArgs("", outputPath);
    default:
      throw unsupportedPlatformError("recording", os);
  }
}

export function playbackArgsForPlatform(os: NodeJS.Platform, audioPath: string): AudioCommand {
  switch (os) {
    case "darwin":
      return { cmd: "afplay", args: [audioPath] };
    case "linux":
    case "win32":
      return {
        cmd: "ffplay",
        args: ["-nodisp", "-autoexit", "-loglevel", "quiet", audioPath],
      };
    default:
      throw unsupportedPlatformError("playback", os);
  }
}

function runCommandCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (error) {
        const code = typeof error.code === "number" ? error.code : undefined;
        const text = combined.trim();
        if (code === 1 || code === 234) {
          resolve(text);
          return;
        }

        reject(new Error(text || error.message));
        return;
      }

      resolve(combined.trim());
    });
  });
}

export function parseOpenAlCaptureDevices(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\[[^\]]+\]\s{2,}(.+?)\s*$/)?.[1] ?? "")
    .filter((line) => line.length > 0);
}

export function parseDshowAudioDevices(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\[[^\]]+\]\s+"(.+)"\s+\(audio\)$/)?.[1] ?? "")
    .filter((line) => line.length > 0);
}

async function probeWindowsRecordingCommand(outputPath: string): Promise<AudioCommand> {
  const openAlOutput = await runCommandCapture("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "openal", "-i", "dummy"]);
  const openAlDevices = parseOpenAlCaptureDevices(openAlOutput);
  if (openAlDevices.length > 0) {
    return openAlRecordingArgs(openAlDevices[0] ?? "", outputPath);
  }

  const dshowOutput = await runCommandCapture("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  const dshowDevices = parseDshowAudioDevices(dshowOutput);
  if (dshowDevices.length > 0) {
    return dshowRecordingArgs(dshowDevices[0] ?? "", outputPath);
  }

  throw new Error("No Windows audio capture device was found via ffmpeg (checked OpenAL and DirectShow).");
}

async function resolveRecordingCommand(outputPath: string): Promise<AudioCommand> {
  const os = platform();
  if (os === "win32") {
    return probeWindowsRecordingCommand(outputPath);
  }

  return recordingArgsForPlatform(os, outputPath);
}

export class AudioService {
  private proc: ReturnType<typeof spawn> | null = null;
  private recordingPath: string | null = null;
  private recordingError: string | null = null;

  async startRecording(): Promise<void> {
    if (this.proc) {
      throw new Error("Already recording.");
    }

    const outPath = join(tmpdir(), `voice-in-${Date.now()}.wav`);
    const { cmd, args } = await resolveRecordingCommand(outPath);
    this.recordingError = null;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
      const stderrChunks: string[] = [];

      let settled = false;
      let started = false;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanupTimers = () => {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      const fail = (message: string) => {
        const stderr = summarizeFfmpegStderr(stderrChunks);
        const error = new Error(stderr ? `${message} ${stderr}` : message);
        this.recordingError = error.message;
        unlink(outPath).catch(() => {});
        return error;
      };

      const done = (err?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanupTimers();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const markStarted = () => {
        if (started || settled) {
          return;
        }

        started = true;
        this.proc = child;
        this.recordingPath = outPath;
        this.recordingError = null;
        child.once("close", (code) => {
          if (this.proc === child) {
            this.proc = null;
            this.recordingPath = null;
            this.recordingError =
              code === null ? "Recording process exited unexpectedly." : `Recording process exited with code ${code}.`;
          }
        });
        done();
      };

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderrChunks.push(text);

        // ffmpeg prints a steady-state line after the input and output open cleanly.
        if (text.includes("Press [q] to stop") || text.includes("size=")) {
          markStarted();
        }
      });

      const pollForOutput = async () => {
        if (settled || started) {
          return;
        }

        try {
          const file = await stat(outPath);
          if (file.isFile()) {
            markStarted();
            return;
          }
        } catch {
          // The file has not been created yet.
        }

        if (child.exitCode !== null) {
          done(fail(`Failed to start recording (exit code ${child.exitCode}).`));
          return;
        }

        pollTimer = setTimeout(() => {
          void pollForOutput();
        }, 100);
      };

      child.once("error", (err) => done(new Error(`Failed to start recording: ${err.message}`)));
      child.once("close", (code) => {
        if (!started) {
          done(fail(`Failed to start recording${code === null ? "." : ` (exit code ${code}).`}`));
        }
      });

      startupTimer = setTimeout(() => {
        if (!started) {
          done(fail("Timed out while waiting for microphone recording to start."));
        }
      }, 3000);

      void pollForOutput();
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

    // Ask ffmpeg to stop gracefully so it flushes the WAV container before exit.
    await new Promise<void>((resolve) => {
      let settled = false;
      let forcedStopTimer: ReturnType<typeof setTimeout> | null = null;
      let safetyTimer: ReturnType<typeof setTimeout> | null = null;

      const done = () => {
        if (settled) {
          return;
        }

        settled = true;
        if (forcedStopTimer) {
          clearTimeout(forcedStopTimer);
        }
        if (safetyTimer) {
          clearTimeout(safetyTimer);
        }
        resolve();
      };

      child.once("close", done);

      try {
        child.stdin?.write("q\n");
        child.stdin?.end();
      } catch {
        // Fall back to terminating the process below.
      }

      forcedStopTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore shutdown errors and let the safety timer resolve.
        }
      }, 1500);

      safetyTimer = setTimeout(done, 5000);
    });

    let buf: Buffer;
    try {
      buf = await readFile(outPath);
    } catch (error) {
      const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        throw new Error(this.recordingError ?? "Recording stopped before any audio was saved.");
      }
      throw error;
    }

    if (buf.length === 0) {
      unlink(outPath).catch(() => {});
      throw new Error("Recording stopped before any audio was saved.");
    }

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
      let hasDetectedSpeech = false;

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

        // silence_end means audio went above the threshold — user has started speaking
        if (stderrTail.includes("silence_end")) {
          hasDetectedSpeech = true;
        }

        // Only stop on silence_start after speech was detected; otherwise the
        // recording would end immediately if the environment starts quiet.
        if (hasDetectedSpeech && stderrTail.includes("silence_start")) {
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

    const { cmd, args } = playbackArgsForPlatform(platform(), audioPath);

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
