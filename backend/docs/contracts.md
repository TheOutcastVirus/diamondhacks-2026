# Backend Contracts

All frontend-facing routes are rooted at `/api` and return JSON unless marked as SSE.

---

## `GET /health`

```json
{ "status": "ok" }
```

---

## Reminders

### `GET /api/reminders`

```json
{
  "reminders": [
    {
      "id": "r_abc123",
      "title": "Hydration reminder",
      "instructions": "Prompt for water.",
      "cron": "0 15 * * *",
      "cadence": "daily",
      "scheduleLabel": "Every day at 15:00",
      "nextRun": "2026-04-05T22:00:00.000Z",
      "status": "active",
      "owner": "Gazabot agent",
      "timezone": "America/Los_Angeles",
      "attachments": [
        {
          "id": "file_abc123",
          "name": "prescription.pdf",
          "mimeType": "application/pdf",
          "sizeBytes": 48312,
          "textStatus": "ready"
        }
      ]
    }
  ]
}
```

### `POST /api/reminders`

Request:
```json
{
  "title": "Hydration reminder",
  "instructions": "Prompt for water.",
  "cadence": "daily",
  "cron": "0 15 * * *",
  "scheduleLabel": "Every day at 15:00",
  "timezone": "America/Los_Angeles",
  "attachmentFileIds": ["file_abc123"]
}
```

Response: single reminder object (same shape as above).

Validation:
- `cadence` must be `daily`, `weekly`, or `custom`
- `cron` must be a valid five-field cron expression
- `timezone` must be a valid IANA timezone name

---

## Transcript

### `GET /api/transcript`

```json
{
  "entries": [
    {
      "id": "t_abc123",
      "timestamp": "2026-04-04T19:00:00.000Z",
      "kind": "message",
      "role": "guardian",
      "text": "What reminders do I have?"
    },
    {
      "id": "t_abc124",
      "timestamp": "2026-04-04T19:00:01.000Z",
      "kind": "tool",
      "role": "system",
      "text": "Tool list_reminders completed",
      "toolName": "list_reminders",
      "toolStatus": "completed"
    }
  ]
}
```

`kind` values: `message`, `tool`  
`role` values: `robot`, `resident`, `guardian`, `system`  
`toolStatus` values: `started`, `completed`, `failed`

### `GET /api/transcript/stream` (SSE)

Response headers:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`

**Event types:**

| Event | Payload | Description |
|---|---|---|
| `transcript` | `TranscriptEntry` | New message from user or robot |
| `tool` | `TranscriptEntry` | Agent tool call started/completed/failed |
| `tts` | `{ text: string }` | Text to speak aloud via TTS |
| `prompt` | `UserPrompt` | Agent sent a form for the user to fill out |

Example frames:
```
event: transcript
data: {"id":"t_123","timestamp":"...","kind":"message","role":"robot","text":"You have no active reminders."}

event: tool
data: {"id":"t_124","timestamp":"...","kind":"tool","role":"system","text":"Tool list_reminders completed","toolName":"list_reminders","toolStatus":"completed"}

event: tts
data: {"text":"You have no active reminders."}

event: prompt
data: {"id":"p_abc123","title":"Credit Card Details","fields":[{"name":"card_number","label":"Card Number","type":"string","required":true},{"name":"cvv","label":"CVV","type":"password","required":true}],"status":"pending","createdAt":"..."}

: keepalive
```

---

## Agent

### `POST /api/agent/turn`

Request:
```json
{
  "message": "What reminders do I have?",
  "source": "resident",
  "forceBrowser": false,
  "profileId": "optional-browser-use-profile-id"
}
```

`source` must be `voice`, `dashboard`, `resident`, or `guardian`.

Conversation response:
```json
{
  "route": "conversation",
  "reply": "You have no active reminders."
}
```

Browser-task response:
```json
{
  "route": "browser_task",
  "browserSessionId": "bs_abc123",
  "previewUrl": null,
  "status": "queued"
}
```

Note: routing is now LLM-driven via tool calling. The agent decides when to use the browser. `forceBrowser: true` overrides this.

### `POST /api/agent/stream` (SSE)

Same request body as `/api/agent/turn`.

Event frames during the stream:

```
event: ready
data: {"source":"resident"}

event: chunk
data: {"delta":"You have ","done":false}

event: chunk
data: {"delta":"no active reminders.","done":false}

