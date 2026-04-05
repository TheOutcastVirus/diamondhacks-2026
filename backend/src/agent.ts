import { hasToolCall, stepCountIs, ToolLoopAgent, tool } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

import type { AppConfig } from "./config";
import type {
  AgentModel,
  AgentTurnRequest,
  PromptField,
  ReminderCadence,
  ReminderUpdateInput,
} from "./contracts";
import { DEFAULT_REMINDER_TIMEZONE, resolveReminderTimezone } from "./reminders";
import type { BrowserUseService } from "./browser-use";
import type { GazabotDatabase } from "./db";
import type { UploadedFileService } from "./files";
import type { TranscriptEventBus } from "./transcript-bus";

export type AgentTurnResult =
  | { kind: "text"; text: string }
  | { kind: "browser_task"; text: string; browserSessionId: string; previewUrl: string | null }
  | { kind: "end_conversation"; text: string };

type BrowserTaskInfo = {
  browserSessionId: string;
  previewUrl: string | null;
};

type FallbackToolCall = {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
};

type TurnRuntime = {
  spokenPhrases: string[];
  browserTask?: BrowserTaskInfo;
  pauseRequested: boolean;
  promptSent: boolean;
  endConversation: boolean;
};

const EMPTY_OBJECT_SCHEMA = z.object({});

const SPEAK_SCHEMA = z.object({
  message: z.string().min(1).describe("Exactly what Gazabot should say to the user right now."),
});

const PAUSE_SCHEMA = z.object({
  reason: z
    .enum(["background_task", "waiting_for_user_input", "waiting_for_external_output", "other"])
    .describe("Why this turn should pause now."),
});

const LIST_REMINDERS_SCHEMA = EMPTY_OBJECT_SCHEMA;

const CREATE_REMINDER_SCHEMA = z.object({
  title: z.string().min(1).describe("Short title for the reminder."),
  instructions: z.string().min(1).describe("What Gazabot should say or do when the reminder fires."),
  cron: z.string().min(1).describe("5-field cron expression."),
  cadence: z.enum(["daily", "weekly", "custom"]).describe("Recurrence type."),
  scheduleLabel: z.string().min(1).describe("Human-readable schedule description."),
  timezone: z.string().optional().describe("Optional IANA timezone name."),
  attachmentFileIds: z.array(z.string()).optional().describe("Optional uploaded file ids to associate."),
});

const UPDATE_REMINDER_SCHEMA = z.object({
  id: z.string().optional().describe("Reminder id to update."),
  reminderId: z.string().optional().describe("Reminder id to update."),
  reminder_id: z.string().optional().describe("Reminder id to update."),
  reminderTitle: z.string().optional().describe("Current reminder title when the id is unknown."),
  currentTitle: z.string().optional().describe("Current reminder title when the id is unknown."),
  existingTitle: z.string().optional().describe("Current reminder title when the id is unknown."),
  reminder_name: z.string().optional().describe("Current reminder title when the id is unknown."),
  title: z.string().optional().describe("Updated title."),
  instructions: z.string().optional().describe("Updated instructions."),
  cron: z.string().optional().describe("Updated cron expression."),
  cadence: z.enum(["daily", "weekly", "custom"]).optional().describe("Updated recurrence type."),
  scheduleLabel: z.string().optional().describe("Updated schedule label."),
  timezone: z.string().optional().describe("Updated IANA timezone."),
  status: z.enum(["active", "paused", "draft"]).optional().describe("Updated reminder status."),
  attachmentFileIds: z.array(z.string()).optional().describe("Replacement uploaded file ids."),
});

const DELETE_REMINDER_SCHEMA = z.object({
  id: z.string().optional().describe("Reminder id to delete."),
  reminderId: z.string().optional().describe("Reminder id to delete."),
  reminder_id: z.string().optional().describe("Reminder id to delete."),
  title: z.string().optional().describe("Reminder title if the id is not known."),
  reminderTitle: z.string().optional().describe("Reminder title if the id is not known."),
  name: z.string().optional().describe("Reminder title if the id is not known."),
  reminder_name: z.string().optional().describe("Reminder title if the id is not known."),
});

const GET_BROWSER_STATE_SCHEMA = EMPTY_OBJECT_SCHEMA;

