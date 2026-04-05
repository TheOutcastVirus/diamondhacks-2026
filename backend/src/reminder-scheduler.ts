import type { AppConfig } from "./config";
import type { GazabotDatabase } from "./db";
import type { Reminder } from "./contracts";

type ReminderFirePayload = {
  reminder: Pick<Reminder, "id" | "title" | "instructions">;
  dueAt: string;
  prompt: string;
};

type ReminderCallback = (payload: ReminderFirePayload) => Promise<void>;

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

  private schedulerActive = false;

  private executing = false;

  private nextDueAt: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: GazabotDatabase,
    private readonly executeReminder: ReminderCallback,
  ) {}

  start(): void {
    if (!this.config.reminders.enabled || this.schedulerActive) {
      return;
    }

    this.schedulerActive = true;
    this.scheduleNextRun();
  }

  stop(): void {
    this.schedulerActive = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextDueAt = null;
  }

  refresh(): void {
    if (!this.config.reminders.enabled || !this.schedulerActive) {
      return;
    }

    const next = this.database.getNextReminderDueAt();
    if (next !== this.nextDueAt) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.scheduleNextRun();
    }
  }

  async runOnce(now = new Date()): Promise<number> {
    return this.runDueReminders(now);
  }

  private scheduleNextRun(): void {
    if (!this.schedulerActive) {
      return;
    }

    const next = this.database.getNextReminderDueAt();
    this.nextDueAt = next;

    if (!next) {
      return;
    }

    const nextDueTime = new Date(next);
    if (Number.isNaN(nextDueTime.valueOf())) {
      console.error(`[reminder] Invalid next_run value skipped: ${next}`);
      this.nextDueAt = null;
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
    if (this.executing) {
      return 0;
    }

    this.executing = true;
    let totalExecuted = 0;

    try {
      let currentNow = initialNow;

      while (true) {
        const claimed = this.database.claimDueReminders(currentNow);
        if (claimed.length === 0) {
          break;
        }

        for (const { reminder, dueAt } of claimed) {
          try {
            await this.executeReminder({
              reminder,
              dueAt,
              prompt: buildReminderPrompt(reminder, dueAt),
            });
            totalExecuted += 1;
          } catch (error) {
            console.error(`[reminder-scheduler] Error firing reminder ${reminder.id}:`, error);
          }
        }

        currentNow = new Date();
      }

      return totalExecuted;
    } finally {
      this.executing = false;
      this.scheduleNextRun();
    }
  }
}
