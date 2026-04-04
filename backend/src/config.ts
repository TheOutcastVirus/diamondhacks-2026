import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type AppConfig = {
  appName: string;
  host: string;
  port: number;
  databasePath: string;
  allowedOrigins: string[];
  browserUse: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    mockMode: boolean;
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
};

type EnvSource = Record<string, string | undefined>;

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

export function loadConfig(source: EnvSource = process.env): AppConfig {
  const browserUse: AppConfig["browserUse"] = {
    baseUrl: source.BROWSER_USE_BASE_URL?.trim() || "https://api.browser-use.com/api/v3",
    model: source.BROWSER_USE_MODEL?.trim() || "bu-mini",
    mockMode: parseBoolean(source.BROWSER_USE_MOCK_MODE, true),
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

  return {
    appName: source.APP_NAME?.trim() || "Gazabot Backend",
    host: source.HOST?.trim() || "127.0.0.1",
    port: parseInteger(source.PORT, 8000),
    databasePath: resolveDatabasePath(source.DATABASE_PATH),
    allowedOrigins: parseOrigins(source.ALLOWED_ORIGINS),
    browserUse,
    agent: {
      chunkDelayMs: parseInteger(source.AGENT_CHUNK_DELAY_MS, 140),
    },
  };
}
