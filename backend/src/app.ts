import type { AppConfig } from "./config";
import type {
  AgentTurnRequest,
  AgentTurnResponse,
  ApiErrorPayload,
  BrowserContext,
  ReminderCreateInput,
  ReminderUpdateInput,
  TranscriptRole,
} from "./contracts";
import { AgentHarness, type AgentTurnResult } from "./agent";
import { BrowserUseService } from "./browser-use";
import { GazabotDatabase } from "./db";
import { ReminderScheduler } from "./reminder-scheduler";
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

function parseReminderCreateInput(payload: unknown): ReminderCreateInput {
  const record = asRecord(payload);
  const cadence = requireString(record, "cadence");
  if (cadence !== "daily" && cadence !== "weekly" && cadence !== "custom") {
    throw new Error("Invalid field: cadence");
  }

  return {
    title: requireString(record, "title"),
    instructions: requireString(record, "instructions"),
    cadence,
    cron: requireString(record, "cron"),
    scheduleLabel: requireString(record, "scheduleLabel"),
    timezone: requireString(record, "timezone"),
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

  private readonly unsubscribeReminderChanges: () => void;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
  ) {
    this.browserUseService = new BrowserUseService(config, database, this.transcriptBus);
    this.agentHarness = new AgentHarness(config, database, this.browserUseService, this.transcriptBus);
    this.reminderScheduler = new ReminderScheduler(
      config,
      database,
      ({ reminder, dueAt, prompt }) => this.executeReminderTurn(reminder, dueAt, prompt),
    );
    this.unsubscribeReminderChanges = this.database.subscribeReminderChanges(() => {
      this.reminderScheduler.refresh();
    });
    this.reminderScheduler.start();
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

      return errorResponse(request, this.config, 404, "Route not found.");
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "Invalid request." || error.message.startsWith("Invalid field:")) {
          return errorResponse(request, this.config, 422, "Invalid request.", error.message);
        }

        if (
          error.message === "Message is required." ||
          error.message === "Invalid cron expression." ||
          error.message.startsWith("Unknown timezone:")
        ) {
          return errorResponse(request, this.config, 400, error.message);
        }

        if (error.message.includes("INFERENCE_CLOUD_API_KEY is not configured")) {
          return errorResponse(request, this.config, 503, error.message);
        }

        if (error.message.startsWith("Imagine API error")) {
          return errorResponse(request, this.config, 502, error.message);
        }

        if (error.message === "Reminder not found.") {
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
}

export function createApp(config: AppConfig, database = new GazabotDatabase(config.databasePath)): GazabotApp {
  return new GazabotApp(config, database);
}
