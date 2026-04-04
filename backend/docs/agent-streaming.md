# Agent Streaming Integration

`src/agent.ts` exposes the agent harness entrypoint used by the HTTP layer:

- `streamPrompt(prompt: string): ReadableStream<string>`
- `collectPrompt(prompt: string): Promise<string>`

Right now the harness is only a stub. Every prompt streams the chunked response:

```text
Agent has not been built yet
```

## Service-to-backend flow

For robot or bot services that need incremental text for speech, call:

- `POST /api/agent/stream`

Request:

```json
{
  "message": "Tell me what you can do.",
  "source": "voice",
  "forceBrowser": false
}
```

The response is an SSE stream over the POST response body. Event order:

1. `ready`
2. one or more `chunk`
3. `done`

Example response body:

```text
event: ready
data: {"source":"voice"}

event: chunk
data: {"delta":"Agent ","done":false}

event: chunk
data: {"delta":"has ","done":false}

event: done
data: {"text":"Agent has not been built yet","done":true}
```

## Bun service example

```ts
const response = await fetch("http://127.0.0.1:3000/api/agent/stream", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "text/event-stream"
  },
  body: JSON.stringify({
    message: "Tell me what you can do.",
    source: "voice",
    forceBrowser: false
  })
});

const reader = response.body
  ?.pipeThrough(new TextDecoderStream())
  .getReader();

let buffered = "";

while (reader) {
  const { done, value } = await reader.read();
  if (done) break;
  buffered += value;

  let boundary = buffered.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);

    const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) {
      boundary = buffered.indexOf("\n\n");
      continue;
    }

    const eventName = eventLine.slice("event: ".length);
    const payload = JSON.parse(dataLine.slice("data: ".length));

    if (eventName === "chunk") {
      console.log(payload.delta);
    }

    if (eventName === "done") {
      console.log("Final text:", payload.text);
    }

    boundary = buffered.indexOf("\n\n");
  }
}
```

## Transcript side effects

Both agent endpoints also persist transcript history:

- the inbound user message is stored immediately
- the final robot reply is stored when streaming finishes
- `/api/transcript/stream` emits those final transcript entries for the dashboard

## BrowserUse note

Conversational streaming and browser task routing are separate:

- use `POST /api/agent/stream` for chunked speech-oriented replies
- use `POST /api/agent/turn` for browser-task dispatch and JSON responses
