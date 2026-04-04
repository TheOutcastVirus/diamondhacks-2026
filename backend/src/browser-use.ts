import type { AppConfig } from "./config";
import type { BrowserStatus } from "./contracts";
import { GazabotDatabase } from "./db";
import { TranscriptEventBus } from "./transcript-bus";

type BrowserUseSessionResponse = {
  id: string;
  status?: string;
  liveUrl?: string | null;
  output?: unknown;
  title?: string | null;
  url?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSummary(output: unknown): string {
  if (typeof output === "string" && output.trim().length > 0) {
    return output.trim();
  }

  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    const summary = record.summary ?? record.message ?? record.text;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }

    return JSON.stringify(output);
  }

  return "Browser task completed.";
}

function toBrowserStatus(status: string | undefined): BrowserStatus {
  if (status === "failed" || status === "blocked" || status === "error") {
    return "blocked";
  }

  if (status === "running" || status === "queued" || status === "pending") {
    return "executing";
  }

  if (status === "navigating") {
    return "navigating";
  }

  return "idle";
}

export class BrowserUseService {
  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly transcriptBus: TranscriptEventBus,
  ) {}

  async runBrowserTask(input: {
    browserSessionId: string;
    task: string;
    profileId?: string;
  }): Promise<void> {
    if (this.config.browserUse.mockMode || !this.config.browserUse.apiKey) {
      await this.runMockTask(input);
      return;
    }

    await this.runRemoteTask(input);
  }

  private async runMockTask(input: {
    browserSessionId: string;
    task: string;
  }): Promise<void> {
    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: `Started mock browser task: ${input.task}`,
      toolName: "browser-use",
      toolStatus: "started",
      metadata: { mode: "mock" },
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "dispatch",
      detail: "Mock Browser Use session started.",
      status: "pending",
    });
    this.transcriptBus.publish("tool", started);

    await sleep(250);
    this.database.updateBrowserSession({
      browserSessionId: input.browserSessionId,
      status: "navigating",
      summary: "Navigating through the requested website in mock mode.",
      activeTask: input.task,
      currentUrl: "https://example.com",
      title: "Example Domain",
      tabLabel: "Example",
      domSnippet: "<main><h1>Example Domain</h1></main>",
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "navigate",
      detail: "Opened a placeholder page while Browser Use mock mode simulates the run.",
      status: "completed",
    });

    await sleep(250);
    const summary = `Mock browser run completed for: ${input.task}`;
    this.database.updateBrowserSession({
      browserSessionId: input.browserSessionId,
      status: "idle",
      summary,
      activeTask: input.task,
      currentUrl: "https://example.com",
      title: "Example Domain",
      tabLabel: "Example",
      domSnippet: "<main><h1>Example Domain</h1><p>Mock Browser Use completed.</p></main>",
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "summary",
      detail: summary,
      status: "completed",
    });

    const completed = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: summary,
      toolName: "browser-use",
      toolStatus: "completed",
      metadata: { mode: "mock" },
    });
    const robot = this.database.createTranscriptEntry({
      kind: "message",
      role: "robot",
      text: summary,
    });
    this.transcriptBus.publish("tool", completed);
    this.transcriptBus.publish("transcript", robot);
  }

  private async runRemoteTask(input: {
    browserSessionId: string;
    task: string;
    profileId?: string;
  }): Promise<void> {
    const effectiveProfileId = input.profileId || this.config.browserUse.profileId;
    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: `Started browser task: ${input.task}`,
      toolName: "browser-use",
      toolStatus: "started",
      metadata: { task: input.task },
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "dispatch",
      detail: "Sent task to Browser Use Cloud.",
      status: "pending",
    });
    this.transcriptBus.publish("tool", started);

    try {
      const createRemoteSessionRequest: { task: string; profileId?: string } = {
        task: input.task,
      };
      if (effectiveProfileId) {
        createRemoteSessionRequest.profileId = effectiveProfileId;
      }
      const initialSession = await this.createRemoteSession(createRemoteSessionRequest);

      const initialUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: input.browserSessionId,
        status: toBrowserStatus(initialSession.status),
        summary: "Browser Use is working on the task.",
        activeTask: input.task,
        remoteSessionId: initialSession.id,
      };
      if (effectiveProfileId) {
        initialUpdate.profileId = effectiveProfileId;
      }
      if (initialSession.liveUrl) {
        initialUpdate.previewUrl = initialSession.liveUrl;
      }
      this.database.updateBrowserSession(initialUpdate);

      const finalSession = await this.pollRemoteSession(initialSession.id);
      const summary = extractSummary(finalSession.output);

      const finalUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: input.browserSessionId,
        status: "idle",
        summary,
        activeTask: input.task,
        remoteSessionId: finalSession.id,
        title: finalSession.title ?? "Browser Use session",
        currentUrl: finalSession.url ?? "Browser Use cloud session",
        tabLabel: finalSession.title ?? "Browser Use",
      };
      if (effectiveProfileId) {
        finalUpdate.profileId = effectiveProfileId;
      }
      if (finalSession.liveUrl) {
        finalUpdate.previewUrl = finalSession.liveUrl;
      }
      this.database.updateBrowserSession(finalUpdate);
      this.database.appendBrowserAction({
        browserSessionId: input.browserSessionId,
        kind: "summary",
        detail: summary,
        status: "completed",
      });

      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: summary,
        toolName: "browser-use",
        toolStatus: "completed",
        metadata: {
          sessionId: finalSession.id,
          liveUrl: finalSession.liveUrl ?? undefined,
        },
      });
      const robot = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: summary,
      });
      this.transcriptBus.publish("tool", completed);
      this.transcriptBus.publish("transcript", robot);

      await this.stopRemoteSession(finalSession.id);
    } catch (error) {
      const message =
        error instanceof Error ? `Browser task failed: ${error.message}` : "Browser task failed.";
      this.database.updateBrowserSession({
        browserSessionId: input.browserSessionId,
        status: "blocked",
        summary: message,
        activeTask: input.task,
      });
      this.database.appendBrowserAction({
        browserSessionId: input.browserSessionId,
        kind: "error",
        detail: message,
        status: "failed",
      });

      const failed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: message,
        toolName: "browser-use",
        toolStatus: "failed",
        metadata: { task: input.task },
      });
      const robot = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: "I couldn't complete that browser task. Check the guardian console for details.",
      });
      this.transcriptBus.publish("tool", failed);
      this.transcriptBus.publish("transcript", robot);
    }
  }

  private async createRemoteSession(input: {
    task: string;
    profileId?: string;
  }): Promise<BrowserUseSessionResponse> {
    const body: Record<string, unknown> = {
      task: input.task,
      model: this.config.browserUse.model,
      keepAlive: this.config.browserUse.keepAlive,
    };
    if (input.profileId) {
      body.profileId = input.profileId;
    }
    if (this.config.browserUse.proxyCountryCode) {
      body.proxyCountryCode = this.config.browserUse.proxyCountryCode;
    }

    return this.browserUseRequest("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async pollRemoteSession(sessionId: string): Promise<BrowserUseSessionResponse> {
    for (let attempt = 0; attempt < this.config.browserUse.maxPollAttempts; attempt += 1) {
      const session = await this.browserUseRequest(`/sessions/${sessionId}`, { method: "GET" });
      const status = String(session.status ?? "");
      if (
        session.output !== undefined ||
        status === "completed" ||
        status === "failed" ||
        status === "stopped"
      ) {
        return session;
      }

      await sleep(this.config.browserUse.pollIntervalMs);
    }

    throw new Error("Browser Use task timed out while polling the session.");
  }

  private async stopRemoteSession(sessionId: string): Promise<void> {
    try {
      await this.browserUseRequest(`/sessions/${sessionId}/stop`, { method: "POST" });
    } catch {
      // Best-effort stop for profile persistence.
    }
  }

  private async browserUseRequest(path: string, init: RequestInit): Promise<BrowserUseSessionResponse> {
    const response = await fetch(`${this.config.browserUse.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "X-Browser-Use-API-Key": this.config.browserUse.apiKey ?? "",
        "x-api-key": this.config.browserUse.apiKey ?? "",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || `Browser Use request failed with status ${response.status}`);
    }

    return (await response.json()) as BrowserUseSessionResponse;
  }
}
