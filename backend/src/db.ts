import { Database } from "bun:sqlite";

import type {
  BrowserAction,
  BrowserActionStatus,
  BrowserContext,
  BrowserStatus,
  Reminder,
  ReminderCreateInput,
  TranscriptEntry,
  TranscriptKind,
  TranscriptRole,
  ToolStatus,
  UserMemoryEntry,
} from "./contracts";
import { computeNextRun } from "./cron";

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

export type BrowserTaskSession = {
  id: string;
  previewUrl: string | null;
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

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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

export class GazabotDatabase {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.initialize();
  }

  close(): void {
    this.database.close(false);
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
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  listReminders(): Reminder[] {
    const rows = this.database.query("SELECT * FROM reminders ORDER BY created_at DESC").all() as ReminderRow[];
    return rows.map(serializeReminder);
  }

  createReminder(input: ReminderCreateInput): Reminder {
    const row: ReminderRow = {
      id: prefixedId("r"),
      title: input.title.trim(),
      instructions: input.instructions.trim(),
      cadence: input.cadence,
      cron: input.cron.trim(),
      schedule_label: input.scheduleLabel.trim(),
      next_run: computeNextRun(input.cron, input.timezone),
      status: "active",
      owner: "Gazabot agent",
      timezone: input.timezone.trim(),
      created_at: nowIso(),
    };

    this.database
      .query(
        `
          INSERT INTO reminders (
            id, title, instructions, cadence, cron, schedule_label, next_run, status, owner, timezone, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
      );

    return serializeReminder(row);
  }

  listTranscriptEntries(): TranscriptEntry[] {
    const rows = this.database
      .query("SELECT * FROM transcript_entries ORDER BY timestamp ASC")
      .all() as TranscriptRow[];
    return rows.map(serializeTranscriptEntry);
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

  readMemory(title: string): UserMemoryEntry | null {
    const row = this.database
      .query("SELECT title, content, updated_at FROM user_memory WHERE title = ?1")
      .get(title) as { title: string; content: string; updated_at: string } | null;
    if (!row) return null;
    return { title: row.title, content: row.content, updatedAt: row.updated_at };
  }

  writeMemory(title: string, content: string): UserMemoryEntry {
    const updatedAt = nowIso();
    this.database
      .query("INSERT OR REPLACE INTO user_memory (title, content, updated_at) VALUES (?1, ?2, ?3)")
      .run(title.trim(), content.trim(), updatedAt);
    return { title: title.trim(), content: content.trim(), updatedAt };
  }
}
