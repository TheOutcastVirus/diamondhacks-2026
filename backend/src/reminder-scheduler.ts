import type { AppConfig } from "./config";
import type { Reminder } from "./contracts";
import type { ClaimedReminder, GazabotDatabase } from "./db";

type ReminderExecutor = (input: ClaimedReminder & { prompt: string }) => Promise<void>;

export function buildReminderPrompt(reminder: Pick<Reminder, "title" | "instructions">, dueAt: string): string {
  return [
    `A scheduled reminder is due now.`,
    `Title: ${reminder.title}`,
    `Scheduled for: ${dueAt}`,
    `Instructions: ${reminder.instructions}`,
    `Deliver the reminder to the resident now. Respond naturally and use speech if appropriate.`,
  ].join("\n");
}

export class ReminderScheduler {
  private static readonly MAX_TIMEOUT_MS = 2_147_483_647;

  private timer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private refreshRequested = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly executeReminder: ReminderExecutor,
  ) {}

  start(): void {
    if (!this.config.reminders.enabled) {
      return;
    }

    this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    if (!this.config.reminders.enabled) {
      return;
    }

    if (this.running) {
      this.refreshRequested = true;
      return;
    }

    this.scheduleNextRun();
  }

  async runOnce(now = new Date()): Promise<number> {
    return this.runDueReminders(now);
  }

  private scheduleNextRun(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextDueAt = this.database.getNextReminderDueAt();
    if (!nextDueAt) {
      return;
    }

    const nextDueTime = new Date(nextDueAt);
    if (Number.isNaN(nextDueTime.valueOf())) {
      console.error(`[reminder] Invalid next_run value skipped: ${nextDueAt}`);
      return;
    }

    const delayMs = nextDueTime.valueOf() - Date.now();
    const boundedDelayMs = Math.min(Math.max(delayMs, 0), ReminderScheduler.MAX_TIMEOUT_MS);

    this.timer = setTimeout(() => {
      this.timer = null;

      if (delayMs > ReminderScheduler.MAX_TIMEOUT_MS) {
        this.scheduleNextRun();
        return;
      }

      void this.runDueReminders(new Date()).catch((error) => {
        console.error("[reminder] Scheduler execution failed:", error);
        this.refresh();
      });
    }, boundedDelayMs);
  }

  private async runDueReminders(initialNow: Date): Promise<number> {
    if (this.running) {
      this.refreshRequested = true;
      return 0;
    }

    this.running = true;
    let totalExecuted = 0;

    try {
      let currentNow = initialNow;

      while (true) {
        const claimed = this.database.claimDueReminders(currentNow);
        if (claimed.length === 0) {
          break;
        }

        for (const reminder of claimed) {
          await this.executeReminder({
            ...reminder,
            prompt: buildReminderPrompt(reminder.reminder, reminder.dueAt),
          });
          totalExecuted += 1;
        }

        currentNow = new Date();
      }

      return totalExecuted;
    } finally {
      this.running = false;
      this.refreshRequested = false;
      this.scheduleNextRun();
    }
  }
}
