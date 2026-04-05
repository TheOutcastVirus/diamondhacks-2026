import type { AppConfig } from "./config";
import type { BrowserStatus, HitlNeed, HitlNeedKind, HitlRequest, PromptField } from "./contracts";
import type { BrowserTaskTemplate } from "./db";
import { GazabotDatabase } from "./db";
import { TranscriptEventBus } from "./transcript-bus";
import {
  buildCvsTask,
  buildFoodOrderTask,
  detectFoodPlatform,
  isCvsTask,
  type OrderCard,
  type OrderItem,
} from "./order-tasks";

type BrowserUseSessionResponse = {
  id: string;
  status?: string;
  liveUrl?: string | null;
  output?: unknown;
  title?: string | null;
  url?: string | null;
  workspaceId?: string | null;
  llmCostUsd?: string | number | null;
};

type BrowserUseWorkspaceResponse = {
  id: string;
  name?: string | null;
};

type PreparedBrowserTask = {
  task: string;
  workspaceId?: string;
  cacheLabel?: string;
  template?: BrowserTaskTemplate;
  orderIntent?: {
    merchant: string;
    normalizedMerchant: string;
    itemName: string;
    normalizedItemName: string;
  };
};

export type BrowserTaskLifecycleEvent =
  | {
      kind: "awaiting_input";
      browserSessionId: string;
      task: string;
      promptId: string;
      needKind: HitlNeedKind;
      promptTitle: string;
      promptDescription: string;
    }
  | {
      kind: "finished";
      browserSessionId: string;
      task: string;
      failed: boolean;
      summary: string;
      previewUrl: string | null;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortProfileId(profileId: string): string {
  return profileId.length <= 18 ? profileId : `${profileId.slice(0, 8)}...${profileId.slice(-8)}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/**
 * Appends Browser Use live-embed query params (theme, ui) to a liveUrl when
 * the matching config fields are set. Returns the url unchanged if no params
 * are configured, or undefined/null if the input is falsy.
 */
function decorateLiveUrl(
  liveUrl: string | null | undefined,
  liveEmbed: AppConfig["browserUse"]["liveEmbed"],
): string | undefined {
  if (!liveUrl) return undefined;
  const hasTheme = liveEmbed.theme !== undefined;
  const hasUi = liveEmbed.ui !== undefined;
  if (!hasTheme && !hasUi) return liveUrl;
  try {
    const url = new URL(liveUrl);
    if (hasTheme) url.searchParams.set("theme", liveEmbed.theme as string);
    if (hasUi) url.searchParams.set("ui", String(liveEmbed.ui));
    return url.toString();
  } catch {
    return liveUrl;
  }
}

function normalizeCloudStatus(status: string | undefined): string {
  return String(status ?? "").trim().toLowerCase();
}

function isTerminalCloudStatus(status: string | undefined): boolean {
  const normalized = normalizeCloudStatus(status);
  return normalized === "completed" || normalized === "failed" || normalized === "stopped";
}

function formatBrowserUseNetworkError(baseUrl: string, error: unknown): string {
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "Network error while contacting Browser Use.";
  return `Browser Use is unreachable (${detail}). Check network access and BROWSER_USE_BASE_URL (${baseUrl}).`;
}

/** Turn API JSON/text bodies into a single line for logs and errors. */
function parseBrowserUseApiErrorBody(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Browser Use request failed (HTTP ${status}).`;
  }
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = data.detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (Array.isArray(detail) && detail.length > 0 && typeof detail[0] === "object" && detail[0] !== null) {
      const msg = (detail[0] as Record<string, unknown>).msg;
      if (typeof msg === "string" && msg.trim()) {
        return msg.trim();
      }
    }
    const message = data.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch {
    /* not JSON */
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 597)}…` : trimmed;
}

/**
 * Stored in `browser_task_templates.workspace_id` when Browser Use rejects creating a workspace.
 * Never send this value to the Cloud API as `workspaceId`.
 */
const BROWSER_WORKSPACE_SKIPPED_MARKER = "gazabot:workspace_skipped";

function effectiveBrowserWorkspaceId(stored: string | null | undefined): string | undefined {
  if (!stored || stored === BROWSER_WORKSPACE_SKIPPED_MARKER) {
    return undefined;
  }
  return stored;
}

/** True when the API refuses a new workspace (usually billing/plan), not a transient glitch. */
function isBrowserUseWorkspaceCreationBlockedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (!msg) return false;
  if (msg.includes("upgrade your plan") || msg.includes("delete unused workspaces")) {
    return true;
  }
  if (msg.includes("active subscription") && msg.includes("workspace")) {
    return true;
  }
  if (msg.includes("subscription") && msg.includes("workspace")) {
    return true;
  }
  if (msg.includes("payment required") || msg.includes("quota exceeded")) {
    return true;
  }
  return false;
}

type BrowserUseStructuredOutput = {
  status?: string;
  orderNumber?: string;
  total?: string;
  estimatedArrival?: string;
  blockedReason?: string;
  summary?: string;
  message?: string;
  text?: string;
};

function coerceStructuredOutput(output: unknown): BrowserUseStructuredOutput | undefined {
  if (typeof output === "object" && output !== null) {
    return output as BrowserUseStructuredOutput;
  }

  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as BrowserUseStructuredOutput) : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function formatStructuredSummary(structured: BrowserUseStructuredOutput): string | undefined {
  const status = typeof structured.status === "string" ? structured.status.trim().toLowerCase() : "";
  const orderNumber = typeof structured.orderNumber === "string" ? structured.orderNumber.trim() : "";
  const total = typeof structured.total === "string" ? structured.total.trim() : "";
  const estimatedArrival =
    typeof structured.estimatedArrival === "string" ? structured.estimatedArrival.trim() : "";
  const blockedReason = typeof structured.blockedReason === "string" ? structured.blockedReason.trim() : "";

  const freeform =
    typeof structured.summary === "string"
      ? structured.summary
      : typeof structured.message === "string"
        ? structured.message
        : typeof structured.text === "string"
          ? structured.text
          : "";
  const freeformTrimmed = freeform.trim();

  if (status === "placed") {
    const details = [
      orderNumber ? `Order #: ${orderNumber}` : "",
      total ? `Total: ${total}` : "",
      estimatedArrival ? `ETA: ${estimatedArrival}` : "",
    ].filter(Boolean);
    return details.length > 0 ? `Order placed. ${details.join(" · ")}.` : "Order placed.";
  }

  if (status === "blocked") {
    const reason = blockedReason || freeformTrimmed;
    return reason ? `I couldn’t complete the task. Needed: ${reason}` : "I couldn’t complete the task (missing info).";
  }

  if (freeformTrimmed) {
    return freeformTrimmed;
  }

  return undefined;
}

