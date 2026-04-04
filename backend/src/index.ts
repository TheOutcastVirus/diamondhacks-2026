import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp(config);

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch(request) {
    return app.fetch(request);
  },
});

console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
