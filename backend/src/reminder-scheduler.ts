import type { AppConfig } from "./config";
import type { GazabotDatabase } from "./db";
import type { Reminder } from "./contracts";

type ReminderFirePayload = {
  reminder: Pick<Reminder, "id" | "title" | "instructions">;
  dueAt: string;
  prompt: string;
};

type ReminderCallback = (payload: ReminderFirePayload) => Promise<void>;

function buildPrompt(reminder: Reminder, dueAt: string): string {
  return `[Scheduled reminder at ${dueAt}] ${reminder.title}: ${reminder.instructions}`;
}

export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private nextDueAt: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly onFire: ReminderCallback,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    if (!this.running) return;
    const next = this.database.getNextReminderDueAt();
    if (next !== this.nextDueAt) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.scheduleNext();
    }
  }

  async runOnce(now = new Date()): Promise<number> {
    const claimed = this.database.claimDueReminders(now);
    for (const { reminder, dueAt } of claimed) {
      const prompt = buildPrompt(reminder, dueAt);
      try {
        await this.onFire({ reminder, dueAt, prompt });
      } catch (err) {
        console.error(`[reminder-scheduler] Error firing reminder ${reminder.id}:`, err);
      }
    }
    return claimed.length;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const next = this.database.getNextReminderDueAt();
    this.nextDueAt = next;

    if (!next) return;

    const delayMs = Math.max(0, new Date(next).getTime() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(() => this.scheduleNext());
    }, delayMs);
  }
}