function extractSummary(output: unknown): string {
  const structured = coerceStructuredOutput(output);
  if (structured) {
    const formatted = formatStructuredSummary(structured);
    if (formatted) return formatted;
    return JSON.stringify(structured);
  }

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

function normalizeKeySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cleanOrderValue(value: string): string {
  return value
    .trim()
    .replace(/^(some|a|an|the)\s+/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
}

function parseOrderIntent(task: string):
  | {
      merchant: string;
      normalizedMerchant: string;
      itemName: string;
      normalizedItemName: string;
    }
  | undefined {
  const normalizedTask = task.trim().replace(/\s+/g, " ");
  const patterns = [
    /(?:order|buy|purchase|get|reorder)\s+(.+?)\s+(?:from|on|at)\s+([a-z0-9][a-z0-9.'& -]{1,80})$/i,
    /(?:from|on|at)\s+([a-z0-9][a-z0-9.'& -]{1,80})\s+(?:order|buy|purchase|get)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalizedTask);
    if (!match) {
      continue;
    }

    const candidateItem = cleanOrderValue(
      pattern === patterns[0] ? (match[1] ?? "") : (match[2] ?? ""),
    );
    const candidateMerchant = cleanOrderValue(
      pattern === patterns[0] ? (match[2] ?? "") : (match[1] ?? ""),
    );
    if (!candidateItem || !candidateMerchant) {
      continue;
    }

    const normalizedMerchant = normalizeKeySegment(candidateMerchant);
    const normalizedItemName = normalizeKeySegment(candidateItem);
    if (!normalizedMerchant || !normalizedItemName) {
      continue;
    }

    return {
      merchant: candidateMerchant,
      normalizedMerchant,
      itemName: candidateItem,
      normalizedItemName,
    };
  }

  return undefined;
}

function buildGenericOrderTemplate(merchant: string, itemName: string): string {
  return [
    `Go to ${merchant} and order ${itemName} for the household.`,
    "Reuse the saved browser profile if available.",
    "Add only the requested item to the cart.",
    "If checkout needs confirmation, payment, substitutions, delivery timing, or any missing info, stop and clearly report what is needed.",
  ].join(" ");
}

function parseCardFromMemory(raw: unknown): OrderCard | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const card = typeof obj.card_number === "string" ? obj.card_number : typeof obj.card === "string" ? obj.card : undefined;
  const exp_month = obj.exp_month ?? obj.expiry_month;
  const exp_year = obj.exp_year ?? obj.expiry_year;
  if (!card || !exp_month || !exp_year) return undefined;
  const cvv = typeof obj.cvv === "string" ? obj.cvv : typeof obj.security_code === "string" ? obj.security_code : undefined;
  const name = typeof obj.cardholder_name === "string" ? obj.cardholder_name : undefined;
  const billing_zip = typeof obj.billing_zip === "string" ? obj.billing_zip : typeof obj.postal_code === "string" ? obj.postal_code : undefined;
  return {
    card,
    exp_month: String(exp_month),
    exp_year: String(exp_year),
    ...(cvv !== undefined ? { cvv } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(billing_zip !== undefined ? { billing_zip } : {}),
  };
}

function parseAddressFromMemory(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const parts = [
    obj.full_name ?? obj.name,
    obj.line_1,
    obj.line_2,
    obj.city,
    obj.state_or_region ?? obj.state,
    obj.postal_code,
    obj.country,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  return parts.length >= 2 ? parts.join(", ") : undefined;
}

function parseItemsFromTask(orderIntent: { itemName: string }): OrderItem[] {
  return [{ name: orderIntent.itemName }];
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
  private browserRunAbort: AbortController | null = null;

  /** Latest local session id passed to runBrowserTask; used to reject stale HITL resumes. */
  private activeBrowserSessionId: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly transcriptBus: TranscriptEventBus,
    private readonly onLifecycleEvent?: (event: BrowserTaskLifecycleEvent) => Promise<void> | void,
  ) {}

  close(): void {
    this.browserRunAbort?.abort();
    this.browserRunAbort = null;
    this.activeBrowserSessionId = null;
  }

  async runBrowserTask(input: {
    browserSessionId: string;
    task: string;
    profileId?: string;
  }): Promise<void> {
    if (!this.config.browserUse.apiKey?.trim()) {
      console.warn(
        `[browser-use] Not sending to Browser Use Cloud (missing BROWSER_USE_API_KEY) — localSession=${input.browserSessionId}`,
      );
      this.recordBrowserTaskFailure(
        input,
        "BROWSER_USE_API_KEY is not configured. Set it in backend/.env.",
      );
      return;
    }

    const supersededId = this.activeBrowserSessionId;
    this.browserRunAbort?.abort();
    const runAbort = new AbortController();
    this.browserRunAbort = runAbort;
    this.activeBrowserSessionId = input.browserSessionId;
    const signal = runAbort.signal;

    if (supersededId && supersededId !== input.browserSessionId) {
      this.database.supersedeBrowserSession(supersededId);
      console.log(`[browser-use] Superseded previous session ${supersededId} — starting ${input.browserSessionId}`);
    }

    try {
      const preparedTask = await this.prepareBrowserTask(input.task);
      if (signal.aborted) {
        return;
      }
      const profileLabel = input.profileId ?? this.config.browserUse.profileId ?? "(default)";
      console.log(
        `[browser-use] Queued browser task — localSession=${input.browserSessionId}, profileId=${profileLabel}, model=${this.config.browserUse.model}, task=${JSON.stringify(preparedTask.task)}`,
      );

      console.log(
        `[browser-use] Sending to ${this.config.browserUse.baseUrl} — localSession=${input.browserSessionId}`,
      );
      await this.runRemoteTask(input, preparedTask, signal);
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      console.error("[browser-use] Browser task failed:", error);
      const detail = error instanceof Error ? error.message.trim() : String(error);
      const technical = detail ? `Browser task failed: ${detail}` : "Browser task failed.";
      this.recordBrowserTaskFailure(input, technical);
    }
  }

  async resumeHitlRequest(hitlRequest: HitlRequest): Promise<void> {
    const followUpTask = this.buildFollowUpTaskForHitlNeed(hitlRequest.needKind);
    if (!followUpTask) {
      throw new Error(`Unable to resolve HITL request ${hitlRequest.id} for need ${hitlRequest.needKind}.`);
    }

    if (
      this.activeBrowserSessionId !== null &&
      hitlRequest.browserSessionId !== this.activeBrowserSessionId
    ) {
      console.warn(
        `[browser-use] Skipping HITL resume — session ${hitlRequest.browserSessionId} is not active (current ${this.activeBrowserSessionId}).`,
      );
      return;
    }

    this.database.updateBrowserSession({
      browserSessionId: hitlRequest.browserSessionId,
      status: "executing",
      summary: "Resuming browser task with your information.",
      activeTask: hitlRequest.originalTask,
      remoteSessionId: hitlRequest.remoteSessionId,
      ...(hitlRequest.profileId ? { profileId: hitlRequest.profileId } : {}),
    });
    this.database.appendBrowserAction({
      browserSessionId: hitlRequest.browserSessionId,
      kind: "hitl",
      detail: `Resuming browser task with ${hitlRequest.needKind}.`,
      status: "pending",
    });

    try {
      const { session, expired } = await this.sendFollowUpTask(
        hitlRequest.remoteSessionId,
        followUpTask,
        hitlRequest.profileId ?? undefined,
      );

      const expiredCreateInput: { task: string; profileId?: string } = {
        task: `${hitlRequest.originalTask}\n\n${followUpTask}`,
      };
      if (hitlRequest.profileId) {
        expiredCreateInput.profileId = hitlRequest.profileId;
      }
      const finalSession = expired ? await this.createRemoteSession(expiredCreateInput) : session;

      const completedSession = isTerminalCloudStatus(finalSession.status)
        ? finalSession
        : await this.pollRemoteSession(finalSession.id);
      const summary = extractSummary(completedSession.output);
      const failed = ["failed", "stopped"].includes(normalizeCloudStatus(completedSession.status));

      const resumedUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: hitlRequest.browserSessionId,
        status: failed ? "blocked" : "idle",
        summary,
        activeTask: hitlRequest.originalTask,
        remoteSessionId: completedSession.id,
        ...(hitlRequest.profileId ? { profileId: hitlRequest.profileId } : {}),
      };
      if (completedSession.url) {
        resumedUpdate.currentUrl = completedSession.url;
      }
      if (completedSession.title) {
        resumedUpdate.title = completedSession.title;
        resumedUpdate.tabLabel = completedSession.title;
      }
      const resumedPreviewUrl = decorateLiveUrl(completedSession.liveUrl, this.config.browserUse.liveEmbed);
      if (resumedPreviewUrl) {
        resumedUpdate.previewUrl = resumedPreviewUrl;
      }
      this.database.updateBrowserSession(resumedUpdate);
      this.database.appendBrowserAction({
        browserSessionId: hitlRequest.browserSessionId,
        kind: "hitl",
        detail: failed
          ? `Browser resume failed after collecting ${hitlRequest.needKind}.`
          : `Browser resume completed after collecting ${hitlRequest.needKind}.`,
        status: failed ? "failed" : "completed",
      });

      const transcriptEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: summary,
        toolName: "browser-use-hitl",
        toolStatus: failed ? "failed" : "completed",
        metadata: {
          hitlRequestId: hitlRequest.id,
          sessionId: completedSession.id,
          needKind: hitlRequest.needKind,
          liveUrl: completedSession.liveUrl ?? undefined,
        },
      });
      this.transcriptBus.publish("tool", transcriptEntry);
      await this.emitLifecycleEvent({
        kind: "finished",
        browserSessionId: hitlRequest.browserSessionId,
        task: hitlRequest.originalTask,
        failed,
        summary,
        previewUrl: resumedPreviewUrl ?? null,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? `Browser resume failed after prompt submission: ${error.message}`
          : "Browser resume failed after prompt submission.";
      this.database.updateBrowserSession({
        browserSessionId: hitlRequest.browserSessionId,
        status: "blocked",
        summary: message,
        activeTask: hitlRequest.originalTask,
        remoteSessionId: hitlRequest.remoteSessionId,
        ...(hitlRequest.profileId ? { profileId: hitlRequest.profileId } : {}),
      });
      this.database.appendBrowserAction({
        browserSessionId: hitlRequest.browserSessionId,
        kind: "hitl",
        detail: message,
        status: "failed",
      });
      const failedEntry = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: message,
        toolName: "browser-use-hitl",
        toolStatus: "failed",
        metadata: {
          hitlRequestId: hitlRequest.id,
          needKind: hitlRequest.needKind,
        },
      });
      this.transcriptBus.publish("tool", failedEntry);
      throw error;
    }
  }

  private recordBrowserTaskFailure(
    input: { browserSessionId: string; task: string },
    message: string,
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
    this.transcriptBus.publish("tool", failed);
    void this.emitLifecycleEvent({
      kind: "finished",
      browserSessionId: input.browserSessionId,
      task: input.task,
      failed: true,
      summary: message,
      previewUrl: null,
    });
  }

  private async runRemoteTask(
    input: {
      browserSessionId: string;
      task: string;
      profileId?: string;
    },
    preparedTask: PreparedBrowserTask,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const effectiveProfileId = input.profileId || this.config.browserUse.profileId;
    let currentRemoteSessionId: string | undefined;
    const started = this.database.createTranscriptEntry({
      kind: "tool",
      role: "system",
      text: `Started browser task: ${preparedTask.task}`,
      toolName: "browser-use",
      toolStatus: "started",
      metadata: {
        task: preparedTask.task,
        workspaceId: preparedTask.workspaceId,
        cacheLabel: preparedTask.cacheLabel,
      },
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "dispatch",
      detail: "Sent task to Browser Use Cloud.",
      status: "pending",
    });
    this.database.appendBrowserAction({
      browserSessionId: input.browserSessionId,
      kind: "auth",
      detail: effectiveProfileId
        ? `Attached Browser Use profile ${shortProfileId(effectiveProfileId)}. Synced cookies and saved browser state should be available to this session.`
        : "No Browser Use profile was attached. This session will not receive synced cookies or saved browser state.",
      status: effectiveProfileId ? "completed" : "failed",
    });
    if (preparedTask.workspaceId) {
      this.database.appendBrowserAction({
        browserSessionId: input.browserSessionId,
        kind: "cache",
        detail:
          preparedTask.cacheLabel ??
          `Using deterministic rerun workspace ${preparedTask.workspaceId} for this browser task.`,
        status: "pending",
      });
    }
    this.transcriptBus.publish("tool", started);

    try {
      const createRemoteSessionRequest: {
        task: string;
        profileId?: string;
        workspaceId?: string;
      } = {
        task: preparedTask.task,
      };
      if (effectiveProfileId) {
        createRemoteSessionRequest.profileId = effectiveProfileId;
      }
      if (preparedTask.workspaceId) {
        createRemoteSessionRequest.workspaceId = preparedTask.workspaceId;
      }
      console.log(
        effectiveProfileId
          ? `[browser-use] Auth passthrough enabled — profileId=${effectiveProfileId}; synced cookies/saved state will be available if they exist in that profile.`
          : "[browser-use] Auth passthrough disabled — no profileId attached; synced cookies/saved state will not be available for this session.",
      );
      const initialSession = await this.createRemoteSession(createRemoteSessionRequest, signal);
      currentRemoteSessionId = initialSession.id;
      if (signal.aborted) {
        return;
      }

      const initialUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: input.browserSessionId,
        status: toBrowserStatus(initialSession.status),
        summary: "Browser Use is working on the task.",
        activeTask: preparedTask.task,
        remoteSessionId: initialSession.id,
      };
      if (effectiveProfileId) {
        initialUpdate.profileId = effectiveProfileId;
      }
      const initialPreviewUrl = decorateLiveUrl(initialSession.liveUrl, this.config.browserUse.liveEmbed);
      if (initialPreviewUrl) {
        initialUpdate.previewUrl = initialPreviewUrl;
      }
      this.database.updateBrowserSession(initialUpdate);

      let currentSession = await this.pollRemoteSession(initialSession.id, signal);
      if (signal.aborted) {
        return;
      }
      const MAX_HITL_LOOPS = 3;

      // --- HITL loop: detect needs, auto-resolve or request user input ---
      for (let hitlLoop = 0; hitlLoop < MAX_HITL_LOOPS; hitlLoop++) {
        if (signal.aborted) {
          return;
        }
        const currentStatus = normalizeCloudStatus(currentSession.status);

        const currentSummary = extractSummary(currentSession.output);
        // Also check raw output text so patterns match against the original blockedReason / output string
        const rawOutputText = typeof currentSession.output === "string"
          ? currentSession.output
          : typeof currentSession.output === "object" && currentSession.output !== null
            ? JSON.stringify(currentSession.output)
            : "";
        const need = this.detectNeededInfo(currentSummary) ?? this.detectNeededInfo(rawOutputText);
        // Always check for HITL need first — even failed sessions may need user action (e.g. login).
        // Only break on terminal-failure if no actionable need was found.
        if (!need) {
          if (currentStatus === "failed" || currentStatus === "stopped") break;
          break;
        }

        console.log(`[browser-use] HITL need detected (loop ${hitlLoop + 1}): ${need.kind} — ${currentSummary.slice(0, 120)}`);

        this.database.appendBrowserAction({
          browserSessionId: input.browserSessionId,
          kind: "hitl",
          detail: `Browser agent needs: ${need.kind}. "${currentSummary.slice(0, 200)}"`,
          status: "pending",
        });

        // Try to auto-resolve from memory
        let followUpTask: string | null = null;
        if (need.kind === "payment_card") {
          const card = this.resolveCardFromMemory();
          if (card) {
            followUpTask = this.buildFollowUpTaskForPayment(card);
          }
        } else if (need.kind === "delivery_address") {
          const addr = this.resolveAddressFromMemory();
          if (addr) {
            followUpTask = this.buildFollowUpTaskForAddress(addr);
          }
        } else if (need.kind === "confirmation") {
          // Confirmations cannot be auto-resolved — always need user
          followUpTask = null;
        }

        if (followUpTask) {
          // Auto-resolved from memory — send follow-up task
          const hitlEntry = this.database.createTranscriptEntry({
            kind: "tool",
            role: "system",
            text: `Auto-resolved ${need.kind} from memory. Sending follow-up to browser session.`,
            toolName: "browser-use-hitl",
            toolStatus: "started",
          });
          this.transcriptBus.publish("tool", hitlEntry);

          this.database.updateBrowserSession({
            browserSessionId: input.browserSessionId,
            status: "executing",
            summary: `Resuming with ${need.kind} from memory...`,
          });

          const { session: nextSession, expired } = await this.sendFollowUpTask(
            currentSession.id,
            followUpTask,
            effectiveProfileId ?? undefined,
            signal,
          );

          if (signal.aborted) {
            return;
          }

          if (expired) {
            // Session expired — start fresh with full context
            console.warn(`[browser-use] Session expired during HITL. Starting fresh session.`);
            const freshTask = `${preparedTask.task}\n\n${followUpTask}`;
            const freshCreateRequest: {
              task: string;
              profileId?: string;
              workspaceId?: string;
            } = { task: freshTask };
            if (effectiveProfileId) {
              freshCreateRequest.profileId = effectiveProfileId;
            }
            if (preparedTask.workspaceId) {
              freshCreateRequest.workspaceId = preparedTask.workspaceId;
            }
            const freshSession = await this.createRemoteSession(freshCreateRequest, signal);
            currentRemoteSessionId = freshSession.id;
            if (signal.aborted) {
              return;
            }
            currentSession = await this.pollRemoteSession(freshSession.id, signal);
          } else {
            currentSession = nextSession;
            currentRemoteSessionId = nextSession.id;
          }

          this.database.appendBrowserAction({
            browserSessionId: input.browserSessionId,
            kind: "hitl",
            detail: `Follow-up sent for ${need.kind}.`,
            status: "completed",
          });
          continue; // Loop to check if more info is needed
        }

        // Cannot auto-resolve — request user input and pause
        const memoryKey =
          need.kind === "payment_card"
            ? "payment_card"
            : need.kind === "delivery_address"
              ? "delivery_address"
              : need.kind === "confirmation"
                ? "browser_confirmation"
                : need.kind === "login"
                  ? "browser_login"
                  : "browser_hitl_info";
        const promptTitle =
          need.kind === "payment_card"
            ? "Payment Information Needed"
            : need.kind === "delivery_address"
              ? "Delivery Address Needed"
              : need.kind === "login"
                ? "Login Required"
                : "Information Needed";
        const promptDescription =
          need.kind === "payment_card"
            ? "The browser agent needs your payment card to complete checkout."
            : need.kind === "delivery_address"
              ? "The browser agent needs your delivery address to complete checkout."
              : need.kind === "login"
                ? "The browser agent needs you to log in. Switch to the Browser tab, log in through the live view, then return here and click Done."
                : `The browser agent needs additional information: ${currentSummary.slice(0, 200)}`;
        const fields =
          need.kind === "payment_card"
            ? this.buildPaymentPromptFields()
            : need.kind === "delivery_address"
              ? this.buildAddressPromptFields()
              : need.kind === "confirmation"
                ? this.buildConfirmationPromptFields()
                : need.kind === "login"
                  ? [] // No fields — user logs in via the live browser view
                  : [{ name: "info", label: "Information", type: "text" as const, required: true }];

        const prompt = this.database.createPrompt({
          title: promptTitle,
          description: promptDescription,
          fields,
          memoryKey,
          memoryLabel: promptTitle,
        });

        const hitlRequestCreateInput: Parameters<GazabotDatabase["createHitlRequest"]>[0] = {
          browserSessionId: input.browserSessionId,
          remoteSessionId: currentSession.id,
          promptId: prompt.id,
          needKind: need.kind,
          originalTask: preparedTask.task,
        };
        if (effectiveProfileId) {
          hitlRequestCreateInput.profileId = effectiveProfileId;
        }
        this.database.createHitlRequest(hitlRequestCreateInput);

        this.database.updateBrowserSession({
          browserSessionId: input.browserSessionId,
          status: "blocked",
          summary: `Waiting for user: ${promptTitle}`,
          activeTask: preparedTask.task,
        });

        const waitingEntry = this.database.createTranscriptEntry({
          kind: "tool",
          role: "system",
          text: `Browser task paused — ${promptDescription} Please fill out the form in the Requested Info panel.`,
          toolName: "browser-use-hitl",
          toolStatus: "started",
          metadata: { promptId: prompt.id, needKind: need.kind },
        });
        this.transcriptBus.publish("tool", waitingEntry);
        this.transcriptBus.publishPrompt(prompt);
        await this.emitLifecycleEvent({
          kind: "awaiting_input",
          browserSessionId: input.browserSessionId,
          task: preparedTask.task,
          promptId: prompt.id,
          needKind: need.kind,
          promptTitle,
          promptDescription,
        });

        // Return early — resume will happen when user submits the prompt (via app.ts hook)
        return;
      }

      // --- Finalize: no more HITL needs or max loops reached ---
      const finalSession = currentSession;
      const cloudStatus = normalizeCloudStatus(finalSession.status);
      const failed = cloudStatus === "failed" || cloudStatus === "stopped";
      const summary = extractSummary(finalSession.output);
      const resolvedSummary =
        summary === "Browser task completed." && failed
          ? `Browser task ${cloudStatus || "failed"} in Browser Use Cloud.`
          : summary;
      const cacheStatus = this.describeCacheOutcome(preparedTask, finalSession);

      const finalUpdate: Parameters<GazabotDatabase["updateBrowserSession"]>[0] = {
        browserSessionId: input.browserSessionId,
        status: failed ? "blocked" : "idle",
        summary: cacheStatus ? `${resolvedSummary} ${cacheStatus}` : resolvedSummary,
        activeTask: preparedTask.task,
        remoteSessionId: finalSession.id,
        title: finalSession.title ?? "Browser Use session",
        currentUrl: finalSession.url ?? "Browser Use cloud session",
        tabLabel: finalSession.title ?? "Browser Use",
      };
      if (effectiveProfileId) {
        finalUpdate.profileId = effectiveProfileId;
      }
      const finalPreviewUrl = decorateLiveUrl(finalSession.liveUrl, this.config.browserUse.liveEmbed);
      if (finalPreviewUrl) {
        finalUpdate.previewUrl = finalPreviewUrl;
      }
      this.database.updateBrowserSession(finalUpdate);
      this.database.appendBrowserAction({
        browserSessionId: input.browserSessionId,
        kind: "summary",
        detail: resolvedSummary,
        status: failed ? "failed" : "completed",
      });
      if (cacheStatus) {
        this.database.appendBrowserAction({
          browserSessionId: input.browserSessionId,
          kind: "cache",
          detail: cacheStatus,
          status: failed ? "failed" : "completed",
        });
      }
      if (!failed && preparedTask.orderIntent) {
        this.database.recordShoppingOrder({
          merchant: preparedTask.orderIntent.merchant,
          normalizedMerchant: preparedTask.orderIntent.normalizedMerchant,
          itemName: preparedTask.orderIntent.itemName,
          normalizedItemName: preparedTask.orderIntent.normalizedItemName,
          sourceTask: input.task,
          templateId: preparedTask.template?.id ?? null,
          browserSessionId: input.browserSessionId,
        });
      }

      const completed = this.database.createTranscriptEntry({
        kind: "tool",
        role: "system",
        text: cacheStatus ? `${resolvedSummary} ${cacheStatus}` : resolvedSummary,
        toolName: "browser-use",
        toolStatus: failed ? "failed" : "completed",
        metadata: {
          sessionId: finalSession.id,
          liveUrl: finalSession.liveUrl ?? undefined,
          workspaceId: finalSession.workspaceId ?? preparedTask.workspaceId,
          deterministicRerun: Boolean(preparedTask.workspaceId),
          cacheStatus: cacheStatus ?? undefined,
        },
      });
      this.transcriptBus.publish("tool", completed);
      await this.emitLifecycleEvent({
        kind: "finished",
        browserSessionId: input.browserSessionId,
        task: preparedTask.task,
        failed,
        summary: cacheStatus ? `${resolvedSummary} ${cacheStatus}` : resolvedSummary,
        previewUrl: finalPreviewUrl ?? null,
      });
      if (finalSession.id) {
        await this.stopRemoteSession(finalSession.id);
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return;
      }
      if (currentRemoteSessionId) {
        await this.stopRemoteSession(currentRemoteSessionId);
      }
      console.error("[browser-use] Remote task failed:", error);
      const message =
        error instanceof Error ? `Browser task failed: ${error.message}` : "Browser task failed.";
      this.recordBrowserTaskFailure(input, message);
    }
  }

  private async emitLifecycleEvent(event: BrowserTaskLifecycleEvent): Promise<void> {
    if (!this.onLifecycleEvent) {
      return;
    }

    try {
      await this.onLifecycleEvent(event);
    } catch (error) {
      console.error("[browser-use] Lifecycle callback failed:", error);
    }
  }

  private async createRemoteSession(
    input: {
      task: string;
      profileId?: string;
      workspaceId?: string;
    },
    signal?: AbortSignal,
  ): Promise<BrowserUseSessionResponse> {
    const body: Record<string, unknown> = {
      task: input.task,
      model: this.config.browserUse.model,
      keepAlive: this.config.browserUse.keepAlive,
    };
    if (input.profileId) {
      body.profileId = input.profileId;
    }
    if (input.workspaceId) {
      body.workspaceId = input.workspaceId;
    }
    if (this.config.browserUse.proxyCountryCode) {
      body.proxyCountryCode = this.config.browserUse.proxyCountryCode;
    }
    const url = `${this.config.browserUse.baseUrl}/sessions`;
    console.log(`[browser-use] POST ${url} body=${JSON.stringify(body)}`);

    const session = await this.browserUseRequest<BrowserUseSessionResponse>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    console.log(
      `[browser-use] Session created: id=${session.id}, status=${session.status}, liveUrl=${session.liveUrl ?? "(none)"}`,
    );

    if (!session.id) {
      throw new Error("Browser Use returned a response without a session id. The session was not created.");
    }

    return session;
  }

  private async pollRemoteSession(sessionId: string, signal?: AbortSignal): Promise<BrowserUseSessionResponse> {
    for (let attempt = 0; attempt < this.config.browserUse.maxPollAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const session = await this.browserUseRequest<BrowserUseSessionResponse>(`/sessions/${sessionId}`, {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      if (isTerminalCloudStatus(session.status)) {
        return session;
      }

      await sleep(this.config.browserUse.pollIntervalMs);
    }

    throw new Error("Browser Use task timed out while polling the session.");
  }

  private async createWorkspace(name: string): Promise<BrowserUseWorkspaceResponse> {
    return this.browserUseRequest<BrowserUseWorkspaceResponse>("/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  }

  private resolveCardFromMemory(): OrderCard | undefined {
    const keys = ["payment_card", "credit_card", "card", "payment"];
    for (const key of keys) {
      const entry = this.database.readMemory(key);
      if (!entry) continue;
      const raw = entry.data ?? (() => { try { return JSON.parse(entry.content); } catch { return undefined; } })();
      const card = parseCardFromMemory(raw);
      if (card) return card;
    }
    return undefined;
  }

  private resolveAddressFromMemory(): string | undefined {
    const keys = ["delivery_address", "home_address", "address", "shipping_address"];
    for (const key of keys) {
      const entry = this.database.readMemory(key);
      if (!entry) continue;
      const raw = entry.data ?? entry.content;
      const addr = parseAddressFromMemory(raw);
      if (addr) return addr;
    }
    return undefined;
  }

  private buildOrderTaskTemplate(
    orderIntent: NonNullable<ReturnType<typeof parseOrderIntent>>,
    task: string,
  ): string {
    const items = parseItemsFromTask(orderIntent);
    const card = this.resolveCardFromMemory();
    const deliveryAddress = this.resolveAddressFromMemory();

    if (isCvsTask(task)) {
      return buildCvsTask({
        items,
        ...(card !== undefined ? { card } : {}),
        ...(deliveryAddress !== undefined ? { deliveryAddress } : {}),
      });
    }

    const platform = detectFoodPlatform(task);
    if (platform) {
      return buildFoodOrderTask({
        platform,
        merchant: orderIntent.merchant,
        items,
        ...(card !== undefined ? { card } : {}),
        ...(deliveryAddress !== undefined ? { deliveryAddress } : {}),
      });
    }

    return buildGenericOrderTemplate(orderIntent.merchant, orderIntent.itemName);
  }

  private async prepareBrowserTask(task: string): Promise<PreparedBrowserTask> {
    const orderIntent = parseOrderIntent(task);
    if (!orderIntent) {
      return { task };
    }

    const templateKey = `merchant_order:${orderIntent.normalizedMerchant}`;
    const taskTemplate = this.buildOrderTaskTemplate(orderIntent, task);
    let template =
      this.database.findBrowserTaskTemplateByKey(templateKey) ??
      this.database.saveBrowserTaskTemplate({
        templateKey,
        label: `${orderIntent.merchant} repeat order`,
        merchant: orderIntent.merchant,
        taskTemplate,
      });

    let workspaceId = effectiveBrowserWorkspaceId(template.workspaceId);
    let cacheLabel: string;

    if (workspaceId) {
      template = this.database.saveBrowserTaskTemplate({
        templateKey,
        label: `${orderIntent.merchant} repeat order`,
        merchant: orderIntent.merchant,
        taskTemplate,
        workspaceId,
        incrementUseCount: true,
      });
      cacheLabel = `Reusing saved deterministic rerun workspace for ${orderIntent.merchant}.`;
    } else if (template.workspaceId === BROWSER_WORKSPACE_SKIPPED_MARKER) {
      template = this.database.saveBrowserTaskTemplate({
        templateKey,
        label: `${orderIntent.merchant} repeat order`,
        merchant: orderIntent.merchant,
        taskTemplate,
        workspaceId: BROWSER_WORKSPACE_SKIPPED_MARKER,
        incrementUseCount: true,
      });
      workspaceId = undefined;
      cacheLabel =
        "Repeat-order workspace skipped (Browser Use plan); running a normal browser session without deterministic cache.";
    } else {
      try {
        const workspace = await this.createWorkspace(`${orderIntent.merchant} repeat orders`);
        workspaceId = workspace.id;
        template = this.database.saveBrowserTaskTemplate({
          templateKey,
          label: `${orderIntent.merchant} repeat order`,
          merchant: orderIntent.merchant,
          taskTemplate,
          workspaceId,
          incrementUseCount: true,
        });
        cacheLabel = `Created deterministic rerun workspace for ${orderIntent.merchant}. This first order seeds the reusable script.`;
      } catch (error) {
        if (!isBrowserUseWorkspaceCreationBlockedError(error)) {
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[browser-use] Workspace creation refused by Browser Use (often plan/subscription—their wording can imply “more” workspaces even when you see one). Continuing without workspace. Detail: ${detail}`,
        );
        template = this.database.saveBrowserTaskTemplate({
          templateKey,
          label: `${orderIntent.merchant} repeat order`,
          merchant: orderIntent.merchant,
          taskTemplate,
          workspaceId: BROWSER_WORKSPACE_SKIPPED_MARKER,
          incrementUseCount: true,
        });
        workspaceId = undefined;
        cacheLabel =
          "Browser Use blocked creating a repeat-order workspace (billing/plan). Running a normal session without deterministic cache.";
      }
    }

    return {
      task: taskTemplate,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(cacheLabel !== undefined ? { cacheLabel } : {}),
      ...(template !== undefined ? { template } : {}),
      ...(orderIntent !== undefined ? { orderIntent } : {}),
    };
  }

  private describeCacheOutcome(
    preparedTask: PreparedBrowserTask,
    session: BrowserUseSessionResponse,
  ): string | undefined {
    if (!preparedTask.workspaceId) {
      return undefined;
    }

    const llmCost =
      typeof session.llmCostUsd === "number"
        ? session.llmCostUsd
        : Number.parseFloat(String(session.llmCostUsd ?? ""));

    if (Number.isFinite(llmCost) && llmCost === 0) {
      return "Deterministic rerun reused the cached Browser Use script with $0 LLM cost.";
    }

    return "Deterministic rerun refreshed or seeded the Browser Use script for future repeat orders.";
  }

  detectNeededInfo(output: string): HitlNeed | null {
    const lower = output.toLowerCase();

    const loginPatterns = [
      "log in", "login", "sign in", "signin", "log into", "sign into",
      "needs to be logged in", "requires login", "please sign in",
      "please log in", "not logged in", "not signed in",
      "authentication required", "please authenticate",
      "credentials", "account credentials", "saved credentials",
      "email and password", "email/phone and password",
      "provide your", "provide.*email", "provide.*password",
      "account email", "account password",
      "no saved account",
    ];
    const paymentPatterns = [
      "payment", "credit card", "card number", "card info",
      "billing", "pay with", "enter card", "add payment",
      "payment method", "card details", "debit card",
    ];
    const addressPatterns = [
      "delivery address", "shipping address", "enter address",
      "add address", "delivery location", "where to deliver",
      "missing address", "need address", "provide address",
    ];
    const confirmationPatterns = [
      "confirm", "confirmation", "approve", "review order",
      "place order", "submit order", "verify", "authorize",
    ];

    for (const p of loginPatterns) {
      if (lower.includes(p)) {
        return { kind: "login", rawMessage: output };
      }
    }
    for (const p of paymentPatterns) {
      if (lower.includes(p)) {
        return { kind: "payment_card", rawMessage: output };
      }
    }
    for (const p of addressPatterns) {
      if (lower.includes(p)) {
        return { kind: "delivery_address", rawMessage: output };
      }
    }
    for (const p of confirmationPatterns) {
      if (lower.includes(p)) {
        return { kind: "confirmation", rawMessage: output };
      }
    }

    // Generic "needs info" / "missing info" patterns
    if (lower.includes("missing info") || lower.includes("need info") || lower.includes("requires info")) {
      return { kind: "unknown", rawMessage: output };
    }

    return null;
  }

  async sendFollowUpTask(
    remoteSessionId: string,
    task: string,
    profileId?: string,
    signal?: AbortSignal,
  ): Promise<{ session: BrowserUseSessionResponse; expired: boolean }> {
    const body: Record<string, unknown> = {
      session_id: remoteSessionId,
      task,
      model: this.config.browserUse.model,
      keepAlive: this.config.browserUse.keepAlive,
    };
    if (profileId) {
      body.profileId = profileId;
    }

    console.log(`[browser-use] Sending follow-up task to session ${remoteSessionId}: ${task.slice(0, 120)}`);

    try {
      const session = await this.browserUseRequest<BrowserUseSessionResponse>("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      const finalSession = await this.pollRemoteSession(session.id, signal);
      return { session: finalSession, expired: false };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("404") || msg.includes("410") || msg.includes("not found") || msg.includes("expired")) {
        console.warn(`[browser-use] Session ${remoteSessionId} expired, cannot send follow-up.`);
        return { session: { id: remoteSessionId, status: "stopped" }, expired: true };
      }
      throw error;
    }
  }

  private buildFollowUpTaskForPayment(card: ReturnType<typeof parseCardFromMemory>): string {
    if (!card) return "";
    const parts = [
      "Continue with checkout. Use this payment information:",
      `Card number: ${card.card}`,
      `Expiry: ${card.exp_month}/${card.exp_year}`,
    ];
    if (card.cvv) parts.push(`CVV: ${card.cvv}`);
    if (card.name) parts.push(`Cardholder name: ${card.name}`);
    if (card.billing_zip) parts.push(`Billing ZIP: ${card.billing_zip}`);
    return parts.join(" ");
  }

  private buildFollowUpTaskForAddress(address: string | undefined): string {
    if (!address) return "";
    return `Continue with checkout. Use this delivery address: ${address}`;
  }

  private buildFollowUpTaskForHitlNeed(needKind: HitlNeedKind): string {
    if (needKind === "payment_card") {
      return this.buildFollowUpTaskForPayment(this.resolveCardFromMemory());
    }
    if (needKind === "delivery_address") {
      return this.buildFollowUpTaskForAddress(this.resolveAddressFromMemory());
    }
    if (needKind === "confirmation") {
      const confirmation = this.database.readMemory("browser_confirmation")?.data;
      if (confirmation && typeof confirmation.confirm === "boolean") {
        return confirmation.confirm
          ? "Continue from where you left off. The user confirmed you should proceed and submit the order."
          : "Do not place the order. The user declined to confirm checkout.";
      }
      return "";
    }
    if (needKind === "login") {
      return "The user has now logged in through the live browser view. Continue with the original task from where you left off.";
    }

    const extraInfo = this.database.readMemory("browser_hitl_info");
    if (!extraInfo) {
      return "";
    }
    return `Continue from where you left off. Here is the information the user provided: ${extraInfo.content}`;
  }

  private buildPaymentPromptFields(): PromptField[] {
    return [
      { name: "cardholder_name", label: "Cardholder Name", type: "string", required: true },
      { name: "card_number", label: "Card Number", type: "password", required: true },
      { name: "exp_month", label: "Expiry Month (MM)", type: "string", required: true },
      { name: "exp_year", label: "Expiry Year (YYYY)", type: "string", required: true },
      { name: "cvv", label: "Security Code (CVV)", type: "password", required: true },
      { name: "billing_zip", label: "Billing ZIP Code", type: "string", required: false },
    ];
  }

  private buildAddressPromptFields(): PromptField[] {
    return [
      { name: "full_name", label: "Full Name", type: "string", required: true },
      { name: "line_1", label: "Address Line 1", type: "string", required: true },
      { name: "line_2", label: "Address Line 2", type: "string", required: false },
      { name: "city", label: "City", type: "string", required: true },
      { name: "state_or_region", label: "State", type: "string", required: true },
      { name: "postal_code", label: "ZIP Code", type: "string", required: true },
      { name: "country", label: "Country", type: "string", required: false, defaultValue: "US" },
      { name: "phone_number", label: "Phone Number", type: "string", required: false },
    ];
  }

  private buildConfirmationPromptFields(): PromptField[] {
    return [
      {
        name: "confirm",
        label: "Proceed With Checkout",
        type: "boolean",
        required: true,
        description: "Allow the browser agent to place or submit the order.",
      },
    ];
  }

  private async stopRemoteSession(sessionId: string): Promise<void> {
    try {
      await this.browserUseRequest<BrowserUseSessionResponse>(`/sessions/${sessionId}/stop`, {
        method: "POST",
      });
      console.log(`[browser-use] Stopped remote session ${sessionId} to persist profile state.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[browser-use] Failed to stop remote session ${sessionId}: ${detail}`);
    }
  }

  private async browserUseRequest<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.browserUse.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "X-Browser-Use-API-Key": this.config.browserUse.apiKey ?? "",
          "x-api-key": this.config.browserUse.apiKey ?? "",
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(formatBrowserUseNetworkError(this.config.browserUse.baseUrl, error));
    }

    if (!response.ok) {
      const body = await response.text();
      console.error(`[browser-use] API error: HTTP ${response.status} ${response.statusText} — ${body.slice(0, 500)}`);
      const parsed = parseBrowserUseApiErrorBody(body, response.status);
      throw new Error(parsed);
    }

    return (await response.json()) as T;
  }
}