event: done
data: {"text":"You have no active reminders.","done":true}
```

On error:
```
event: error
data: {"message":"Agent stream failed."}
```

---

## Browser

### `GET /api/browser`

```json
{
  "browser": {
    "url": "https://example.com",
    "title": "Example Domain",
    "summary": "Mock browser run completed.",
    "status": "idle",
    "lastUpdated": "2026-04-04T19:00:00.000Z",
    "activeTask": "Search for latest AI news",
    "tabLabel": "Example",
    "domSnippet": "<main><h1>Example</h1></main>",
    "recentActions": [
      {
        "id": "a_abc123",
        "kind": "navigate",
        "detail": "Opened example.com",
        "timestamp": "2026-04-04T19:00:00.000Z",
        "status": "completed"
      }
    ]
  }
}
```

`status` values: `idle`, `navigating`, `executing`, `blocked`

---

## TTS

### `POST /api/tts`

Request:
```json
{ "text": "Hello, how can I help you?" }
```

Response:
```json
{ "spoken": true, "text": "Hello, how can I help you?" }
```

`spoken: false` if no `TTS_ENDPOINT` is configured. Either way, a `tts` SSE event is emitted on the transcript stream.

---

## User Input Prompts

Used when the agent needs structured input from the user (e.g. payment details, address, uploaded documents). The agent creates a prompt via its `request_user_input` tool; the frontend detects it via the `prompt` SSE event and renders the form.

### `GET /api/prompts`

Returns all pending (unfilled) prompts.

```json
{
  "prompts": [
    {
      "id": "p_abc123",
      "title": "Credit Card Details",
      "description": "Needed to complete your order.",
      "fields": [
        { "name": "card_number", "label": "Card Number", "type": "string", "required": true },
        { "name": "cardholder_name", "label": "Name on Card", "type": "string", "required": true },
        { "name": "expiry_month", "label": "Expiry Month", "type": "string", "required": true, "placeholder": "04" },
        { "name": "expiry_year", "label": "Expiry Year", "type": "string", "required": true, "placeholder": "2028" },
        { "name": "security_code", "label": "Security Code", "type": "password", "required": true },
        { "name": "billing_address_line_1", "label": "Billing Address Line 1", "type": "string", "required": true },
        { "name": "billing_city", "label": "Billing City", "type": "string", "required": true },
        { "name": "billing_state_or_region", "label": "Billing State / Region", "type": "string", "required": true },
        { "name": "billing_postal_code", "label": "Billing Postal Code", "type": "string", "required": true },
        { "name": "billing_country", "label": "Billing Country", "type": "string", "required": true }
      ],
      "status": "pending",
      "createdAt": "2026-04-04T19:00:00.000Z"
    }
  ]
}
```

### `POST /api/prompts/:id/respond`

Submit the filled form. Keys in `response` must match the `name` fields defined in the prompt.

Request:
```json
{
  "response": {
    "card_number": "4111111111111111",
    "cardholder_name": "Alice",
    "expiry_month": "04",
    "expiry_year": "2028",
    "security_code": "123"
  }
}
```

Response: the completed prompt object.
```json
{
  "prompt": {
    "id": "p_abc123",
    "title": "Credit Card Details",
    "fields": [...],
    "status": "completed",
    "createdAt": "...",
    "response": { "card_number": "4111111111111111", ... },
    "respondedAt": "2026-04-04T19:00:05.000Z"
  }
}
```

The response data is recorded as a transcript entry and a `tool` SSE event is emitted. After submitting, send a follow-up message via `/api/agent/turn` to continue the conversation with the collected data in context.

File fields return an array of uploaded file references, for example:
```json
[
  {
    "id": "file_abc123",
    "name": "prescription.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 48312,
    "textStatus": "ready"
  }
]
```

**Field types and recommended HTML inputs:**

| `type` | HTML input |
|---|---|
| `string` | `<input type="text">` |
| `password` | `<input type="password">` |
| `int` | `<input type="number" step="1">` |
| `float` | `<input type="number" step="any">` |
| `boolean` | `<input type="checkbox">` |
| `file` | `<input type="file">` |

---

## Files

### `GET /api/files`

Returns uploaded files available to the household.

### `POST /api/files`

Multipart form upload endpoint. Expected fields:
- `file`: uploaded file blob
- `displayName` (optional)
- `promptId` (optional)
- `fieldName` (optional)
- `reminderId` (optional)

Response:
```json
{
  "file": {
    "id": "file_abc123",
    "name": "prescription.pdf",
    "originalName": "prescription.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 48312,
    "textStatus": "ready",
    "createdAt": "2026-04-04T19:00:00.000Z",
    "extractedText": "Prescription contents..."
  }
}
```

### `GET /api/files/:id`

Returns one uploaded file record.

### `GET /api/files/:id/text`

Returns extracted text for the uploaded file and triggers extraction on demand if it has not already been produced.

---

## Error Envelope

All handled errors return:

```json
{
  "message": "Human readable error",
  "details": "Optional validation detail"
}
```

HTTP status codes: `400` bad input, `404` not found, `422` parse/validation error, `500` server error.
