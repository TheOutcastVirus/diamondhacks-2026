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
  attachments?: UploadedFileReference[];
};

export type ReminderCreateInput = {
  title: string;
  instructions: string;
  cadence: ReminderCadence;
  cron: string;
  scheduleLabel: string;
  timezone: string;
  attachmentFileIds?: string[];
};

export type ReminderUpdateInput = {
  title?: string;
  instructions?: string;
  cadence?: ReminderCadence;
  cron?: string;
  scheduleLabel?: string;
  timezone?: string;
  status?: ReminderStatus;
  attachmentFileIds?: string[];
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

export type MemoryKind = "text" | "structured";

export type UserMemoryEntry = {
  title: string;
  content: string;
  updatedAt: string;
  kind: MemoryKind;
  schema?: PromptField[];
  data?: Record<string, unknown>;
};

export type PromptFieldType =
  | "string"
  | "text"
  | "int"
  | "float"
  | "boolean"
  | "password"
  | "date"
  | "select"
  | "file";

export type PromptFieldOption = {
  label: string;
  value: string;
};

export type PromptField = {
  name: string;
  label: string;
  type: PromptFieldType;
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: PromptFieldOption[];
  defaultValue?: string | number | boolean | null;
  accept?: string;
  multiple?: boolean;
};

export type UploadedFileTextStatus = "none" | "ready" | "failed";

export type UploadedFileReference = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  textStatus: UploadedFileTextStatus;
};

export type UploadedFile = UploadedFileReference & {
  originalName: string;
  createdAt: string;
  reminderId?: string;
  promptId?: string;
  promptFieldName?: string;
  extractedText?: string;
};

export type PromptStatus = "pending" | "completed" | "cancelled";

export type UserPrompt = {
  id: string;
  title: string;
  description?: string;
  fields: PromptField[];
  memoryKey: string;
  memoryLabel: string;
  status: PromptStatus;
  createdAt: string;
  response?: Record<string, unknown>;
  respondedAt?: string;
};

export type ApiErrorPayload = {
  message: string;
  details?: unknown;
};

export type HitlNeedKind = "payment_card" | "delivery_address" | "confirmation" | "unknown";

export type HitlNeed = {
  kind: HitlNeedKind;
  rawMessage: string;
};

export type HitlRequestStatus = "pending" | "resolved" | "expired";

export type HitlRequest = {
  id: string;
  browserSessionId: string;
  remoteSessionId: string;
  promptId: string | null;
  needKind: HitlNeedKind;
  status: HitlRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  originalTask: string;
  profileId: string | null;
};
