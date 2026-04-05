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
import { buildRecentActivitySnapshot } from "./activity";

export type AgentTurnResult =
  | { kind: "text"; text: string }
  | { kind: "browser_task"; text: string; browserSessionId: string; previewUrl: string | null }
  | { kind: "end_conversation"; text: string };

type BrowserTaskInfo = {
  browserSessionId: string;
  previewUrl: string | null;
};
/*
const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_recent_activity",
      description:
        "Summarize recent activity across the household, including transcript messages, tool calls, and browser automation history. Use when the user asks what happened recently or wants a recap.",
      parameters: {
        type: "object",
        properties: {
          lookback_minutes: {
            type: "number",
            description: "How far back to look, in minutes. Defaults to 240 (4 hours).",
          },
          limit: {
            type: "number",
            description: "Maximum number of activity items to return. Defaults to 30.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "Get all scheduled reminders for the household.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a new scheduled reminder.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the reminder" },
          instructions: { type: "string", description: "What to do or say when the reminder fires" },
          cron: { type: "string", description: "5-field cron expression (e.g. '0 9 * * *' for 9am daily)" },
          cadence: { type: "string", enum: ["daily", "weekly", "custom"], description: "Recurrence type" },
          scheduleLabel: { type: "string", description: "Human-readable schedule description (e.g. 'Every day at 9am')" },
          timezone: {
            type: "string",
            description: `Optional IANA timezone name (e.g. 'America/New_York'). Defaults to ${DEFAULT_REMINDER_TIMEZONE}.`,
          },
          attachmentFileIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional uploaded file ids to associate with the reminder.",
          },
        },
        required: ["title", "instructions", "cron", "cadence", "scheduleLabel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_reminder",
      description:
        "Update an existing reminder. Use to pause, resume, rename, edit the schedule, change the timezone, or change reminder instructions.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reminder id to update" },
          title: { type: "string", description: "Updated reminder title" },
          instructions: { type: "string", description: "Updated reminder instructions" },
          cron: { type: "string", description: "Updated 5-field cron expression" },
          cadence: { type: "string", enum: ["daily", "weekly", "custom"], description: "Updated recurrence type" },
          scheduleLabel: { type: "string", description: "Updated human-readable schedule description" },
          timezone: { type: "string", description: "Updated IANA timezone name" },
          status: { type: "string", enum: ["active", "paused", "draft"], description: "Reminder status" },
          attachmentFileIds: {
            type: "array",
            items: { type: "string" },
            description: "Replace the reminder's attached uploaded files with these file ids.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_reminder",
      description: "Delete an existing reminder by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reminder id to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_browser_state",
      description: "Get the current browser automation state and recent actions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_browser_task",
      description:
        "Dispatch a browser automation task. Use for web searches, ordering food (DoorDash, Uber Eats, Grubhub), pharmacy orders (CVS — OTC items and prescription refills), booking, checking websites, or any task requiring internet browsing. Always dispatch the task immediately — the browser agent will automatically pause and ask the user for payment or delivery details if needed during checkout.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Natural-language description of what to do. Examples: 'Order a large pepperoni pizza from Dominos on DoorDash', 'Get Tylenol from CVS', 'Refill prescription rx:RX1234567 from CVS', 'Search for the best sushi near me on Uber Eats'.",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_uploaded_files",
      description:
        "List all uploaded files available to the household, including filenames, types, reminder links, and whether text extraction succeeded.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_uploaded_file",
      description:
        "Read an uploaded file by id. Returns filename, file metadata, and the extracted plain-text clone when available so a text-only model can use the file contents.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Uploaded file id to inspect" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_pdf_text",
      description:
        "Force text extraction for an uploaded file by id, especially PDFs, screenshots, photos, and other documents where visible text matters. Use when you need OCR-style contents for a task.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Uploaded file id to extract text from" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description:
        "Fetch the full content of a stored memory entry by its title. Some entries are plain text and some are structured JSON-backed records, but they are all accessed through this same tool.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The memory title to retrieve" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_memory",
      description:
        "Store or update a memory entry about the user or household. Use a short descriptive title (e.g. 'user_name', 'health_notes', 'dietary_restrictions', 'communication_preferences'). For normal notes, write plain text in content. For machine-editable memory, provide content_json with a JSON object string and optionally fields_json describing the schema.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short descriptive key for this memory" },
          content: { type: "string", description: "Full details to store" },
          content_json: {
            type: "string",
            description:
              'Optional JSON object string for machine-editable memory, e.g. {"preferred_name":"Pat","allergies":["peanuts"]}',
          },
          fields_json: {
            type: "string",
            description:
              'Optional JSON array string describing the schema when content_json is used. Same field format as request_user_input.',
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "present_options",
      description:
        'Present a numbered list of options to the user and wait for their choice. Use when the user needs to pick from multiple products, restaurants, search results, or any list of choices. The options appear as a selectable list on the frontend AND are spoken aloud for voice users. The user can respond by voice (saying the number or name) or by tapping on screen. After the user picks, the selection is saved to memory under the given memory_key.',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title shown to the user, e.g. 'Which chips would you like?'" },
          description: { type: "string", description: "Optional context about the options" },
          options_json: {
            type: "string",
            description:
              'JSON array of option objects. Each: {"label":"Display name","value":"unique_id","detail":"optional price or description"}. Example: [{"label":"Lay\'s Classic","value":"lays_classic","detail":"$3.49"},{"label":"Doritos Nacho","value":"doritos_nacho","detail":"$4.29"}]',
          },
          memory_key: {
            type: "string",
            description: "Memory key to store the selection under, e.g. 'pending_shop_choice'",
          },
        },
        required: ["title", "options_json"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_conversation",
      description:
        "End the current voice conversation and return to idle listening mode. Call this when the user clearly wants to stop (e.g. says 'no', 'stop', 'goodbye', 'that's all', 'I'm done', or declines an offer to continue). Do not call this speculatively — only when the user has clearly signalled they are finished.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "request_user_input",
      description:
        'Send a structured JSON-defined form to the user to collect information you need. Use when you require data the user must provide (e.g. payment details, address, medical background, preferences, household details, uploaded documents). Prefer discrete fields over one large textbox. For credit cards include cardholder_name, card_number, expiry_month, expiry_year, security_code, and billing address fields unless the site clearly needs less. For addresses include full_name, line_1, line_2, city, state_or_region, postal_code, country, phone_number, and delivery_instructions when relevant. For uploads use type "file" and optionally accept/multiple. The form appears on the frontend and the response is stored as structured memory. fields_json must be a valid JSON array string.',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Form title shown to the user" },
          description: { type: "string", description: "Explanation of why this information is needed" },
          memory_key: {
            type: "string",
            description:
              "Stable structured memory key where the response should be stored, e.g. 'medical_profile' or 'shopping_preferences'",
          },
          memory_label: {
            type: "string",
            description: "Human-friendly label for the saved memory record",
          },
          fields_json: {
            type: "string",
            description:
              'JSON array of field objects. Each object: {"name":"snake_case_key","label":"Display Label","type":"string|text|int|float|boolean|password|date|select|file","required":true|false}. File fields may also include accept and multiple.',
          },
        },
        required: ["title", "fields_json"],
      },
    },
  },
] as const;
*/

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
  /** When present_options ran without speak, use this for voice TTS. */
  optionsSpokenList?: string;
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

