export const DEFAULT_REMINDER_TIMEZONE = "America/Los_Angeles";

export function resolveReminderTimezone(timezone: unknown): string {
  if (typeof timezone !== "string") {
    return DEFAULT_REMINDER_TIMEZONE;
  }

  const trimmed = timezone.trim();
  return trimmed || DEFAULT_REMINDER_TIMEZONE;
}
