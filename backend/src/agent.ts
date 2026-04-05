import type { AppConfig } from "./config";
import type {
  AgentTurnRequest,
  PromptField,
  ReminderCadence,
  ReminderUpdateInput,
} from "./contracts";
import type { BrowserUseService } from "./browser-use";
import type { GazabotDatabase } from "./db";
import type { UploadedFileService } from "./files";
import { DEFAULT_REMINDER_TIMEZONE, resolveReminderTimezone } from "./reminders";
import type { TranscriptEventBus } from "./transcript-bus";

// OpenAI-compatible types for Imagine API
type ChatRole = "system" | "user" | "assistant" | "tool";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ChatCompletionResponse = {
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
};

export type AgentTurnResult =
  | { kind: "text"; text: string }
  | { kind: "browser_task"; browserSessionId: string; previewUrl: string | null }
  | { kind: "end_conversation"; text: string };

const TOOL_DEFINITIONS = [
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
        "Dispatch a browser automation task. Use for web searches, ordering food (DoorDash, Uber Eats, Grubhub), pharmacy orders (CVS — OTC items and prescription refills), booking, checking websites, or any task requiring internet browsing. Before placing any order, ensure payment_card and delivery_address are stored in memory; if missing, call request_user_input first.",
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

// Maximum number of tool-call groups (assistant + results) to keep in the active
// context window. Older groups are dropped before each API call to prevent context rot.
const MAX_TOOL_GROUPS_IN_CONTEXT = 10;

/**
 * Prune the messages array sent to the model on each iteration.
 *
 * Strategy:
 *  - Everything up to and including the current user message is kept (system
 *    prompt + conversation history + the user's current request).
 *  - After that point we have the agentic tool-call chain for this turn
 *    (repeated assistant→tool_results pairs). We keep only the most recent
 *    MAX_TOOL_GROUPS_IN_CONTEXT groups so the context doesn't bloat.
 */
function pruneMessages(messages: ChatMessage[]): ChatMessage[] {
  // Locate the last plain user message (not a tool result) — this is the pivot
  let pivotIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !messages[i].tool_call_id) {
      pivotIdx = i;
      break;
    }
  }
  if (pivotIdx === -1) return messages;

  const prefix = messages.slice(0, pivotIdx + 1);
  const toolChain = messages.slice(pivotIdx + 1);

  // Group the tool chain into (assistant + its tool results) pairs
  const groups: ChatMessage[][] = [];
  let i = 0;
  while (i < toolChain.length) {
    const msg = toolChain[i];
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const group: ChatMessage[] = [msg];
      i++;
      while (i < toolChain.length && toolChain[i].role === "tool") {
        group.push(toolChain[i]);
        i++;
      }
      groups.push(group);
    } else {
      groups.push([msg]);
      i++;
    }
  }

  const kept = groups.slice(-MAX_TOOL_GROUPS_IN_CONTEXT);
  return [...prefix, ...kept.flat()];
}

// Some model deployments output tool calls as plain JSON text instead of using the
// tool_calls field. This parser detects and normalizes that pattern.
function parseTextToolCall(content: string): ToolCall | null {
  const trimmed = content.trim().replace(/<\|eom_id\|>.*$/s, "").trim();
  if (!trimmed.startsWith("{")) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name : null;
    if (!name) return null;

    const argsSource = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
    let argsStr: string;

    if (typeof argsSource === "string") {
      argsStr = argsSource;
    } else {
      // Normalize any string-encoded sub-fields (model sometimes encodes arrays as strings)
      const normalized = { ...(argsSource as Record<string, unknown>) };
      for (const [k, v] of Object.entries(normalized)) {
        if (typeof v === "string") {
          try {
            normalized[k] = JSON.parse(v);
          } catch {
            // leave as-is
          }
        }
      }
      argsStr = JSON.stringify(normalized);
    }

    return { id: `text-tool-${Date.now()}`, type: "function", function: { name, arguments: argsStr } };
  } catch {
    return null;
  }
}

