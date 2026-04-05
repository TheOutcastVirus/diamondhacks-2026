import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
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

async function resolveRecordingCommandWithSilence(
  outputPath: string,
  silenceDb: number,
  silenceDuration: number,
): Promise<{ cmd: string; args: string[] }> {
  // silencedetect logs "silence_start: <t>" to stderr when audio drops below
  // the noise floor for the given duration; we parse that to auto-stop.
  const filter = `silencedetect=noise=${silenceDb}dB:duration=${silenceDuration}`;

  if (platform() === "win32") {
    const base = await probeWindowsRecordingCommand(outputPath);
    // Splice the silence filter before the output path args
    const outputIdx = base.args.indexOf(outputPath);
    const before = base.args.slice(0, outputIdx);
    const after = base.args.slice(outputIdx);
    return { cmd: base.cmd, args: [...before, "-af", filter, ...after] };
  }

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

/**
 * Returns ffmpeg args that stream raw PCM (s16le, 16 kHz, mono) to stdout on
 * every platform — used by the Silero VAD recording path.
 */
async function resolvePcmStreamingArgs(): Promise<AudioCommand> {
  const os = platform();
  const pcmOutputArgs = ["-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"];

  if (os === "darwin") {
    return {
      cmd: "ffmpeg",
      args: ["-hide_banner", "-f", "avfoundation", "-i", ":0", ...pcmOutputArgs],
    };
  }

  if (os === "linux") {
    return {
      cmd: "ffmpeg",
      args: ["-hide_banner", "-f", "alsa", "-i", "default", ...pcmOutputArgs],
    };
  }

  if (os === "win32") {
    const openAlOutput = await runCommandCapture("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "openal", "-i", "dummy"]);
    const openAlDevices = parseOpenAlCaptureDevices(openAlOutput);
    if (openAlDevices.length > 0) {
      return {
        cmd: "ffmpeg",
        args: [
          "-hide_banner",
          "-f", "openal",
          "-channels", "1",
          "-sample_size", "16",
          "-sample_rate", "44100",
          "-i", openAlDevices[0] ?? "",
          ...pcmOutputArgs,
        ],
      };
    }

    const dshowOutput = await runCommandCapture("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
    const dshowDevices = parseDshowAudioDevices(dshowOutput);
    if (dshowDevices.length > 0) {
      return {
        cmd: "ffmpeg",
        args: [
          "-hide_banner",
          "-f", "dshow",
          "-audio_buffer_size", "50",
          "-i", `audio=${dshowDevices[0] ?? ""}`,
          ...pcmOutputArgs,
        ],
      };
    }

    throw new Error("No Windows audio capture device found via ffmpeg (checked OpenAL and DirectShow).");
  }

  throw unsupportedPlatformError("recording", os);
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
    const { cmd, args: baseArgs } = await resolveRecordingCommandWithSilence(outPath, silenceDb, silenceDuration);
    // Append a second output so ffmpeg also streams raw PCM to stdout for dB monitoring.
    const args = [...baseArgs, "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"];

    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      this.proc          = child;
      this.recordingPath = outPath;

      const bytesPer800ms = 25600; // 16 kHz * 1 ch * 2 bytes * 0.8 s
      let pcmTail = Buffer.alloc(0);
      let pcmWindowIndex = 0;

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

        // Ask ffmpeg to stop gracefully by writing 'q' to stdin so it can flush
        // the WAV container before exiting.  On Windows, kill("SIGTERM") is a
        // hard TerminateProcess and skips the flush, producing a corrupt file.
        let forcedKillTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          child.stdin?.write("q\n");
          child.stdin?.end();
          forcedKillTimer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
          }, 2000);
        } catch {
          try { child.kill(); } catch { /* ignore */ }
        }

        let settled = false;
        const afterClose = async () => {
          if (settled) return;
          settled = true;
          if (forcedKillTimer) { clearTimeout(forcedKillTimer); forcedKillTimer = null; }
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

      child.stdout?.on("data", (chunk: Buffer) => {
        pcmTail = Buffer.concat([pcmTail, chunk]);
        while (pcmTail.length >= bytesPer800ms) {
          const frame = pcmTail.subarray(0, bytesPer800ms);
          pcmTail = pcmTail.subarray(bytesPer800ms);
          pcmWindowIndex += 1;

          let sumSquares = 0;
          const sampleCount = frame.length / 2;
          for (let i = 0; i < frame.length; i += 2) {
            const sample = frame.readInt16LE(i) / 32768;
            sumSquares += sample * sample;
          }

          const rms = Math.sqrt(sumSquares / Math.max(sampleCount, 1));
          const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
          const label = Number.isFinite(dbfs) ? dbfs.toFixed(2) : "-inf";
          process.stderr.write(
            `[audio:level:win] ${(pcmWindowIndex * 800).toString().padStart(5, " ")}ms ${label} dBFS\n`,
          );
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail += text;

        if (text.includes("silence_start") || text.includes("silence_end")) {
          process.stderr.write(`[ffmpeg:silence:win] ${text}`);
        }

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

  /**
   * Records from the microphone and streams raw PCM s16le chunks (16 kHz, mono)
   * to `onChunk` in real-time.  Stops automatically once ffmpeg detects
   * `silenceDuration` consecutive seconds below `silenceDb` dB, or after
   * `maxDuration` seconds regardless.
   *
   * Use this with SttService.createRealtimeSession() so transcription runs in
   * parallel with recording — by the time this resolves the transcript is ready.
   */
  async recordPcmUntilSilence(
    onChunk: (pcm: Buffer) => void,
    options?: { silenceDb?: number; silenceDuration?: number; maxDuration?: number },
  ): Promise<void> {
    if (this.proc) {
      throw new Error("Already recording.");
    }

    const silenceDb       = options?.silenceDb       ?? -20;
    const silenceDuration = options?.silenceDuration ?? 2;
    const maxDuration     = options?.maxDuration      ?? 10;

    const os = platform();
    let micArgs: string[];
    if (os === "darwin") {
      micArgs = ["-f", "avfoundation", "-i", ":0"];
    } else if (os === "linux") {
      micArgs = ["-f", "alsa", "-i", "default"];
    } else {
      throw new Error(`Streaming PCM recording is not supported on ${os}.`);
    }

    const filter = `silencedetect=noise=${silenceDb}dB:duration=${silenceDuration}`;
    const args = [
      "-hide_banner",
      ...micArgs,
      "-af", filter,
      "-ar", "16000",
      "-ac", "1",
      "-f", "s16le",  // raw signed-16-bit little-endian PCM
      "pipe:1",       // write to stdout
    ];

    return new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      this.proc          = child;
      this.recordingPath = null;

      const bytesPer800ms = 25600; // 16 kHz * 1 ch * 2 bytes * 0.8 s
      let pcmTail = Buffer.alloc(0);
      let pcmWindowIndex = 0;

      let maxTimer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      let stderrTail = "";
      let hasDetectedSpeech = false;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        this.proc = null;
        child.kill("SIGTERM");
        child.once("close", () => resolve());
        setTimeout(resolve, 4000); // safety: don't block forever
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        onChunk(chunk);

        pcmTail = Buffer.concat([pcmTail, chunk]);
        while (pcmTail.length >= bytesPer800ms) {
          const frame = pcmTail.subarray(0, bytesPer800ms);
          pcmTail = pcmTail.subarray(bytesPer800ms);
          pcmWindowIndex += 1;

          let sumSquares = 0;
          const sampleCount = frame.length / 2;
          for (let i = 0; i < frame.length; i += 2) {
            const sample = frame.readInt16LE(i) / 32768;
            sumSquares += sample * sample;
          }

          const rms = Math.sqrt(sumSquares / Math.max(sampleCount, 1));
          const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
          const label = Number.isFinite(dbfs) ? dbfs.toFixed(2) : "-inf";
          process.stderr.write(
            `[audio:level:mac] ${(pcmWindowIndex * 800).toString().padStart(5, " ")}ms ${label} dBFS\n`,
          );
        }
      });

      child.on("error", (err) => {
        this.proc = null;
        reject(new Error(`Failed to start streaming recording: ${err.message}`));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrTail += text;

        if (text.includes("silence_start") || text.includes("silence_end")) {
          process.stderr.write(`[ffmpeg:silence:mac] ${text}`);
        }

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

        const nl = stderrTail.lastIndexOf("\n");
        if (nl !== -1) stderrTail = stderrTail.slice(nl + 1);
      });

      // Start the max-duration timer even if stderr is slow
      setTimeout(() => {
        if (!maxTimer && !stopped) {
          maxTimer = setTimeout(stop, maxDuration * 1000);
        }
      }, 600);
    });
  }

  /**
   * Records from the microphone on any platform, streams raw PCM s16le chunks
   * (16 kHz, mono) to `onChunk`, and stops automatically when Silero VAD detects
   * `silenceDuration` seconds of silence following a speech onset.
   *
   * A hard `maxDuration` cap prevents runaway recordings.  Falls back to the
   * FFmpeg `silencedetect` filter if the Python/ONNX subprocess fails to start.
   */
  async recordPcmWithSileroVad(
    onChunk: (pcm: Buffer) => void,
    options?: {
      maxDuration?: number;
      silenceDuration?: number;
      speechThreshold?: number;
    },
  ): Promise<void> {
    if (this.proc) {
      throw new Error("Already recording.");
    }

    const maxDuration     = options?.maxDuration     ?? 10;
    const silenceDuration = options?.silenceDuration ?? 1.0;
    const speechThreshold = options?.speechThreshold ?? 0.5;

    const { cmd: ffmpegCmd, args: ffmpegArgs } = await resolvePcmStreamingArgs();

    // Resolve the venv Python and VAD script paths (same convention as wake_word)
    const botDir    = resolvePath(import.meta.dir, "../../bot");
    const vadScript = resolvePath(botDir, "silero_vad.py");
    const venvPython = process.platform === "win32"
      ? resolvePath(botDir, ".venv/Scripts/python.exe")
      : resolvePath(botDir, ".venv/bin/python3");
    const python = (await stat(venvPython).catch(() => null)) ? venvPython : "python3";

    return new Promise<void>((resolve, reject) => {
      // ── Spawn Silero VAD subprocess first ─────────────────────────────────
      // FFmpeg is started only after VAD emits READY so no audio is missed
      // while the ONNX model loads.
      const vadProc = spawn(python, [
        vadScript,
        "--threshold",        String(speechThreshold),
        "--silence-duration", String(silenceDuration),
      ], { stdio: ["pipe", "pipe", "pipe"] });

      let vadStdoutBuf = "";
      let stopped      = false;
      let inSpeech     = false;
      let ffmpeg: ReturnType<typeof spawn> | null = null;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;

      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        this.proc = null;

        try { vadProc.stdin?.end(); } catch { /* ignore */ }
        try { vadProc.kill("SIGTERM"); } catch { /* ignore */ }

        if (ffmpeg) {
          ffmpeg.kill("SIGTERM");
          ffmpeg.once("close", () => resolve());
          setTimeout(resolve, 4000);
        } else {
          resolve();
        }
      };

      vadProc.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[silero-vad] ${chunk.toString()}`);
      });

      vadProc.on("error", (err: Error) => {
        reject(new Error(`Failed to start Silero VAD: ${err.message}`));
      });

      vadProc.stdout?.on("data", (chunk: Buffer) => {
        vadStdoutBuf += chunk.toString();
        const lines = vadStdoutBuf.split("\n");
        vadStdoutBuf = lines[lines.length - 1] ?? "";

        for (const line of lines.slice(0, -1)) {
          const event = line.trim();

          if (event === "READY") {
            console.log("[silero-vad] Model ready — starting microphone capture.");
            startFfmpeg();
          } else if (event === "speech_start") {
            inSpeech = true;
            process.stderr.write("[silero-vad] speech_start\n");
          } else if (event === "speech_end" && inSpeech) {
            process.stderr.write("[silero-vad] speech_end\n");
            stop();
          }
        }
      });

      // ── FFmpeg is started here once VAD is ready ─────────────────────────
      const startFfmpeg = () => {
        if (stopped) return;

        const child = spawn(ffmpegCmd, ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
        ffmpeg = child;
        this.proc = child;

        child.on("error", (err: Error) => {
          this.proc = null;
          reject(new Error(`Failed to start recording: ${err.message}`));
        });

        child.stderr?.on("data", () => {
          // Use first stderr output as the signal that FFmpeg is running
          if (!maxTimer && !stopped) {
            maxTimer = setTimeout(stop, maxDuration * 1000);
          }
        });

        child.stdout?.on("data", (pcm: Buffer) => {
          onChunk(pcm);
          try { vadProc.stdin?.write(pcm); } catch { /* ignore */ }
        });

        // Fallback: start max-duration timer even if FFmpeg stderr is slow
        setTimeout(() => {
          if (!maxTimer && !stopped) {
            maxTimer = setTimeout(stop, maxDuration * 1000);
          }
        }, 600);
      };

      // Safety: if VAD never becomes ready, give up after 30 s (covers first-run download)
      setTimeout(() => {
        if (!ffmpeg && !stopped) {
          reject(new Error("Silero VAD did not become ready in time (model download may have failed)."));
          try { vadProc.kill("SIGTERM"); } catch { /* ignore */ }
        }
      }, 30_000);
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
