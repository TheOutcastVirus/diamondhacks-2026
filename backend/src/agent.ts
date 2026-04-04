function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentHarness {
  constructor(private readonly chunkDelayMs: number) {}

  streamPrompt(_prompt: string): ReadableStream<string> {
    const chunks = ["Agent ", "has ", "not ", "been ", "built ", "yet"];

    return new ReadableStream<string>({
      start: (controller) => {
        void (async () => {
          try {
            for (const chunk of chunks) {
              await delay(this.chunkDelayMs);
              controller.enqueue(chunk);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        })();
      },
    });
  }

  async collectPrompt(prompt: string): Promise<string> {
    let text = "";
    const reader = this.streamPrompt(prompt).getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      text += value;
    }

    return text || "Agent has not been built yet";
  }
}
