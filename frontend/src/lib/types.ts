export type ThemeMode = 'light' | 'dark';
export type ConversationState = 'idle' | 'conversation';
export type RecordingState = 'idle' | 'recording' | 'processing';
export type AgentModel = 'cerebras' | 'gemini-fast';
export type PageId = 'reminders' | 'transcription' | 'browser' | 'requested-info';
export type EndpointKey =
  | 'reminders'
  | 'browser'
  | 'transcript'
  | 'transcriptStream'
  | 'prompts'
  | 'memory'
  | 'files';

export type PageDefinition = {
  id: PageId;
  label: string;
  shortLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  metricLabel: string;
};

export type ReminderStatus = 'active' | 'paused' | 'draft';
export type ReminderCadence = 'daily' | 'weekly' | 'custom';

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

export type TranscriptKind = 'message' | 'tool';
export type TranscriptRole = 'robot' | 'resident' | 'guardian' | 'system';
export type ToolStatus = 'started' | 'completed' | 'failed';

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
  status?: 'pending' | 'completed' | 'failed';
};

export type BrowserContext = {
  url: string;
  title: string;
  summary: string;
  status: 'idle' | 'navigating' | 'executing' | 'blocked';
  lastUpdated: string;
  profileId?: string;
  configuredProfileId?: string;
  activeTask?: string;
  tabLabel?: string;
  domSnippet?: string;
  previewUrl?: string;
  screenshotUrl?: string;
  recentActions: BrowserAction[];
};

export type PromptFieldType =
  | 'string'
  | 'text'
  | 'int'
  | 'float'
  | 'boolean'
  | 'password'
  | 'date'
  | 'select'
  | 'file';

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

export type UploadedFileTextStatus = 'none' | 'ready' | 'failed';

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

export type PromptStatus = 'pending' | 'completed' | 'cancelled';

export type MemoryKind = 'text' | 'structured';

export type UserMemoryEntry = {
  title: string;
  content: string;
  updatedAt: string;
  kind: MemoryKind;
  schema?: PromptField[];
  data?: Record<string, unknown>;
};

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

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}
