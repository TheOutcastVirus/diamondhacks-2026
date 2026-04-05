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
  | { kind: "browser_task"; browserSessionId: string; previewUrl: string | null };

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
          timezone: { type: "string", description: "IANA timezone name (e.g. 'America/New_York')" },
          attachmentFileIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional uploaded file ids to associate with the reminder.",
          },
        },
        required: ["title", "instructions", "cron", "cadence", "scheduleLabel", "timezone"],
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
        "Dispatch a browser automation task. Use for web searches, ordering items, checking websites, booking, or any task requiring internet browsing.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Detailed description of what to do in the browser",
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
        "Read an uploaded file by id. For PDFs and text files this returns extracted text when available, plus metadata such as filename and mime type.",
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
        "Force text extraction for an uploaded PDF or text-like document by id. Use when you need the document contents for a task.",
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
      name: "speak",
      description:
        "Speak a response aloud via text-to-speech. Use this to give voice feedback, confirmations, or spoken answers to the user.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak aloud" },
        },
        required: ["text"],
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
      name: "capture_image",
      description:
        "Capture a photo using the robot's camera and get an AI-generated description of what the robot currently sees. Use this to understand the robot's surroundings, check on the user, or identify objects in the environment.",
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
      throw new Error(`Imagine API error ${response.status}: ${body}`);
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
              return `- ${r.title} (${r.scheduleLabel}): ${r.instructions}${attachmentSummary}`;
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
        ? "\n\nThis is a VOICE interaction. Your reply will be spoken aloud automatically, so do NOT call the speak tool. Keep your response to 1-3 sentences."
        : "\n\nUse the speak tool ONCE if you want to vocalize a reply.";

    const systemPrompt = `You are Gazabot, a senior care assistant. You help with reminders, web tasks, and daily questions. Be warm, concise, and friendly.

Current date and time: ${new Date().toISOString()}

Stored memory topics (call read_memory to get full details):
${memoryIndex}

Active reminders:
${reminderSummary}

When you learn something worth remembering about the user or household, call write_memory to store it.
When information should stay machine-editable as JSON, use write_memory with content_json or request_user_input with a memory_key.
Available uploaded files (call list_uploaded_files or read_uploaded_file for details):
${uploadedFileSummary}

TOOL USE RULES - follow exactly:
- Only call a tool if the user EXPLICITLY requests that action.
- For greetings, questions, or conversation: respond in plain text, call NO tools.
- Use run_browser_task ONLY if the user asks to search, order, book, or browse the web.
- Use create_reminder ONLY if the user asks to set or schedule a reminder.
- Use list_reminders ONLY if the user asks to see their reminders.
- Never call more than one tool per turn unless strictly necessary.
- Never repeat a tool call.
- When you need user data, prefer request_user_input over asking for free-form prose.
- For payment forms, collect the complete set of fields needed to actually submit the card, including billing address.
- For shipping or delivery, collect the complete address in separate fields, plus recipient name and phone if useful.
- When a document could matter, request a file upload field or inspect existing uploaded files before proceeding.${voiceNote}${forceNote}`;

    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    for (const entry of history) {
      if (entry.kind !== "message") continue;
      const role: ChatRole = entry.role === "robot" ? "assistant" : "user";
      messages.push({ role, content: entry.text });
    }

    messages.push({ role: "user", content: request.message });
    return messages;
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
            timezone: String(args.timezone ?? "UTC"),
            ...(attachmentFileIds !== undefined && { attachmentFileIds }),
          });
          break;
        }

        case "update_reminder": {
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

          result = this.database.updateReminder(String(args.id ?? ""), update as ReminderUpdateInput);
          break;
        }

        case "delete_reminder": {
          result = { deleted: this.database.deleteReminder(String(args.id ?? "")) };
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
          result = file.textStatus === "ready" ? file : await this.uploadedFileService.extractTextIfPossible(fileId);
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

        case "capture_image": {
          const { file, description } = await this.uploadedFileService.captureAndDescribeImage();
          result = {
            fileId: file.id,
            fileName: file.name,
            capturedAt: new Date().toISOString(),
            description: description ?? "No description available (check GEMINI_API_KEY configuration).",
          };
          break;
        }

        case "speak": {
          const text = String(args.text ?? "");
          await this.invokeTts(text);
          result = { spoken: true };
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
      });
      this.transcriptBus.publish("tool", failEntry);
      return { result: { error: String(error) } };
    }
  }

  private async invokeTts(text: string): Promise<void> {
    // Publish TTS event so the frontend can play the audio
    this.transcriptBus.publishTts(text);

    const endpoint = this.config.tts.endpoint;
    if (!endpoint) return;

    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      // TTS is non-critical; ignore failures
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
      const response = await this.callImagine(messages);
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
        for (const toolCall of toolCalls) {
          const { result, browserTask: bt } = await this.executeTool(toolCall, request.profileId);
          if (bt) browserTask = bt;
          if (toolCall.function.name === "request_user_input") promptSent = true;
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
