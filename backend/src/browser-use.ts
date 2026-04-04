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

function normalizeCloudStatus(status: string | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

function isTerminalCloudStatus(status: string | undefined): boolean {
  const normalized = normalizeCloudStatus(status);
  return normalized === "completed" || normalized === "failed" || normalized === "stopped";
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
    const profileLabel = input.profileId ?? this.config.browserUse.profileId ?? "(default)";
    console.log(
      `[browser-use] Queued browser task — localSession=${input.browserSessionId}, profileId=${profileLabel}, model=${this.config.browserUse.model}, task=${JSON.stringify(input.task)}`,
    );

    if (!this.config.browserUse.apiKey?.trim()) {
      console.warn(
        `[browser-use] Not sending to Browser Use Cloud (missing BROWSER_USE_API_KEY) — localSession=${input.browserSessionId}`,
      );
      this.recordBrowserTaskFailure(
        input,
        "BROWSER_USE_API_KEY is not configured. Set it in backend/.env.",
        "I couldn't start browser automation. Configure BROWSER_USE_API_KEY in backend/.env.",
      );
      return;
    }

    console.log(
      `[browser-use] Sending to ${this.config.browserUse.baseUrl} — localSession=${input.browserSessionId}`,
    );
    await this.runRemoteTask(input);
  }

  private recordBrowserTaskFailure(
    input: { browserSessionId: string; task: string },
    message: string,
    robotUserMessage = "I couldn't complete that browser task. Check the guardian console for details.",
  ): void {
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
      text: robotUserMessage,
    });
    this.transcriptBus.publish("tool", failed);
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
      const cloudStatus = normalizeCloudStatus(finalSession.status);
      const failed = cloudStatus === "failed" || cloudStatus === "stopped";
      const summary = extractSummary(finalSession.output);
      const resolvedSummary =
        summary === "Browser task completed." && failed
          ? `Browser task ${cloudStatus || "failed"} in Browser Use Cloud.`
          : summary;

      const finalUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: input.browserSessionId,
        status: failed ? "blocked" : "idle",
        summary: resolvedSummary,
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
        detail: resolvedSummary,
        status: failed ? "failed" : "completed",
      });

      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: resolvedSummary,
        toolName: "browser-use",
        toolStatus: failed ? "failed" : "completed",
        metadata: {
          sessionId: finalSession.id,
          liveUrl: finalSession.liveUrl ?? undefined,
        },
      });
      const robot = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: resolvedSummary,
      });
      this.transcriptBus.publish("tool", completed);
      this.transcriptBus.publish("transcript", robot);
    } catch (error) {
      console.error("[browser-use] Remote task failed:", error);
      const message =
        error instanceof Error ? `Browser task failed: ${error.message}` : "Browser task failed.";
      this.recordBrowserTaskFailure(input, message);
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

    const url = `${this.config.browserUse.baseUrl}/sessions`;
    console.log(`[browser-use] POST ${url} body=${JSON.stringify(body)}`);

    return this.browserUseRequest("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async pollRemoteSession(sessionId: string): Promise<BrowserUseSessionResponse> {
    for (let attempt = 0; attempt < this.config.browserUse.maxPollAttempts; attempt += 1) {
      const session = await this.browserUseRequest(`/sessions/${sessionId}`, { method: "GET" });
      if (isTerminalCloudStatus(session.status)) {
        return session;
      }

      await sleep(this.config.browserUse.pollIntervalMs);
    }

    throw new Error("Browser Use task timed out while polling the session.");
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
