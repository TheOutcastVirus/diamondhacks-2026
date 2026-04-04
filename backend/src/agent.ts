import type { AppConfig } from "./config";
import type { AgentTurnRequest, ReminderCadence, ReminderUpdateInput } from "./contracts";
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
] as const;

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
    const allEntries = this.database.listTranscriptEntries();
    const history = allEntries.slice(-this.config.imagine.maxHistoryEntries);

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

Active reminders:
${reminderSummary}

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

      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          const { result, browserTask: bt } = await this.executeTool(toolCall, request.profileId);
          if (bt) browserTask = bt;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      const text = choice.message.content ?? "";

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
