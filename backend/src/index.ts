import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

if (!config.imagine.apiKey.trim()) {
  console.warn("[startup] INFERENCE_CLOUD_API_KEY is not set; /api/agent/* will error until configured.");
}
if (!config.browserUse.apiKey?.trim()) {
  console.warn("[startup] BROWSER_USE_API_KEY is not set; browser automation will error until configured.");
}

console.log(
  `[startup] Imagine API → ${config.imagine.endpoint} (model=${config.imagine.model})`,
);
console.log(
  `[startup] Browser Use → ${config.browserUse.baseUrl} (model=${config.browserUse.model}); when a task runs, watch for [browser-use] lines below`,
);
if (config.browserUse.profileId?.trim()) {
  console.log(`[startup] Browser Use default profile → ${config.browserUse.profileId}`);
} else {
  console.log("[startup] Browser Use default profile → none configured; browser tasks will run without synced cookies unless a profileId is provided.");
}

const app = createApp(config);

Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 120,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.startsWith("/api/agent")) {
      console.log(`[http] ${request.method} ${url.pathname}`);
    }
    return app.fetch(request);
  },
});

console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
