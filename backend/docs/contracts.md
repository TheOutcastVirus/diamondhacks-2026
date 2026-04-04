# Backend Contracts

All frontend-facing routes are rooted at `/api` and return JSON unless marked as SSE.

## `GET /health`

Response:

```json
{
  "status": "ok"
}
```

## `GET /api/reminders`

Response:

```json
{
  "reminders": [
    {
      "id": "r_123",
      "title": "Hydration reminder",
      "instructions": "Prompt for water.",
      "cron": "0 15 * * *",
      "cadence": "daily",
      "scheduleLabel": "Every day at 15:00",
      "nextRun": "2026-04-05T22:00:00.000Z",
      "status": "active",
      "owner": "Gazabot agent",
      "timezone": "America/Los_Angeles"
    }
  ]
}
```

## `POST /api/reminders`

Request:

```json
{
  "title": "Hydration reminder",
  "instructions": "Prompt for water.",
  "cadence": "daily",
  "cron": "0 15 * * *",
  "scheduleLabel": "Every day at 15:00",
  "timezone": "America/Los_Angeles"
}
```

Response: a single reminder object with the same shape used in `GET /api/reminders`.

Validation notes:

- `cadence` must be `daily`, `weekly`, or `custom`.
- `cron` must be a five-field cron expression.
- `timezone` must be a valid IANA timezone.

## `GET /api/transcript`

Response:

```json
{
  "entries": [
    {
      "id": "t_123",
      "timestamp": "2026-04-04T19:00:00.000Z",
      "kind": "message",
      "role": "guardian",
      "text": "Please note this for later."
    },
    {
      "id": "t_124",
      "timestamp": "2026-04-04T19:00:01.000Z",
      "kind": "tool",
      "role": "system",
      "text": "Queued browser task: Find the nearest pharmacy hours in the browser.",
      "toolName": "browser-use",
      "toolStatus": "started",
      "metadata": {
        "browserSessionId": "bs_123"
      }
    }
  ]
}
```

## `GET /api/transcript/stream` (SSE)

Response headers:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`

Event types:

- `transcript`
- `tool`

Each event payload is a single transcript entry:

```text
event: transcript
data: {"id":"t_123","timestamp":"2026-04-04T19:00:00.000Z","kind":"message","role":"robot","text":"Agent has not been built yet"}
```

Keepalive comments are sent periodically:

```text
: keepalive
```

## `GET /api/browser`

Response:

```json
{
  "browser": {
    "url": "https://example.com",
    "title": "Example Domain",
    "summary": "Pharmacy hours: 9am–5pm weekdays.",
    "status": "idle",
    "lastUpdated": "2026-04-04T19:00:00.000Z",
    "activeTask": "Find the nearest pharmacy hours in the browser.",
    "tabLabel": "Example",
    "domSnippet": "<main><h1>Example Domain</h1></main>",
    "recentActions": [
      {
        "id": "a_123",
        "kind": "navigate",
        "detail": "Sent task to Browser Use Cloud.",
        "timestamp": "2026-04-04T19:00:00.000Z",
        "status": "completed"
      }
    ]
  }
}
```

## `POST /api/agent/turn`

Request:

```json
{
  "message": "Please note this for later.",
  "source": "guardian",
  "forceBrowser": false,
  "profileId": "optional-browser-use-profile-id"
}
```

Conversation response:

```json
{
  "route": "conversation",
  "reply": "Agent has not been built yet"
}
```

Browser-task response:

```json
{
  "route": "browser_task",
  "browserSessionId": "bs_123",
  "previewUrl": null,
  "status": "queued"
}
```

Routing notes:

- `source` must be `voice`, `dashboard`, `resident`, or `guardian`.
- `forceBrowser` overrides keyword routing.
- Browser tasks are queued asynchronously; state is reflected through `/api/browser` and `/api/transcript`.

## Error envelope

All handled errors return:

```json
{
  "message": "Human readable error",
  "details": "Optional validation detail"
}
```
