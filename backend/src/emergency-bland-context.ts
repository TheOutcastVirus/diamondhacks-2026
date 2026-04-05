import { buildRecentActivitySnapshot, formatRecentActivityForBland } from "./activity";
import type { UserMemoryEntry } from "./contracts";
import type { SodiumDatabase } from "./db";

export type EmergencyCallSource = "keyword" | "agent" | "guardian";

const MAX_FIELD = 4000;
const MAX_BRIEF = 3500;
const MAX_MEMORY_LINE = 420;
const MAX_MESSAGES = 22;

function clampText(value: string, max: number): string {
  const t = value.trim().replace(/\s+/g, " ");
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

function isSensitiveMemoryTitle(title: string): boolean {
  const k = title.toLowerCase();
  return (
    k.includes("password") ||
    k.includes("card") ||
    k.includes("cvv") ||
    k.includes("payment") ||
    k.includes("ssn") ||
    k.includes("secret") ||
    k.includes("token") ||
    k === "family_contact_primary" ||
    k.endsWith("family_contact_primary")
  );
}

function isSensitiveDataKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("card") ||
    k.includes("cvv") ||
    k.includes("security_code") ||
    k.includes("password") ||
    k.includes("phone") ||
    k.includes("ssn") ||
    k.includes("token")
  );
}

function sanitizeStructuredData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveDataKey(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function memoryEntryExcerpt(entry: UserMemoryEntry): string {
  if (entry.kind === "structured" && entry.data && Object.keys(entry.data).length > 0) {
    const safe = sanitizeStructuredData(entry.data);
    if (Object.keys(safe).length === 0) {
      return "";
    }
    return clampText(JSON.stringify(safe), MAX_MEMORY_LINE);
  }
  return clampText(entry.content, MAX_MEMORY_LINE);
}

/** Recent transcript messages only (Resident / Assistant / Guardian), newest at end. */
export function buildRecentChatForBland(db: SodiumDatabase): string {
  const lines: string[] = [];
  const entries = db.listTranscriptEntries();
  for (let index = entries.length - 1; index >= 0 && lines.length < MAX_MESSAGES; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== "message") {
      continue;
    }
    const speaker =
      entry.role === "robot" ? "Assistant" : entry.role === "guardian" ? "Guardian" : "Resident";
    const text = entry.text.trim().replace(/\s+/g, " ");
    if (!text) {
      continue;
    }
    lines.push(`${speaker}: ${text}`);
  }
  lines.reverse();
  return clampText(lines.join(" | "), MAX_FIELD);
}

/** Household memory titles and short excerpts; omits sensitive keys and primary contact payloads. */
export function buildMemoryContextForBland(db: SodiumDatabase): string {
  const titles = db.listMemoryTitles().filter((title) => !isSensitiveMemoryTitle(title));
  const chunks: string[] = [];
  let budget = 0;
  for (const title of titles) {
    if (budget >= MAX_FIELD - 200) {
      break;
    }
    const mem = db.readMemory(title);
    if (!mem) {
      continue;
    }
    const excerpt = memoryEntryExcerpt(mem);
    if (!excerpt) {
      continue;
    }
    const line = `${title}: ${excerpt}`;
    chunks.push(line);
    budget += line.length + 1;
  }
  return clampText(chunks.join("\n"), MAX_FIELD);
}

/** Last ~30 minutes of transcript messages when the activity snapshot has nothing to send. */
function summarizeRecentTranscriptFallback(db: SodiumDatabase): string | undefined {
  const now = Date.now();
  const maxAgeMs = 30 * 60 * 1000;
  const snippets: string[] = [];
  const entries = db.listTranscriptEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== "message") {
      continue;
    }
    if (entry.role !== "resident" && entry.role !== "robot" && entry.role !== "guardian") {
      continue;
    }
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts) || now - ts > maxAgeMs) {
      continue;
    }
    if (entry.text.trim().length === 0) {
      continue;
    }
    const speaker =
      entry.role === "robot" ? "Assistant" : entry.role === "guardian" ? "Guardian" : "Resident";
    snippets.push(`${speaker}: ${entry.text.trim()}`);
    if (snippets.length >= 4) {
      break;
    }
  }
  if (snippets.length === 0) {
    return undefined;
  }
  return clampText(snippets.reverse().join(" | "), MAX_FIELD);
}

