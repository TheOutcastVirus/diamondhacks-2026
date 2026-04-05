import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AppConfig = {
  appName: string;
  host: string;
  port: number;
  databasePath: string;
  uploadsDir: string;
  allowedOrigins: string[];
  reminders: {
    enabled: boolean;
  };
  wakeWord: {
    enabled: boolean;
  };
  browserUse: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    profileId?: string;
    keepAlive: boolean;
    idleStopSeconds: number;
    proxyCountryCode?: string;
    pollIntervalMs: number;
    maxPollAttempts: number;
    authStatePath?: string;
    liveEmbed: {
      theme?: "dark" | "light";
      ui?: boolean;
    };
  };
  agent: {
    chunkDelayMs: number;
    conversationTimeoutSeconds: number;
  };
  crisis: {
    enabled: boolean;
    callCooldownSeconds: number;
  };
  bland: {
    apiKey?: string;
    pathwayId?: string;
    baseUrl: string;
  };
  cerebras: {
    apiKey: string;
    endpoint: string;
    model: string;
    maxTokens: number;
    maxHistoryEntries: number;
  };
  tts: {
    endpoint?: string;
  };
  elevenLabs: {
    apiKey: string;
    voiceId: string;
  };
  googleAi: {
    apiKey?: string;
    model: string;
    agentModel: string;
    baseUrl: string;
  };
};

type EnvSource = Record<string, string | undefined>;

const DEFAULT_BROWSER_USE_MODEL = "bu-max";

const SUPPORTED_BROWSER_USE_MODELS = new Set([
  "gemini-3-flash",
  "claude-sonnet-4.6",
  "claude-opus-4.6",
  "gpt-5.4-mini",
  "bu-mini",
  "bu-max",
  "bu-ultra",
]);

