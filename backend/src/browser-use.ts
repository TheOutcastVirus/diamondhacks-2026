import type { AppConfig } from "./config";
import type { BrowserStatus } from "./contracts";
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
    const preparedTask = await this.prepareBrowserTask(input.task);
    const profileLabel = input.profileId ?? this.config.browserUse.profileId ?? "(default)";
    console.log(
      `[browser-use] Queued browser task — localSession=${input.browserSessionId}, profileId=${profileLabel}, model=${this.config.browserUse.model}, task=${JSON.stringify(preparedTask.task)}`,
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
    await this.runRemoteTask(input, preparedTask);
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
  }, preparedTask: PreparedBrowserTask): Promise<void> {
    const effectiveProfileId = input.profileId || this.config.browserUse.profileId;
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
      const initialSession = await this.createRemoteSession(createRemoteSessionRequest);

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
      const robot = this.database.createTranscriptEntry({
        kind: "message",
        role: "robot",
        text: cacheStatus ? `${resolvedSummary} ${cacheStatus}` : resolvedSummary,
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
    workspaceId?: string;
  }): Promise<BrowserUseSessionResponse> {
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

    return this.browserUseRequest<BrowserUseSessionResponse>("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async pollRemoteSession(sessionId: string): Promise<BrowserUseSessionResponse> {
    for (let attempt = 0; attempt < this.config.browserUse.maxPollAttempts; attempt += 1) {
      const session = await this.browserUseRequest<BrowserUseSessionResponse>(`/sessions/${sessionId}`, { method: "GET" });
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

    let workspaceId = template.workspaceId ?? undefined;
    let cacheLabel: string;
    if (!workspaceId) {
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
    } else {
      template = this.database.saveBrowserTaskTemplate({
        templateKey,
        label: `${orderIntent.merchant} repeat order`,
        merchant: orderIntent.merchant,
        taskTemplate,
        workspaceId,
        incrementUseCount: true,
      });
      cacheLabel = `Reusing saved deterministic rerun workspace for ${orderIntent.merchant}.`;
    }

    return {
      task: taskTemplate,
      workspaceId,
      cacheLabel,
      template,
      orderIntent,
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

  private async browserUseRequest<T>(path: string, init: RequestInit): Promise<T> {
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

    return (await response.json()) as T;
  }
}