/** Active reminders with a next run, soonest first. */
export function buildUpcomingRemindersForBland(db: SodiumDatabase): string {
  const reminders = db
    .listReminders()
    .filter((r) => r.status === "active" && r.nextRun)
    .sort((a, b) => Date.parse(a.nextRun!) - Date.parse(b.nextRun!))
    .slice(0, 12);
  if (reminders.length === 0) {
    return "";
  }
  const lines = reminders.map((r) => {
    const tz = r.timezone ? ` · ${r.timezone}` : "";
    return `${r.title} — next ${r.nextRun} (${r.scheduleLabel})${tz}`;
  });
  return clampText(lines.join(" | "), MAX_FIELD);
}

/**
 * Short spoken-oriented summary. Full detail lives in separate request_data keys so pathways
 * can use {{recent_chat}}, {{memory_context}}, etc. without duplicating huge strings in the brief.
 */
function buildEmergencyBrief(params: {
  callReason: string;
  relationship: string;
  recentActivity: string;
  recentChat: string;
  memoryContext: string;
  upcomingReminders: string;
}): string {
  const base =
    "This is an automated wellness alert from a home care assistant. Someone you support may be in distress or need urgent help. Please try to reach them right away, or ask someone nearby to check on them. Thank you for responding as quickly as you can.";
  const parts: string[] = [
    base,
    `Call reason: ${params.callReason}`,
    `Relationship to resident: ${params.relationship}`,
  ];
  const extras: string[] = [];
  if (params.recentChat) {
    extras.push("recent_chat");
  }
  if (params.recentActivity) {
    extras.push("recent_activity");
  }
  if (params.memoryContext) {
    extras.push("memory_context");
  }
  if (params.upcomingReminders) {
    extras.push("upcoming_reminders");
  }
  if (extras.length > 0) {
    parts.push(
      `More context is available in these variables: ${extras.join(", ")}. Prefer them for specifics.`,
    );
  }
  return clampText(parts.join("\n\n"), MAX_BRIEF);
}

/**
 * Full `request_data` for Bland pathway variables (e.g. {{emergency_brief}}, {{call_reason}}, {{recent_chat}}).
 */
export function buildEmergencyBlandRequestData(
  db: SodiumDatabase,
  params: {
    relationship: string;
    callReason: string;
    source: EmergencyCallSource;
    /** When true, also sets `agent_reason` to match `callReason` for existing pathways. */
    setAgentReasonAlias?: boolean;
  },
): Record<string, string> {
  const relationship = params.relationship.trim();
  const callReason = clampText(params.callReason, 4000);

  const snapshot = buildRecentActivitySnapshot(db, { lookbackMinutes: 240, limit: 18 });
  let recentActivity = formatRecentActivityForBland(snapshot) ?? "";
  if (!recentActivity) {
    const fallback = summarizeRecentTranscriptFallback(db);
    if (fallback) {
      recentActivity = fallback;
    }
  }
  const recentChat = buildRecentChatForBland(db);
  const memoryContext = buildMemoryContextForBland(db);
  const upcomingReminders = buildUpcomingRemindersForBland(db);

  const emergencyBrief = buildEmergencyBrief({
    callReason,
    relationship,
    recentActivity,
    recentChat,
    memoryContext,
    upcomingReminders,
  });

  const out: Record<string, string> = {
    emergency_brief: emergencyBrief,
    relationship_to_resident: relationship,
    call_reason: callReason,
    call_source: params.source,
  };

  if (recentActivity) {
    out.recent_activity = recentActivity;
  }
  if (recentChat) {
    out.recent_chat = recentChat;
  }
  if (memoryContext) {
    out.memory_context = memoryContext;
  }
  if (upcomingReminders) {
    out.upcoming_reminders = upcomingReminders;
  }
  if (params.setAgentReasonAlias && callReason) {
    out.agent_reason = callReason;
  }

  return out;
}

export function buildKeywordCallReason(userMessage: string, matchedPhrases: string[]): string {
  const phrases =
    matchedPhrases.length > 0 ? `Matched phrases: ${matchedPhrases.join(", ")}.` : "Crisis phrase detected.";
  return clampText(`${phrases} Resident said: ${userMessage.trim()}`, 4000);
}
