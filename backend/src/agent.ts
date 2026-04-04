import type { AppConfig } from "./config";
import type { AgentTurnRequest, PromptField, ReminderCadence, ReminderUpdateInput } from "./contracts";
import type { BrowserUseService } from "./browser-use";
import type { GazabotDatabase } from "./db";
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
      description: "Fetch the full content of a stored memory entry by its title. Use when you need details about a topic listed in the system prompt's memory index.",
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
        "Store or update a memory entry about the user or household. Use a short descriptive title (e.g. 'user_name', 'health_notes', 'dietary_restrictions', 'communication_preferences') and put the full details in content. Call this whenever you learn something worth remembering.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short descriptive key for this memory" },
          content: { type: "string", description: "Full details to store" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_user_input",
      description:
        'Send a structured form to the user to collect information you need. Use when you require data the user must provide (e.g. payment details, address, personal info). The form appears on the frontend and the response is fed back to you automatically. fields_json must be a valid JSON array string, e.g.: [{"name":"card_number","label":"Card Number","type":"string","required":true},{"name":"cvv","label":"CVV","type":"password","required":true}]',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Form title shown to the user" },
          description: { type: "string", description: "Explanation of why this information is needed" },
          fields_json: {
            type: "string",
            description: 'JSON array of field objects. Each object: {"name":"snake_case_key","label":"Display Label","type":"string|int|float|boolean|password","required":true|false}',
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
            .map((r) => `- ${r.title} (${r.scheduleLabel}): ${r.instructions}`)
            .join("\n");

    const forceNote = request.forceBrowser
      ? "\n\nIMPORTANT: The user has explicitly requested this be handled via browser automation."
      : "";

    const systemPrompt = `You are Gazabot, a helpful AI assistant for a household. You help manage reminders, browse the web, answer questions, and assist with daily tasks. Be concise and friendly.

Current date and time: ${new Date().toISOString()}

Stored memory topics (call read_memory to get full details):
${memoryIndex}

Active reminders:
${reminderSummary}

When you learn something worth remembering about the user or household, call write_memory to store it.
When you want to speak a response aloud (for voice interactions), use the speak tool with the text you want vocalized. You can speak AND also return a text response.${forceNote}`;

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
          result = this.database.createReminder({
            title: String(args.title ?? ""),
            instructions: String(args.instructions ?? ""),
            cron: String(args.cron ?? ""),
            cadence: (args.cadence as ReminderCadence) ?? "custom",
            scheduleLabel: String(args.scheduleLabel ?? ""),
            timezone: String(args.timezone ?? "UTC"),
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
          result = this.database.writeMemory(String(args.title ?? ""), String(args.content ?? ""));
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
          const promptInput: { title: string; fields: PromptField[]; description?: string } = {
            title: String(args.title ?? ""),
            fields,
          };
          if (args.description) promptInput.description = String(args.description);
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

  private async collectTurnMock(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const browserHints = ["browser", "search", "look up", "lookup", "find", "open", "visit", "order", "book", "buy"];
    const normalized = request.message.toLowerCase();
    const isBrowser = request.forceBrowser === true || browserHints.some((h) => normalized.includes(h));

    if (isBrowser) {
      const session = this.database.beginBrowserTask(request.message, request.profileId);
      const queuedEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: `Queued browser task: ${request.message}`,
        toolName: "browser-use",
        toolStatus: "started",
        metadata: { browserSessionId: session.id },
      });
      this.transcriptBus.publish("tool", queuedEntry);

      const taskRequest: { browserSessionId: string; task: string; profileId?: string } = {
        browserSessionId: session.id,
        task: request.message,
      };
      if (request.profileId) {
        taskRequest.profileId = request.profileId;
      }
      void this.browserUseService.runBrowserTask(taskRequest);

      return { kind: "browser_task", browserSessionId: session.id, previewUrl: session.previewUrl };
    }

    return { kind: "text", text: "Agent has not been built yet" };
  }

  async collectTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (this.config.imagine.mockMode) {
      return this.collectTurnMock(request);
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
