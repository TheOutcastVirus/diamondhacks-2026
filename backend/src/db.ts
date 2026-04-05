import { Database } from "bun:sqlite";

import type {
  BrowserAction,
  BrowserActionStatus,
  BrowserContext,
  BrowserStatus,
  MemoryKind,
  PromptField,
  PromptStatus,
  Reminder,
  ReminderCreateInput,
  ReminderUpdateInput,
  TranscriptEntry,
  TranscriptKind,
  TranscriptRole,
  ToolStatus,
  UploadedFile,
  UploadedFileReference,
  UploadedFileTextStatus,
  UserMemoryEntry,
  UserPrompt,
} from "./contracts";
import { computeNextRun } from "./cron";
import { resolveReminderTimezone } from "./reminders";

type ReminderRow = {
  id: string;
  title: string;
  instructions: string;
  cadence: Reminder["cadence"];
  cron: string;
  schedule_label: string;
  next_run: string | null;
  status: Reminder["status"];
  owner: string;
  timezone: string;
  created_at: string;
  attachments_json: string | null;
};

type TranscriptRow = {
  id: string;
  timestamp: string;
  kind: TranscriptKind;
  role: TranscriptRole;
  text: string;
  tool_name: string | null;
  tool_status: ToolStatus | null;
  metadata_json: string | null;
};

type BrowserSessionRow = {
  id: string;
  remote_session_id: string | null;
  profile_id: string | null;
  status: BrowserStatus;
  current_url: string;
  title: string;
  summary: string;
  active_task: string | null;
  tab_label: string | null;
  preview_url: string | null;
  screenshot_url: string | null;
  dom_snippet: string | null;
  last_updated: string;
};

type BrowserActionRow = {
  id: string;
  session_id: string;
  kind: string;
  detail: string;
  timestamp: string;
  status: BrowserActionStatus | null;
};

type UserPromptRow = {
  id: string;
  title: string;
  description: string | null;
  memory_key: string;
  memory_label: string;
  fields_json: string;
  status: PromptStatus;
  response_json: string | null;
  created_at: string;
  responded_at: string | null;
};

type UserMemoryRow = {
  title: string;
  content: string;
  kind: MemoryKind | null;
  schema_json: string | null;
  data_json: string | null;
  updated_at: string;
};

