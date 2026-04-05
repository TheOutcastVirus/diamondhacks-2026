import type { AppConfig } from "./config";
import type {
  AgentTurnRequest,
  AgentTurnResponse,
  ApiErrorPayload,
  BrowserContext,
  PromptField,
  PromptFieldOption,
  ReminderCreateInput,
  ReminderUpdateInput,
  TranscriptRole,
  UploadedFile,
  UploadedFileReference,
} from "./contracts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AgentHarness, type AgentTurnResult } from "./agent";
import { AudioService } from "./audio";
import { BrowserUseService } from "./browser-use";
import { GazabotDatabase } from "./db";
import { UploadedFileService } from "./files";
import { parseMultipartUpload } from "./multipart";
import { ReminderScheduler } from "./reminder-scheduler";
import { resolveReminderTimezone } from "./reminders";
import { SttService } from "./stt";
import { TtsService } from "./tts";
import { TranscriptEventBus } from "./transcript-bus";


function corsHeaders(request: Request, config: AppConfig): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
  };
}

function jsonResponse(
  request: Request,
  config: AppConfig,
  payload: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, config),
      ...init.headers,
    },
  });
}

function eventStreamResponse(request: Request, config: AppConfig, stream: ReadableStream<string>): Response {
  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(request, config),
    },
  });
}

