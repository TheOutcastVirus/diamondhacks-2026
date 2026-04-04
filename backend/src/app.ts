import type { AppConfig } from "./config";
import type {
  AgentTurnRequest,
  AgentTurnResponse,
  ApiErrorPayload,
  BrowserContext,
  ReminderCreateInput,
  TranscriptRole,
} from "./contracts";
import { AgentHarness, type AgentTurnResult } from "./agent";
import { BrowserUseService } from "./browser-use";
import { GazabotDatabase } from "./db";
import { TranscriptEventBus } from "./transcript-bus";


function corsHeaders(request: Request, config: AppConfig): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && config.allowedOrigins.includes(origin) ? origin : config.allowedOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
  ) {
    this.browserUseService = new BrowserUseService(config, database, this.transcriptBus);
    this.agentHarness = new AgentHarness(config, database, this.browserUseService, this.transcriptBus);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, this.config),
      });
    }

    const url = new URL(request.url);

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

      if (request.method === "GET" && url.pathname === "/api/prompts") {
        return jsonResponse(request, this.config, { prompts: this.database.listPendingPrompts() });
      }

      if (request.method === "POST" && url.pathname.startsWith("/api/prompts/") && url.pathname.endsWith("/respond")) {
        const id = url.pathname.slice("/api/prompts/".length, -"/respond".length);
        return jsonResponse(request, this.config, await this.handlePromptRespond(request, id));
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
          error.message.startsWith("Prompt already ")
        ) {
          return errorResponse(request, this.config, 400, error.message);
        }
      }

      return errorResponse(request, this.config, 500, "Internal server error.");
    }
  }

  private async handleAgentTurn(request: Request): Promise<AgentTurnResponse> {
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

    const result: AgentTurnResult = await this.agentHarness.collectTurn(payload);

    if (result.kind === "browser_task") {
      return {
        route: "browser_task",
        browserSessionId: result.browserSessionId,
        previewUrl: result.previewUrl,
        status: "queued",
      };
    }

    const robotEntry = this.database.createTranscriptEntry({
      kind: "message",
      role: "robot",
      text: result.text,
    });
    this.transcriptBus.publish("transcript", robotEntry);

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

    const completed = this.database.respondToPrompt(promptId, response as Record<string, unknown>);

    const responseText = `User submitted form "${completed.title}": ${JSON.stringify(completed.response)}`;
    const responseEntry = this.database.createTranscriptEntry({
      kind: "tool",
      role: "resident",
      text: responseText,
      toolName: "user-prompt",
      toolStatus: "completed",
      metadata: { promptId: completed.id, response: completed.response },
    });
    this.transcriptBus.publish("tool", responseEntry);

    return { prompt: completed };
  }
}

export function createApp(config: AppConfig, database = new GazabotDatabase(config.databasePath)): GazabotApp {
  return new GazabotApp(config, database);
}
