import type { TranscriptEntry } from "./contracts";
import type { SodiumDatabase } from "./db";

export type RecentActivityItem = {
  timestamp: string;
  category:
    | "transcript"
    | "tool"
    | "browser_session"
    | "browser_action"
    | "shopping_order"
    | "prompt";
  summary: string;
  sourceId?: string;
};

export type RecentActivitySnapshot = {
  since: string;
  until: string;
  windowMinutes: number;
  items: RecentActivityItem[];
};

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("card") ||
    k.includes("cvv") ||
    k.includes("security_code") ||
    k.includes("password") ||
    k.includes("phone") ||
    k.includes("ssn")
  );
}

function summarizeTranscriptEntry(entry: TranscriptEntry): RecentActivityItem | null {
  if (entry.kind === "tool") {
    const tool = entry.toolName ?? "tool";
    const status = entry.toolStatus ?? "started";
    return {
      timestamp: entry.timestamp,
      category: tool === "user-prompt" ? "prompt" : "tool",
      summary: `${tool} ${status}: ${entry.text}`,
      sourceId: entry.id,
    };
  }

  // Message transcript: keep short and useful.
  const speaker =
    entry.role === "robot" ? "Assistant" : entry.role === "guardian" ? "Guardian" : "Resident";
  const text = entry.text.trim();
  if (!text) return null;
  return {
    timestamp: entry.timestamp,
    category: "transcript",
    summary: `${speaker}: ${text}`,
    sourceId: entry.id,
  };
}

export function buildRecentActivitySnapshot(
  db: SodiumDatabase,
  opts: { lookbackMinutes?: number; limit?: number } = {},
): RecentActivitySnapshot {
  const windowMinutes = Number.isFinite(opts.lookbackMinutes) ? Math.max(1, opts.lookbackMinutes as number) : 240;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit as number) : 30;

  const until = new Date();
  const since = new Date(until.getTime() - windowMinutes * 60_000);

  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const items: RecentActivityItem[] = [];

  // Transcript entries (messages + tools) within window.
  for (const entry of db.listTranscriptEntries()) {
    const ts = Date.parse(entry.timestamp);
    if (Number.isNaN(ts) || ts < since.getTime() || ts > until.getTime()) continue;
    const item = summarizeTranscriptEntry(entry);
    if (item) items.push(item);
  }

  // Browser sessions within window (captures browser-use activity even if transcript was reset).
  if ("listBrowserSessionsSince" in db && typeof (db as any).listBrowserSessionsSince === "function") {
    const sessions = (db as any).listBrowserSessionsSince(sinceIso, 8) as Array<Record<string, unknown>>;
    for (const session of sessions) {
      items.push({
        timestamp: safeString(session.lastUpdated) || safeString(session.last_updated) || untilIso,
        category: "browser_session",
        summary:
          `Browser session ${safeString(session.status) || "unknown"}: ` +
          `${safeString(session.summary) || safeString(session.activeTask) || "Browser activity"}`,
        sourceId: safeString(session.id),
      });
    }
  }

  // Shopping orders within window.
  for (const order of db.listShoppingOrders()) {
    const ts = Date.parse(order.createdAt);
    if (Number.isNaN(ts) || ts < since.getTime() || ts > until.getTime()) continue;
    items.push({
      timestamp: order.createdAt,
      category: "shopping_order",
      summary: `Order intent: ${order.merchant} · ${order.itemName}`,
      sourceId: order.id,
    });
  }

  // Sort newest-first, trim.
  items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  // Remove obviously sensitive info (defense in depth). We never include raw prompt response values,
  // but transcript text could contain them in older data.
  const redacted = items.map((item) => {
    let summary = item.summary;
    // Very light heuristic redaction: if a summary looks like it contains JSON, strip sensitive keys.
    // (We avoid parsing arbitrary strings, but this handles our own "{...}" shapes.)
    if (summary.includes("{") && summary.includes("}")) {
      try {
        const start = summary.indexOf("{");
        const end = summary.lastIndexOf("}");
        const prefix = summary.slice(0, start);
        const jsonText = summary.slice(start, end + 1);
        const parsed = JSON.parse(jsonText) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const cleaned: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            cleaned[k] = isSensitiveKey(k) ? "[REDACTED]" : v;
          }
          summary = `${prefix}${JSON.stringify(cleaned)}`;
        }
      } catch {
        // ignore
      }
    }
    return { ...item, summary };
  });

  return {
    since: sinceIso,
    until: untilIso,
    windowMinutes,
    items: redacted.slice(0, limit),
  };
}

export function formatRecentActivityRecap(
  snapshot: RecentActivitySnapshot,
  opts: { voice?: boolean } = {},
): string {
  const voice = Boolean(opts.voice);
  if (snapshot.items.length === 0) {
    return voice ? "I don't see any recent activity." : "No recent activity recorded.";
  }

  const header = `In the last ${snapshot.windowMinutes} minutes, here’s what happened:`;
  const lines = snapshot.items
    .slice(0, voice ? 3 : 10)
    .map((item) => `- ${item.summary}`);

  if (voice) {
    // Voice: 1–3 sentences, no markdown list vibe.
    const top = snapshot.items.slice(0, 3).map((i) => i.summary);
    return top.length === 1
      ? `Recently: ${top[0]}.`
      : `Recently: ${top.slice(0, -1).join("; ")}; and ${top[top.length - 1]}.`;
  }

  return `${header}\n${lines.join("\n")}`;
}

export function formatRecentActivityForBland(snapshot: RecentActivitySnapshot): string | undefined {
  if (snapshot.items.length === 0) return undefined;
  // Single-line, compact, suitable for pathway variables.
  // Prefer user/assistant messages + high-signal tool outcomes; drop low-signal internal echoes.
  const top = snapshot.items
    .filter((item) => {
      const s = item.summary.toLowerCase();
      if (item.category === "transcript") return true;
      if (item.category === "shopping_order") return true;
      if (item.category === "browser_session") return true;
      if (item.category === "tool") {
        // Keep crisis escalation + browser-use completion/failure; drop meta tool plumbing.
        if (s.includes("crisis-escalation")) return true;
        if (s.startsWith("browser-use completed") || s.startsWith("browser-use failed")) return true;
        return false;
      }
      return false;
    })
    .map((i) =>
      i.summary
        .replace(/\s+/g, " ")
        .replace(/\bTool run_browser_task completed\b/i, "Browser task queued")
        .replace(/\bbrowser-use-hitl\b/gi, "Browser verification")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 8);
  if (top.length === 0) return undefined;
  return top.join(" | ");
}
