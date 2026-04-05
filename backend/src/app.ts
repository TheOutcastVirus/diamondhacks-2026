import type { AppConfig } from "./config";
import type {
  AgentModel,
  AgentTurnRequest,
  AgentTurnResponse,
  ApiErrorPayload,
  BrowserContext,
  PromptField,
  PromptFieldOption,
  ReminderCreateInput,
  ReminderUpdateInput,
  TranscriptRole,
  TranscriptEntry,
  UploadedFile,
  UploadedFileReference,
} from "./contracts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AgentHarness, type AgentTurnResult } from "./agent";
import { AudioService } from "./audio";
import { BlandService } from "./bland";
import { BrowserUseService } from "./browser-use";
import { detectCrisis } from "./crisis";
import {
  buildRecentActivitySnapshot,
  formatRecentActivityForBland,
  formatRecentActivityRecap,
} from "./activity";
import { GazabotDatabase } from "./db";
import { UploadedFileService } from "./files";
import { parseMultipartUpload } from "./multipart";
import { ReminderScheduler } from "./reminder-scheduler";
import { DEFAULT_REMINDER_TIMEZONE, resolveReminderTimezone } from "./reminders";
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
  const model = optionalString(record, "model");
  if (model) {
    if (model !== "imagine" && model !== "gemini-fast") {
      throw new Error("Invalid field: model");
    }
    request.model = model;
  }

  return request;
}

function parseOptionalAgentModel(value: string | File | undefined | null): AgentModel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === "imagine" || trimmed === "gemini-fast") {
    return trimmed;
  }

  throw new Error("Invalid field: model");
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

const FAMILY_CONTACT_MEMORY_KEY = "family_contact_primary";

const FAMILY_CONTACT_PROMPT_FIELDS: PromptField[] = [
  { name: "full_name", label: "Full Name", type: "string", required: true },
  { name: "relationship", label: "Relationship", type: "string", required: true },
  {
    name: "phone_number",
    label: "Phone Number",
    type: "string",
    required: true,
    placeholder: "+14155551234",
    description: "Store the number in E.164 format for automatic crisis calling.",
  },
  { name: "notes", label: "Notes", type: "text", required: false },
];

function redactPhoneNumber(phoneNumber: string): string {
  if (phoneNumber.length <= 6) {
    return `${phoneNumber.slice(0, 2)}***`;
  }
  return `${phoneNumber.slice(0, 5)}******${phoneNumber.slice(-2)}`;
}

/** Copy for Bland `request_data` — use in the pathway as variables (e.g. {{emergency_brief}}) so the voice agent sounds human and clear. */
function emergencyCallRequestData(relationship: string, recentActivity?: string): Record<string, string> {
  const activitySuffix = recentActivity ? ` Recent activity: ${recentActivity}` : "";
  const requestData: Record<string, string> = {
    emergency_brief:
      "This is an automated wellness alert from a home care assistant. Someone you support may be in distress or need urgent help. Please try to reach them right away, or ask someone nearby to check on them. Thank you for responding as quickly as you can.",
    relationship_to_resident: relationship,
  };
  if (activitySuffix) {
    requestData.emergency_brief = `${requestData.emergency_brief}${activitySuffix}`;
  }
  if (recentActivity) {
    requestData.recent_activity = recentActivity;
  }
  return requestData;
}

function formatTranscriptSnippet(entry: { role: TranscriptRole; text: string }): string {
  const speaker = entry.role === "robot" ? "Assistant" : entry.role === "guardian" ? "Guardian" : "Resident";
  return `${speaker}: ${entry.text}`;
}

function summarizeRecentActivity(entries: TranscriptEntry[]): string | undefined {
  const now = Date.now();
  const maxAgeMs = 30 * 60 * 1000;
  const snippets: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.kind !== "message") {
      continue;
    }
    if (entry.role !== "resident" && entry.role !== "robot" && entry.role !== "guardian") {
      continue;
    }
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts) || now - ts > maxAgeMs) {
      continue;
    }
    if (entry.text.trim().length === 0) {
      continue;
    }
    snippets.push(formatTranscriptSnippet({ role: entry.role, text: entry.text.trim() }));
    if (snippets.length >= 4) {
      break;
    }
  }
  if (snippets.length === 0) {
    return undefined;
  }
  return snippets.reverse().join(" | ");
}

function normalizeRecapMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecentActivityRecapRequest(message: string): boolean {
  const normalized = normalizeRecapMessage(message);
  if (!normalized) return false;
  return (
    normalized.includes("what happened recently") ||
    normalized.includes("what did i miss") ||
    normalized.includes("catch me up") ||
    normalized.includes("recap what happened")
  );
}

export class GazabotApp {
  private readonly transcriptBus = new TranscriptEventBus();