const LIST_RECENT_ACTIVITY_SCHEMA = z.object({
  lookback_minutes: z.number().int().positive().optional().describe("How far back to look, in minutes."),
  limit: z.number().int().positive().optional().describe("Maximum number of activity items to return."),
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

const PRESENT_OPTIONS_SCHEMA = z.object({
  title: z.string().min(1).describe("Title shown to the user, e.g. Which item would you like?"),
  description: z.string().optional().describe("Optional context about the options."),
  options_json: z
    .string()
    .min(2)
    .describe('JSON array of {label, value, detail?} for each selectable option.'),
  memory_key: z
    .string()
    .optional()
    .describe("Memory key for the pending choice; defaults to pending_shop_choice."),
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

    const interactionStyle = request.source === "voice" ? "Turn type: voice." : "Turn type: dashboard.";

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
      "Choices: When the user must pick from multiple search or shopping results, call present_options with options_json (array of objects with label, value, and optional detail). Wait for their reply; read_memory on the memory_key you used to resolve voice or form picks before run_browser_task.",
      "Ordering: Food — DoorDash, Uber Eats, Grubhub (name the platform in the task). Pharmacy — CVS.com for OTC and Rx refills; include rx:RX1234567 style ids when refilling. Before checkout, ensure payment_card and delivery_address exist in memory or collect via request_user_input.",
      "The browser sub-agent does not see this chat. Pass every fact it needs inside the run_browser_task string or via memory it can rely on.",
      "Use speak for user-visible replies in this turn. Plain text only — no markdown. Stay concise.",
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
        case "list_recent_activity": {
          const lookbackMinutes =
            typeof args.lookback_minutes === "number"
              ? args.lookback_minutes
              : typeof args.lookbackMinutes === "number"
                ? args.lookbackMinutes
                : 240;
          const limit =
            typeof args.limit === "number" ? args.limit : typeof args.maxItems === "number" ? args.maxItems : 30;
          result = buildRecentActivitySnapshot(this.database, { lookbackMinutes, limit });
          break;
        }

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
          const memoryTitle = String(args.title ?? "");
          result = this.database.writeMemory(memoryTitle, content, {
            ...(fields !== undefined && { schema: fields }),
            ...(data !== undefined && { data }),
          });

          // Auto-cancel any pending prompt for this memory key (e.g. voice user
          // picked an option that was also shown as a form on the frontend)
          const pendingPrompt = this.database.findPendingPromptByMemoryKey(memoryTitle);
          if (pendingPrompt) {
            this.database.cancelPrompt(pendingPrompt.id);
          }
          break;
        }

        case "end_conversation": {
          runtime.endConversation = true;
          result = { ended: true };
          break;
        }

        case "present_options": {
          type OptionItem = { label: string; value: string; detail?: string };
          let options: OptionItem[] = [];
          try {
            const rawOptions = args.options_json ?? "[]";
            const parsed = JSON.parse(typeof rawOptions === "string" ? rawOptions : JSON.stringify(rawOptions));
            options = Array.isArray(parsed) ? (parsed as OptionItem[]) : [];
          } catch {
            options = [];
          }

          if (options.length === 0) {
            result = { error: "No options provided" };
            break;
          }

          // Build select field for the frontend form
          const selectField: PromptField = {
            name: "chosen_option",
            label: String(args.title ?? "Pick one"),
            type: "select",
            required: true,
            options: options.map((opt, i) => ({
              label: opt.detail ? `${i + 1}. ${opt.label} — ${opt.detail}` : `${i + 1}. ${opt.label}`,
              value: opt.value,
            })),
          };

          const memoryKey = typeof args.memory_key === "string" ? args.memory_key : "pending_shop_choice";
          const promptInput: {
            title: string;
            fields: PromptField[];
            description?: string;
            memoryKey?: string;
            memoryLabel?: string;
          } = {
            title: String(args.title ?? "Choose an option"),
            fields: [selectField],
            memoryKey,
            memoryLabel: String(args.title ?? "User choice"),
          };
          if (typeof args.description === "string" && args.description.trim()) {
            promptInput.description = args.description;
          }
          const prompt = this.database.createPrompt(promptInput);
          this.transcriptBus.publishPrompt(prompt);

          // Also save the full options list to memory so voice resolution can match
          this.database.writeMemory(memoryKey, JSON.stringify(options, null, 2), {
            data: { options, promptId: prompt.id, status: "pending" },
          });

          // Build a voice-friendly numbered list
          const spokenList = options
            .map((opt, i) => `${i + 1}: ${opt.label}${opt.detail ? `, ${opt.detail}` : ""}`)
            .join(". ");

          const spokenListFull = `Here are your options. ${spokenList}. Which one would you like?`;
          runtime.optionsSpokenList = spokenListFull;
          result = {
            promptId: prompt.id,
            status: "pending",
            message: "Options sent to user.",
            spokenList: spokenListFull,
          };
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
      stopWhen: [
        hasToolCall("pause_until_output"),
        hasToolCall("end_conversation"),
        hasToolCall("present_options"),
        stepCountIs(12),
      ],
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
        list_recent_activity: tool({
          description:
            "Summarize recent household activity, including transcript messages, tool calls, and browser automation history.",
          inputSchema: LIST_RECENT_ACTIVITY_SCHEMA,
          execute: async (input) => this.executeToolByName("list_recent_activity", input, runtime, request.profileId),
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
        present_options: tool({
          description:
            "Present numbered choices (screen dropdown + voice). Wait for the user's reply before ordering or run_browser_task.",
          inputSchema: PRESENT_OPTIONS_SCHEMA,
          execute: async (input) => this.executeToolByName("present_options", input, runtime, request.profileId),
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

      if (runtime.optionsSpokenList?.trim() && !spokenText) {
        return { kind: "text", text: runtime.optionsSpokenList.trim() };
      }

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

          const afterFallbackSpoken = runtime.spokenPhrases.join(" ").trim();
          if (runtime.optionsSpokenList?.trim() && !afterFallbackSpoken) {
            return { kind: "text", text: runtime.optionsSpokenList.trim() };
          }

          if (runtime.endConversation) {
            return {
              kind: "end_conversation",
              text: afterFallbackSpoken || "Goodbye for now.",
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