const RUN_BROWSER_TASK_SCHEMA = z.object({
  task: z.string().min(1).describe("Natural-language task for Browser Use."),
});

const LIST_UPLOADED_FILES_SCHEMA = EMPTY_OBJECT_SCHEMA;

const READ_UPLOADED_FILE_SCHEMA = z.object({
  id: z.string().min(1).describe("Uploaded file id."),
});

const EXTRACT_PDF_TEXT_SCHEMA = z.object({
  id: z.string().min(1).describe("Uploaded file id."),
});

const READ_MEMORY_SCHEMA = z.object({
  title: z.string().min(1).describe("Stored memory key or title."),
});

const WRITE_MEMORY_SCHEMA = z.object({
  title: z.string().min(1).describe("Short descriptive memory key."),
  content: z.string().optional().describe("Plain-text memory content."),
  content_json: z.string().optional().describe("Optional JSON object string for structured memory."),
  data: z.string().optional().describe("Optional JSON object string for structured memory."),
  fields_json: z.string().optional().describe("Optional JSON array schema string for structured memory."),
  fields: z.string().optional().describe("Optional JSON array schema string for structured memory."),
});

const END_CONVERSATION_SCHEMA = EMPTY_OBJECT_SCHEMA;

const REQUEST_USER_INPUT_SCHEMA = z.object({
  title: z.string().min(1).describe("Form title shown to the user."),
  description: z.string().optional().describe("Explain why the information is needed."),
  memory_key: z.string().optional().describe("Structured memory key where the response should be stored."),
  memory_label: z.string().optional().describe("Human-friendly label for the saved memory."),
  fields_json: z.string().min(2).describe("JSON array string defining the prompt fields."),
  fields: z.string().optional().describe("Optional JSON array string defining the prompt fields."),
});

function safeParseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function safeParseJsonArray(raw: unknown): unknown[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function unwrapJsonEncodedText(content: string): string {
  let current = content.trim().replace(/<\|eom_id\|>.*$/s, "").trim();

  for (let iteration = 0; iteration < 2; iteration += 1) {
    if (!(current.startsWith('"') && current.endsWith('"'))) {
      break;
    }

    try {
      const parsed = JSON.parse(current) as unknown;
      if (typeof parsed !== "string") {
        break;
      }
      current = parsed.trim();
    } catch {
      break;
    }
  }

  return current;
}

function extractJsonObjects(content: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseFallbackToolCallObject(rawObject: string): FallbackToolCall | null {
  try {
    const parsed = JSON.parse(rawObject) as Record<string, unknown>;
    const name =
      typeof parsed.name === "string"
        ? parsed.name
        : typeof parsed.function === "string"
          ? parsed.function
          : null;
    if (!name) {
      return null;
    }

    const inputSource = parsed.parameters ?? parsed.arguments ?? parsed.args ?? {};
    const input =
      typeof inputSource === "object" && inputSource !== null && !Array.isArray(inputSource)
        ? (inputSource as Record<string, unknown>)
        : safeParseJsonObject(inputSource) ?? {};

    return {
      toolCallId: `text-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      input,
    };
  } catch {
    return null;
  }
}

function parseTextToolCalls(content: string): FallbackToolCall[] {
  const normalized = unwrapJsonEncodedText(content);
  const rawObjects = extractJsonObjects(normalized);
  return rawObjects.map(parseFallbackToolCallObject).filter((toolCall) => toolCall !== null);
}

function normalizeFallbackToolResult(toolResult: unknown): Record<string, unknown> {
  if (typeof toolResult === "object" && toolResult !== null && !Array.isArray(toolResult)) {
    return toolResult as Record<string, unknown>;
  }

  return {
    result: toolResult ?? null,
  };
}

export class AgentHarness {
  private readonly cerebrasProvider;

  private readonly googleProvider;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly browserUseService: BrowserUseService,
    private readonly uploadedFileService: UploadedFileService,
    private readonly transcriptBus: TranscriptEventBus,
  ) {
    this.cerebrasProvider = createOpenAICompatible({
      name: "cerebras",
      baseURL: this.config.cerebras.endpoint,
      ...(this.config.cerebras.apiKey ? { apiKey: this.config.cerebras.apiKey } : {}),
    });
    this.googleProvider = createGoogleGenerativeAI({
      baseURL: this.config.googleAi.baseUrl,
      ...(this.config.googleAi.apiKey ? { apiKey: this.config.googleAi.apiKey } : {}),
    });
  }

  private resolveRequestedModel(request: AgentTurnRequest): AgentModel {
    return request.model ?? "cerebras";
  }

  private selectLanguageModel(request: AgentTurnRequest): LanguageModelV3 {
    const selectedModel = this.resolveRequestedModel(request);

    if (selectedModel === "gemini-fast") {
      if (!this.config.googleAi.apiKey?.trim()) {
        throw new Error("GOOGLE_AI_API_KEY is not configured. Set it in backend/.env.");
      }
      return this.googleProvider(this.config.googleAi.agentModel);
    }

    if (!this.config.cerebras.apiKey.trim()) {
      throw new Error("CEREBRAS_API_KEY is not configured. Set it in backend/.env.");
    }
    return this.cerebrasProvider(this.config.cerebras.model);
  }

  private buildInstructions(request: AgentTurnRequest): string {
    const reminders = this.database.listReminders();
    const memoryTitles = this.database.listMemoryTitles();
    const uploadedFiles = this.database.listUploadedFiles();

    const memoryIndex =
      memoryTitles.length === 0
        ? "No stored memory."
        : memoryTitles.map((title) => `- ${title}`).join("\n");

    const reminderSummary =
      reminders.length === 0
        ? "No reminders."
        : reminders
            .map((reminder) => {
              const timezone = reminder.timezone ?? DEFAULT_REMINDER_TIMEZONE;
              const nextRun = reminder.nextRun ?? "none";
              return `- id=${reminder.id} | title=${reminder.title} | status=${reminder.status} | schedule=${reminder.scheduleLabel} | timezone=${timezone} | next_run=${nextRun}`;
            })
            .join("\n");

    const uploadedFileSummary =
      uploadedFiles.length === 0
        ? "No uploaded files."
        : uploadedFiles
            .map((file) => `- ${file.id}: ${file.name} [${file.mimeType}, text=${file.textStatus}]`)
            .join("\n");

    const interactionStyle =
      request.source === "voice"
        ? "Turn type: voice."
        : "Turn type: dashboard.";

    const browserState = request.forceBrowser
      ? "Browser request: the user explicitly requested browser automation for this turn."
      : "Browser request: decide based on the task.";

    return [
      "You are Gazabot, a concise household assistant for reminders, memory, uploaded files, forms, and browser tasks.",
      interactionStyle,
      browserState,
      `Default reminder timezone: ${DEFAULT_REMINDER_TIMEZONE}.`,
      `Current date and time: ${new Date().toLocaleString("en-US", {
        timeZone: DEFAULT_REMINDER_TIMEZONE,
        dateStyle: "full",
        timeStyle: "long",
      })}`,
      `Memory topics:\n${memoryIndex}`,
      `Active reminders:\n${reminderSummary}`,
      `Uploaded files:\n${uploadedFileSummary}`,
    ].join("\n\n");
  }

  private buildMessages(request: AgentTurnRequest): ModelMessage[] {
    const allEntries = this.database.listTranscriptEntries();
    const history = allEntries.slice(-this.config.cerebras.maxHistoryEntries);
    const messages: ModelMessage[] = [];

    for (const entry of history) {
      if (entry.kind !== "message") {
        continue;
      }

      if (entry.role === "robot") {
        messages.push({ role: "assistant", content: entry.text });
        continue;
      }

      messages.push({ role: "user", content: entry.text });
    }

    messages.push({ role: "user", content: request.message });
    return messages;
  }

  private appendFallbackToolMessages(
    messages: ModelMessage[],
    toolCall: FallbackToolCall,
    toolResult: unknown,
  ): void {
    const normalizedToolResult = normalizeFallbackToolResult(toolResult);
    const assistantToolCallMessage = {
      role: "assistant",
      content: JSON.stringify({
        type: "function",
        name: toolCall.name,
        parameters: toolCall.input,
      }),
    } as ModelMessage;
    const toolResultMessage = {
      role: "user",
      content: `Tool ${toolCall.name} result: ${JSON.stringify(normalizedToolResult)}`,
    } as ModelMessage;

    messages.push(assistantToolCallMessage);
    messages.push(toolResultMessage);
  }

  private resolveReminderId(
    args: Record<string, unknown>,
    options: { titleKeys?: string[] } = {},
  ): string {
    const findUniqueTitleMatch = (value: string): string | null => {
      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        return null;
      }

      const matches = this.database
        .listReminders()
        .filter((reminder) => reminder.title.trim().toLowerCase() === normalized);

      if (matches.length === 1) {
        return matches[0]!.id;
      }

      if (matches.length > 1) {
        throw new Error(`Multiple reminders match "${value}". Use the exact reminder id.`);
      }

      return null;
    };

    for (const candidate of [args.id, args.reminderId, args.reminder_id]) {
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }

      const identifier = candidate.trim();
      const reminder = this.database.getReminderById(identifier);
      if (reminder) {
        return reminder.id;
      }

      const matchedByTitle = findUniqueTitleMatch(identifier);
      if (matchedByTitle) {
        return matchedByTitle;
      }

      throw new Error(`Reminder not found for identifier "${identifier}".`);
    }

    for (const key of options.titleKeys ?? []) {
      const candidate = args[key];
      if (typeof candidate !== "string" || !candidate.trim()) {
        continue;
      }

      const matchedByTitle = findUniqueTitleMatch(candidate);
      if (matchedByTitle) {
        return matchedByTitle;
      }

      throw new Error(`Reminder not found for title "${candidate.trim()}".`);
    }

    throw new Error("Reminder id is required. Call list_reminders first if you are not certain which reminder to modify.");
  }

  private async executeToolByName(
    name: string,
    args: Record<string, unknown>,
    runtime: TurnRuntime,
    profileId?: string,
  ): Promise<unknown> {
    const startEntry = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: `Calling tool: ${name}`,
      toolName: name,
      toolStatus: "started",
      metadata: { params: args },
    });
    this.transcriptBus.publish("tool", startEntry);

    try {
      let result: unknown;

      switch (name) {
        case "speak": {
          const message = String(args.message ?? "").trim();
          if (message) {
            runtime.spokenPhrases.push(message);
          }
          result = { spoken: Boolean(message) };
          break;
        }

        case "pause_until_output": {
          runtime.pauseRequested = true;
          result = { paused: true, reason: String(args.reason ?? "other") };
          break;
        }

        case "list_reminders": {
          result = this.database.listReminders();
          break;
        }

        case "create_reminder": {
          const attachmentFileIds = Array.isArray(args.attachmentFileIds)
            ? args.attachmentFileIds.map((value) => String(value))
            : undefined;
          result = this.database.createReminder({
            title: String(args.title ?? ""),
            instructions: String(args.instructions ?? ""),
            cron: String(args.cron ?? ""),
            cadence: (args.cadence as ReminderCadence) ?? "custom",
            scheduleLabel: String(args.scheduleLabel ?? ""),
            timezone: resolveReminderTimezone(args.timezone),
            ...(attachmentFileIds !== undefined && { attachmentFileIds }),
          });
          break;
        }

        case "update_reminder": {
          const reminderId = this.resolveReminderId(args, {
            titleKeys: ["reminderTitle", "currentTitle", "existingTitle", "reminder_name"],
          });
          const update: Record<string, unknown> = {};
          if (typeof args.title === "string") {
            update.title = args.title;
          }
          if (typeof args.instructions === "string") {
            update.instructions = args.instructions;
          }
          if (typeof args.cron === "string") {
            update.cron = args.cron;
          }
          if (args.cadence === "daily" || args.cadence === "weekly" || args.cadence === "custom") {
            update.cadence = args.cadence;
          }
          if (typeof args.scheduleLabel === "string") {
            update.scheduleLabel = args.scheduleLabel;
          }
          if (typeof args.timezone === "string") {
            update.timezone = args.timezone;
          }
          if (args.status === "active" || args.status === "paused" || args.status === "draft") {
            update.status = args.status;
          }
          if (Array.isArray(args.attachmentFileIds)) {
            update.attachmentFileIds = args.attachmentFileIds.map((value) => String(value));
          }

          result = this.database.updateReminder(reminderId, update as ReminderUpdateInput);
          break;
        }

        case "delete_reminder": {
          const reminderId = this.resolveReminderId(args, {
            titleKeys: ["title", "reminderTitle", "name", "reminder_name"],
          });
          const deleted = this.database.deleteReminder(reminderId);
          if (!deleted) {
            throw new Error(`Reminder not found for id "${reminderId}".`);
          }
          result = { deleted: true, id: reminderId };
          break;
        }

        case "get_browser_state": {
          result = this.database.getCurrentBrowserContext();
          break;
        }

        case "run_browser_task": {
          const task = String(args.task ?? "");
          const session = this.database.beginBrowserTask(task, profileId);
          const queuedEntry = this.database.createTranscriptEntry({
            kind: "tool",
            role: "system",
            text: `Queued browser task: ${task}`,
            toolName: "browser-use",
            toolStatus: "started",
            metadata: { browserSessionId: session.id },
          });
          this.transcriptBus.publish("tool", queuedEntry);

          const taskRequest: { browserSessionId: string; task: string; profileId?: string } = {
            browserSessionId: session.id,
            task,
          };
          if (profileId) {
            taskRequest.profileId = profileId;
          }
          void this.browserUseService.runBrowserTask(taskRequest);

          runtime.browserTask = { browserSessionId: session.id, previewUrl: session.previewUrl };
          result = { queued: true, ...runtime.browserTask };
          break;
        }

        case "list_uploaded_files": {
          result = this.database.listUploadedFiles();
          break;
        }

        case "read_uploaded_file": {
          const fileId = String(args.id ?? "");
          const file = this.database.getUploadedFile(fileId);
          if (!file) {
            result = { error: "Uploaded file not found" };
            break;
          }
          const extracted = file.textStatus === "ready" ? file : await this.uploadedFileService.extractTextIfPossible(fileId);
          result = {
            id: extracted.id,
            name: extracted.name,
            originalName: extracted.originalName,
            mimeType: extracted.mimeType,
            sizeBytes: extracted.sizeBytes,
            textStatus: extracted.textStatus,
            promptId: extracted.promptId,
            promptFieldName: extracted.promptFieldName,
            reminderId: extracted.reminderId,
            contentText: extracted.extractedText ?? "",
          };
          break;
        }

        case "extract_pdf_text": {
          const fileId = String(args.id ?? "");
          const file = this.database.getUploadedFile(fileId);
          result = file ?? { error: "Uploaded file not found" };
          if (file) {
            result = await this.uploadedFileService.extractTextIfPossible(fileId);
          }
          break;
        }

        case "read_memory": {
          result = this.database.readMemory(String(args.title ?? "")) ?? { error: "Memory entry not found" };
          break;
        }

        case "write_memory": {
          const data = safeParseJsonObject(args.content_json ?? args.data);
          const fields = safeParseJsonArray(args.fields_json ?? args.fields) as PromptField[] | undefined;
          const content =
            typeof args.content === "string"
              ? args.content
              : data
                ? JSON.stringify(data, null, 2)
                : "";

          result = this.database.writeMemory(String(args.title ?? ""), content, {
            ...(fields !== undefined && { schema: fields }),
            ...(data !== undefined && { data }),
          });
          break;
        }

        case "end_conversation": {
          runtime.endConversation = true;
          result = { ended: true };
          break;
        }

        case "request_user_input": {
          const fields = (safeParseJsonArray(args.fields_json ?? args.fields) ?? []) as PromptField[];
          const promptInput: {
            title: string;
            fields: PromptField[];
            description?: string;
            memoryKey?: string;
            memoryLabel?: string;
          } = {
            title: String(args.title ?? ""),
            fields,
          };
          if (args.description) {
            promptInput.description = String(args.description);
          }
          if (typeof args.memory_key === "string") {
            promptInput.memoryKey = args.memory_key;
          }
          if (typeof args.memory_label === "string") {
            promptInput.memoryLabel = args.memory_label;
          }

          const prompt = this.database.createPrompt(promptInput);
          this.transcriptBus.publishPrompt(prompt);
          runtime.promptSent = true;
          result = { promptId: prompt.id, status: "pending", message: "Form sent to user." };
          break;
        }

        default: {
          result = { error: `Unknown tool: ${name}` };
          break;
        }
      }

      const doneEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Tool ${name} completed`,
        toolName: name,
        toolStatus: "completed",
        metadata: { result },
      });
      this.transcriptBus.publish("tool", doneEntry);

      return result;
    } catch (error) {
      const failEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        toolName: name,
        toolStatus: "failed",
        metadata: {
          params: args,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.transcriptBus.publish("tool", failEntry);
      return { error: String(error) };
    }
  }

  private buildTurnAgent(request: AgentTurnRequest, runtime: TurnRuntime) {
    const model = this.selectLanguageModel(request);

    return new ToolLoopAgent({
      model,
      instructions: this.buildInstructions(request),
      stopWhen: [hasToolCall("pause_until_output"), hasToolCall("end_conversation"), stepCountIs(12)],
      tools: {
        speak: tool({
          description:
            "Say something to the user. Use this for any user-visible response in this turn instead of replying directly.",
          inputSchema: SPEAK_SCHEMA,
          execute: async (input) => this.executeToolByName("speak", input, runtime, request.profileId),
        }),
        pause_until_output: tool({
          description:
            "Pause this turn after you have already spoken. Use when background work continues elsewhere or when waiting for user-provided information.",
          inputSchema: PAUSE_SCHEMA,
          execute: async (input) => this.executeToolByName("pause_until_output", input, runtime, request.profileId),
        }),
        list_reminders: tool({
          description: "Get all scheduled reminders for the household.",
          inputSchema: LIST_REMINDERS_SCHEMA,
          execute: async (input) => this.executeToolByName("list_reminders", input, runtime, request.profileId),
        }),
        create_reminder: tool({
          description: "Create a new scheduled reminder.",
          inputSchema: CREATE_REMINDER_SCHEMA,
          execute: async (input) => this.executeToolByName("create_reminder", input, runtime, request.profileId),
        }),
        update_reminder: tool({
          description: "Update an existing reminder by id or by an exact unique current title.",
          inputSchema: UPDATE_REMINDER_SCHEMA,
          execute: async (input) => this.executeToolByName("update_reminder", input, runtime, request.profileId),
        }),
        delete_reminder: tool({
          description: "Delete an existing reminder by id or by an exact unique current title.",
          inputSchema: DELETE_REMINDER_SCHEMA,
          execute: async (input) => this.executeToolByName("delete_reminder", input, runtime, request.profileId),
        }),
        get_browser_state: tool({
          description: "Get the current browser automation state and recent actions.",
          inputSchema: GET_BROWSER_STATE_SCHEMA,
          execute: async (input) => this.executeToolByName("get_browser_state", input, runtime, request.profileId),
        }),
        run_browser_task: tool({
          description:
            "Dispatch a browser automation task for browsing, ordering, booking, searching, or interacting with websites.",
          inputSchema: RUN_BROWSER_TASK_SCHEMA,
          execute: async (input) => this.executeToolByName("run_browser_task", input, runtime, request.profileId),
        }),
        list_uploaded_files: tool({
          description: "List all uploaded files available to the household.",
          inputSchema: LIST_UPLOADED_FILES_SCHEMA,
          execute: async (input) => this.executeToolByName("list_uploaded_files", input, runtime, request.profileId),
        }),
        read_uploaded_file: tool({
          description: "Read an uploaded file by id and return its extracted text clone when available.",
          inputSchema: READ_UPLOADED_FILE_SCHEMA,
          execute: async (input) => this.executeToolByName("read_uploaded_file", input, runtime, request.profileId),
        }),
        extract_pdf_text: tool({
          description: "Force text extraction for an uploaded file by id.",
          inputSchema: EXTRACT_PDF_TEXT_SCHEMA,
          execute: async (input) => this.executeToolByName("extract_pdf_text", input, runtime, request.profileId),
        }),
        read_memory: tool({
          description: "Read a stored memory entry by title.",
          inputSchema: READ_MEMORY_SCHEMA,
          execute: async (input) => this.executeToolByName("read_memory", input, runtime, request.profileId),
        }),
        write_memory: tool({
          description: "Store or update a memory entry about the user or household.",
          inputSchema: WRITE_MEMORY_SCHEMA,
          execute: async (input) => this.executeToolByName("write_memory", input, runtime, request.profileId),
        }),
        end_conversation: tool({
          description: "End the current conversation after you have already spoken a brief farewell.",
          inputSchema: END_CONVERSATION_SCHEMA,
          execute: async (input) => this.executeToolByName("end_conversation", input, runtime, request.profileId),
        }),
        request_user_input: tool({
          description:
            "Send a structured form to the user to collect required information. Prefer discrete fields over free-form text.",
          inputSchema: REQUEST_USER_INPUT_SCHEMA,
          execute: async (input) => this.executeToolByName("request_user_input", input, runtime, request.profileId),
        }),
      },
    });
  }

  async collectTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.forceBrowser) {
      const runtime: TurnRuntime = {
        spokenPhrases: ["Okay. I'll handle that now."],
        pauseRequested: true,
        promptSent: false,
        endConversation: false,
      };
      await this.executeToolByName("run_browser_task", { task: request.message }, runtime, request.profileId);

      if (runtime.browserTask) {
        return { kind: "browser_task", text: runtime.spokenPhrases[0]!, ...runtime.browserTask };
      }

      return {
        kind: "text",
        text: "I couldn't start that browser task yet.",
      };
    }

    const runtime: TurnRuntime = {
      spokenPhrases: [],
      pauseRequested: false,
      promptSent: false,
      endConversation: false,
    };
    const messages = this.buildMessages(request);

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const agent = this.buildTurnAgent(request, runtime);
      const result = await agent.generate({
        messages,
      });

      const spokenText = runtime.spokenPhrases.join(" ").trim();
      const fallbackText = result.text.trim();

      if (!spokenText && !runtime.browserTask && !runtime.endConversation && !runtime.promptSent) {
        const fallbackToolCalls = parseTextToolCalls(fallbackText);
        if (fallbackToolCalls.length > 0) {
          for (const fallbackToolCall of fallbackToolCalls) {
            const toolResult = await this.executeToolByName(
              fallbackToolCall.name,
              fallbackToolCall.input,
              runtime,
              request.profileId,
            );
            this.appendFallbackToolMessages(messages, fallbackToolCall, toolResult);
          }

          if (runtime.endConversation) {
            return {
              kind: "end_conversation",
              text: runtime.spokenPhrases.join(" ").trim() || "Goodbye for now.",
            };
          }

          const browserTask = runtime.browserTask as BrowserTaskInfo | undefined;
          if (browserTask) {
            return {
              kind: "browser_task",
              text: runtime.spokenPhrases.join(" ").trim() || "Okay. I'll handle that now.",
              browserSessionId: browserTask.browserSessionId,
              previewUrl: browserTask.previewUrl,
            };
          }

          if (runtime.promptSent || runtime.pauseRequested) {
            return {
              kind: "text",
              text:
                runtime.spokenPhrases.join(" ").trim() ||
                (runtime.promptSent
                  ? "I've sent you a form to fill out. Please check the Requested Info panel."
                  : "Okay."),
            };
          }

          continue;
        }
      }

      if (runtime.endConversation) {
        return {
          kind: "end_conversation",
          text: spokenText || fallbackText || "Goodbye for now.",
        };
      }

      const replyText =
        spokenText ||
        fallbackText ||
        (runtime.promptSent
          ? "I've sent you a form to fill out. Please check the Requested Info panel."
          : "I'm sorry, I couldn't complete that request.");

      if (runtime.browserTask) {
        return { kind: "browser_task", text: replyText, ...runtime.browserTask };
      }

      return { kind: "text", text: replyText };
    }

    if (runtime.endConversation) {
      return { kind: "end_conversation", text: runtime.spokenPhrases.join(" ").trim() || "Goodbye for now." };
    }
    if (runtime.browserTask) {
      return {
        kind: "browser_task",
        text: runtime.spokenPhrases.join(" ").trim() || "Okay. I'll handle that now.",
        ...runtime.browserTask,
      };
    }
    return {
      kind: "text",
      text:
        runtime.spokenPhrases.join(" ").trim() ||
        (runtime.promptSent
          ? "I've sent you a form to fill out. Please check the Requested Info panel."
          : "I'm sorry, I couldn't complete that request."),
    };
  }

  streamTurn(request: AgentTurnRequest): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          try {
            const result = await this.collectTurn(request);
            if (result.text) {
              controller.enqueue(result.text);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        })();
      },
    });
  }
}
