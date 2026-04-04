import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { GazabotDatabase } from "../src/db";

const cleanupPaths: string[] = [];

function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "gazabot-backend-"));
  cleanupPaths.push(directory);

  const config = loadConfig({
    APP_NAME: "Gazabot Backend Test",
    DATABASE_PATH: join(directory, "test.sqlite"),
    BROWSER_USE_MOCK_MODE: "true",
    AGENT_MOCK_MODE: "true",
    AGENT_CHUNK_DELAY_MS: "5",
  });
  const database = new GazabotDatabase(config.databasePath);
  const app = createApp(config, database);

  return { app, database };
}

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("Gazabot Bun backend", () => {
  test("supports reminder round trip", async () => {
    const { app, database } = createTestApp();

    try {
      const emptyResponse = await app.fetch(new Request("http://localhost/api/reminders"));
      expect(emptyResponse.status).toBe(200);
      expect(await emptyResponse.json()).toEqual({ reminders: [] });

      const createResponse = await app.fetch(
        new Request("http://localhost/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Hydration reminder",
            instructions: "Prompt for water.",
            cadence: "daily",
            cron: "0 15 * * *",
            scheduleLabel: "Every day at 15:00",
            timezone: "America/Los_Angeles",
          }),
        }),
      );

      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as Record<string, unknown>;
      expect(created.title).toBe("Hydration reminder");
      expect(created.scheduleLabel).toBe("Every day at 15:00");
      expect(created.nextRun).toBeString();

      const listResponse = await app.fetch(new Request("http://localhost/api/reminders"));
      const listed = (await listResponse.json()) as { reminders: unknown[] };
      expect(listed.reminders).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("records transcript history and streams agent replies", async () => {
    const { app, database } = createTestApp();

    try {
      const streamResponse = await app.fetch(
        new Request("http://localhost/api/agent/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Please note this for later.",
            source: "guardian",
            forceBrowser: false,
          }),
        }),
      );

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

      const bodyText = await streamResponse.text();
      expect(bodyText).toContain("event: chunk");
      expect(bodyText).toContain("Agent has not been built yet");

      const transcriptResponse = await app.fetch(new Request("http://localhost/api/transcript"));
      expect(transcriptResponse.status).toBe(200);
      const transcript = (await transcriptResponse.json()) as { entries: Array<Record<string, unknown>> };
      expect(transcript.entries).toHaveLength(2);
      expect(transcript.entries[0]?.text).toBe("Please note this for later.");
      expect(transcript.entries[1]?.role).toBe("robot");
      expect(transcript.entries[1]?.text).toBe("Agent has not been built yet");
    } finally {
      database.close();
    }
  });

  test("updates browser state after a queued browser task", async () => {
    const { app, database } = createTestApp();

    try {
      const response = await app.fetch(
        new Request("http://localhost/api/agent/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Find the nearest pharmacy hours in the browser.",
            source: "dashboard",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const payload = (await response.json()) as Record<string, unknown>;
      expect(payload.route).toBe("browser_task");

      await new Promise((resolve) => setTimeout(resolve, 750));

      const browserResponse = await app.fetch(new Request("http://localhost/api/browser"));
      expect(browserResponse.status).toBe(200);
      const browserPayload = (await browserResponse.json()) as { browser: Record<string, unknown> };
      expect(browserPayload.browser.status).toBe("idle");
      expect(Array.isArray(browserPayload.browser.recentActions)).toBe(true);
      expect(String(browserPayload.browser.summary)).toContain("Mock browser run completed");
    } finally {
      database.close();
    }
  });
});