  private readonly agentHarness: AgentHarness;

  private readonly browserUseService: BrowserUseService;

  private readonly blandService: BlandService;

  private readonly reminderScheduler: ReminderScheduler;

  private readonly uploadedFileService: UploadedFileService;

  private readonly unsubscribeReminderChanges: () => void;

  private readonly sttService: SttService;

  private readonly ttsService: TtsService;

  private readonly audioService = new AudioService();

  // ── Conversation state ─────────────────────────────────────────────────────
  private conversationState: "idle" | "conversation" = "idle";
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private isSpeaking = false;
  private lastActivityAt: Date | null = null;
  private wakeWordProcess: ReturnType<typeof spawn> | null = null;
  private wakeWordRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeWordListenerEnabled = false;
  private interactionOwner: "conversation" | "voice-http" | "reminder" | null = null;
  private interactionPhase: "idle" | "user_listening" | "agent_thinking" | "agent_speaking" = "idle";
  private static readonly SESSION_GAP_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly POST_SPEECH_LISTEN_DELAY_MS = 750;

  private claimInteraction(owner: "conversation" | "voice-http" | "reminder"): boolean {
    if (this.interactionOwner && this.interactionOwner !== owner) {
      return false;
    }
    this.interactionOwner = owner;
    return true;
  }

  private releaseInteraction(owner: "conversation" | "voice-http" | "reminder"): void {
    if (this.interactionOwner !== owner) {
      return;
    }
    this.interactionOwner = null;
    this.interactionPhase = "idle";
  }

  private setInteractionPhase(
    owner: "conversation" | "voice-http" | "reminder",
    phase: "user_listening" | "agent_thinking" | "agent_speaking",
  ): void {
    if (this.interactionOwner === owner) {
      this.interactionPhase = phase;
    }
  }

  private interactionBusyMessage(owner: "conversation" | "voice-http" | "reminder"): string {
    const phaseLabel =
      this.interactionPhase === "user_listening"
        ? "listening to the user"
        : this.interactionPhase === "agent_thinking"
          ? "processing a turn"
          : this.interactionPhase === "agent_speaking"
            ? "speaking"
            : "busy";
    return `[${owner}] Interaction locked by ${this.interactionOwner ?? "unknown"} while ${phaseLabel}.`;
  }

  private interactionBusyError(owner: "conversation" | "voice-http" | "reminder"): Error & { conflict: true } {
    return Object.assign(new Error(this.interactionBusyMessage(owner)), { conflict: true as const });
  }

  private enterConversationMode(): void {
    this.conversationState = "conversation";
    this.resetConversationTimer();
    this.transcriptBus.publishState("conversation");
    console.log("[conversation] Entered conversation mode.");
  }

  private exitConversationMode(): void {
    if (this.conversationState === "idle") return;
    this.conversationState = "idle";
    if (this.conversationTimer) {
      clearTimeout(this.conversationTimer);
      this.conversationTimer = null;
    }
    this.transcriptBus.publishState("idle");
    console.log("[conversation] Returned to idle (inactivity timeout).");
  }

  private resetConversationTimer(): void {
    if (this.conversationTimer) clearTimeout(this.conversationTimer);
    this.conversationTimer = setTimeout(
      () => this.exitConversationMode(),
      this.config.agent.conversationTimeoutSeconds * 1000,
    );
  }

