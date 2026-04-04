const WEEKDAY_LOOKUP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type ParsedField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = {
  minutes: ParsedField;
  hours: ParsedField;
  daysOfMonth: ParsedField;
  months: ParsedField;
  daysOfWeek: ParsedField;
};

type DateParts = {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timeZone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Unknown timezone: ${timeZone}`);
  }
}

function parseSegment(segment: string, min: number, max: number, normalize?: (value: number) => number): number[] {
  if (segment === "*") {
    const values: number[] = [];
    for (let value = min; value <= max; value += 1) {
      values.push(normalize ? normalize(value) : value);
    }
    return values;
  }

  const [rawRangePart, stepPart] = segment.split("/");
  const rangePart = rawRangePart ?? "*";
  const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron field step: ${segment}`);
  }

  let rangeStart = min;
  let rangeEnd = max;
  if (rangePart !== "*") {
    const [rawStart, rawEnd] = rangePart.split("-");
    rangeStart = Number.parseInt(rawStart ?? "", 10);
    rangeEnd = rawEnd === undefined ? rangeStart : Number.parseInt(rawEnd, 10);
  }

  if (
    !Number.isInteger(rangeStart) ||
    !Number.isInteger(rangeEnd) ||
    rangeStart < min ||
    rangeEnd > max ||
    rangeStart > rangeEnd
  ) {
    throw new Error(`Invalid cron field range: ${segment}`);
  }

  const values: number[] = [];
  for (let value = rangeStart; value <= rangeEnd; value += step) {
    values.push(normalize ? normalize(value) : value);
  }
  return values;
}

function parseField(source: string, min: number, max: number, normalize?: (value: number) => number): ParsedField {
  const trimmed = source.trim();
  const wildcard = trimmed === "*";
  const values = new Set<number>();

  for (const segment of trimmed.split(",")) {
    if (!segment.trim()) {
      throw new Error(`Invalid cron field: ${source}`);
    }

    for (const parsed of parseSegment(segment.trim(), min, max, normalize)) {
      values.add(parsed);
    }
  }

  return { values, wildcard };
}

function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Invalid cron expression.");
  }

  return {
    minutes: parseField(parts[0]!, 0, 59),
    hours: parseField(parts[1]!, 0, 23),
    daysOfMonth: parseField(parts[2]!, 1, 31),
    months: parseField(parts[3]!, 1, 12),
    daysOfWeek: parseField(parts[4]!, 0, 7, (value) => (value === 7 ? 0 : value)),
  };
}

function getLocalParts(date: Date, timeZone: string): DateParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values = new Map<string, string>();
  for (const part of parts) {
    values.set(part.type, part.value);
  }

  const weekdayName = values.get("weekday");
  const weekday = weekdayName ? WEEKDAY_LOOKUP[weekdayName] : undefined;
  if (weekday === undefined) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }

  return {
    month: Number.parseInt(values.get("month") ?? "0", 10),
    day: Number.parseInt(values.get("day") ?? "0", 10),
    hour: Number.parseInt(values.get("hour") ?? "0", 10),
    minute: Number.parseInt(values.get("minute") ?? "0", 10),
    weekday,
  };
}

function matchesDay(parsed: ParsedCron, parts: DateParts): boolean {
  const dayOfMonthMatch = parsed.daysOfMonth.values.has(parts.day);
  const dayOfWeekMatch = parsed.daysOfWeek.values.has(parts.weekday);

  if (parsed.daysOfMonth.wildcard && parsed.daysOfWeek.wildcard) {
    return true;
  }

  if (parsed.daysOfMonth.wildcard) {
    return dayOfWeekMatch;
  }

  if (parsed.daysOfWeek.wildcard) {
    return dayOfMonthMatch;
  }

  return dayOfMonthMatch || dayOfWeekMatch;
}

function matches(parsed: ParsedCron, date: Date, timeZone: string): boolean {
  const parts = getLocalParts(date, timeZone);
  return (
    parsed.minutes.values.has(parts.minute) &&
    parsed.hours.values.has(parts.hour) &&
    parsed.months.values.has(parts.month) &&
    matchesDay(parsed, parts)
  );
}

export function computeNextRun(cronExpression: string, timeZone: string, baseDate = new Date()): string {
  assertValidTimeZone(timeZone);
  const parsed = parseCronExpression(cronExpression);
  const candidate = new Date(baseDate);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let index = 0; index < 1_051_200; index += 1) {
    if (matches(parsed, candidate, timeZone)) {
      return candidate.toISOString();
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("Unable to compute next run within two years.");
}
