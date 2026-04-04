import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AppConfig = {
  appName: string;
  host: string;
  port: number;
  databasePath: string;
  allowedOrigins: string[];
  reminders: {
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
  };
  agent: {
    chunkDelayMs: number;
  };
  imagine: {
    apiKey: string;
    endpoint: string;
    model: string;
    maxTokens: number;
    maxHistoryEntries: number;
  };
  tts: {
    endpoint?: string;
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
  const browserUse: AppConfig["browserUse"] = {
    baseUrl: source.BROWSER_USE_BASE_URL?.trim() || "https://api.browser-use.com/api/v3",
    model: resolveBrowserUseModel(source.BROWSER_USE_MODEL),
    keepAlive: parseBoolean(source.BROWSER_USE_KEEP_ALIVE, true),
    idleStopSeconds: parseInteger(source.BROWSER_USE_IDLE_STOP_SECONDS, 900),
    pollIntervalMs: parseInteger(source.BROWSER_USE_POLL_INTERVAL_MS, 2000),
    maxPollAttempts: parseInteger(source.BROWSER_USE_MAX_POLL_ATTEMPTS, 120),
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

  const imagine: AppConfig["imagine"] = {
    apiKey: source.INFERENCE_CLOUD_API_KEY?.trim() || "",
    endpoint: source.INFERENCE_CLOUD_ENDPOINT?.trim() || "https://aisuite.cirrascale.com/apis/v2",
    model: "Llama-3.1-8B",
    maxTokens: parseInteger(source.INFERENCE_CLOUD_MAX_TOKENS, 1024),
    maxHistoryEntries: parseInteger(source.INFERENCE_CLOUD_MAX_HISTORY, 20),
  };

  const tts: AppConfig["tts"] = {};
  const ttsEndpoint = source.TTS_ENDPOINT?.trim();
  if (ttsEndpoint) {
    tts.endpoint = ttsEndpoint;
  }

  return {
    appName: source.APP_NAME?.trim() || "Gazabot Backend",
    host: source.HOST?.trim() || "127.0.0.1",
    port: parseInteger(source.PORT, 8000),
    databasePath: resolveDatabasePath(source.DATABASE_PATH),
    allowedOrigins: parseOrigins(source.ALLOWED_ORIGINS),
    reminders: {
      enabled: parseBoolean(source.REMINDER_SCHEDULER_ENABLED, true),
    },
    browserUse,
    agent: {
      chunkDelayMs: parseInteger(source.AGENT_CHUNK_DELAY_MS, 140),
    },
    imagine,
    tts,
  };
}