  async archiveAndResetConversation(): Promise<void> {
    const entries = this.database.listMessageTranscriptEntries();

    if (entries.length > 0) {
      const dateLabel = new Date().toLocaleString("en-US", {
        timeZone: DEFAULT_REMINDER_TIMEZONE,
        dateStyle: "medium",
        timeStyle: "short",
      });

      const lines = entries
        .filter((e) => e.role === "robot" || e.role === "resident" || e.role === "guardian")
        .map((e) => {
          const speaker = e.role === "robot" ? "Gazabot" : "User";
          return `${speaker}: ${e.text}`;
        });

      if (lines.length > 0) {
        const title = `past_conversation_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "_")}`;
        this.database.writeMemory(title, `Conversation on ${dateLabel}:\n${lines.join("\n")}`);
        console.log(`[session] Archived conversation as "${title}".`);
      }
    }

    this.database.clearTranscriptEntries();
    this.lastActivityAt = null;
    this.transcriptBus.publishSessionReset();
    console.log("[session] Transcript cleared — new session started.");
  }

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
  ) {
    this.browserUseService = new BrowserUseService(config, database, this.transcriptBus);
    this.blandService = new BlandService(config);
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
    // Pre-warm the Silero VAD model so the first conversation turn has no load delay
    this.audioService.startPersistentVad({ threshold: 0.5, silenceDuration: 1.0 }).catch((err) => {
      console.warn(`[silero-vad] Pre-warm failed: ${err.message}`);
    });
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

      if (request.method === "POST" && url.pathname === "/api/conversation/new") {
        await this.archiveAndResetConversation();
        return jsonResponse(request, this.config, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/emergency-family-call") {
        return this.handleEmergencyFamilyCallRequest(request);
      }

      if (request.method === "GET" && url.pathname === "/api/transcript/stream") {
        return eventStreamResponse(request, this.config, this.transcriptBus.createStream());
      }

      if (request.method === "GET" && url.pathname === "/api/browser") {
        const browser = this.database.getCurrentBrowserContext();
        const configuredProfileId = this.config.browserUse.profileId?.trim();
        if (configuredProfileId) {
          browser.configuredProfileId = configuredProfileId;
        }
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
        return jsonResponse(request, this.config, await this.handleVoiceStop(request));
      }

      if (request.method === "GET" && url.pathname === "/api/prompts") {
        const status = parsePromptStatus(url.searchParams.get("status"));
        return jsonResponse(request, this.config, { prompts: this.database.listPrompts(status) });
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/prompts/") && url.pathname.endsWith("/respond")) {
        const id = url.pathname.slice("/api/prompts/".length, -"/respond".length);
        return jsonResponse(request, this.config, await this.handlePromptRespond(request, id));
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        this.database.resetSession();
        console.log("[reset] Session data cleared (transcript, browser, prompts, orders).");
        return jsonResponse(request, this.config, { status: "ok", message: "Session reset." });
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

        if ((error as Error & { conflict?: boolean }).conflict) {
          return errorResponse(request, this.config, 409, error.message);
        }

        if (error.message.includes("INFERENCE_CLOUD_API_KEY is not configured")) {
          return errorResponse(request, this.config, 503, error.message);
        }
        if (error.message.includes("GOOGLE_AI_API_KEY is not configured")) {
          return errorResponse(request, this.config, 503, error.message);
        }

        if (error.message.startsWith("Imagine API error")) {
          return errorResponse(request, this.config, 502, error.message);
        }
        if (error.message.startsWith("Gemini API error") || error.message.startsWith("Gemini request failed")) {
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

    if (isRecentActivityRecapRequest(payload.message)) {
      const snapshot = buildRecentActivitySnapshot(this.database, { lookbackMinutes: 240, limit: 30 });
      const recap = formatRecentActivityRecap(snapshot, { voice: payload.source === "voice" });

      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: recap,
        metadata: { recapWindowMinutes: snapshot.windowMinutes, recapItems: snapshot.items.length },
      });
      this.transcriptBus.publish("transcript", robotEntry);

      const stream = new ReadableStream<string>({
        start: (controller) => {
          controller.enqueue(encodeSseFrame("ready", { source: payload.source }));
          controller.enqueue(encodeSseFrame("chunk", { delta: recap, done: false }));
          controller.enqueue(encodeSseFrame("done", { text: recap, done: true }));
          controller.close();
        },
      });
      return eventStreamResponse(request, this.config, stream);
    }

    const crisisResult = await this.handleCrisisTurn(payload);
    if (crisisResult?.kind === "text") {
      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: crisisResult.text,
      });
      this.transcriptBus.publish("transcript", robotEntry);

      const stream = new ReadableStream<string>({
        start: (controller) => {
          controller.enqueue(encodeSseFrame("ready", { source: payload.source }));
          controller.enqueue(encodeSseFrame("chunk", { delta: crisisResult.text, done: false }));
          controller.enqueue(encodeSseFrame("done", { text: crisisResult.text, done: true }));
          controller.close();
        },
      });
      return eventStreamResponse(request, this.config, stream);
    }

    const stream = new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          try {
            controller.enqueue(encodeSseFrame("ready", { source: payload.source }));
            const result = await this.agentHarness.collectTurn(payload);

            if (result.kind === "browser_task") {
              controller.enqueue(
                encodeSseFrame("done", {
                  text: "",
                  done: true,
                  route: "browser_task",
                  browserSessionId: result.browserSessionId,
                  previewUrl: result.previewUrl,
                }),
              );
              controller.close();
              return;
            }

            const reply = result.text;
            const robotEntry = this.database.createTranscriptEntry({
              kind: "message",
              role: "robot",
              text: reply,
            });
            this.transcriptBus.publish("transcript", robotEntry);
            controller.enqueue(encodeSseFrame("chunk", { delta: reply, done: false }));
            controller.enqueue(encodeSseFrame("done", { text: reply, done: true }));
            if (result.kind === "end_conversation") {
              await this.archiveAndResetConversation();
            }
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

  private async processTranscriptText(
    transcript: string,
    model?: AgentModel,
  ): Promise<{ transcript: string; replyText: string; endConversation: boolean }> {
    const userEntry = this.database.createTranscriptEntry({
      kind: "message",
      role: "resident",
      text: transcript,
    });
    this.transcriptBus.publish("transcript", userEntry);

    const result: AgentTurnResult = await this.agentHarness.collectTurn({
      message: transcript,
      source: "voice",
      ...(model !== undefined ? { model } : {}),
    });

    let replyText: string;
    const endConversation = result.kind === "end_conversation";

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

    return { transcript, replyText, endConversation };
  }

  private async processVoiceAudio(
    audio: File | Blob | Buffer,
    model?: AgentModel,
  ): Promise<{ transcript: string; replyText: string; endConversation: boolean }> {
    const transcript = await this.sttService.transcribe(audio);
    if (!transcript.trim()) {
      throw Object.assign(new Error("No speech detected."), { noSpeech: true });
    }
    return this.processTranscriptText(transcript, model);
  }

  // ── Wake word ──────────────────────────────────────────────────────────────

  private startWakeWordListener(): void {
    this.wakeWordListenerEnabled = true;
    const botDir = resolve(import.meta.dir, "../../bot");
    const script = resolve(botDir, "wake_word.py");
    // Use the venv's Python if it exists, otherwise fall back to system python3
    const venvPython = process.platform === "win32"
      ? resolve(botDir, ".venv/Scripts/python.exe")
      : resolve(botDir, ".venv/bin/python3");
    const python = Bun.file(venvPython).size > 0 ? venvPython : "python3";
    let child: ReturnType<typeof spawn>;

    const start = () => {
      if (!this.wakeWordListenerEnabled || this.wakeWordProcess) {
        return;
      }
      child = spawn(python, [script], { stdio: ["ignore", "pipe", "pipe"] });
      this.wakeWordProcess = child;

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
        if (this.wakeWordProcess === child) {
          this.wakeWordProcess = null;
        }
        if (!this.wakeWordListenerEnabled) {
          return;
        }
        console.warn(`[wake-word] Process exited (code=${code}). Restarting in 3 s…`);
        this.wakeWordRestartTimer = setTimeout(() => {
          this.wakeWordRestartTimer = null;
          start();
        }, 3000);
      });
    };

    start();
  }

  private stopWakeWordListener(): void {
    this.wakeWordListenerEnabled = false;
    if (this.wakeWordRestartTimer) {
      clearTimeout(this.wakeWordRestartTimer);
      this.wakeWordRestartTimer = null;
    }

    const child = this.wakeWordProcess;
    if (!child) {
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore shutdown races if the process already exited.
    }
  }

  private async handleWakeWord(): Promise<void> {
    if (this.isSpeaking || this.interactionPhase === "agent_speaking") {
      console.log("[wake-word] Bot is speaking — ignoring trigger.");
      return;
    }

    if (
      this.interactionOwner !== null ||
      (this.conversationState === "conversation" && this.audioService.isRecording)
    ) {
      // Already in a conversation turn or another voice interaction, ignore duplicate triggers
      return;
    }

    // If the user has been away for more than SESSION_GAP_MS, archive the old
    // conversation and start fresh before entering the new one.
    if (
      this.lastActivityAt !== null &&
      Date.now() - this.lastActivityAt.valueOf() > GazabotApp.SESSION_GAP_MS
    ) {
      console.log("[session] Session gap exceeded — archiving conversation.");
      await this.archiveAndResetConversation();
    }

    console.log("[wake-word] Wake word detected — entering conversation mode.");
    this.enterConversationMode();
    await this.runConversationTurn();
  }

  private async runConversationTurn(): Promise<void> {
    const ownsInteraction = this.interactionOwner === "conversation";
    if (this.conversationState !== "conversation" || this.audioService.isRecording || this.isSpeaking) {
      return;
    }
    if (!ownsInteraction && !this.claimInteraction("conversation")) {
      return;
    }

    // Suspend the inactivity timer for the entire turn: recording → STT → agent
    // → TTS → playback. The timer races with recordUntilSilence (both are ~10s)
    // and was firing mid-recording before the turn even reached processing.
    // The countdown only resumes once the bot has finished speaking.
    if (this.conversationTimer) {
      clearTimeout(this.conversationTimer);
      this.conversationTimer = null;
    }

    let transcript = "";
    const recordingStartedAt = Date.now();
    let recordingStoppedAt = recordingStartedAt;
    let sttFinishedAt = recordingStartedAt;
    try {
      this.setInteractionPhase("conversation", "user_listening");
      const session = await this.sttService.createRealtimeSession();
      await this.audioService.recordPcmWithSileroVad(
        (chunk) => session.sendAudio(chunk),
        { maxDuration: 10 },
      );
      recordingStoppedAt = Date.now();
      console.log(
        `[conversation] Recording stopped +${((recordingStoppedAt - recordingStartedAt) / 1000).toFixed(1)}s`,
      );
      transcript = await session.finalize();
      sttFinishedAt = Date.now();
      console.log(
        `[conversation] STT done          +${((sttFinishedAt - recordingStoppedAt) / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      console.error("[conversation] Recording failed:", err);
      this.resetConversationTimer();
      if (!ownsInteraction) {
        this.releaseInteraction("conversation");
      }
      return;
    }

    if (!transcript.trim()) {
      console.log("[conversation] No speech detected, waiting for activity…");
      this.resetConversationTimer();
      if (!ownsInteraction) {
        this.releaseInteraction("conversation");
      }
      return;
    }

    let result: { transcript: string; replyText: string; endConversation: boolean };
    try {
      this.setInteractionPhase("conversation", "agent_thinking");
      result = await this.processTranscriptText(transcript);
    } catch (err) {
      console.error("[conversation] Processing failed:", err);
      this.resetConversationTimer();
      if (!ownsInteraction) {
        this.releaseInteraction("conversation");
      }
      return;
    }

    console.log(`[conversation] User: "${result.transcript}"`);
    this.lastActivityAt = new Date();

    this.isSpeaking = true;
    try {
      this.setInteractionPhase("conversation", "agent_speaking");
      await this.speakReplyText(result.replyText, "voice");
    } catch (err) {
      console.error("[conversation] TTS/playback failed:", err);
    } finally {
      await Bun.sleep(GazabotApp.POST_SPEECH_LISTEN_DELAY_MS);
      this.isSpeaking = false;
    }

    // Agent explicitly ended the conversation — exit immediately, no further listening
    if (result.endConversation) {
      console.log("[conversation] Agent ended conversation.");
      this.exitConversationMode();
      await this.archiveAndResetConversation();
      this.releaseInteraction("conversation");
      return;
    }

    // Bot has finished speaking — start the inactivity countdown, then loop
    this.resetConversationTimer();
    this.setInteractionPhase("conversation", "user_listening");
    if (this.conversationState === "conversation") {
      void this.runConversationTurn();
      return;
    }
    this.releaseInteraction("conversation");
  }

  // ── HTTP voice routes ───────────────────────────────────────────────────────

  private async handleVoiceTurn(request: Request): Promise<Response> {
    if (!this.claimInteraction("voice-http")) {
      return errorResponse(request, this.config, 409, this.interactionBusyMessage("voice-http"));
    }

    let formData: Awaited<ReturnType<Request["formData"]>>;
    try {
      formData = await request.formData();
    } catch {
      this.releaseInteraction("voice-http");
      return errorResponse(request, this.config, 422, "Expected multipart/form-data.");
    }

    const audioField = formData.get("audio");
    if (!audioField || !(audioField instanceof File)) {
      this.releaseInteraction("voice-http");
      return errorResponse(request, this.config, 422, "Missing audio field.");
    }

    let model: AgentModel | undefined;
    try {
      model = parseOptionalAgentModel(formData.get("model"));
    } catch (error) {
      this.releaseInteraction("voice-http");
      return errorResponse(request, this.config, 422, error instanceof Error ? error.message : "Invalid field: model");
    }

    let result: { transcript: string; replyText: string; endConversation: boolean };
    try {
      this.setInteractionPhase("voice-http", "agent_thinking");
      result = await this.processVoiceAudio(audioField, model);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException & { noSpeech?: boolean }).noSpeech) {
        this.releaseInteraction("voice-http");
        return errorResponse(request, this.config, 422, err.message);
      }
      this.releaseInteraction("voice-http");
      throw err;
    }

    try {
      this.setInteractionPhase("voice-http", "agent_speaking");
      await this.speakReplyText(result.replyText, "voice");
      if (result.endConversation) {
        await this.archiveAndResetConversation();
      }
      return jsonResponse(request, this.config, { ok: true, transcript: result.transcript });
    } finally {
      this.releaseInteraction("voice-http");
    }
  }

  private async handleVoiceStart(): Promise<{ ok: boolean }> {
    if (!this.claimInteraction("voice-http")) {
      throw this.interactionBusyError("voice-http");
    }
    this.setInteractionPhase("voice-http", "user_listening");
    try {
      await this.audioService.startRecording();
      return { ok: true };
    } catch (error) {
      this.releaseInteraction("voice-http");
      throw error;
    }
  }

  private async handleVoiceStop(request: Request): Promise<{ ok: boolean; transcript: string }> {
    if (this.interactionOwner !== "voice-http") {
      throw this.interactionBusyError("voice-http");
    }

    let audioBuffer: Buffer;
    try {
      audioBuffer = await this.audioService.stopRecording();
    } catch (error) {
      this.releaseInteraction("voice-http");
      throw error;
    }
    console.log(`[voice] Recorded buffer size: ${audioBuffer.length} bytes`);

    let model: AgentModel | undefined;
    try {
      const body = await parseJsonBody(request);
      const record = asRecord(body);
      const modelValue =
        typeof record.model === "string" || record.model instanceof File ? record.model : undefined;
      model = parseOptionalAgentModel(modelValue);
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid request.") {
        model = undefined;
      } else {
        this.releaseInteraction("voice-http");
        throw error;
      }
    }

    let result: { transcript: string; replyText: string; endConversation: boolean };
    try {
      this.setInteractionPhase("voice-http", "agent_thinking");
      result = await this.processVoiceAudio(audioBuffer, model);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException & { noSpeech?: boolean }).noSpeech) {
        this.releaseInteraction("voice-http");
        return { ok: false, transcript: "" };
      }
      this.releaseInteraction("voice-http");
      throw err;
    }

    try {
      this.setInteractionPhase("voice-http", "agent_speaking");
      await this.speakReplyText(result.replyText, "voice");
      if (result.endConversation) {
        await this.archiveAndResetConversation();
      }
      return { ok: true, transcript: result.transcript };
    } finally {
      this.releaseInteraction("voice-http");
    }
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

    const responseKeys = Object.keys(completed.response ?? {});
    const responseText = `User submitted form "${completed.title}" for ${completed.memoryKey}. Fields: ${responseKeys.join(", ") || "(none)"}`;
    const responseEntry = this.database.createTranscriptEntry({
      kind: "tool",
      role: "resident",
      text: responseText,
      toolName: "user-prompt",
      toolStatus: "completed",
      metadata: {
        promptId: completed.id,
        memoryKey: completed.memoryKey,
        formTitle: completed.title,
        submittedFields: responseKeys,
      },
    });
    this.transcriptBus.publish("tool", responseEntry);

    const hitlRequest = this.database.findPendingHitlByPromptId(promptId);
    if (hitlRequest) {
      this.database.resolveHitlRequest(hitlRequest.id);

      const resumeEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: "Resuming browser task with your information.",
        toolName: "browser-use-hitl",
        toolStatus: "started",
        metadata: {
          promptId: completed.id,
          hitlRequestId: hitlRequest.id,
          needKind: hitlRequest.needKind,
          browserSessionId: hitlRequest.browserSessionId,
        },
      });
      const robotResume = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: "Resuming the browser task with the information you provided.",
      });
      this.transcriptBus.publish("tool", resumeEntry);
      this.transcriptBus.publish("transcript", robotResume);

      void this.browserUseService.resumeHitlRequest(hitlRequest).catch((error) => {
        console.error("[browser-use] Failed to resume HITL request:", error);
      });
    }

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
    this.stopWakeWordListener();
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

    if (isRecentActivityRecapRequest(payload.message)) {
      const snapshot = buildRecentActivitySnapshot(this.database, { lookbackMinutes: 240, limit: 30 });
      const recap = formatRecentActivityRecap(snapshot, { voice: payload.source === "voice" });
      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: recap,
        metadata: { recapWindowMinutes: snapshot.windowMinutes, recapItems: snapshot.items.length },
      });
      this.transcriptBus.publish("transcript", robotEntry);
      return { kind: "text", text: recap };
    }

    const crisisResult = await this.handleCrisisTurn(payload);
    if (crisisResult) {
      if (crisisResult.kind === "text") {
        const robotEntry = this.database.createTranscriptEntry({
          kind: "message",
          role: "robot",
          text: crisisResult.text,
        });
        this.transcriptBus.publish("transcript", robotEntry);
      }
      return crisisResult;
    }

    const result = await this.agentHarness.collectTurn(payload);
    if (result.kind === "text" || result.kind === "end_conversation") {
      const robotEntry = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: result.text,
      });
      this.transcriptBus.publish("transcript", robotEntry);
    }
    if (result.kind === "end_conversation") {
      await this.archiveAndResetConversation();
    }

    return result;
  }

  private readPrimaryFamilyContact(): { fullName: string; relationship: string; phoneNumber: string } | null {
    const contactMemory = this.database.readMemory(FAMILY_CONTACT_MEMORY_KEY);
    const contactData = contactMemory?.data;
    const fullName = typeof contactData?.full_name === "string" ? contactData.full_name.trim() : "";
    const relationship = typeof contactData?.relationship === "string" ? contactData.relationship.trim() : "";
    const phoneNumber = typeof contactData?.phone_number === "string" ? contactData.phone_number.trim() : "";
    if (!fullName || !relationship || !phoneNumber) {
      return null;
    }
    return { fullName, relationship, phoneNumber };
  }

  private findRecentManualEmergencyCall(): boolean {
    const thresholdMs = this.config.crisis.callCooldownSeconds * 1000;
    const now = Date.now();
    const entries = this.database.listTranscriptEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      if (entry.kind !== "tool" || entry.toolName !== "crisis-escalation" || entry.toolStatus !== "completed") {
        continue;
      }
      if (entry.metadata?.manualTrigger !== true) {
        continue;
      }
      const timestampMs = Date.parse(entry.timestamp);
      if (Number.isNaN(timestampMs) || now - timestampMs > thresholdMs) {
        continue;
      }
      return true;
    }
    return false;
  }

  private async handleEmergencyFamilyCallRequest(request: Request): Promise<Response> {
    if (this.findRecentManualEmergencyCall()) {
      return errorResponse(
        request,
        this.config,
        429,
        "An emergency call was placed recently. Wait before trying again, or use your phone if the situation is critical.",
      );
    }

    const contact = this.readPrimaryFamilyContact();
    if (!contact) {
      this.ensureFamilyContactPrompt();
      return errorResponse(
        request,
        this.config,
        400,
        "Save a primary family contact (Request info) before placing an emergency call.",
      );
    }

    if (!this.blandService.isConfigured()) {
      return errorResponse(
        request,
        this.config,
        503,
        "Emergency calling is not configured. Add BLAND_API_KEY on the server.",
      );
    }

    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: "Calling tool: crisis-escalation (guardian-initiated)",
      toolName: "crisis-escalation",
      toolStatus: "started",
      metadata: { manualTrigger: true },
    });
    this.transcriptBus.publish("tool", started);

    try {
      const snapshot = buildRecentActivitySnapshot(this.database, { lookbackMinutes: 240, limit: 18 });
      const recentActivity =
        formatRecentActivityForBland(snapshot) ?? summarizeRecentActivity(this.database.listTranscriptEntries());
      const blandCall = await this.blandService.placePathwayCall({
        phoneNumber: contact.phoneNumber,
        requestData: emergencyCallRequestData(contact.relationship, recentActivity),
      });
      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: "Tool crisis-escalation completed (guardian-initiated)",
        toolName: "crisis-escalation",
        toolStatus: "completed",
        metadata: {
          manualTrigger: true,
          targetName: contact.fullName,
          relationship: contact.relationship,
          targetPhoneRedacted: redactPhoneNumber(contact.phoneNumber),
          blandCallId: blandCall.callId,
          recentActivityIncluded: Boolean(recentActivity),
        },
      });
      this.transcriptBus.publish("tool", completed);

      const guardianNote = this.database.createTranscriptEntry({
        kind: "message",
        role: "guardian",
        text: "Guardian placed an emergency call to the primary family contact (Bland AI).",
        metadata: { source: "emergency-family-call-button" },
      });
      this.transcriptBus.publish("transcript", guardianNote);

      return jsonResponse(request, this.config, { ok: true, callId: blandCall.callId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Tool crisis-escalation failed: ${message}`,
        toolName: "crisis-escalation",
        toolStatus: "failed",
        metadata: {
          manualTrigger: true,
          targetName: contact.fullName,
          targetPhoneRedacted: redactPhoneNumber(contact.phoneNumber),
          failureReason: message,
        },
      });
      this.transcriptBus.publish("tool", failed);
      return errorResponse(request, this.config, 502, `Could not place the call: ${message}`);
    }
  }

  private async handleCrisisTurn(payload: AgentTurnRequest): Promise<AgentTurnResult | null> {
    if (!this.config.crisis.enabled) {
      return null;
    }

    const detection = detectCrisis(payload.message);
    if (!detection.triggered) {
      return null;
    }

    const duplicate = this.findRecentCrisisEscalation(detection.normalizedMessage);
    if (duplicate) {
      return {
        kind: "text",
        text:
          payload.source === "voice"
            ? "I already contacted your family. Stay with me."
            : "Crisis escalation already triggered recently for this request.",
      };
    }

    const contact = this.readPrimaryFamilyContact();
    const fullName = contact?.fullName ?? "";
    const relationship = contact?.relationship ?? "";
    const phoneNumber = contact?.phoneNumber ?? "";

    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: "Calling tool: crisis-escalation",
      toolName: "crisis-escalation",
      toolStatus: "started",
      metadata: {
        matchedPhrases: detection.matchedPhrases,
        normalizedMessage: detection.normalizedMessage,
      },
    });
    this.transcriptBus.publish("tool", started);

    if (!fullName || !relationship || !phoneNumber) {
      this.ensureFamilyContactPrompt();
      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: "Tool crisis-escalation failed: Missing family contact.",
        toolName: "crisis-escalation",
        toolStatus: "failed",
        metadata: {
          matchedPhrases: detection.matchedPhrases,
          failureReason: "family_contact_missing",
        },
      });
      this.transcriptBus.publish("tool", failed);
      return {
        kind: "text",
        text: "I'm trying to contact your family, but I don't have their phone number saved yet.",
      };
    }

    if (!this.blandService.isConfigured()) {
      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: "Tool crisis-escalation failed: Bland is not configured.",
        toolName: "crisis-escalation",
        toolStatus: "failed",
        metadata: {
          matchedPhrases: detection.matchedPhrases,
          targetName: fullName,
          targetPhoneRedacted: redactPhoneNumber(phoneNumber),
          failureReason: "bland_not_configured",
        },
      });
      this.transcriptBus.publish("tool", failed);
      return {
        
        kind: "text",
        text: "I'm trying to contact your family, but the calling system is not set up yet.",
      };
    }

    try {
      const snapshot = buildRecentActivitySnapshot(this.database, { lookbackMinutes: 240, limit: 18 });
      const recentActivity = formatRecentActivityForBland(snapshot);
      const blandCall = await this.blandService.placePathwayCall({
        phoneNumber,
        requestData: emergencyCallRequestData(relationship, recentActivity),
      });
      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: "Tool crisis-escalation completed",
        toolName: "crisis-escalation",
        toolStatus: "completed",
        metadata: {
          matchedPhrases: detection.matchedPhrases,
          targetName: fullName,
          relationship,
          targetPhoneRedacted: redactPhoneNumber(phoneNumber),
          blandCallId: blandCall.callId,
          normalizedMessage: detection.normalizedMessage,
          recentActivityIncluded: Boolean(recentActivity),
        },
      });
      this.transcriptBus.publish("tool", completed);
      return {
        kind: "text",
        text:
          payload.source === "voice"
            ? "I'm contacting your family now. Stay with me."
            : "Crisis escalation triggered. Calling the primary family contact now.",
      };
    } catch (error) {
      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Tool crisis-escalation failed: ${error instanceof Error ? error.message : String(error)}`,
        toolName: "crisis-escalation",
        toolStatus: "failed",
        metadata: {
          matchedPhrases: detection.matchedPhrases,
          targetName: fullName,
          targetPhoneRedacted: redactPhoneNumber(phoneNumber),
          failureReason: error instanceof Error ? error.message : String(error),
        },
      });
      this.transcriptBus.publish("tool", failed);
      return {
        kind: "text",
        text: "I couldn't place the family call automatically. Please call for help right away.",
      };
    }
  }

  private ensureFamilyContactPrompt(): void {
    const pendingPrompt = this.database
      .listPrompts("pending")
      .find((prompt) => prompt.memoryKey === FAMILY_CONTACT_MEMORY_KEY);
    if (pendingPrompt) {
      return;
    }

    const prompt = this.database.createPrompt({
      title: "Primary family contact",
      description: "A crisis phrase was detected. Save the primary family contact so Gazabot can call them immediately.",
      memoryKey: FAMILY_CONTACT_MEMORY_KEY,
      memoryLabel: "Primary family contact",
      fields: FAMILY_CONTACT_PROMPT_FIELDS,
    });
    this.transcriptBus.publishPrompt(prompt);
  }

  private findRecentCrisisEscalation(normalizedMessage: string): Record<string, unknown> | null {
    const thresholdMs = this.config.crisis.callCooldownSeconds * 1000;
    const now = Date.now();
    const entries = this.database.listTranscriptEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      if (entry.kind !== "tool" || entry.toolName !== "crisis-escalation" || entry.toolStatus !== "completed") {
        continue;
      }
      const metadata = entry.metadata ?? {};
      if (metadata.manualTrigger === true) {
        continue;
      }
      if (metadata.normalizedMessage !== normalizedMessage) {
        continue;
      }
      const timestampMs = Date.parse(entry.timestamp);
      if (Number.isNaN(timestampMs) || now - timestampMs > thresholdMs) {
        continue;
      }
      return metadata;
    }
    return null;
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

    while (!this.claimInteraction("reminder")) {
      await Bun.sleep(50);
    }

    try {
      this.setInteractionPhase("reminder", "agent_thinking");
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
        this.setInteractionPhase("reminder", "agent_speaking");
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
    } finally {
      this.releaseInteraction("reminder");
    }
  }

  private async speakReplyText(text: string, source: "voice" | "reminder"): Promise<void> {
    const ttsStartedAt = Date.now();
    const audioOut = await this.ttsService.synthesize(text);
    console.log(
      `[${source === "voice" ? "conversation" : "reminder"}] TTS done          +${((Date.now() - ttsStartedAt) / 1000).toFixed(1)}s`,
    );
    await this.audioService.playAudio(audioOut);
  }
}

export function createApp(config: AppConfig, database = new GazabotDatabase(config.databasePath)): GazabotApp {
  return new GazabotApp(config, database);
}
