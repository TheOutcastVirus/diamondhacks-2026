export type ReminderStatus = "active" | "paused" | "draft";
export type ReminderCadence = "daily" | "weekly" | "custom";
export type TranscriptKind = "message" | "tool";
export type TranscriptRole = "robot" | "resident" | "guardian" | "system";
export type ToolStatus = "started" | "completed" | "failed";
export type BrowserStatus = "idle" | "navigating" | "executing" | "blocked";
export type BrowserActionStatus = "pending" | "completed" | "failed";
export type AgentSource = "voice" | "dashboard" | "resident" | "guardian";

export type Reminder = {
  id: string;
  title: string;
  instructions: string;
  cron: string;
  cadence: ReminderCadence;
  scheduleLabel: string;
  nextRun: string | null;
  status: ReminderStatus;
  owner?: string;
  timezone?: string;
};

export type ReminderCreateInput = {
  title: string;
  instructions: string;
  cadence: ReminderCadence;
  cron: string;
  scheduleLabel: string;
  timezone: string;
};

export type ReminderUpdateInput = {
  title?: string;
  instructions?: string;
  cadence?: ReminderCadence;
  cron?: string;
  scheduleLabel?: string;
  timezone?: string;
  status?: ReminderStatus;
};

export type TranscriptEntry = {
  id: string;
  timestamp: string;
  kind: TranscriptKind;
  role: TranscriptRole;
  text: string;
  toolName?: string;
  toolStatus?: ToolStatus;
  metadata?: Record<string, unknown>;
};

export type BrowserAction = {
  id: string;
  kind: string;
  detail: string;
  timestamp: string;
  status?: BrowserActionStatus;
};

export type BrowserContext = {
  url: string;
  title: string;
  summary: string;
  status: BrowserStatus;
  lastUpdated: string;
  activeTask?: string;
  tabLabel?: string;
  domSnippet?: string;
  previewUrl?: string;
  screenshotUrl?: string;
  recentActions: BrowserAction[];
};

export type AgentTurnRequest = {
  householdId?: string;
  message: string;
  source: AgentSource;
  profileId?: string;
  forceBrowser?: boolean;
};

export type AgentTurnResponse =
  | {
      route: "conversation";
      reply: string;
    }
  | {
      route: "browser_task";
      browserSessionId: string;
      previewUrl: string | null;
      status: "queued";
    };

export type ApiErrorPayload = {
  message: string;
  details?: unknown;
};