function errorResponse(
  request: Request,
  config: AppConfig,
  status: number,
  message: string,
  details?: unknown,
): Response {
  const payload: ApiErrorPayload = details === undefined ? { message } : { message, details };
  return jsonResponse(request, config, payload, { status });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid request.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid request.");
  }

  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid field: ${key}`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid field: ${key}`);
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Invalid field: ${key}`);
  }
  return value;
}

function optionalRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid field: ${key}`);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Invalid field: ${key}`);
  }
  return value.map((item) => item.trim());
}

function normalizePromptFieldOption(value: unknown, index: number): PromptFieldOption {
  const record = asRecord(value);
  return {
    label: requireString(record, "label"),
    value: String(record.value ?? record.label ?? `option_${index + 1}`),
  };
}

function normalizePromptField(value: unknown): PromptField {
  const record = asRecord(value);
  const type = requireString(record, "type");
  if (
    type !== "string" &&
    type !== "text" &&
    type !== "int" &&
    type !== "float" &&
    type !== "boolean" &&
    type !== "password" &&
    type !== "date" &&
    type !== "select" &&
    type !== "file"
  ) {
    throw new Error("Invalid field: type");
  }

  const field: PromptField = {
    name: requireString(record, "name"),
    label: requireString(record, "label"),
    type,
    required: Boolean(record.required),
  };

  const placeholder = optionalString(record, "placeholder");
  if (placeholder) {
    field.placeholder = placeholder;
  }

  const description = optionalString(record, "description");
  if (description) {
    field.description = description;
  }

  if (Array.isArray(record.options)) {
    field.options = record.options.map((option, index) => normalizePromptFieldOption(option, index));
  }

  const accept = optionalString(record, "accept");
  if (accept) {
    field.accept = accept;
  }

  if ("multiple" in record) {
    if (typeof record.multiple !== "boolean") {
      throw new Error("Invalid field: multiple");
    }
    field.multiple = record.multiple;
  }

  const defaultValue = record.defaultValue;
  if (
    defaultValue === null ||
    typeof defaultValue === "string" ||
    typeof defaultValue === "number" ||
    typeof defaultValue === "boolean"
  ) {
    field.defaultValue = defaultValue;
  }

  return field;
}

function parsePromptStatus(value: string | null): "pending" | "completed" | "cancelled" | "all" {
  if (value === "pending" || value === "completed" || value === "cancelled" || value === "all") {
    return value;
  }
  return "pending";
}

function normalizePromptResponseValue(field: PromptField, value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    if (field.required) {
      throw new Error(`Invalid field: response.${field.name}`);
    }
    if (field.type === "boolean") return false;
    if (field.type === "file") return [];
    return null;
  }

  switch (field.type) {
    case "file": {
      const values = Array.isArray(value) ? value : [value];
      const normalized = values.map((entry) => normalizeUploadedFileReference(entry, field.name));
      if (field.required && normalized.length === 0) {
        throw new Error(`Invalid field: response.${field.name}`);
      }
      if (!field.multiple && normalized.length > 1) {
        throw new Error(`Invalid field: response.${field.name}`);
      }
      return normalized;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      break;
    case "int": {
      const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
      if (Number.isInteger(parsed)) return parsed;
      break;
    }
    case "float": {
      const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
      if (!Number.isNaN(parsed)) return parsed;
      break;
    }
    case "select": {
      const normalized = String(value);
      if (!field.options?.some((option) => option.value === normalized)) {
        throw new Error(`Invalid field: response.${field.name}`);
      }
      return normalized;
    }
    default:
      return String(value);
  }

  throw new Error(`Invalid field: response.${field.name}`);
}

function normalizeUploadedFileReference(value: unknown, fieldName: string): UploadedFileReference {
  const record = asRecord(value);
  const sizeValue = record.sizeBytes;
  const sizeBytes =
    typeof sizeValue === "number" && Number.isFinite(sizeValue)
      ? sizeValue
      : typeof sizeValue === "string"
        ? Number.parseInt(sizeValue, 10)
        : NaN;
  const textStatus =
    record.textStatus === "ready" || record.textStatus === "failed" ? record.textStatus : "none";

  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    !Number.isFinite(sizeBytes)
  ) {
    throw new Error(`Invalid field: response.${fieldName}`);
  }

  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes,
    textStatus,
  };
}

function normalizePromptResponse(
  prompt: { fields: PromptField[] },
  rawResponse: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const field of prompt.fields) {
    normalized[field.name] = normalizePromptResponseValue(field, rawResponse[field.name]);
  }
  return normalized;
}

function parseMemoryWrite(payload: unknown): {
  content?: string;
  schema?: PromptField[];
  data?: Record<string, unknown>;
} {
  const record = asRecord(payload);
  const data = optionalRecord(record, "data");
  const parsed: { content?: string; schema?: PromptField[]; data?: Record<string, unknown> } = {};
  const content = optionalString(record, "content");
  if (content) {
    parsed.content = content;
  }
  if (data) {
    parsed.data = data;
  }
  if (Array.isArray(record.schema)) {
    parsed.schema = record.schema.map((field) => normalizePromptField(field));
  }
  if (!parsed.content && !parsed.data) {
    throw new Error("Invalid request.");
  }
  return parsed;
}

function parseReminderCreateInput(payload: unknown): ReminderCreateInput {
  const record = asRecord(payload);
  const cadence = requireString(record, "cadence");
  const attachmentFileIds = optionalStringArray(record, "attachmentFileIds");
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "custom") {
    throw new Error("Invalid field: cadence");
  }

  return {
    title: requireString(record, "title"),
    instructions: requireString(record, "instructions"),
    cadence,
    cron: requireString(record, "cron"),
    scheduleLabel: requireString(record, "scheduleLabel"),
    timezone: resolveReminderTimezone(record.timezone),
    ...(attachmentFileIds !== undefined && { attachmentFileIds }),
  };
}

function parseReminderUpdateInput(payload: unknown): ReminderUpdateInput {
  const record = asRecord(payload);
  const update: ReminderUpdateInput = {};

  if ("title" in record) {
    update.title = requireString(record, "title");
  }
  if ("instructions" in record) {
    update.instructions = requireString(record, "instructions");
  }
  if ("cadence" in record) {
    const cadence = requireString(record, "cadence");
    if (cadence !== "daily" && cadence !== "weekly" && cadence !== "custom") {
      throw new Error("Invalid field: cadence");
    }
    update.cadence = cadence;
  }
  if ("cron" in record) {
    update.cron = requireString(record, "cron");
  }
  if ("scheduleLabel" in record) {
    update.scheduleLabel = requireString(record, "scheduleLabel");
  }
  if ("timezone" in record) {
    update.timezone = requireString(record, "timezone");
  }
  if ("status" in record) {
    const status = requireString(record, "status");
    if (status !== "active" && status !== "paused" && status !== "draft") {
      throw new Error("Invalid field: status");
    }
    update.status = status;
  }
  if ("attachmentFileIds" in record) {
    update.attachmentFileIds = optionalStringArray(record, "attachmentFileIds") ?? [];
  }

  if (Object.keys(update).length === 0) {
    throw new Error("Invalid request.");
  }

  return update;
}

function parseAgentTurnRequest(payload: unknown): AgentTurnRequest {
  const record = asRecord(payload);
  const source = optionalString(record, "source") ?? "dashboard";
  if (source !== "voice" && source !== "dashboard" && source !== "resident" && source !== "guardian") {
    throw new Error("Invalid field: source");
  }

  const request: AgentTurnRequest = {
    message: requireString(record, "message"),
    source,
  };
  const householdId = optionalString(record, "householdId");
  const profileId = optionalString(record, "profileId");
  const forceBrowser = optionalBoolean(record, "forceBrowser");
  if (householdId) {
    request.householdId = householdId;
  }
  if (profileId) {
    request.profileId = profileId;
  }
  if (forceBrowser !== undefined) {
    request.forceBrowser = forceBrowser;
  }

  return request;
}

function roleForSource(source: AgentTurnRequest["source"]): TranscriptRole {
  if (source === "dashboard" || source === "guardian") {
    return "guardian";
  }

  return "resident";
}


function encodeSseFrame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class GazabotApp {
  private readonly transcriptBus = new TranscriptEventBus();

  private readonly agentHarness: AgentHarness;

  private readonly browserUseService: BrowserUseService;

  private readonly reminderScheduler: ReminderScheduler;

  private readonly uploadedFileService: UploadedFileService;

  private readonly unsubscribeReminderChanges: () => void;

  private readonly sttService: SttService;

  private readonly ttsService: TtsService;

  private readonly audioService = new AudioService();

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
  ) {
    this.browserUseService = new BrowserUseService(config, database, this.transcriptBus);
    this.uploadedFileService = new UploadedFileService(config, database);
    this.agentHarness = new AgentHarness(
      config,
      database,
      this.browserUseService,
      this.uploadedFileService,
      this.transcriptBus,
    );
    this.reminderScheduler = new ReminderScheduler(
      config,
      database,
      ({ reminder, dueAt, prompt }: { reminder: { id: string; title: string; instructions: string }; dueAt: string; prompt: string }) => this.executeReminderTurn(reminder, dueAt, prompt),
    );
    this.unsubscribeReminderChanges = this.database.subscribeReminderChanges(() => {
      this.reminderScheduler.refresh();
    });
    this.reminderScheduler.start();
    this.sttService = new SttService(config);
    this.ttsService = new TtsService(config);
    this.startWakeWordListener();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, this.config),
      });
    }

    const url = new URL(request.url);
    const reminderMatch = /^\/api\/reminders\/([^/]+)$/.exec(url.pathname);
    const memoryMatch = /^\/api\/memory\/([^/]+)$/.exec(url.pathname);
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    const fileTextMatch = /^\/api\/files\/([^/]+)\/text$/.exec(url.pathname);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(request, this.config, { status: "ok" });
      }

      if (request.method === "GET" && url.pathname === "/api/reminders") {
        return jsonResponse(request, this.config, { reminders: this.database.listReminders() });
      }

      if (request.method === "POST" && url.pathname === "/api/reminders") {
        const payload = parseReminderCreateInput(await parseJsonBody(request));
        return jsonResponse(request, this.config, this.database.createReminder(payload));
      }

      if (reminderMatch) {
        const reminderId = decodeURIComponent(reminderMatch[1] ?? "");

        if (request.method === "GET") {
          const reminder = this.database.getReminderById(reminderId);
          if (!reminder) {
            return errorResponse(request, this.config, 404, "Reminder not found.");
          }
          return jsonResponse(request, this.config, reminder);
        }

        if (request.method === "PATCH") {
          const payload = parseReminderUpdateInput(await parseJsonBody(request));
          return jsonResponse(request, this.config, this.database.updateReminder(reminderId, payload));
        }

        if (request.method === "DELETE") {
          const deleted = this.database.deleteReminder(reminderId);
          if (!deleted) {
            return errorResponse(request, this.config, 404, "Reminder not found.");
          }

          return new Response(null, {
            status: 204,
            headers: corsHeaders(request, this.config),
          });
        }
      }

      if (request.method === "GET" && url.pathname === "/api/transcript") {
        return jsonResponse(request, this.config, { entries: this.database.listTranscriptEntries() });
      }

      if (request.method === "GET" && url.pathname === "/api/transcript/stream") {
        return eventStreamResponse(request, this.config, this.transcriptBus.createStream());
      }

      if (request.method === "GET" && url.pathname === "/api/browser") {
        const browser = this.database.getCurrentBrowserContext();
        return jsonResponse(request, this.config, { browser } satisfies { browser: BrowserContext });
      }

      if (request.method === "POST" && url.pathname === "/api/agent/turn") {
        return jsonResponse(request, this.config, await this.handleAgentTurn(request));
      }

      if (request.method === "POST" && url.pathname === "/api/agent/stream") {
        return this.handleAgentStream(request);
      }

      if (request.method === "POST" && url.pathname === "/api/tts") {
        return jsonResponse(request, this.config, await this.handleTts(request));
      }

      if (request.method === "POST" && url.pathname === "/api/agent/voice-turn") {
        return this.handleVoiceTurn(request);
      }

      if (request.method === "POST" && url.pathname === "/api/agent/voice-start") {
        return jsonResponse(request, this.config, await this.handleVoiceStart());
      }

      if (request.method === "POST" && url.pathname === "/api/agent/voice-stop") {
        return jsonResponse(request, this.config, await this.handleVoiceStop());
      }

      if (request.method === "GET" && url.pathname === "/api/prompts") {
        const status = parsePromptStatus(url.searchParams.get("status"));
        return jsonResponse(request, this.config, { prompts: this.database.listPrompts(status) });
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/prompts/") && url.pathname.endsWith("/respond")) {
        const id = url.pathname.slice("/api/prompts/".length, -"/respond".length);
        return jsonResponse(request, this.config, await this.handlePromptRespond(request, id));
      }

      if (request.method === "GET" && url.pathname === "/api/memory") {
        return jsonResponse(request, this.config, { entries: this.database.listMemoryEntries() });
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
        return jsonResponse(request, this.config, { files: this.database.listUploadedFiles() });
      }

      if (request.method === "POST" && url.pathname === "/api/files") {
        return jsonResponse(request, this.config, await this.handleFileUpload(request));
      }

      if (memoryMatch) {
        const title = decodeURIComponent(memoryMatch[1] ?? "");
        if (request.method === "GET") {
          const entry = this.database.readMemory(title);
          if (!entry) {
            return errorResponse(request, this.config, 404, "Memory entry not found.");
          }
          return jsonResponse(request, this.config, { entry });
        }

        if (request.method === "PATCH") {
          const payload = parseMemoryWrite(await parseJsonBody(request));
          return jsonResponse(
            request,
            this.config,
            this.database.writeMemory(
              title,
              payload.content ?? JSON.stringify(payload.data ?? {}, null, 2),
              {
                ...(payload.schema !== undefined && { schema: payload.schema }),
                ...(payload.data !== undefined && { data: payload.data }),
              },
            ),
          );
        }
      }

      if (request.method === "PATCH" && url.pathname === "/api/memory") {
        const payloadRecord = asRecord(await parseJsonBody(request));
        const title = requireString(payloadRecord, "title");
        const payload = parseMemoryWrite(payloadRecord);
        return jsonResponse(
          request,
          this.config,
          this.database.writeMemory(
            title,
            payload.content ?? JSON.stringify(payload.data ?? {}, null, 2),
            {
              ...(payload.schema !== undefined && { schema: payload.schema }),
              ...(payload.data !== undefined && { data: payload.data }),
            },
          ),
        );
      }

      if (fileTextMatch && request.method === "GET") {
        const fileId = decodeURIComponent(fileTextMatch[1] ?? "");
        const file = this.database.getUploadedFile(fileId);
        if (!file) {
          return errorResponse(request, this.config, 404, "Uploaded file not found.");
        }

        const refreshed =
          file.textStatus === "ready" ? file : await this.uploadedFileService.extractTextIfPossible(fileId);
        return jsonResponse(request, this.config, {
          fileId: refreshed.id,
          textStatus: refreshed.textStatus,
          text: refreshed.extractedText ?? "",
        });
      }

      if (fileMatch && request.method === "GET") {
        const fileId = decodeURIComponent(fileMatch[1] ?? "");
        const file = this.database.getUploadedFile(fileId);
        if (!file) {
          return errorResponse(request, this.config, 404, "Uploaded file not found.");
        }

        return jsonResponse(request, this.config, { file });
      }

      return errorResponse(request, this.config, 404, "Route not found.");
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Invalid request." || error.message.startsWith("Invalid field:")) {
          return errorResponse(request, this.config, 422, "Invalid request.", error.message);
        }

        if ((error as Error & { notFound?: boolean }).notFound) {
          return errorResponse(request, this.config, 404, error.message);
        }

        if (
          error.message === "Message is required." ||
          error.message === "Invalid cron expression." ||
          error.message.startsWith("Unknown timezone:") ||
          error.message.startsWith("Prompt already ") ||
          error.name === "MulterError" ||
          error.message === "Unexpected end of form" ||
          error.message === "File too large"
        ) {
          return errorResponse(request, this.config, 400, error.message);
        }

        if (error.message.includes("INFERENCE_CLOUD_API_KEY is not configured")) {
          return errorResponse(request, this.config, 503, error.message);
        }

        if (error.message.startsWith("Imagine API error")) {
          return errorResponse(request, this.config, 502, error.message);
        }

        if (
          error.message === "Reminder not found." ||
          error.message === "Memory entry not found." ||
          error.message === "Uploaded file not found."
        ) {
          return errorResponse(request, this.config, 404, error.message);
        }
      }

      console.error("[app] Unhandled error:", error);
      return errorResponse(request, this.config, 500, "Internal server error.");
    }
  }

  private async handleAgentTurn(request: Request): Promise<AgentTurnResponse> {
    const payload = parseAgentTurnRequest(await parseJsonBody(request));
    if (!payload.message.trim()) {
      throw new Error("Message is required.");
    }

    const result: AgentTurnResult = await this.executeRecordedTurn(payload, roleForSource(payload.source));

    if (result.kind === "browser_task") {
      return {
        route: "browser_task",
        browserSessionId: result.browserSessionId,
        previewUrl: result.previewUrl,
        status: "queued",
      };
    }

    return {
      route: "conversation",
      reply: result.text,
    };
  }

  private async handleAgentStream(request: Request): Promise<Response> {
    const payload = parseAgentTurnRequest(await parseJsonBody(request));
    if (!payload.message.trim()) {
      throw new Error("Message is required.");
    }

    const userEntry = this.database.createTranscriptEntry({
      kind: "message",
      role: roleForSource(payload.source),
      text: payload.message,
    });
    this.transcriptBus.publish("transcript", userEntry);

    const stream = new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          let reply = "";

          try {
            controller.enqueue(encodeSseFrame("ready", { source: payload.source }));
            const reader = this.agentHarness.streamTurn(payload).getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              reply += value;
              controller.enqueue(encodeSseFrame("chunk", { delta: value, done: false }));
            }

            const robotEntry = this.database.createTranscriptEntry({
              kind: "message",
              role: "robot",
              text: reply,
            });
            this.transcriptBus.publish("transcript", robotEntry);
            controller.enqueue(encodeSseFrame("done", { text: reply, done: true }));
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Agent stream failed.";
            controller.enqueue(encodeSseFrame("error", { message }));
            controller.close();
          }
        })();
      },
    });

    return eventStreamResponse(request, this.config, stream);
  }

  private async processTranscriptText(transcript: string): Promise<{ transcript: string; replyText: string }> {
    const userEntry = this.database.createTranscriptEntry({
      kind: "message",
      role: "resident",
      text: transcript,
    });
    this.transcriptBus.publish("transcript", userEntry);

    const result: AgentTurnResult = await this.agentHarness.collectTurn({
      message: transcript,
      source: "voice",
    });

    let replyText: string;
    if (result.kind === "browser_task") {
      replyText = "I'm on it - I'll handle that for you now.";
    } else {
      replyText = result.text;
      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: replyText,
      });
      this.transcriptBus.publish("transcript", robotEntry);
    }

    return { transcript, replyText };
  }

  private async processVoiceAudio(audio: File | Blob | Buffer): Promise<{ transcript: string; replyText: string }> {
    const transcript = await this.sttService.transcribe(audio);
    if (!transcript.trim()) {
      throw Object.assign(new Error("No speech detected."), { noSpeech: true });
    }
    return this.processTranscriptText(transcript);
  }

  // ── Wake word ──────────────────────────────────────────────────────────────

  private startWakeWordListener(): void {
    const botDir = resolve(import.meta.dir, "../../bot");
    const script = resolve(botDir, "wake_word.py");
    // Use the venv's Python if it exists, otherwise fall back to system python3
    const venvPython = process.platform === "win32"
      ? resolve(botDir, ".venv/Scripts/python.exe")
      : resolve(botDir, ".venv/bin/python3");
    const python = Bun.file(venvPython).size > 0 ? venvPython : "python3";
    let child: ReturnType<typeof spawn>;

    const start = () => {
      child = spawn(python, [script], { stdio: ["ignore", "pipe", "pipe"] });

      // Forward Python stderr so wake_word startup logs appear in the Bun console
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[wake-word] ${chunk.toString()}`);
      });

      let buf = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines[lines.length - 1] ?? "";

        for (const line of lines.slice(0, -1)) {
          if (line.trim() === "WAKE") {
            this.handleWakeWord().catch((err) => {
              console.error("[wake-word] Error handling wake word:", err);
            });
          }
        }
      });

      child.on("error", (err: Error) => {
        // Python not installed or script missing — log and skip rather than crash
        console.warn(`[wake-word] Could not start wake_word.py: ${err.message}`);
      });

      child.on("close", (code: number | null) => {
        console.warn(`[wake-word] Process exited (code=${code}). Restarting in 3 s…`);
        setTimeout(start, 3000);
      });
    };

    start();
  }

  private async handleWakeWord(): Promise<void> {
    if (this.audioService.isRecording) {
      console.log("[wake-word] Already recording — ignoring trigger.");
      return;
    }

    console.log("[wake-word] Wake word detected — recording command…");
    const t0 = Date.now();

    // Open the AssemblyAI realtime WebSocket BEFORE starting the mic so
    // transcription begins the moment the first audio chunk arrives.
    let session: Awaited<ReturnType<typeof this.sttService.createRealtimeSession>>;
    try {
      session = await this.sttService.createRealtimeSession();
    } catch (err) {
      console.error("[wake-word] Failed to open STT session:", err);
      return;
    }

    const silenceOpts = { silenceDb: -15, silenceDuration: 1, maxDuration: 10 };
    console.log(`[wake-word] Recording with silenceDb=${silenceOpts.silenceDb} silenceDuration=${silenceOpts.silenceDuration}s maxDuration=${silenceOpts.maxDuration}s`);

    try {
      await this.audioService.recordPcmUntilSilence(
        (chunk) => session.sendAudio(chunk),
        silenceOpts,
      );
    } catch (err) {
      console.error("[wake-word] Recording failed:", err);
      await session.finalize().catch(() => {});
      return;
    }

    console.log(`[wake-word] Recording stopped  +${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const t1 = Date.now();

    // Flush any remaining transcripts — should be near-instant since
    // transcription was running in parallel with recording.
    const transcript = await session.finalize();
    console.log(`[wake-word] STT done           +${((Date.now() - t1) / 1000).toFixed(1)}s`);

    if (!transcript.trim()) {
      console.log("[wake-word] No speech detected after wake word.");
      return;
    }

    const t2 = Date.now();
    let result: { transcript: string; replyText: string };
    try {
      result = await this.processTranscriptText(transcript);
    } catch (err) {
      console.error("[wake-word] LLM processing failed:", err);
      return;
    }

    console.log(`[wake-word] LLM done           +${((Date.now() - t2) / 1000).toFixed(1)}s  (command: "${result.transcript}")`);

    const audioOut = await this.ttsService.synthesize(result.replyText);
    await this.audioService.playAudio(audioOut);
  }

  // ── HTTP voice routes ───────────────────────────────────────────────────────

  private async handleVoiceTurn(request: Request): Promise<Response> {
    let formData: Awaited<ReturnType<Request["formData"]>>;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse(request, this.config, 422, "Expected multipart/form-data.");
    }

    const audioField = formData.get("audio");
    if (!audioField || !(audioField instanceof File)) {
      return errorResponse(request, this.config, 422, "Missing audio field.");
    }

    let result: { transcript: string; replyText: string };
    try {
      result = await this.processVoiceAudio(audioField);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException & { noSpeech?: boolean }).noSpeech) {
        return errorResponse(request, this.config, 422, err.message);
      }
      throw err;
    }

    await this.speakReplyText(result.replyText, "voice");

    return jsonResponse(request, this.config, { ok: true, transcript: result.transcript });
  }

  private async handleVoiceStart(): Promise<{ ok: boolean }> {
    await this.audioService.startRecording();
    return { ok: true };
  }

  private async handleVoiceStop(): Promise<{ ok: boolean; transcript: string }> {
    const audioBuffer = await this.audioService.stopRecording();
    console.log(`[voice] Recorded buffer size: ${audioBuffer.length} bytes`);

    let result: { transcript: string; replyText: string };
    try {
      result = await this.processVoiceAudio(audioBuffer);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException & { noSpeech?: boolean }).noSpeech) {
        return { ok: false, transcript: "" };
      }
      throw err;
    }

    await this.speakReplyText(result.replyText, "voice");

    return { ok: true, transcript: result.transcript };
  }

  private async handleTts(request: Request): Promise<{ spoken: boolean; text: string }> {
    const body = asRecord(await parseJsonBody(request));
    const text = requireString(body, "text");

    this.transcriptBus.publishTts(text);

    const endpoint = this.config.tts.endpoint;
    if (endpoint) {
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        return { spoken: true, text };
      } catch {
        // TTS service unavailable — fall through
      }
    }

    return { spoken: false, text };
  }

  private async handlePromptRespond(request: Request, promptId: string): Promise<unknown> {
    const prompt = this.database.getPrompt(promptId);
    if (!prompt) {
      throw Object.assign(new Error(`Prompt not found: ${promptId}`), { notFound: true });
    }
    if (prompt.status !== "pending") {
      throw new Error(`Prompt already ${prompt.status}.`);
    }

    const body = asRecord(await parseJsonBody(request));
    const response = body.response;
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new Error("Invalid field: response");
    }

    const normalizedResponse = normalizePromptResponse(prompt, response as Record<string, unknown>);
    const { prompt: completed, memoryEntry } = this.database.respondToPrompt(promptId, normalizedResponse);

    const responseText = `User submitted form "${completed.title}" for ${completed.memoryKey}: ${JSON.stringify(completed.response)}`;
    const responseEntry = this.database.createTranscriptEntry({
      kind: "tool",
      role: "resident",
      text: responseText,
      toolName: "user-prompt",
      toolStatus: "completed",
      metadata: {
        promptId: completed.id,
        memoryKey: completed.memoryKey,
        response: completed.response,
        memory: memoryEntry,
      },
    });
    this.transcriptBus.publish("tool", responseEntry);

    return { prompt: completed, memoryEntry };
  }

  private async handleFileUpload(request: Request): Promise<{ file: UploadedFile }> {
    const fallbackRequest = request.clone();
    let uploadedFile: File;
    let displayName: string | undefined;
    let promptId: string | undefined;
    let fieldName: string | undefined;
    let reminderId: string | undefined;

    try {
      const { file: uploaded, fields } = await parseMultipartUpload(request);
      uploadedFile = new File([uploaded.buffer], uploaded.originalname || "upload", {
        type: uploaded.mimetype || "application/octet-stream",
      });
      displayName = typeof fields.displayName === "string" ? fields.displayName : undefined;
      promptId = typeof fields.promptId === "string" ? fields.promptId : undefined;
      fieldName = typeof fields.fieldName === "string" ? fields.fieldName : undefined;
      reminderId = typeof fields.reminderId === "string" ? fields.reminderId : undefined;
    } catch {
      let formData: Awaited<ReturnType<Request["formData"]>>;
      try {
        formData = await fallbackRequest.formData();
      } catch {
        throw new Error("Invalid request.");
      }

      const uploaded = formData.get("file");
      if (!(uploaded instanceof File)) {
        throw new Error("Invalid field: file");
      }

      uploadedFile = uploaded;
      const fallbackDisplayName = formData.get("displayName");
      const fallbackPromptId = formData.get("promptId");
      const fallbackFieldName = formData.get("fieldName");
      const fallbackReminderId = formData.get("reminderId");
      displayName = typeof fallbackDisplayName === "string" ? fallbackDisplayName : undefined;
      promptId = typeof fallbackPromptId === "string" ? fallbackPromptId : undefined;
      fieldName = typeof fallbackFieldName === "string" ? fallbackFieldName : undefined;
      reminderId = typeof fallbackReminderId === "string" ? fallbackReminderId : undefined;
    }

    const file = await this.uploadedFileService.saveUpload(uploadedFile, {
      ...(displayName?.trim() ? { displayName } : {}),
      ...(promptId?.trim() ? { promptId } : {}),
      ...(fieldName?.trim() ? { fieldName } : {}),
      ...(reminderId?.trim() ? { reminderId } : {}),
    });

    return { file };
  }

  async runReminderSchedulerOnce(now = new Date()): Promise<number> {
    return this.reminderScheduler.runOnce(now);
  }

  close(): void {
    this.unsubscribeReminderChanges();
    this.reminderScheduler.stop();
  }

  private async executeRecordedTurn(
    payload: AgentTurnRequest,
    transcriptRole: TranscriptRole,
    transcriptText = payload.message,
    metadata?: Record<string, unknown>,
  ): Promise<AgentTurnResult> {
    const entryInput: {
      kind: "message";
      role: TranscriptRole;
      text: string;
      metadata?: Record<string, unknown>;
    } = {
      kind: "message",
      role: transcriptRole,
      text: transcriptText,
    };
    if (metadata) {
      entryInput.metadata = metadata;
    }

    const userEntry = this.database.createTranscriptEntry(entryInput);
    this.transcriptBus.publish("transcript", userEntry);

    const result = await this.agentHarness.collectTurn(payload);
    if (result.kind === "text") {
      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: result.text,
      });
      this.transcriptBus.publish("transcript", robotEntry);
    }

    return result;
  }

  private async executeReminderTurn(
    reminder: { id: string; title: string; instructions: string },
    dueAt: string,
    prompt: string,
  ): Promise<void> {
    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: `Triggered reminder: ${reminder.title}`,
      toolName: "reminder-scheduler",
      toolStatus: "started",
      metadata: { reminderId: reminder.id, dueAt },
    });
    this.transcriptBus.publish("tool", started);
    console.log(`[reminder] Triggered ${reminder.id} "${reminder.title}" at ${dueAt}`);

    try {
      const result = await this.executeRecordedTurn(
        {
          message: prompt,
          source: "voice",
        },
        "system",
        `Reminder fired: ${reminder.title}. ${reminder.instructions}`,
        { reminderId: reminder.id, dueAt, reminderTitle: reminder.title },
      );
      if (result.kind === "text") {
        await this.speakReplyText(result.text, "reminder");
      }

      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text:
          result.kind === "browser_task"
            ? `Reminder dispatched a browser task: ${reminder.title}`
            : `Reminder completed: ${reminder.title}`,
        toolName: "reminder-scheduler",
        toolStatus: "completed",
        metadata: {
          reminderId: reminder.id,
          dueAt,
          resultKind: result.kind,
        },
      });
      this.transcriptBus.publish("tool", completed);
      console.log(`[reminder] Completed ${reminder.id} "${reminder.title}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Reminder failed: ${reminder.title}. ${message}`,
        toolName: "reminder-scheduler",
        toolStatus: "failed",
        metadata: { reminderId: reminder.id, dueAt },
      });
      this.transcriptBus.publish("tool", failed);
      console.error(`[reminder] Failed ${reminder.id} "${reminder.title}": ${message}`);
      throw error;
    }
  }

  private async speakReplyText(text: string, source: "voice" | "reminder"): Promise<void> {
    const audioOut = await this.ttsService.synthesize(text);
    this.audioService.playAudio(audioOut).catch((err) => {
      console.error(`[${source}] Playback error:`, err);
    });
  }
}

export function createApp(config: AppConfig, database = new GazabotDatabase(config.databasePath)): GazabotApp {
  return new GazabotApp(config, database);
}