type BrowserTaskTemplateRow = {
  id: string;
  template_key: string;
  label: string;
  merchant: string;
  task_template: string;
  workspace_id: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

type ShoppingOrderRow = {
  id: string;
  merchant: string;
  normalized_merchant: string;
  item_name: string;
  normalized_item_name: string;
  source_task: string;
  template_id: string | null;
  browser_session_id: string | null;
  created_at: string;
};

type UploadedFileRow = {
  id: string;
  name: string;
  original_name: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  text_status: UploadedFileTextStatus;
  extracted_text: string | null;
  reminder_id: string | null;
  prompt_id: string | null;
  prompt_field_name: string | null;
  created_at: string;
};

export type BrowserTaskSession = {
  id: string;
  previewUrl: string | null;
};

export type ClaimedReminder = {
  reminder: Reminder;
  dueAt: string;
};

export type BrowserTaskTemplate = {
  id: string;
  templateKey: string;
  label: string;
  merchant: string;
  taskTemplate: string;
  workspaceId: string | null;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type ShoppingOrder = {
  id: string;
  merchant: string;
  normalizedMerchant: string;
  itemName: string;
  normalizedItemName: string;
  sourceTask: string;
  templateId: string | null;
  browserSessionId: string | null;
  createdAt: string;
};

const IDLE_BROWSER_CONTEXT: BrowserContext = {
  url: "No page loaded",
  title: "Awaiting browser state",
  summary:
    "Once the backend exposes browser context, this page will mirror the active page, task, and recent browser actions.",
  status: "idle",
  lastUpdated: new Date().toISOString(),
  activeTask: "Waiting for browser automation",
  tabLabel: "No active tab",
  domSnippet: "",
  recentActions: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function slugifyKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || `memory_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  return parseJsonObject(value);
}

function parseUploadedFileReferences(value: string | null | undefined): UploadedFileReference[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) {
        return [];
      }

      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name : "";
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
      const sizeBytes =
        typeof record.sizeBytes === "number" && Number.isFinite(record.sizeBytes) ? record.sizeBytes : 0;
      const textStatus =
        record.textStatus === "ready" || record.textStatus === "failed" ? record.textStatus : "none";

      if (!id || !name || !mimeType) {
        return [];
      }

      return [{ id, name, mimeType, sizeBytes, textStatus }];
    });
  } catch {
    return [];
  }
}

function serializeUploadedFile(row: UploadedFileRow): UploadedFile {
  return {
    id: row.id,
    name: row.name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    textStatus: row.text_status,
    createdAt: row.created_at,
    ...(row.reminder_id ? { reminderId: row.reminder_id } : {}),
    ...(row.prompt_id ? { promptId: row.prompt_id } : {}),
    ...(row.prompt_field_name ? { promptFieldName: row.prompt_field_name } : {}),
    ...(row.extracted_text ? { extractedText: row.extracted_text } : {}),
  };
}

function serializeReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    cron: row.cron,
    cadence: row.cadence,
    scheduleLabel: row.schedule_label,
    nextRun: row.next_run,
    status: row.status,
    owner: row.owner,
    timezone: row.timezone,
    attachments: parseUploadedFileReferences(row.attachments_json),
  };
}

function serializeUploadedFile(row: UploadedFileRow): UploadedFile {
  return {
    id: row.id,
    name: row.name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    textStatus: row.text_status,
    createdAt: row.created_at,
    reminderId: row.reminder_id ?? undefined,
    promptId: row.prompt_id ?? undefined,
    promptFieldName: row.prompt_field_name ?? undefined,
  };
}

function serializeTranscriptEntry(row: TranscriptRow): TranscriptEntry {
  const entry: TranscriptEntry = {
    id: row.id,
    timestamp: row.timestamp,
    kind: row.kind,
    role: row.role,
    text: row.text,
  };

  if (row.tool_name) {
    entry.toolName = row.tool_name;
  }
  if (row.tool_status) {
    entry.toolStatus = row.tool_status;
  }
  const metadata = parseMetadata(row.metadata_json);
  if (metadata) {
    entry.metadata = metadata;
  }

  return entry;
}

function serializeBrowserAction(row: BrowserActionRow): BrowserAction {
  const action: BrowserAction = {
    id: row.id,
    kind: row.kind,
    detail: row.detail,
    timestamp: row.timestamp,
  };

  if (row.status) {
    action.status = row.status;
  }

  return action;
}

function serializeBrowserContext(session: BrowserSessionRow | null, actions: BrowserAction[]): BrowserContext {
  if (!session) {
    return {
      ...IDLE_BROWSER_CONTEXT,
      lastUpdated: nowIso(),
    };
  }

  const context: BrowserContext = {
    url: session.current_url,
    title: session.title,
    summary: session.summary,
    status: session.status,
    lastUpdated: session.last_updated,
    domSnippet: session.dom_snippet ?? "",
    recentActions: actions,
  };

  if (session.active_task) {
    context.activeTask = session.active_task;
  }
  if (session.tab_label) {
    context.tabLabel = session.tab_label;
  }
  if (session.preview_url) {
    context.previewUrl = session.preview_url;
  }
  if (session.screenshot_url) {
    context.screenshotUrl = session.screenshot_url;
  }

  return context;
}

function serializePrompt(row: UserPromptRow): UserPrompt {
  const memoryKey = String((row as { memory_key?: string | null }).memory_key ?? "").trim() || slugifyKey(row.title);
  const memoryLabel = String((row as { memory_label?: string | null }).memory_label ?? "").trim() || row.title;
  const prompt: UserPrompt = {
    id: row.id,
    title: row.title,
    fields: JSON.parse(row.fields_json) as PromptField[],
    memoryKey,
    memoryLabel,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.description) {
    prompt.description = row.description;
  }
  if (row.response_json) {
    prompt.response = JSON.parse(row.response_json) as Record<string, unknown>;
  }
  if (row.responded_at) {
    prompt.respondedAt = row.responded_at;
  }
  return prompt;
}

function serializeMemoryEntry(row: UserMemoryRow): UserMemoryEntry {
  const entry: UserMemoryEntry = {
    title: row.title,
    content: row.content,
    updatedAt: row.updated_at,
    kind: row.kind === "structured" ? "structured" : "text",
  };
  if (row.schema_json) {
    entry.schema = JSON.parse(row.schema_json) as PromptField[];
  }
  if (row.data_json) {
    entry.data = JSON.parse(row.data_json) as Record<string, unknown>;
  }
  return entry;
}

function serializeBrowserTaskTemplate(row: BrowserTaskTemplateRow): BrowserTaskTemplate {
  return {
    id: row.id,
    templateKey: row.template_key,
    label: row.label,
    merchant: row.merchant,
    taskTemplate: row.task_template,
    workspaceId: row.workspace_id,
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function serializeShoppingOrder(row: ShoppingOrderRow): ShoppingOrder {
  return {
    id: row.id,
    merchant: row.merchant,
    normalizedMerchant: row.normalized_merchant,
    itemName: row.item_name,
    normalizedItemName: row.normalized_item_name,
    sourceTask: row.source_task,
    templateId: row.template_id,
    browserSessionId: row.browser_session_id,
    createdAt: row.created_at,
  };
}

function nextRunForReminder(input: {
  cron: string;
  timezone: string;
  status: Reminder["status"];
}): string | null {
  if (input.status !== "active") {
    return null;
  }

  return computeNextRun(input.cron, input.timezone);
}

export class GazabotDatabase {
  private readonly database: Database;

  private readonly reminderListeners = new Set<() => void>();

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.initialize();
  }

  close(): void {
    this.database.close(false);
  }

  subscribeReminderChanges(listener: () => void): () => void {
    this.reminderListeners.add(listener);
    return () => {
      this.reminderListeners.delete(listener);
    };
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'custom')),
        cron TEXT NOT NULL,
        schedule_label TEXT NOT NULL,
        next_run TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'draft')),
        owner TEXT NOT NULL,
        timezone TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS transcript_entries (
        id TEXT PRIMARY KEY NOT NULL,
        timestamp TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'tool')),
        role TEXT NOT NULL CHECK (role IN ('robot', 'resident', 'guardian', 'system')),
        text TEXT NOT NULL,
        tool_name TEXT,
        tool_status TEXT CHECK (tool_status IS NULL OR tool_status IN ('started', 'completed', 'failed')),
        metadata_json TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        remote_session_id TEXT,
        profile_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'navigating', 'executing', 'blocked')),
        current_url TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        active_task TEXT,
        tab_label TEXT,
        preview_url TEXT,
        screenshot_url TEXT,
        dom_snippet TEXT,
        last_updated TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS browser_actions (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT CHECK (status IS NULL OR status IN ('pending', 'completed', 'failed'))
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_memory (
        title TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL,
        kind TEXT CHECK (kind IS NULL OR kind IN ('text', 'structured')),
        schema_json TEXT,
        data_json TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_prompts (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        memory_key TEXT,
        memory_label TEXT,
        fields_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        responded_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS browser_task_templates (
        id TEXT PRIMARY KEY NOT NULL,
        template_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        merchant TEXT NOT NULL,
        task_template TEXT NOT NULL,
        workspace_id TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS shopping_orders (
        id TEXT PRIMARY KEY NOT NULL,
        merchant TEXT NOT NULL,
        normalized_merchant TEXT NOT NULL,
        item_name TEXT NOT NULL,
        normalized_item_name TEXT NOT NULL,
        source_task TEXT NOT NULL,
        template_id TEXT REFERENCES browser_task_templates(id) ON DELETE SET NULL,
        browser_session_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS uploaded_files (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        text_status TEXT NOT NULL,
        extracted_text TEXT,
        reminder_id TEXT,
        prompt_id TEXT,
        prompt_field_name TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

    `);

    this.ensureColumn("user_memory", "kind", "TEXT");
    this.ensureColumn("user_memory", "schema_json", "TEXT");
    this.ensureColumn("user_memory", "data_json", "TEXT");
    this.ensureColumn("user_prompts", "memory_key", "TEXT");
    this.ensureColumn("user_prompts", "memory_label", "TEXT");
    this.ensureColumn("reminders", "attachments_json", "TEXT");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.database
      .query(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  }

  listReminders(): Reminder[] {
    const rows = this.database.query("SELECT * FROM reminders ORDER BY created_at DESC").all() as ReminderRow[];
    return rows.map(serializeReminder);
  }

  getReminderById(id: string): Reminder | null {
    const row = this.database.query("SELECT * FROM reminders WHERE id = ?1").get(id) as ReminderRow | null;
    return row ? serializeReminder(row) : null;
  }

  createReminder(input: ReminderCreateInput): Reminder {
    const attachments = this.resolveUploadedFileReferences(input.attachmentFileIds);
    const timezone = resolveReminderTimezone(input.timezone);
    const row: ReminderRow = {
      id: prefixedId("r"),
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      cadence: input.cadence,
      cron: input.cron.trim(),
      schedule_label: input.scheduleLabel.trim(),
      next_run: nextRunForReminder({
        cron: input.cron.trim(),
        timezone,
        status: "active",
      }),
      status: "active",
      owner: "Gazabot agent",
      timezone,
      created_at: nowIso(),
      attachments_json: JSON.stringify(attachments),
    };

    this.database
      .query(
        `
          INSERT INTO reminders (
            id, title, instructions, cadence, cron, schedule_label, next_run, status, owner, timezone, created_at, attachments_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        `,
      )
      .run(
        row.id,
        row.title,
        row.instructions,
        row.cadence,
        row.cron,
        row.schedule_label,
        row.next_run,
        row.status,
        row.owner,
        row.timezone,
        row.created_at,
        row.attachments_json,
      );

    const reminder = serializeReminder(row);
    this.linkUploadedFilesToReminder(reminder.id, attachments.map((attachment) => attachment.id));
    this.notifyReminderListeners();
    return reminder;
  }

  getNextReminderDueAt(): string | null {
    const row = this.database
      .query(
        `
          SELECT next_run
          FROM reminders
          WHERE status = 'active'
            AND next_run IS NOT NULL
          ORDER BY next_run ASC, created_at ASC
          LIMIT 1
        `,
      )
      .get() as { next_run: string | null } | null;

    return row?.next_run ?? null;
  }

  claimDueReminders(now = new Date()): ClaimedReminder[] {
    const nowIso = now.toISOString();
    const claimTransaction = this.database.transaction((currentIso: string, currentDate: Date) => {
      const dueRows = this.database
        .query(
          `
            SELECT * FROM reminders
            WHERE status = 'active'
              AND next_run IS NOT NULL
              AND next_run <= ?1
            ORDER BY next_run ASC, created_at ASC
          `,
        )
        .all(currentIso) as ReminderRow[];

      const claimed: ClaimedReminder[] = [];
      for (const row of dueRows) {
        const dueAt = row.next_run ?? currentIso;
        const dueDate = new Date(dueAt);
        const baseDate =
          Number.isNaN(dueDate.valueOf()) || dueDate <= currentDate ? currentDate : dueDate;
        const nextRun = computeNextRun(row.cron, row.timezone, baseDate);

        this.database
          .query(
            `
              UPDATE reminders
              SET next_run = ?2
              WHERE id = ?1
            `,
          )
          .run(row.id, nextRun);

        claimed.push({
          dueAt,
          reminder: serializeReminder({
            ...row,
            next_run: nextRun,
          }),
        });
      }

      return claimed;
    });

    return claimTransaction(nowIso, now);
  }

  updateReminder(id: string, input: ReminderUpdateInput): Reminder {
    const existing = this.database.query("SELECT * FROM reminders WHERE id = ?1").get(id) as ReminderRow | null;
    if (!existing) {
      throw new Error("Reminder not found.");
    }

    const title = input.title === undefined ? existing.title : input.title.trim();
    const instructions = input.instructions === undefined ? existing.instructions : input.instructions.trim();
    const cadence = input.cadence ?? existing.cadence;
    const cron = input.cron === undefined ? existing.cron : input.cron.trim();
    const scheduleLabel = input.scheduleLabel === undefined ? existing.schedule_label : input.scheduleLabel.trim();
    const timezone = input.timezone === undefined ? existing.timezone : resolveReminderTimezone(input.timezone);
    const status = input.status ?? existing.status;
    const attachments =
      input.attachmentFileIds === undefined
        ? parseUploadedFileReferences((existing as ReminderRow & { attachments_json?: string | null }).attachments_json ?? null)
        : this.resolveUploadedFileReferences(input.attachmentFileIds);

    const row: ReminderRow = {
      ...existing,
      title,
      instructions,
      cadence,
      cron,
      schedule_label: scheduleLabel,
      next_run: nextRunForReminder({ cron, timezone, status }),
      status,
      timezone,
      attachments_json: JSON.stringify(attachments),
    };

    this.database
      .query(
        `
          UPDATE reminders
          SET title = ?2,
              instructions = ?3,
              cadence = ?4,
              cron = ?5,
              schedule_label = ?6,
              next_run = ?7,
              status = ?8,
              timezone = ?9,
              attachments_json = ?10
          WHERE id = ?1
        `,
      )
      .run(
        row.id,
        row.title,
        row.instructions,
        row.cadence,
        row.cron,
        row.schedule_label,
        row.next_run,
        row.status,
        row.timezone,
        row.attachments_json,
      );

    const reminder = serializeReminder(row);
    if (input.attachmentFileIds !== undefined) {
      this.linkUploadedFilesToReminder(reminder.id, attachments.map((attachment) => attachment.id));
    }
    this.notifyReminderListeners();
    return reminder;
  }

  deleteReminder(id: string): boolean {
    const result = this.database.query("DELETE FROM reminders WHERE id = ?1").run(id);
    const deleted = Number(result.changes) > 0;
    if (deleted) {
      this.notifyReminderListeners();
    }
    return deleted;
  }

  listTranscriptEntries(): TranscriptEntry[] {
    const rows = this.database
      .query("SELECT * FROM transcript_entries ORDER BY timestamp ASC")
      .all() as TranscriptRow[];
    return rows.map(serializeTranscriptEntry);
  }

  listMessageTranscriptEntries(): TranscriptEntry[] {
    const rows = this.database
      .query("SELECT * FROM transcript_entries WHERE kind = 'message' ORDER BY timestamp ASC")
      .all() as TranscriptRow[];
    return rows.map(serializeTranscriptEntry);
  }

  clearTranscriptEntries(): void {
    this.database.query("DELETE FROM transcript_entries").run();
  }

  createTranscriptEntry(input: {
    kind: TranscriptKind;
    role: TranscriptRole;
    text: string;
    toolName?: string;
    toolStatus?: ToolStatus;
    metadata?: Record<string, unknown>;
  }): TranscriptEntry {
    const row: TranscriptRow = {
      id: prefixedId("t"),
      timestamp: nowIso(),
      kind: input.kind,
      role: input.role,
      text: input.text,
      tool_name: input.toolName ?? null,
      tool_status: input.toolStatus ?? null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
    };

    this.database
      .query(
        `
          INSERT INTO transcript_entries (
            id, timestamp, kind, role, text, tool_name, tool_status, metadata_json
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `,
      )
      .run(
        row.id,
        row.timestamp,
        row.kind,
        row.role,
        row.text,
        row.tool_name,
        row.tool_status,
        row.metadata_json,
      );

    return serializeTranscriptEntry(row);
  }

  beginBrowserTask(task: string, profileId?: string): BrowserTaskSession {
    const row: BrowserSessionRow = {
      id: prefixedId("bs"),
      remote_session_id: null,
      profile_id: profileId ?? null,
      status: "executing",
      current_url: IDLE_BROWSER_CONTEXT.url,
      title: IDLE_BROWSER_CONTEXT.title,
      summary: "Browser task queued.",
      active_task: task,
      tab_label: IDLE_BROWSER_CONTEXT.tabLabel ?? null,
      preview_url: null,
      screenshot_url: null,
      dom_snippet: "",
      last_updated: nowIso(),
    };

    this.database
      .query(
        `
          INSERT INTO browser_sessions (
            id, remote_session_id, profile_id, status, current_url, title, summary, active_task,
            tab_label, preview_url, screenshot_url, dom_snippet, last_updated
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        `,
      )
      .run(
        row.id,
        row.remote_session_id,
        row.profile_id,
        row.status,
        row.current_url,
        row.title,
        row.summary,
        row.active_task,
        row.tab_label,
        row.preview_url,
        row.screenshot_url,
        row.dom_snippet,
        row.last_updated,
      );

    return {
      id: row.id,
      previewUrl: row.preview_url,
    };
  }

  updateBrowserSession(input: {
    browserSessionId: string;
    status: BrowserStatus;
    summary: string;
    activeTask?: string;
    remoteSessionId?: string;
    profileId?: string;
    currentUrl?: string;
    title?: string;
    tabLabel?: string;
    previewUrl?: string;
    screenshotUrl?: string;
    domSnippet?: string;
  }): void {
    const existing = this.database
      .query("SELECT * FROM browser_sessions WHERE id = ?1")
      .get(input.browserSessionId) as BrowserSessionRow | null;
    if (!existing) {
      throw new Error(`Unknown browser session: ${input.browserSessionId}`);
    }

    const row: BrowserSessionRow = {
      ...existing,
      remote_session_id: input.remoteSessionId ?? existing.remote_session_id,
      profile_id: input.profileId ?? existing.profile_id,
      status: input.status,
      current_url: input.currentUrl ?? existing.current_url,
      title: input.title ?? existing.title,
      summary: input.summary,
      active_task: input.activeTask ?? existing.active_task,
      tab_label: input.tabLabel ?? existing.tab_label,
      preview_url: input.previewUrl ?? existing.preview_url,
      screenshot_url: input.screenshotUrl ?? existing.screenshot_url,
      dom_snippet: input.domSnippet ?? existing.dom_snippet,
      last_updated: nowIso(),
    };

    this.database
      .query(
        `
          UPDATE browser_sessions
          SET remote_session_id = ?2,
              profile_id = ?3,
              status = ?4,
              current_url = ?5,
              title = ?6,
              summary = ?7,
              active_task = ?8,
              tab_label = ?9,
              preview_url = ?10,
              screenshot_url = ?11,
              dom_snippet = ?12,
              last_updated = ?13
          WHERE id = ?1
        `,
      )
      .run(
        row.id,
        row.remote_session_id,
        row.profile_id,
        row.status,
        row.current_url,
        row.title,
        row.summary,
        row.active_task,
        row.tab_label,
        row.preview_url,
        row.screenshot_url,
        row.dom_snippet,
        row.last_updated,
      );
  }

  appendBrowserAction(input: {
    browserSessionId: string;
    kind: string;
    detail: string;
    status?: BrowserActionStatus;
  }): BrowserAction {
    const row: BrowserActionRow = {
      id: prefixedId("a"),
      session_id: input.browserSessionId,
      kind: input.kind,
      detail: input.detail,
      timestamp: nowIso(),
      status: input.status ?? null,
    };

    this.database
      .query(
        `
          INSERT INTO browser_actions (id, session_id, kind, detail, timestamp, status)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .run(row.id, row.session_id, row.kind, row.detail, row.timestamp, row.status);

    const staleRows = this.database
      .query(
        `
          SELECT id
          FROM browser_actions
          WHERE session_id = ?1
          ORDER BY timestamp DESC
          LIMIT -1 OFFSET 12
        `,
      )
      .all(input.browserSessionId) as Array<{ id: string }>;
    for (const staleRow of staleRows) {
      this.database.query("DELETE FROM browser_actions WHERE id = ?1").run(staleRow.id);
    }

    return serializeBrowserAction(row);
  }

  getCurrentBrowserContext(): BrowserContext {
    const session = this.database
      .query("SELECT * FROM browser_sessions ORDER BY last_updated DESC LIMIT 1")
      .get() as BrowserSessionRow | null;
    if (!session) {
      return {
        ...IDLE_BROWSER_CONTEXT,
        lastUpdated: nowIso(),
      };
    }

    const actionRows = this.database
      .query("SELECT * FROM browser_actions WHERE session_id = ?1 ORDER BY timestamp ASC")
      .all(session.id) as BrowserActionRow[];

    return serializeBrowserContext(session, actionRows.map(serializeBrowserAction));
  }

  listMemoryTitles(): string[] {
    const rows = this.database
      .query("SELECT title FROM user_memory ORDER BY title ASC")
      .all() as Array<{ title: string }>;
    return rows.map((r) => r.title);
  }

  listMemoryEntries(): UserMemoryEntry[] {
    const rows = this.database
      .query("SELECT * FROM user_memory ORDER BY updated_at DESC, title ASC")
      .all() as UserMemoryRow[];
    return rows.map(serializeMemoryEntry);
  }

  readMemory(title: string): UserMemoryEntry | null {
    const row = this.database
      .query("SELECT * FROM user_memory WHERE title = ?1")
      .get(title) as UserMemoryRow | null;
    if (!row) return null;
    return serializeMemoryEntry(row);
  }

  writeMemory(
    title: string,
    content: string,
    options?: { schema?: PromptField[]; data?: Record<string, unknown> },
  ): UserMemoryEntry {
    const updatedAt = nowIso();
    const normalizedTitle = title.trim();
    const schemaJson = options?.schema ? JSON.stringify(options.schema) : null;
    const dataJson = options?.data ? JSON.stringify(options.data) : null;
    const kind: MemoryKind = options?.data ? "structured" : "text";
    this.database
      .query(
        `
          INSERT OR REPLACE INTO user_memory (title, content, kind, schema_json, data_json, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `,
      )
      .run(normalizedTitle, content.trim(), kind, schemaJson, dataJson, updatedAt);
    return {
      title: normalizedTitle,
      content: content.trim(),
      updatedAt,
      kind,
      ...(options?.schema !== undefined && { schema: options.schema }),
      ...(options?.data !== undefined && { data: options.data }),
    };
  }

  findBrowserTaskTemplateByKey(templateKey: string): BrowserTaskTemplate | null {
    const row = this.database
      .query("SELECT * FROM browser_task_templates WHERE template_key = ?1")
      .get(templateKey) as BrowserTaskTemplateRow | null;
    return row ? serializeBrowserTaskTemplate(row) : null;
  }

  saveBrowserTaskTemplate(input: {
    templateKey: string;
    label: string;
    merchant: string;
    taskTemplate: string;
    workspaceId?: string | null;
    incrementUseCount?: boolean;
  }): BrowserTaskTemplate {
    const existing = this.database
      .query("SELECT * FROM browser_task_templates WHERE template_key = ?1")
      .get(input.templateKey) as BrowserTaskTemplateRow | null;
    const timestamp = nowIso();

    if (existing) {
      const useCount = existing.use_count + (input.incrementUseCount ? 1 : 0);
      const lastUsedAt = input.incrementUseCount ? timestamp : existing.last_used_at;
      const row: BrowserTaskTemplateRow = {
        ...existing,
        label: input.label.trim(),
        merchant: input.merchant.trim(),
        task_template: input.taskTemplate.trim(),
        workspace_id: input.workspaceId === undefined ? existing.workspace_id : input.workspaceId,
        use_count: useCount,
        updated_at: timestamp,
        last_used_at: lastUsedAt,
      };

      this.database
        .query(
          `
            UPDATE browser_task_templates
            SET label = ?2,
                merchant = ?3,
                task_template = ?4,
                workspace_id = ?5,
                use_count = ?6,
                updated_at = ?7,
                last_used_at = ?8
            WHERE id = ?1
          `,
        )
        .run(
          row.id,
          row.label,
          row.merchant,
          row.task_template,
          row.workspace_id,
          row.use_count,
          row.updated_at,
          row.last_used_at,
        );

      return serializeBrowserTaskTemplate(row);
    }

    const row: BrowserTaskTemplateRow = {
      id: prefixedId("btt"),
      template_key: input.templateKey.trim(),
      label: input.label.trim(),
      merchant: input.merchant.trim(),
      task_template: input.taskTemplate.trim(),
      workspace_id: input.workspaceId ?? null,
      use_count: input.incrementUseCount ? 1 : 0,
      created_at: timestamp,
      updated_at: timestamp,
      last_used_at: input.incrementUseCount ? timestamp : null,
    };

    this.database
      .query(
        `
          INSERT INTO browser_task_templates (
            id, template_key, label, merchant, task_template, workspace_id, use_count, created_at, updated_at, last_used_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        `,
      )
      .run(
        row.id,
        row.template_key,
        row.label,
        row.merchant,
        row.task_template,
        row.workspace_id,
        row.use_count,
        row.created_at,
        row.updated_at,
        row.last_used_at,
      );

    return serializeBrowserTaskTemplate(row);
  }

  recordShoppingOrder(input: {
    merchant: string;
    normalizedMerchant: string;
    itemName: string;
    normalizedItemName: string;
    sourceTask: string;
    templateId?: string | null;
    browserSessionId?: string | null;
  }): ShoppingOrder {
    const row: ShoppingOrderRow = {
      id: prefixedId("so"),
      merchant: input.merchant.trim(),
      normalized_merchant: input.normalizedMerchant.trim(),
      item_name: input.itemName.trim(),
      normalized_item_name: input.normalizedItemName.trim(),
      source_task: input.sourceTask.trim(),
      template_id: input.templateId ?? null,
      browser_session_id: input.browserSessionId ?? null,
      created_at: nowIso(),
    };

    this.database
      .query(
        `
          INSERT INTO shopping_orders (
            id, merchant, normalized_merchant, item_name, normalized_item_name, source_task, template_id, browser_session_id, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        `,
      )
      .run(
        row.id,
        row.merchant,
        row.normalized_merchant,
        row.item_name,
        row.normalized_item_name,
        row.source_task,
        row.template_id,
        row.browser_session_id,
        row.created_at,
      );

    return serializeShoppingOrder(row);
  }

  listShoppingOrders(): ShoppingOrder[] {
    const rows = this.database
      .query("SELECT * FROM shopping_orders ORDER BY created_at DESC")
      .all() as ShoppingOrderRow[];
    return rows.map(serializeShoppingOrder);
  }

  createPrompt(input: {
    title: string;
    description?: string;
    fields: PromptField[];
    memoryKey?: string;
    memoryLabel?: string;
  }): UserPrompt {
    const id = prefixedId("p");
    const createdAt = nowIso();
    const memoryKey = slugifyKey(input.memoryKey ?? input.title);
    const memoryLabel = input.memoryLabel?.trim() || input.title.trim();
    this.database
      .query(
        `INSERT INTO user_prompts (
           id, title, description, memory_key, memory_label, fields_json, status, response_json, created_at, responded_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', NULL, ?7, NULL)`,
      )
      .run(id, input.title, input.description ?? null, memoryKey, memoryLabel, JSON.stringify(input.fields), createdAt);
    const prompt: UserPrompt = {
      id,
      title: input.title,
      fields: input.fields,
      memoryKey,
      memoryLabel,
      status: "pending",
      createdAt,
    };
    if (input.description) prompt.description = input.description;
    return prompt;
  }

  listPrompts(status: PromptStatus | "all" = "pending"): UserPrompt[] {
    const rows =
      status === "all"
        ? (this.database
            .query("SELECT * FROM user_prompts ORDER BY created_at DESC")
            .all() as UserPromptRow[])
        : (this.database
            .query("SELECT * FROM user_prompts WHERE status = ?1 ORDER BY created_at ASC")
            .all(status) as UserPromptRow[]);
    return rows.map(serializePrompt);
  }

  getPrompt(id: string): UserPrompt | null {
    const row = this.database.query("SELECT * FROM user_prompts WHERE id = ?1").get(id) as UserPromptRow | null;
    if (!row) return null;
    return serializePrompt(row);
  }

  respondToPrompt(id: string, response: Record<string, unknown>): { prompt: UserPrompt; memoryEntry: UserMemoryEntry } {
    const prompt = this.getPrompt(id);
    if (!prompt) {
      throw new Error(`Prompt not found: ${id}`);
    }

    const respondedAt = nowIso();
    this.database
      .query(
        `UPDATE user_prompts SET status = 'completed', response_json = ?2, responded_at = ?3 WHERE id = ?1`,
      )
      .run(id, JSON.stringify(response), respondedAt);
    const updated = this.getPrompt(id);
    if (!updated) throw new Error(`Prompt not found: ${id}`);
    const memoryEntry = this.writeMemory(
      updated.memoryKey,
      JSON.stringify(response, null, 2),
      {
        schema: updated.fields,
        data: response,
      },
    );
    return { prompt: updated, memoryEntry };
  }

  listUploadedFiles(): UploadedFile[] {
    const rows = this.database
      .query("SELECT * FROM uploaded_files ORDER BY created_at DESC, name ASC")
      .all() as UploadedFileRow[];
    return rows.map(serializeUploadedFile);
  }

  getUploadedFile(id: string): UploadedFile | null {
    const row = this.database.query("SELECT * FROM uploaded_files WHERE id = ?1").get(id) as UploadedFileRow | null;
    return row ? serializeUploadedFile(row) : null;
  }

  getUploadedFileStoragePath(id: string): string | null {
    const row = this.database
      .query("SELECT storage_path FROM uploaded_files WHERE id = ?1")
      .get(id) as { storage_path: string } | null;
    return row?.storage_path ?? null;
  }

  createUploadedFile(input: {
    name: string;
    originalName: string;
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
    promptId?: string;
    promptFieldName?: string;
    reminderId?: string;
  }): UploadedFile {
    const row: UploadedFileRow = {
      id: prefixedId("file"),
      name: input.name.trim(),
      original_name: input.originalName.trim(),
      storage_path: input.storagePath,
      mime_type: input.mimeType.trim(),
      size_bytes: input.sizeBytes,
      text_status: "none",
      extracted_text: null,
      reminder_id: input.reminderId ?? null,
      prompt_id: input.promptId ?? null,
      prompt_field_name: input.promptFieldName ?? null,
      created_at: nowIso(),
    };

    this.database
      .query(
        `INSERT INTO uploaded_files (
          id, name, original_name, storage_path, mime_type, size_bytes, text_status, extracted_text,
          reminder_id, prompt_id, prompt_field_name, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .run(
        row.id,
        row.name,
        row.original_name,
        row.storage_path,
        row.mime_type,
        row.size_bytes,
        row.text_status,
        row.extracted_text,
        row.reminder_id,
        row.prompt_id,
        row.prompt_field_name,
        row.created_at,
      );

    return serializeUploadedFile(row);
  }

  replaceUploadedFileStorage(id: string, storagePath: string): UploadedFile {
    this.database.query("UPDATE uploaded_files SET storage_path = ?2 WHERE id = ?1").run(id, storagePath);
    const updated = this.getUploadedFile(id);
    if (!updated) {
      throw new Error(`Uploaded file not found: ${id}`);
    }
    return updated;
  }

  updateUploadedFileExtraction(id: string, input: { textStatus: UploadedFileTextStatus; extractedText?: string }): UploadedFile {
    this.database
      .query("UPDATE uploaded_files SET text_status = ?2, extracted_text = ?3 WHERE id = ?1")
      .run(id, input.textStatus, input.extractedText ?? null);
    const updated = this.getUploadedFile(id);
    if (!updated) {
      throw new Error(`Uploaded file not found: ${id}`);
    }
    return updated;
  }

  private resolveUploadedFileReferences(fileIds: string[] | undefined): UploadedFileReference[] {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }

    return fileIds.map((id) => {
      const file = this.getUploadedFile(id);
      if (!file) {
        throw new Error(`Uploaded file not found: ${id}`);
      }
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        textStatus: file.textStatus,
      };
    });
  }

  private linkUploadedFilesToReminder(reminderId: string, fileIds: string[]): void {
    this.database.query("UPDATE uploaded_files SET reminder_id = NULL WHERE reminder_id = ?1").run(reminderId);
    for (const fileId of fileIds) {
      this.database.query("UPDATE uploaded_files SET reminder_id = ?2 WHERE id = ?1").run(fileId, reminderId);
    }
  }

  private notifyReminderListeners(): void {
    for (const listener of this.reminderListeners) {
      listener();
    }
  }
}