export class AgentHarness {
  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly browserUseService: BrowserUseService,
    private readonly uploadedFileService: UploadedFileService,
    private readonly transcriptBus: TranscriptEventBus,
  ) {}

  private async callImagine(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.config.imagine.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.imagine.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.imagine.model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        max_tokens: this.config.imagine.maxTokens,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Imagine API error ${response.status} for model "${this.config.imagine.model}": ${body}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  private buildMessages(request: AgentTurnRequest): ChatMessage[] {
    const reminders = this.database.listReminders();
    const memoryTitles = this.database.listMemoryTitles();
    const uploadedFiles = this.database.listUploadedFiles();
    const allEntries = this.database.listTranscriptEntries();
    const history = allEntries.slice(-this.config.imagine.maxHistoryEntries);

    const memoryIndex =
      memoryTitles.length === 0
        ? "No stored memory."
        : memoryTitles.map((t) => `- ${t}`).join("\n");

    const reminderSummary =
      reminders.length === 0
        ? "No active reminders."
        : reminders
            .map((r) => {
              const attachmentSummary =
                r.attachments && r.attachments.length > 0
                  ? ` | attached files: ${r.attachments.map((attachment) => attachment.name).join(", ")}`
                  : "";
              const nextRun = r.nextRun ?? "none";
              const timezone = r.timezone ?? DEFAULT_REMINDER_TIMEZONE;
              return `- id=${r.id} | title=${r.title} | status=${r.status} | schedule=${r.scheduleLabel} | timezone=${timezone} | next_run=${nextRun}: ${r.instructions}${attachmentSummary}`;
            })
            .join("\n");

    const uploadedFileSummary =
      uploadedFiles.length === 0
        ? "No uploaded files."
        : uploadedFiles
            .map((file) => {
              const linkedReminder = file.reminderId ? ` -> reminder ${file.reminderId}` : "";
              return `- ${file.id}: ${file.name} [${file.mimeType}, text=${file.textStatus}]${linkedReminder}`;
            })
            .join("\n");

    const forceNote = request.forceBrowser
      ? "\n\nIMPORTANT: The user has explicitly requested this be handled via browser automation."
      : "";

    const voiceNote =
      request.source === "voice"
        ? "\n\nThis is a VOICE interaction. Your reply will be spoken aloud automatically. Keep your response to 1-3 sentences. If the resident is clearly ending the conversation, you MUST call end_conversation before giving a brief farewell. Do not end a voice conversation with farewell text alone."
        : "";

    const systemPrompt = `You are Gazabot, a senior care assistant specializing in reminders, web tasks, food ordering, and daily questions. Be warm, concise, and friendly.

Current date and time: ${new Date().toLocaleString("en-US", { timeZone: DEFAULT_REMINDER_TIMEZONE, dateStyle: "full", timeStyle: "long" })}

Stored memory topics (call read_memory to get full details):
${memoryIndex}

Active reminders:
${reminderSummary}

When you learn something worth remembering about the user or household, call write_memory to store it.
When information should stay machine-editable as JSON, use write_memory with content_json or request_user_input with a memory_key.
Available uploaded files (call list_uploaded_files or read_uploaded_file for details):
${uploadedFileSummary}

ORDERING CAPABILITIES:
- Food ordering platforms: DoorDash, Uber Eats, Grubhub — use run_browser_task with the platform name in the task string.
- Pharmacy: CVS.com — OTC items and prescription refills. For Rx refills, include the Rx number as 'rx:RX1234567' in the item name.
- Before any order, check memory for 'payment_card' (fields: card_number, exp_month, exp_year, cvv, cardholder_name) and 'delivery_address' (fields: full_name, line_1, line_2, city, state_or_region, postal_code, country, phone_number). If either is missing, call request_user_input to collect it and write_memory to store it before dispatching run_browser_task.

TOOL USE RULES - follow exactly:
- Only call a tool if the user EXPLICITLY requests that action.
- For greetings, questions, or conversation: respond in plain text, call NO tools.
- Use run_browser_task ONLY if the user asks to search, order, book, or browse the web.
- Use create_reminder ONLY if the user asks to set or schedule a reminder.
- Use list_reminders ONLY if the user asks to see their reminders.
- To update or delete a reminder, use the exact reminder id. If you are not certain which reminder id matches the user's request, call list_reminders first. Never guess a reminder id.
- Never call more than one tool per turn unless strictly necessary.
- Never repeat a tool call.
- For reminders, use timezone ${DEFAULT_REMINDER_TIMEZONE} unless the user clearly asks for a different timezone. If no timezone is specified, you may omit the timezone field.
- read_uploaded_file returns a text-only clone of the file. For images, prioritize the exact visible text and numbers from the image; any scene note is secondary and brief. Do not invent identities or scene details beyond what the extracted text supports.
- When a user asks about an uploaded image, video, PDF, or document, use read_uploaded_file and rely on its contentText field as the file content you can reason over. If the user asks to extract text from an image, you only have access to the contentText. If the user absolutely wants to re-extract text, use the extract_pdf_text tool.
- When you need specific user data (such as credit card information), prefer request_user_input over asking for free-form prose.
- When a document could matter, request a file upload field or inspect existing uploaded files before proceeding.${voiceNote}${forceNote}
- The run_browser_task tool hands off the task to another agent, who does not have access to the information you do. It is your job to supply the browser agent with all the information needed to complete the task (For example, when buying something, ensure to either collect credit card information and address information - request_user_input - or retrieve it from memory - read_memory - when available)
- Call end_conversation when the user clearly signals they are done (e.g. "no", "stop", "goodbye", "that's all", declining a follow-up offer). After calling it, say a brief farewell in your next reply.`;

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    for (const entry of history) {
      if (entry.kind !== "message") continue;
      const role: ChatRole = entry.role === "robot" ? "assistant" : "user";
      messages.push({ role, content: entry.text });
    }

    messages.push({ role: "user", content: request.message });
    return messages;
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

  private async executeTool(
    toolCall: ToolCall,
    profileId?: string,
  ): Promise<{ result: unknown; browserTask?: { browserSessionId: string; previewUrl: string | null } }> {
    const { name, arguments: argsJson } = toolCall.function;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return { result: { error: "Invalid tool arguments" } };
    }

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
      let browserTask: { browserSessionId: string; previewUrl: string | null } | undefined;

      switch (name) {
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

          browserTask = { browserSessionId: session.id, previewUrl: session.previewUrl };
          result = browserTask;
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
          let data: Record<string, unknown> | undefined;
          let fields: PromptField[] | undefined;

          if (args.content_json !== undefined || args.data !== undefined) {
            try {
              const rawData = args.content_json ?? args.data ?? "{}";
              const parsed = JSON.parse(typeof rawData === "string" ? rawData : JSON.stringify(rawData));
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                data = parsed as Record<string, unknown>;
              }
            } catch {
              data = undefined;
            }
          }

          if (args.fields_json !== undefined || args.fields !== undefined) {
            try {
              const rawFields = args.fields_json ?? args.fields ?? "[]";
              const parsed = JSON.parse(typeof rawFields === "string" ? rawFields : JSON.stringify(rawFields));
              if (Array.isArray(parsed)) {
                fields = parsed as PromptField[];
              }
            } catch {
              fields = undefined;
            }
          }

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
          result = { ended: true };
          break;
        }

        case "request_user_input": {
          let fields: PromptField[] = [];
          try {
            const rawFields = args.fields_json ?? args.fields ?? "[]";
            const parsed = JSON.parse(typeof rawFields === "string" ? rawFields : JSON.stringify(rawFields));
            fields = Array.isArray(parsed) ? (parsed as PromptField[]) : [];
          } catch {
            fields = [];
          }
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
          if (args.description) promptInput.description = String(args.description);
          if (typeof args.memory_key === "string") {
            promptInput.memoryKey = args.memory_key;
          }
          if (typeof args.memory_label === "string") {
            promptInput.memoryLabel = args.memory_label;
          }
          const prompt = this.database.createPrompt(promptInput);
          this.transcriptBus.publishPrompt(prompt);
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

      if (browserTask) {
        return { result, browserTask };
      }
      return { result };
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
      return { result: { error: String(error) } };
    }
  }

  async collectTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.forceBrowser) {
      const { browserTask } = await this.executeTool(
        {
          id: "forced_browser_task",
          type: "function",
          function: {
            name: "run_browser_task",
            arguments: JSON.stringify({ task: request.message }),
          },
        },
        request.profileId,
      );

      if (browserTask) {
        return { kind: "browser_task", ...browserTask };
      }
    }

    if (!this.config.imagine.apiKey.trim()) {
      throw new Error("INFERENCE_CLOUD_API_KEY is not configured. Set it in backend/.env.");
    }

    const messages = this.buildMessages(request);
    let browserTask: { browserSessionId: string; previewUrl: string | null } | undefined;

    for (let iteration = 0; iteration < 10; iteration++) {
      const response = await this.callImagine(pruneMessages(messages));
      const choice = response.choices[0];
      if (!choice) break;

      // Prefer structured tool_calls; fall back to text-encoded tool call (some model deployments)
      const toolCalls: ToolCall[] =
        choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length
          ? choice.message.tool_calls
          : (() => {
              const fallback = parseTextToolCall(choice.message.content ?? "");
              return fallback ? [fallback] : [];
            })();

      if (toolCalls.length > 0) {
        messages.push({ ...choice.message, tool_calls: toolCalls });

        let promptSent = false;
        let endConversation = false;
        for (const toolCall of toolCalls) {
          const { result, browserTask: bt } = await this.executeTool(toolCall, request.profileId);
          if (bt) browserTask = bt;
          if (toolCall.function.name === "request_user_input") promptSent = true;
          if (toolCall.function.name === "end_conversation") endConversation = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
        // Stop looping once a user input form has been sent — further iterations would duplicate it
        if (promptSent) {
          return { kind: "text", text: "I've sent you a form to fill out. Please complete it and I'll continue." };
        }
        // Let the model produce a farewell text before we signal end_conversation
        if (endConversation) {
          const farewell = await this.callImagine(pruneMessages(messages));
          const farewellText = (farewell.choices[0]?.message.content ?? "").replace(/<\|eom_id\|>.*$/s, "").trim();
          return { kind: "end_conversation", text: farewellText };
        }
        continue;
      }

      const text = (choice.message.content ?? "").replace(/<\|eom_id\|>.*$/s, "").trim();

      if (browserTask) {
        return { kind: "browser_task", ...browserTask };
      }
      return { kind: "text", text };
    }

    if (browserTask) {
      return { kind: "browser_task", ...browserTask };
    }
    return { kind: "text", text: "I'm sorry, I couldn't complete that request." };
  }

  streamTurn(request: AgentTurnRequest): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          try {
            const result = await this.collectTurn(request);
            if (result.kind === "text") {
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
