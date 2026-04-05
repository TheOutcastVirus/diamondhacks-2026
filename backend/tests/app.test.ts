import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseDshowAudioDevices, parseOpenAlCaptureDevices, playbackArgsForPlatform, recordingArgsForPlatform } from "../src/audio";
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
    UPLOADS_DIR: join(directory, "uploads"),
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

  test("defaults agent-created reminders to Los Angeles when timezone is omitted", async () => {
    let completionRound = 0;
    const restore = withFetchStub(async (url) => {
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
                        name: "create_reminder",
                        arguments: JSON.stringify({
                          title: "Morning medication",
                          instructions: "Prompt for the morning pills.",
                          cadence: "daily",
                          cron: "0 9 * * *",
                          scheduleLabel: "Every day at 09:00",
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
              message: { role: "assistant", content: "Reminder saved.", tool_calls: undefined },
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
        const response = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Set a daily medication reminder for 9am.",
              source: "guardian",
            }),
          }),
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as Record<string, unknown>;
        expect(payload.route).toBe("conversation");
        expect(payload.reply).toBe("Reminder saved.");

        const remindersResponse = await app.fetch(new Request("http://localhost/api/reminders"));
        expect(remindersResponse.status).toBe(200);
        const remindersPayload = (await remindersResponse.json()) as { reminders: Array<Record<string, unknown>> };
        expect(remindersPayload.reminders).toHaveLength(1);
        expect(remindersPayload.reminders[0]?.timezone).toBe("America/Los_Angeles");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("reuses deterministic rerun workspaces for repeat merchant orders", async () => {
    const sessionBodies: Array<Record<string, unknown>> = [];
    let workspaceCreates = 0;
    let sessionCreates = 0;

    const restore = withFetchStub(async (url, init) => {
      if (url.endsWith("/workspaces")) {
        workspaceCreates += 1;
        expect(init?.method).toBe("POST");
        return jsonResponse({ id: "ws_cvs_repeat" });
      }

      if (url.endsWith("/sessions")) {
        sessionCreates += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sessionBodies.push(body);

        if (sessionCreates === 1) {
          expect(body.workspaceId).toBe("ws_cvs_repeat");
          expect(String(body.task)).toContain("Go to https://www.cvs.com and sign in with the saved account.");
          expect(String(body.task)).toContain("Order the following items: chips.");
          return jsonResponse({
            id: "remote-order-1",
            status: "running",
            liveUrl: "https://browser-use.example/live/1",
            workspaceId: "ws_cvs_repeat",
          });
        }

        expect(body.workspaceId).toBe("ws_cvs_repeat");
        expect(String(body.task)).toContain("Go to https://www.cvs.com and sign in with the saved account.");
        expect(String(body.task)).toContain("Order the following items: pretzels.");
        return jsonResponse({
          id: "remote-order-2",
          status: "running",
          liveUrl: "https://browser-use.example/live/2",
          workspaceId: "ws_cvs_repeat",
        });
      }

      if (url.endsWith("/sessions/remote-order-1")) {
        return jsonResponse({
          id: "remote-order-1",
          status: "completed",
          output: "Ordered chips from CVS.",
          title: "CVS checkout",
          url: "https://www.cvs.com/",
          workspaceId: "ws_cvs_repeat",
          llmCostUsd: "0.21",
        });
      }

      if (url.endsWith("/sessions/remote-order-2")) {
        return jsonResponse({
          id: "remote-order-2",
          status: "completed",
          output: "Ordered pretzels from CVS.",
          title: "CVS checkout",
          url: "https://www.cvs.com/",
          workspaceId: "ws_cvs_repeat",
          llmCostUsd: "0",
        });
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp({
        INFERENCE_CLOUD_API_KEY: "",
      });

      try {
        const firstOrderResponse = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Order chips from CVS",
              source: "guardian",
              forceBrowser: true,
            }),
          }),
        );

        expect(firstOrderResponse.status).toBe(200);
        expect(workspaceCreates).toBe(1);
        expect(sessionCreates).toBe(1);
        await Bun.sleep(30);

        const secondOrderResponse = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Order pretzels from CVS",
              source: "guardian",
              forceBrowser: true,
            }),
          }),
        );

        expect(secondOrderResponse.status).toBe(200);
        expect(workspaceCreates).toBe(1);
        expect(sessionCreates).toBe(2);
        expect(sessionBodies).toHaveLength(2);
        await Bun.sleep(30);

        const browserResponse = await app.fetch(new Request("http://localhost/api/browser"));
        expect(browserResponse.status).toBe(200);
        const browserPayload = (await browserResponse.json()) as {
          browser: { summary: string; recentActions: Array<{ detail: string }> };
        };

        expect(browserPayload.browser.summary).toContain("$0 LLM cost");
        expect(browserPayload.browser.recentActions.some((action) => action.detail.includes("deterministic rerun"))).toBe(
          true,
        );

        const orders = database.listShoppingOrders();
        expect(orders).toHaveLength(2);
        expect(orders[0]?.merchant).toBe("CVS");
        expect(orders[0]?.itemName).toBe("pretzels");
        expect(orders[1]?.itemName).toBe("chips");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("defaults agent-created reminders to Los Angeles when timezone is omitted", async () => {
    let completionRound = 0;
    const restore = withFetchStub(async (url) => {
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
                        name: "create_reminder",
                        arguments: JSON.stringify({
                          title: "Morning medication",
                          instructions: "Prompt for the morning pills.",
                          cadence: "daily",
                          cron: "0 9 * * *",
                          scheduleLabel: "Every day at 09:00",
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
              message: { role: "assistant", content: "Reminder saved.", tool_calls: undefined },
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
        const response = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Set a daily medication reminder for 9am.",
              source: "guardian",
            }),
          }),
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as Record<string, unknown>;
        expect(payload.route).toBe("conversation");
        expect(payload.reply).toBe("Reminder saved.");

        const remindersResponse = await app.fetch(new Request("http://localhost/api/reminders"));
        expect(remindersResponse.status).toBe(200);
        const remindersPayload = (await remindersResponse.json()) as { reminders: Array<Record<string, unknown>> };
        expect(remindersPayload.reminders).toHaveLength(1);
        expect(remindersPayload.reminders[0]?.timezone).toBe("America/Los_Angeles");
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

  test("uploads documents, extracts PDF text, and links files to reminders", async () => {
    const restore = withFetchStub(async (url, init) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const parts = (((body.contents as Array<Record<string, unknown>> | undefined)?.[0]?.parts ??
          []) as Array<Record<string, unknown>>);
        expect(
          parts.some((part) => {
            const inlineData = part.inlineData as Record<string, unknown> | undefined;
            return inlineData?.mimeType === "application/pdf";
          }),
        ).toBe(true);
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: "Hello Prescription" }],
              },
            },
          ],
        });
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp({
        GOOGLE_AI_API_KEY: "test-google-key",
      });

      try {
        const form = new FormData();
        form.append(
          "file",
          new File(
            [
              `%PDF-1.4
1 0 obj
<< /Length 53 >>
stream
BT
/F1 12 Tf
72 720 Td
(Hello Prescription) Tj
ET
endstream
endobj
trailer <<>>
%%EOF`,
            ],
            "prescription.pdf",
            { type: "application/pdf" },
          ),
        );

        const uploadResponse = await app.fetch(
          new Request("http://localhost/api/files", {
            method: "POST",
            body: form,
          }),
        );

        expect(uploadResponse.status).toBe(200);
        const uploadPayload = (await uploadResponse.json()) as { file: Record<string, unknown> };
        expect(uploadPayload.file.name).toBe("prescription.pdf");
        expect(uploadPayload.file.textStatus).toBe("ready");
        expect(String(uploadPayload.file.extractedText)).toContain("Hello");

        const fileId = String(uploadPayload.file.id);

        const reminderResponse = await app.fetch(
          new Request("http://localhost/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Mail prescription",
              instructions: "Mail the attached prescription to the pharmacy.",
              cadence: "daily",
              cron: "0 10 * * *",
              scheduleLabel: "Every day at 10:00",
              timezone: "America/Los_Angeles",
              attachmentFileIds: [fileId],
            }),
          }),
        );

        expect(reminderResponse.status).toBe(200);
        const reminderPayload = (await reminderResponse.json()) as Record<string, unknown>;
        expect(Array.isArray(reminderPayload.attachments)).toBe(true);
        expect((reminderPayload.attachments as Array<Record<string, unknown>>)[0]?.name).toBe("prescription.pdf");

        const textResponse = await app.fetch(new Request(`http://localhost/api/files/${fileId}/text`));
        expect(textResponse.status).toBe(200);
        const textPayload = (await textResponse.json()) as Record<string, unknown>;
        expect(textPayload.textStatus).toBe("ready");
        expect(String(textPayload.text)).toContain("Hello");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("extracts image uploads into text with Google AI when needed", async () => {
    const restore = withFetchStub(async (url, init) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const parts = (((body.contents as Array<Record<string, unknown>> | undefined)?.[0]?.parts ??
          []) as Array<Record<string, unknown>>);
        const promptPart = parts.find((part) => typeof part.text === "string");
        expect(promptPart).toBeDefined();
        expect(String(promptPart?.text)).toContain("Extract all clearly visible text and numbers from this image");
        expect(
          parts.some((part) => {
            const inlineData = part.inlineData as Record<string, unknown> | undefined;
            return typeof inlineData?.mimeType === "string" && String(inlineData.mimeType).startsWith("image/");
          }),
        ).toBe(true);
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: "Medication bottle label: Take one tablet daily." }],
              },
            },
          ],
        });
      }

      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp({
        GOOGLE_AI_API_KEY: "test-google-key",
      });

      try {
        const form = new FormData();
        form.append("file", new File(["fake-image"], "label.png", { type: "image/png" }));

        const uploadResponse = await app.fetch(
          new Request("http://localhost/api/files", {
            method: "POST",
            body: form,
          }),
        );

        expect(uploadResponse.status).toBe(200);
        const uploadPayload = (await uploadResponse.json()) as { file: Record<string, unknown> };
        expect(uploadPayload.file.textStatus).toBe("ready");
        expect(String(uploadPayload.file.extractedText)).toContain("Take one tablet daily");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("read_uploaded_file tool returns metadata and extracted text content", async () => {
    let completionRound = 0;
    let secondRequestMessages: Array<Record<string, unknown>> = [];
    let uploadedFileId = "";
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
                        name: "read_uploaded_file",
                        arguments: JSON.stringify({
                          id: uploadedFileId,
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

        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
        secondRequestMessages = body.messages ?? [];
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Reviewed the file.", tool_calls: undefined },
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
        const uploaded = database.createUploadedFile({
          name: "care-plan.txt",
          originalName: "care-plan.txt",
          storagePath: "C:\\tmp\\care-plan.txt",
          mimeType: "text/plain",
          sizeBytes: 24,
        });
        uploadedFileId = uploaded.id;
        database.updateUploadedFileExtraction(uploaded.id, {
          textStatus: "ready",
          extractedText: "Morning meds at 9am.",
        });

        const response = await app.fetch(
          new Request("http://localhost/api/agent/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: "Read the care plan file.",
              source: "guardian",
            }),
          }),
        );

        expect(response.status).toBe(200);
        const payload = (await response.json()) as Record<string, unknown>;
        expect(payload.reply).toBe("Reviewed the file.");

        const toolMessage = secondRequestMessages.find((message) => message.role === "tool");
        expect(toolMessage).toBeDefined();
        const toolContent = JSON.parse(String(toolMessage?.content ?? "{}")) as Record<string, unknown>;
        expect(toolContent.name).toBe("care-plan.txt");
        expect(toolContent.mimeType).toBe("text/plain");
        expect(toolContent.contentText).toBe("Morning meds at 9am.");
      } finally {
        app.close();
        database.close();
      }
    } finally {
      restore();
    }
  });

  test("accepts file fields in prompts and stores uploaded file references in structured memory", async () => {
    const { app, database } = createTestApp();

    try {
      const prompt = database.createPrompt({
        title: "Prescription upload",
        description: "Attach the prescription that should be mailed.",
        memoryKey: "prescription_packet",
        fields: [
          { name: "prescription_files", label: "Prescription", type: "file", required: true, accept: ".pdf" },
          { name: "delivery_address", label: "Delivery address", type: "text", required: true },
        ],
      });

      const form = new FormData();
      form.append("promptId", prompt.id);
      form.append("fieldName", "prescription_files");
      form.append("file", new File(["doctor notes"], "rx.txt", { type: "text/plain" }));

      const uploadResponse = await app.fetch(
        new Request("http://localhost/api/files", {
          method: "POST",
          body: form,
        }),
      );

      expect(uploadResponse.status).toBe(200);
      const uploadPayload = (await uploadResponse.json()) as { file: Record<string, unknown> };

      const respondResponse = await app.fetch(
        new Request(`http://localhost/api/prompts/${prompt.id}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response: {
              prescription_files: [uploadPayload.file],
              delivery_address: "123 Main St\nSpringfield, CA 90210",
            },
          }),
        }),
      );

      expect(respondResponse.status).toBe(200);
      const respondPayload = (await respondResponse.json()) as { memoryEntry: Record<string, unknown> };
      const data = respondPayload.memoryEntry.data as Record<string, unknown>;
      expect(Array.isArray(data.prescription_files)).toBe(true);
      expect((data.prescription_files as Array<Record<string, unknown>>)[0]?.name).toBe("rx.txt");
      expect((data.prescription_files as Array<Record<string, unknown>>)[0]?.textStatus).toBe("ready");
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

  test("speaks reminder replies aloud when a due reminder returns text", async () => {
    const restore = withFetchStub(async (url) => {
      if (url.includes("/chat/completions")) {
        return jsonResponse({
          choices: [
            {
              message: { role: "assistant", content: "Hello, it is time to take your medicine.", tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
        });
      }
      return new Response(`unexpected fetch: ${url}`, { status: 501 });
    });

    try {
      const { app, database } = createTestApp();
      const synthesizeCalls: string[] = [];
      const playedAudio: Buffer[] = [];

      (app as unknown as {
        ttsService: { synthesize: (text: string) => Promise<Buffer> };
        audioService: { playAudio: (audio: Buffer) => Promise<void> };
      }).ttsService.synthesize = async (text: string) => {
        synthesizeCalls.push(text);
        return Buffer.from("fake-audio");
      };

      (app as unknown as {
        audioService: { playAudio: (audio: Buffer) => Promise<void> };
      }).audioService.playAudio = async (audio: Buffer) => {
        playedAudio.push(audio);
      };

      try {
        const createResponse = await app.fetch(
          new Request("http://localhost/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Medication reminder",
              instructions: "Say hello and remind the resident to take medicine.",
              cadence: "custom",
              cron: "* * * * *",
              scheduleLabel: "Every minute",
              timezone: "America/Los_Angeles",
            }),
          }),
        );

        expect(createResponse.status).toBe(200);
        const created = (await createResponse.json()) as Record<string, unknown>;
        const dueAt = String(created.nextRun);

        const executedCount = await app.runReminderSchedulerOnce(new Date(dueAt));
        expect(executedCount).toBe(1);
        expect(synthesizeCalls).toEqual(["Hello, it is time to take your medicine."]);
        expect(playedAudio).toHaveLength(1);
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

  test("keeps Linux voice capture on ALSA for production hosts", () => {
    const command = recordingArgsForPlatform("linux", "/tmp/voice.wav");

    expect(command.cmd).toBe("ffmpeg");
    expect(command.args).toContain("alsa");
    expect(command.args).toContain("default");
    expect(command.args).not.toContain("wasapi");
  });

  test("uses avfoundation for macOS voice capture", () => {
    const command = recordingArgsForPlatform("darwin", "/tmp/voice.wav");

    expect(command.cmd).toBe("ffmpeg");
    expect(command.args).toContain("avfoundation");
    expect(command.args).toContain(":0");
  });

  test("extracts Windows OpenAL capture devices from ffmpeg output", () => {
    const devices = parseOpenAlCaptureDevices(`
[in#0 @ 0000023825296ec0] List of OpenAL capture devices on this system:
[in#0 @ 0000023825296ec0]   OpenAL Soft on Microphone Array (Realtek(R) Audio)
Error opening input file dummy.
`);

    expect(devices).toEqual(["OpenAL Soft on Microphone Array (Realtek(R) Audio)"]);
  });

  test("extracts Windows DirectShow audio devices from ffmpeg output", () => {
    const devices = parseDshowAudioDevices(`
[in#0 @ 000001b920c86ec0] "Microphone Array (Realtek(R) Audio)" (audio)
[in#0 @ 000001b920c86ec0]   Alternative name "@device_cm_{GUID}\\wave_{GUID}"
[in#0 @ 000001b920c86ec0] "OBS Virtual Camera" (video)
`);

    expect(devices).toEqual(["Microphone Array (Realtek(R) Audio)"]);
  });

  test("uses native playback commands for each supported OS", () => {
    expect(playbackArgsForPlatform("darwin", "/tmp/reply.mp3")).toEqual({
      cmd: "afplay",
      args: ["/tmp/reply.mp3"],
    });

    expect(playbackArgsForPlatform("linux", "/tmp/reply.mp3")).toEqual({
      cmd: "ffplay",
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "/tmp/reply.mp3"],
    });

    expect(playbackArgsForPlatform("win32", "C:\\temp\\reply.mp3")).toEqual({
      cmd: "ffplay",
      args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "C:\\temp\\reply.mp3"],
    });
  });

  test("fails fast on unsupported platforms instead of guessing an audio backend", () => {
    expect(() => recordingArgsForPlatform("aix", "/tmp/voice.wav")).toThrow(
      'Audio recording is not supported on platform "aix".',
    );
    expect(() => playbackArgsForPlatform("aix", "/tmp/reply.mp3")).toThrow(
      'Audio playback is not supported on platform "aix".',
    );
  });
});