const LEGACY_BROWSER_USE_MODEL_ALIASES = new Map<string, string>([
  ["gemini-3.1", "bu-max"],
  ["gemini-3.1-flash", "bu-max"],
  ["bu-medium", "bu-max"],
  ["bu-meduim", "bu-max"],
]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  return fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) {
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveDatabasePath(rawPath: string | undefined): string {
  const configured = rawPath?.trim() || "data/gazabot.sqlite";
  const resolved = resolve(process.cwd(), configured);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function resolveUploadsDir(rawPath: string | undefined): string {
  const configured = rawPath?.trim() || "data/files";
  const resolved = resolve(process.cwd(), configured);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function resolveBrowserUseModel(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) {
    return DEFAULT_BROWSER_USE_MODEL;
  }

  if (SUPPORTED_BROWSER_USE_MODELS.has(configured)) {
    return configured;
  }

  const aliasedModel = LEGACY_BROWSER_USE_MODEL_ALIASES.get(configured);
  if (aliasedModel) {
    console.warn(`[config] Translating legacy BROWSER_USE_MODEL=${configured} to ${aliasedModel}.`);
    return aliasedModel;
  }

  console.warn(
    `[config] Unsupported BROWSER_USE_MODEL=${configured}; falling back to ${DEFAULT_BROWSER_USE_MODEL}.`,
  );
  return DEFAULT_BROWSER_USE_MODEL;
}

export function loadConfig(source: EnvSource = process.env): AppConfig {
  const liveEmbedConfig: AppConfig["browserUse"]["liveEmbed"] = {};
  const liveTheme = source.BROWSER_USE_LIVE_THEME?.trim().toLowerCase();
  if (liveTheme === "dark" || liveTheme === "light") {
    liveEmbedConfig.theme = liveTheme;
  }
  const liveUiRaw = source.BROWSER_USE_LIVE_UI?.trim();
  if (liveUiRaw !== undefined) {
    liveEmbedConfig.ui = parseBoolean(liveUiRaw, true);
  }

  const browserUse: AppConfig["browserUse"] = {
    baseUrl: source.BROWSER_USE_BASE_URL?.trim() || "https://api.browser-use.com/api/v3",
    model: resolveBrowserUseModel(source.BROWSER_USE_MODEL),
    // Default to ending sessions after each task unless explicitly kept alive via env.
    keepAlive: parseBoolean(source.BROWSER_USE_KEEP_ALIVE, false),
    idleStopSeconds: parseInteger(source.BROWSER_USE_IDLE_STOP_SECONDS, 900),
    pollIntervalMs: parseInteger(source.BROWSER_USE_POLL_INTERVAL_MS, 2000),
    maxPollAttempts: parseInteger(source.BROWSER_USE_MAX_POLL_ATTEMPTS, 120),
    liveEmbed: liveEmbedConfig,
  };
  const apiKey = source.BROWSER_USE_API_KEY?.trim();
  const profileId = source.BROWSER_USE_PROFILE_ID?.trim();
  const proxyCountryCode = source.BROWSER_USE_PROXY_COUNTRY_CODE?.trim();

  if (apiKey) {
    browserUse.apiKey = apiKey;
  }
  if (profileId) {
    browserUse.profileId = profileId;
  }
  if (proxyCountryCode) {
    browserUse.proxyCountryCode = proxyCountryCode;
  }
  const authStatePath = source.BROWSER_USE_AUTH_STATE_PATH?.trim();
  if (authStatePath) {
    browserUse.authStatePath = authStatePath;
  }

  const cerebras: AppConfig["cerebras"] = {
    apiKey: source.CEREBRAS_API_KEY?.trim() || source.INFERENCE_CLOUD_API_KEY?.trim() || "",
    endpoint: source.CEREBRAS_ENDPOINT?.trim() || "https://api.cerebras.ai/v1",
    model: source.CEREBRAS_MODEL?.trim() || "llama3.1-8b",
    maxTokens: parseInteger(source.CEREBRAS_MAX_TOKENS, 1024),
    maxHistoryEntries: parseInteger(source.CEREBRAS_MAX_HISTORY, 20),
  };

  const bland: AppConfig["bland"] = {
    baseUrl: source.BLAND_BASE_URL?.trim() || "https://api.bland.ai",
  };
  const blandApiKey = source.BLAND_API_KEY?.trim();
  const blandPathwayId = source.BLAND_PATHWAY_ID?.trim();
  if (blandApiKey) {
    bland.apiKey = blandApiKey;
  }
  if (blandPathwayId) {
    bland.pathwayId = blandPathwayId;
  }

  const tts: AppConfig["tts"] = {};
  const ttsEndpoint = source.TTS_ENDPOINT?.trim();
  if (ttsEndpoint) {
    tts.endpoint = ttsEndpoint;
  }

  const googleAi: AppConfig["googleAi"] = {
    model: source.GOOGLE_AI_MODEL?.trim() || "gemini-3.1-flash-lite-preview",
    agentModel: source.GOOGLE_AI_AGENT_MODEL?.trim() || "gemini-3-pro-preview",
    baseUrl: source.GOOGLE_AI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta",
  };
  const googleApiKey = source.GOOGLE_AI_API_KEY?.trim();
  if (googleApiKey) {
    googleAi.apiKey = googleApiKey;
  }

  return {
    appName: source.APP_NAME?.trim() || "Gazabot Backend",
    host: source.HOST?.trim() || "127.0.0.1",
    port: parseInteger(source.PORT, 8000),
    databasePath: resolveDatabasePath(source.DATABASE_PATH),
    uploadsDir: resolveUploadsDir(source.UPLOADS_DIR),
    allowedOrigins: parseOrigins(source.ALLOWED_ORIGINS),
    reminders: {
      enabled: parseBoolean(source.REMINDER_SCHEDULER_ENABLED, true),
    },
    wakeWord: {
      enabled: parseBoolean(source.WAKE_WORD_ENABLED, true),
    },
    browserUse,
    agent: {
      chunkDelayMs: parseInteger(source.AGENT_CHUNK_DELAY_MS, 140),
      conversationTimeoutSeconds: parseInteger(source.CONVERSATION_TIMEOUT_SECONDS, 10),
    },
    crisis: {
      enabled: parseBoolean(source.CRISIS_ESCALATION_ENABLED, true),
      callCooldownSeconds: parseInteger(source.CRISIS_CALL_COOLDOWN_SECONDS, 300),
    },
    bland,
    cerebras,
    tts,
    elevenLabs: {
      apiKey: source.ELEVEN_LABS_API_KEY?.trim() || "",
      voiceId: source.ELEVEN_LABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM",
    },
    googleAi,
  };
}
