import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { GazabotDatabase } from "../src/db";

const cleanupPaths: string[] = [];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withFetchStub(stub: (url: string, init?: RequestInit) => Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | Request | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.href;
    return stub(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

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
    INFERENCE_CLOUD_API_KEY: "test-inference-key",
    BROWSER_USE_API_KEY: "test-browser-key",
    AGENT_CHUNK_DELAY_MS: "5",
    BROWSER_USE_POLL_INTERVAL_MS: "5",
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
    const restore = withFetchStub(async (url) => {
      if (url.includes("/chat/completions")) {
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Noted for later.", tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
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
        expect(bodyText).toContain("Noted for later.");

        const transcriptResponse = await app.fetch(new Request("http://localhost/api/transcript"));
        expect(transcriptResponse.status).toBe(200);
        const transcript = (await transcriptResponse.json()) as { entries: Array<Record<string, unknown>> };
        expect(transcript.entries).toHaveLength(2);
        expect(transcript.entries[0]?.text).toBe("Please note this for later.");
        expect(transcript.entries[1]?.role).toBe("robot");
        expect(transcript.entries[1]?.text).toBe("Noted for later.");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("updates browser state after a queued browser task", async () => {
    let completionRound = 0;
    let stopRequests = 0;
    const restore = withFetchStub(async (url, init) => {
      if (url.includes("/chat/completions")) {
        completionRound += 1;
        if (completionRound === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "run_browser_task",
                        arguments: JSON.stringify({
                          task: "Find the nearest pharmacy hours in the browser.",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Browser task finished.", tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
        });
      }

      if (url.includes("browser-use.com")) {
        const path = new URL(url).pathname;
        if (path.endsWith("/sessions") && init?.method === "POST") {
          return jsonResponse({ id: "remote-sess-1", status: "running", liveUrl: null });
        }
        if (init?.method === "GET" && /\/sessions\/[^/]+$/.test(path) && !path.endsWith("/stop")) {
          return jsonResponse({
            id: "remote-sess-1",
            status: "completed",
            output: { summary: "Pharmacy hours: 9am–5pm weekdays." },
            title: "Nearby pharmacy",
            url: "https://example.com/pharmacy",
          });
        }
        if (init?.method === "POST" && path.includes("/stop")) {
          stopRequests += 1;
          return jsonResponse({});
        }
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
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
        expect(String(browserPayload.browser.summary)).toContain("Pharmacy hours");
        expect(stopRequests).toBe(0);
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("stores prompt responses and plain notes in the same memory surface", async () => {
    const { app, database } = createTestApp();

    try {
      database.writeMemory("care_notes", "Resident prefers tea after dinner.");
      const prompt = database.createPrompt({
        title: "Medical intake",
        description: "Collect current health details.",
        memoryKey: "medical_profile",
        fields: [
          { name: "allergies", label: "Allergies", type: "text", required: true },
          { name: "uses_walker", label: "Uses walker", type: "boolean", required: false },
        ],
      });

      const respondResponse = await app.fetch(
        new Request(`http://localhost/api/prompts/${prompt.id}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response: {
              allergies: "Peanuts",
              uses_walker: true,
            },
          }),
        }),
      );

      expect(respondResponse.status).toBe(200);
      const respondPayload = (await respondResponse.json()) as {
        prompt: Record<string, unknown>;
        memoryEntry: Record<string, unknown>;
      };
      expect(respondPayload.prompt.status).toBe("completed");
      expect(respondPayload.memoryEntry.title).toBe("medical_profile");
      expect(respondPayload.memoryEntry.kind).toBe("structured");

      const memoryResponse = await app.fetch(new Request("http://localhost/api/memory"));
      expect(memoryResponse.status).toBe(200);
      const memoryPayload = (await memoryResponse.json()) as { entries: Array<Record<string, unknown>> };
      expect(memoryPayload.entries).toHaveLength(2);
      expect(memoryPayload.entries.some((entry) => entry.title === "care_notes" && entry.kind === "text")).toBe(true);
      expect(memoryPayload.entries.some((entry) => entry.title === "medical_profile" && entry.kind === "structured")).toBe(true);

      const profileResponse = await app.fetch(new Request("http://localhost/api/memory/medical_profile"));
      expect(profileResponse.status).toBe(200);
      const profilePayload = (await profileResponse.json()) as { entry: Record<string, unknown> };
      expect(profilePayload.entry.kind).toBe("structured");
      expect(profilePayload.entry.data).toEqual({
        allergies: "Peanuts",
        uses_walker: true,
      });
      expect(profilePayload.entry.schema).toHaveLength(2);
    } finally {
      app.close();
      database.close();
    }
  });

  test("runs simultaneous due reminders sequentially and records them in transcript history", async () => {
    const restore = withFetchStub(async (url) => {
      if (url.includes("/chat/completions")) {
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Reminder handled.", tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
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
        expect(transcript.entries.filter((entry) => entry.text === "Reminder handled.")).toHaveLength(2);

        const remindersResponse = await app.fetch(new Request("http://localhost/api/reminders"));
        expect(remindersResponse.status).toBe(200);
        const reminders = (await remindersResponse.json()) as { reminders: Array<Record<string, unknown>> };
        expect(reminders.reminders).toHaveLength(2);
        expect(reminders.reminders.every((reminder) => String(reminder.nextRun) !== initialNextRun)).toBe(true);
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("forceBrowser dispatches browser-use without waiting for the model to choose the tool", async () => {
    const restore = withFetchStub(async (url, init) => {
      if (url.includes("/chat/completions")) {
        return new Response("chat completions should not be called for forceBrowser requests", { status: 500 });
      }

      if (url.includes("browser-use.com")) {
        const path = new URL(url).pathname;
        if (path.endsWith("/sessions") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect(body.task).toBe("Open example.com in the browser.");
          return jsonResponse({ id: "remote-sess-force", status: "running", liveUrl: "https://live.example/session" });
        }
        if (init?.method === "GET" && /\/sessions\/[^/]+$/.test(path) && !path.endsWith("/stop")) {
          return jsonResponse({
            id: "remote-sess-force",
            status: "completed",
            output: { summary: "Example opened." },
            title: "Example Domain",
            url: "https://example.com",
            liveUrl: "https://live.example/session",
          });
        }
        if (init?.method === "POST" && path.includes("/stop")) {
          return jsonResponse({});
        }
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp();

      try {
        const response = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Open example.com in the browser.",
              source: "dashboard",
              forceBrowser: true,
            }),
          }),
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as Record<string, unknown>;
        expect(payload.route).toBe("browser_task");

        await new Promise((resolve) => setTimeout(resolve, 750));

        const browserResponse = await app.fetch(new Request("http://localhost/api/browser"));
        const browserPayload = (await browserResponse.json()) as { browser: Record<string, unknown> };
        expect(browserPayload.browser.status).toBe("idle");
        expect(browserPayload.browser.summary).toBe("Example opened.");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("waits for cloud terminal status before finalizing browser session", async () => {
    let completionRound = 0;
    let sessionPollCount = 0;
    let stopRequests = 0;
    const restore = withFetchStub(async (url, init) => {
      if (url.includes("/chat/completions")) {
        completionRound += 1;
        if (completionRound === 1) {
          return jsonResponse({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "run_browser_task",
                        arguments: JSON.stringify({
                          task: "Check if Browser Use waits for terminal status.",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          });
        }
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Browser task finished.", tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
        });
      }

      if (url.includes("browser-use.com")) {
        const path = new URL(url).pathname;
        if (path.endsWith("/sessions") && init?.method === "POST") {
          return jsonResponse({ id: "remote-sess-2", status: "running", liveUrl: "https://live.example/session2" });
        }

        if (init?.method === "GET" && /\/sessions\/[^/]+$/.test(path) && !path.endsWith("/stop")) {
          sessionPollCount += 1;
          if (sessionPollCount === 1) {
            return jsonResponse({
              id: "remote-sess-2",
              status: "running",
              output: { summary: "Partial output while still running." },
              liveUrl: "https://live.example/session2",
            });
          }

          return jsonResponse({
            id: "remote-sess-2",
            status: "completed",
            output: { summary: "Completed after terminal status." },
            title: "Terminal status test",
            url: "https://example.com/terminal",
            liveUrl: "https://live.example/session2",
          });
        }

        if (init?.method === "POST" && path.includes("/stop")) {
          stopRequests += 1;
          return jsonResponse({});
        }
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp();

      try {
        const response = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Check if Browser Use waits for terminal status.",
              source: "dashboard",
            }),
          }),
        );

        expect(response.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const browserResponse = await app.fetch(new Request("http://localhost/api/browser"));
        const browserPayload = (await browserResponse.json()) as { browser: Record<string, unknown> };
        expect(browserPayload.browser.status).toBe("idle");
        expect(browserPayload.browser.summary).toBe("Completed after terminal status.");
        expect(sessionPollCount).toBeGreaterThan(1);
        expect(stopRequests).toBe(0);
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("invalid Browser Use model falls back to bu-max", () => {
    const config = loadConfig({
      APP_NAME: "Gazabot Backend Test",
      DATABASE_PATH: join(tmpdir(), "gazabot-invalid-model.sqlite"),
      INFERENCE_CLOUD_API_KEY: "test-inference-key",
      BROWSER_USE_API_KEY: "test-browser-key",
      BROWSER_USE_MODEL: "not-a-real-browser-use-model",
    });

    expect(config.browserUse.model).toBe("bu-max");
  });

  test("legacy Browser Use model aliases to bu-max", () => {
    const config = loadConfig({
      APP_NAME: "Gazabot Backend Test",
      DATABASE_PATH: join(tmpdir(), "gazabot-legacy-model.sqlite"),
      INFERENCE_CLOUD_API_KEY: "test-inference-key",
      BROWSER_USE_API_KEY: "test-browser-key",
      BROWSER_USE_MODEL: "gemini-3.1-flash",
    });

    expect(config.browserUse.model).toBe("bu-max");
  });

  test("bu-medium aliases to bu-max", () => {
    const config = loadConfig({
      APP_NAME: "Gazabot Backend Test",
      DATABASE_PATH: join(tmpdir(), "gazabot-bu-medium-model.sqlite"),
      INFERENCE_CLOUD_API_KEY: "test-inference-key",
      BROWSER_USE_API_KEY: "test-browser-key",
      BROWSER_USE_MODEL: "bu-medium",
    });

    expect(config.browserUse.model).toBe("bu-max");
  });
});
