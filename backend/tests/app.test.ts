import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { GazabotDatabase } from "../src/db";

const cleanupPaths: string[] = [];

async function removePathWithRetries(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
      if (code !== "EBUSY" || attempt === 4) {
        if (code === "EBUSY") {
          return;
        }
        throw error;
      }

      await Bun.sleep(25);
    }
  }
}

function createTestApp(overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gazabot-backend-"));
  cleanupPaths.push(directory);

  const config = loadConfig({
    APP_NAME: "Gazabot Backend Test",
    DATABASE_PATH: join(directory, "test.sqlite"),
    BROWSER_USE_MOCK_MODE: "true",
    AGENT_MOCK_MODE: "true",
    AGENT_CHUNK_DELAY_MS: "5",
    REMINDER_SCHEDULER_ENABLED: "false",
    REMINDER_POLL_INTERVAL_MS: "25",
    ...overrides,
  });
  const database = new GazabotDatabase(config.databasePath);
  const app = createApp(config, database);

  return { app, database };
}

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) {
      await removePathWithRetries(path);
    }
  }
});

describe("Gazabot Bun backend", () => {
  test("supports reminder create, update, pause, and delete flow", async () => {
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

      const reminderId = String(created.id);

      const updateResponse = await app.fetch(
        new Request(`http://localhost/api/reminders/${reminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Evening hydration reminder",
            instructions: "Prompt for water after dinner.",
            cadence: "weekly",
            cron: "30 19 * * 2",
            scheduleLabel: "Every Tuesday at 19:30",
            timezone: "America/New_York",
          }),
        }),
      );

      expect(updateResponse.status).toBe(200);
      const updated = (await updateResponse.json()) as Record<string, unknown>;
      expect(updated.title).toBe("Evening hydration reminder");
      expect(updated.instructions).toBe("Prompt for water after dinner.");
      expect(updated.scheduleLabel).toBe("Every Tuesday at 19:30");
      expect(updated.timezone).toBe("America/New_York");
      expect(updated.nextRun).toBeString();

      const pauseResponse = await app.fetch(
        new Request(`http://localhost/api/reminders/${reminderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "paused",
          }),
        }),
      );

      expect(pauseResponse.status).toBe(200);
      const paused = (await pauseResponse.json()) as Record<string, unknown>;
      expect(paused.status).toBe("paused");
      expect(paused.nextRun).toBeNull();

      const listResponse = await app.fetch(new Request("http://localhost/api/reminders"));
      const listed = (await listResponse.json()) as { reminders: unknown[] };
      expect(listed.reminders).toHaveLength(1);

      const deleteResponse = await app.fetch(
        new Request(`http://localhost/api/reminders/${reminderId}`, {
          method: "DELETE",
        }),
      );
      expect(deleteResponse.status).toBe(204);

      const emptyAgainResponse = await app.fetch(new Request("http://localhost/api/reminders"));
      expect(emptyAgainResponse.status).toBe(200);
      expect(await emptyAgainResponse.json()).toEqual({ reminders: [] });
    } finally {
      app.close();
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
      app.close();
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
      app.close();
      database.close();
    }
  });

  test("runs simultaneous due reminders sequentially and records them in transcript history", async () => {
    const { app, database } = createTestApp();

    try {
      const firstCreateResponse = await app.fetch(
        new Request("http://localhost/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Medication check-in",
            instructions: "Ask whether the resident has taken their afternoon medication.",
            cadence: "custom",
            cron: "* * * * *",
            scheduleLabel: "Every minute",
            timezone: "America/Los_Angeles",
          }),
        }),
      );

      expect(firstCreateResponse.status).toBe(200);
      const firstCreated = (await firstCreateResponse.json()) as Record<string, unknown>;

      const secondCreateResponse = await app.fetch(
        new Request("http://localhost/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Hydration prompt",
            instructions: "Ask the resident to drink a glass of water.",
            cadence: "custom",
            cron: "* * * * *",
            scheduleLabel: "Every minute",
            timezone: "America/Los_Angeles",
          }),
        }),
      );

      expect(secondCreateResponse.status).toBe(200);
      const secondCreated = (await secondCreateResponse.json()) as Record<string, unknown>;
      const initialNextRun = String(firstCreated.nextRun);
      expect(String(secondCreated.nextRun)).toBe(initialNextRun);

      const executedCount = await app.runReminderSchedulerOnce(new Date(initialNextRun));
      expect(executedCount).toBe(2);

      const transcriptResponse = await app.fetch(new Request("http://localhost/api/transcript"));
      expect(transcriptResponse.status).toBe(200);
      const transcript = (await transcriptResponse.json()) as { entries: Array<Record<string, unknown>> };

      expect(
        transcript.entries.some((entry) => String(entry.text).includes("Reminder fired: Medication check-in")),
      ).toBe(true);
      expect(
        transcript.entries.some((entry) => String(entry.text).includes("Reminder fired: Hydration prompt")),
      ).toBe(true);
      expect(transcript.entries.some((entry) => entry.role === "robot")).toBe(true);
      expect(
        transcript.entries.filter((entry) => entry.toolName === "reminder-scheduler"),
      ).toHaveLength(4);
      expect(
        transcript.entries.filter((entry) => entry.text === "Agent has not been built yet"),
      ).toHaveLength(2);

      const remindersResponse = await app.fetch(new Request("http://localhost/api/reminders"));
      expect(remindersResponse.status).toBe(200);
      const reminders = (await remindersResponse.json()) as { reminders: Array<Record<string, unknown>> };
      expect(reminders.reminders).toHaveLength(2);
      expect(reminders.reminders.every((reminder) => String(reminder.nextRun) !== initialNextRun)).toBe(true);
    } finally {
      app.close();
      database.close();
    }
  });
});
