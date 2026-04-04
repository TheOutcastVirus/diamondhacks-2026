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

function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "gazabot-backend-"));
  cleanupPaths.push(directory);

  const config = loadConfig({
    APP_NAME: "Gazabot Backend Test",
    DATABASE_PATH: join(directory, "test.sqlite"),
    INFERENCE_CLOUD_API_KEY: "test-inference-key",
    BROWSER_USE_API_KEY: "test-browser-key",
    AGENT_CHUNK_DELAY_MS: "5",
    BROWSER_USE_POLL_INTERVAL_MS: "5",
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
