import type { TranscriptEntry, UserPrompt } from "./contracts";

type TranscriptEventType = "transcript" | "tool" | "tts" | "prompt";

function encodeSseFrame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export class TranscriptEventBus {
  private readonly subscribers = new Set<ReadableStreamDefaultController<string>>();

  publish(event: TranscriptEventType, payload: TranscriptEntry): void {
    const frame = encodeSseFrame(event, payload as unknown as Record<string, unknown>);
    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(frame);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  publishPrompt(prompt: UserPrompt): void {
    const frame = encodeSseFrame("prompt", prompt as unknown as Record<string, unknown>);
    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(frame);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  publishTts(text: string): void {
    const frame = encodeSseFrame("tts", { text });
    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(frame);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  createStream(): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        this.subscribers.add(controller);
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(": keepalive\n\n");
          } catch {
            clearInterval(keepAlive);
            this.subscribers.delete(controller);
          }
        }, 15_000);

        controller.enqueue(": connected\n\n");
      },
      cancel: () => {
        // Controller cleanup happens on enqueue failure when the socket closes.
      },
    });
  }
}
