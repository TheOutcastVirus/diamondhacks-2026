<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { createEventStream, get } from '../api';
  import type { ToolStatus, TranscriptEntry, TranscriptKind, TranscriptRole } from '../types';
  import VoiceInput from '../components/VoiceInput.svelte';

  type StreamState = 'connecting' | 'live' | 'offline';
  type FilterMode = 'all' | 'message' | 'tool';

  let entries: TranscriptEntry[] = [];
  let streamState: StreamState = 'connecting';
  let streamError = '';
  let isBootstrapping = true;
  let filterMode: FilterMode = 'all';
  let autoScroll = true;
  let lastEventAt = '';
  let eventSource: EventSource | null = null;

  function formatTimestamp(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        }).format(parsed);
  }

  function formatLongTimestamp(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function normalizeKind(value: unknown, fallbackType: string): TranscriptKind {
    if (value === 'tool') {
      return 'tool';
    }

    return fallbackType === 'tool' ? 'tool' : 'message';
  }

  function normalizeRole(value: unknown, kind: TranscriptKind): TranscriptRole {
    if (value === 'resident' || value === 'guardian' || value === 'system' || value === 'robot') {
      return value;
    }

    return kind === 'tool' ? 'system' : 'robot';
  }

  function normalizeToolStatus(value: unknown): ToolStatus | undefined {
    if (value === 'started' || value === 'completed' || value === 'failed') {
      return value;
    }

    return undefined;
  }

  function normalizeTranscriptEntry(
    raw: unknown,
    index: number,
    fallbackType: string = 'message',
  ): TranscriptEntry {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const kind = normalizeKind(value.kind ?? value.type, fallbackType);
    const text =
      kind === 'tool'
        ? String(
            value.text ??
              value.detail ??
              value.message ??
              value.summary ??
              `${String(value.toolName ?? value.name ?? 'Tool action')} recorded.`,
          )
        : String(value.text ?? value.message ?? value.content ?? '');

    return {
      id: String(value.id ?? `${Date.now()}-${index}`),
      timestamp: String(value.timestamp ?? value.createdAt ?? new Date().toISOString()),
      kind,
      role: normalizeRole(value.role, kind),
      text,
      toolName: value.toolName ? String(value.toolName) : value.name ? String(value.name) : undefined,
      toolStatus: normalizeToolStatus(value.toolStatus ?? value.status),
      metadata:
        typeof value.metadata === 'object' && value.metadata !== null
          ? (value.metadata as Record<string, unknown>)
          : undefined,
    };
  }

  function normalizeTranscriptResponse(payload: unknown) {
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(record?.entries)
        ? (record.entries as unknown[])
        : Array.isArray(record?.transcript)
          ? (record.transcript as unknown[])
          : [];

    return list.map((item, index) => normalizeTranscriptEntry(item, index));
  }

  function appendEntries(nextEntries: TranscriptEntry[]) {
    if (nextEntries.length === 0) {
      return;
    }

    entries = [...entries, ...nextEntries].slice(-250);
    lastEventAt = nextEntries[nextEntries.length - 1].timestamp;

    if (autoScroll) {
      requestAnimationFrame(() => {
        const feed = document.querySelector<HTMLElement>('[data-transcript-feed]');
        feed?.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
      });
    }
  }

  async function loadTranscriptHistory() {
    isBootstrapping = true;
    streamError = '';

    try {
      const payload = await get<unknown>('transcript');
      entries = normalizeTranscriptResponse(payload);
      if (entries.length > 0) {
        lastEventAt = entries[entries.length - 1].timestamp;
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : 'Unable to load transcript history.';
    } finally {
      isBootstrapping = false;
    }
  }

  function parseEventData(data: string) {
    try {
      return JSON.parse(data);
    } catch {
      return { text: data };
    }
  }

  function attachStreamListeners(source: EventSource) {
    const processMessage = (eventType: string, event: MessageEvent<string>) => {
      const payload = parseEventData(event.data);
      const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;

      if (Array.isArray(record?.entries)) {
        appendEntries(
          record.entries.map((item, index) => normalizeTranscriptEntry(item, index, eventType)),
        );
        return;
      }

      appendEntries([normalizeTranscriptEntry(payload, entries.length, eventType)]);
    };

    source.onopen = () => {
      streamState = 'live';
      streamError = '';
    };

    source.onerror = () => {
      if (eventSource !== source) {
        return;
      }

      streamState = source.readyState === EventSource.CLOSED ? 'offline' : 'connecting';
      streamError = '';
    };

    source.onmessage = (event) => processMessage('message', event);
    source.addEventListener('transcript', (event) =>
      processMessage('message', event as MessageEvent<string>),
    );
    source.addEventListener('tool', (event) => processMessage('tool', event as MessageEvent<string>));
  }

  function disconnectStream() {
    eventSource?.close();
    eventSource = null;
    streamState = 'offline';
  }

  function connectStream() {
    eventSource?.close();
    eventSource = null;
    streamState = 'connecting';
    streamError = '';

    const source = createEventStream('transcriptStream');
    eventSource = source;
    attachStreamListeners(source);
  }

  onMount(async () => {
    await loadTranscriptHistory();
    connectStream();
  });

  onDestroy(() => {
    eventSource?.close();
  });

  $: messageCount = entries.filter((entry) => entry.kind === 'message').length;
  $: toolCount = entries.filter((entry) => entry.kind === 'tool').length;
  $: filteredEntries =
    filterMode === 'all' ? entries : entries.filter((entry) => entry.kind === filterMode);
</script>

<section class="page-grid tx-console" aria-label="Live transcript">
  <section class="panel panel-feed">
    <header class="feed-toolbar">
      <div class="segmented" role="tablist" aria-label="Transcript filters">
        <button class:active-filter={filterMode === 'all'} class="seg-btn" type="button" on:click={() => (filterMode = 'all')}>
          All
        </button>
        <button class:active-filter={filterMode === 'message'} class="seg-btn" type="button" on:click={() => (filterMode = 'message')}>
          Chat
        </button>
        <button class:active-filter={filterMode === 'tool'} class="seg-btn" type="button" on:click={() => (filterMode = 'tool')}>
          Tools
        </button>
      </div>

      <div class="toolbar-actions">
        <label class="switcher">
          <input bind:checked={autoScroll} type="checkbox" />
          <span>Follow latest</span>
        </label>
        <div class="button-row">
          <button class="btn-secondary" type="button" on:click={connectStream}>Reconnect</button>
          <button class="btn-quiet" type="button" on:click={disconnectStream}>Pause</button>
        </div>
      </div>
    </header>

    <div class="feed" data-transcript-feed>
      {#if isBootstrapping}
        <div class="feed-state" role="status">
          <div class="skeleton-line wide"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line narrow"></div>
          <p class="feed-state-label">Loading history…</p>
        </div>
      {:else if filteredEntries.length === 0}
        <div class="feed-state feed-state-empty">
          <p class="feed-empty-title">
            {entries.length === 0 ? 'Quiet channel' : 'Nothing in this view'}
          </p>
          <p class="feed-empty-body">
            {entries.length === 0
              ? 'Events will appear here as soon as the agent speaks or runs a tool.'
              : 'Switch to All or another filter to see buffered events.'}
          </p>
        </div>
      {:else}
        {#each filteredEntries as entry}
          <article class={`entry entry-${entry.kind}`}>
            <div class="entry-head">
              <div class="entry-meta">
                <span class={`role-pill role-${entry.role}`}>{entry.role}</span>
                {#if entry.kind === 'tool' && entry.toolName}
                  <strong class="tool-name">{entry.toolName}</strong>
                {/if}
              </div>

              <time class="timestamp" datetime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
            </div>

            <p class="entry-copy">{entry.text}</p>

            {#if entry.kind === 'tool'}
              <div class="tool-foot">
                <span class={`status-pill status-${entry.toolStatus ?? 'started'}`}>
                  {entry.toolStatus ?? 'started'}
                </span>
                {#if entry.metadata}
                  <code class="meta">{JSON.stringify(entry.metadata)}</code>
                {/if}
              </div>
            {/if}
          </article>
        {/each}
      {/if}
    </div>
  </section>

  <aside class="panel panel-sidebar">
    <section class="sidebar-card connection-card">
      <div class="card-title-row">
        <p class="sidebar-card-title">Connection</p>
        <span class={`state-badge state-${streamState}`}>{streamState}</span>
      </div>
      <div class="status-row">
        <span class={`live-dot live-${streamState}`} aria-hidden="true"></span>
        <p class="status-detail">
          {#if lastEventAt}
            Last event · {formatLongTimestamp(lastEventAt)}
          {:else}
            Waiting for the first event.
          {/if}
        </p>
      </div>

      {#if streamError}
        <p class="feedback feedback-error">{streamError}</p>
      {/if}
    </section>

    <section class="metrics" aria-label="Session counts">
      <article class="metric-card metric-hero">
        <p class="metric-label">Messages</p>
        <strong class="metric-value">{messageCount}</strong>
        <p class="metric-hint">Total in buffer</p>
      </article>
      <article class="metric-card metric-stack">
        <p class="metric-label">Tool calls</p>
        <strong class="metric-value metric-value-sm">{toolCount}</strong>
      </article>
      <article class="metric-card metric-stack">
        <p class="metric-label">In view</p>
        <strong class="metric-value metric-value-sm">{filteredEntries.length}</strong>
      </article>
    </section>

    <section class="sidebar-card panel-voice">
      <p class="sidebar-card-title">Voice input</p>
      <VoiceInput />
    </section>

    <section class="sidebar-card panel-note">
      <p class="sidebar-card-title">Tips</p>
      <ul class="note-list">
        <li>Speech and tool runs show up in order.</li>
        <li>Use Chat / Tools to focus the feed.</li>
        <li>Reconnect if the live stream stops.</li>
      </ul>
    </section>
  </aside>
</section>

<style>
  section.page-grid.tx-console {
    --tx-r: 12px;
    --tx-r-sm: 8px;
    --tx-ease: cubic-bezier(0.16, 1, 0.3, 1);
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 25rem);
    gap: clamp(1rem, 1.8vw, 1.75rem);
    align-items: stretch;
    width: min(100%, 110rem);
    margin: 0 auto;
    min-block-size: clamp(38rem, calc(100dvh - 11rem), 72rem);
  }

  section.page-grid.tx-console > * {
    min-width: 0;
    min-height: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  section.panel-feed {
    min-height: 0;
  }

  aside.panel-sidebar {
    min-height: 0;
    position: sticky;
    top: clamp(1rem, 2vw, 1.5rem);
    max-block-size: calc(100dvh - clamp(2rem, 4vw, 3rem));
    overflow: auto;
    padding-right: 0.1rem;
  }

  /* Feed chrome */
  header.feed-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.875rem 1rem;
    padding: 0.35rem 0;
  }

  div.segmented {
    display: inline-flex;
    padding: 3px;
    border-radius: var(--tx-r-sm);
    background: var(--color-panel-muted);
    border: var(--border-width) solid var(--color-line);
    gap: 2px;
  }

  button.seg-btn {
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    border: none;
    border-radius: calc(var(--tx-r-sm) - 2px);
    padding: 0.5rem 0.95rem;
    color: var(--color-ink-soft);
    background: transparent;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  button.seg-btn:hover,
  button.seg-btn:focus-visible {
    color: var(--color-ink-strong);
    background: color-mix(in srgb, var(--color-panel) 80%, transparent);
  }

  button.seg-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 65%, var(--color-line));
    outline-offset: 2px;
  }

  button.seg-btn.active-filter {
    color: var(--color-ink-strong);
    background: var(--color-panel);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--color-line-strong) 8%, transparent),
      0 1px 2px color-mix(in srgb, var(--color-line-strong) 10%, transparent);
  }

  div.toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
  }

  div.button-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  button.btn-secondary,
  button.btn-quiet {
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    border-radius: var(--tx-r-sm);
    padding: 0.5rem 0.9rem;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      color 140ms ease;
  }

  button.btn-secondary {
    border: var(--border-width) solid color-mix(in srgb, var(--color-accent) 45%, var(--color-line));
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel));
    color: var(--color-ink-strong);
  }

  button.btn-secondary:hover,
  button.btn-secondary:focus-visible {
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel));
  }

  button.btn-secondary:focus-visible,
  button.btn-quiet:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  button.btn-secondary:active,
  button.btn-quiet:active {
    transform: translateY(1px);
  }

  button.btn-quiet {
    border: var(--border-width) solid var(--color-line);
    background: transparent;
    color: var(--color-ink-soft);
  }

  button.btn-quiet:hover,
  button.btn-quiet:focus-visible {
    border-color: var(--color-ink-soft);
    color: var(--color-ink-strong);
  }

  label.switcher {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--color-ink-soft);
    user-select: none;
  }

  label.switcher input {
    accent-color: var(--color-accent);
    width: 1rem;
    height: 1rem;
  }

  /* Scroll region — utilitarian “tape” readout */
  div.feed {
    position: relative;
    isolation: isolate;
    min-height: 0;
    flex: 1 1 auto;
    block-size: 100%;
    overflow: auto;
    scroll-behavior: smooth;
    border-radius: var(--tx-r);
    border: var(--border-width) solid var(--color-line);
    background-color: var(--color-bg-strong);
    background-image:
      linear-gradient(
        165deg,
        color-mix(in srgb, var(--color-accent) 4%, transparent) 0%,
        transparent 42%
      ),
      repeating-linear-gradient(
        -12deg,
        transparent,
        transparent 11px,
        color-mix(in srgb, var(--color-line-strong) 3%, transparent) 11px,
        color-mix(in srgb, var(--color-line-strong) 3%, transparent) 12px
      );
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--color-line-strong) 5%, transparent),
      inset 0 0 0 1px color-mix(in srgb, var(--color-panel) 40%, transparent);
  }

  div.feed-state {
    margin: auto;
    padding: 2.5rem 1.5rem;
    max-width: 22rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  div.feed-state-empty {
    max-width: 26rem;
    text-align: center;
    align-items: center;
  }

  p.feed-empty-title {
    margin: 0;
    font-family: var(--font-body);
    font-size: 1.05rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--color-ink-strong);
  }

  p.feed-empty-body {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.55;
    color: var(--color-ink-soft);
    max-width: 38ch;
  }

  p.feed-state-label {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: var(--color-ink-soft);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  div.skeleton-line {
    height: 0.55rem;
    width: 100%;
    max-width: 14rem;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      var(--color-panel-muted) 0%,
      color-mix(in srgb, var(--color-accent) 12%, var(--color-panel)) 50%,
      var(--color-panel-muted) 100%
    );
    background-size: 200% 100%;
    animation: tx-shimmer 1.35s var(--tx-ease) infinite;
  }

  div.skeleton-line.wide {
    max-width: 18rem;
  }

  div.skeleton-line.narrow {
    max-width: 9rem;
  }

  @keyframes tx-shimmer {
    0% {
      background-position: 100% 0;
    }
    100% {
      background-position: -100% 0;
    }
  }

  /* Entries */
  div.entry-head,
  div.tool-foot {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
  }

  article.entry {
    border-radius: var(--tx-r-sm);
    padding: 0.85rem 1rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-line-strong) 5%, transparent);
    transition:
      border-color 0.22s var(--tx-ease),
      transform 0.22s var(--tx-ease),
      box-shadow 0.22s var(--tx-ease);
  }

  article.entry:hover {
    border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-line));
    transform: translateY(-1px);
    box-shadow:
      0 2px 8px color-mix(in srgb, var(--color-line-strong) 6%, transparent),
      0 1px 0 color-mix(in srgb, var(--color-line-strong) 5%, transparent);
  }

  article.entry-tool {
    background: color-mix(in srgb, var(--color-accent) 6%, var(--color-panel));
    border-color: color-mix(in srgb, var(--color-accent) 22%, var(--color-line));
  }

  div.entry-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    min-width: 0;
  }

  span.role-pill,
  span.status-pill {
    border-radius: 999px;
    padding: 0.2rem 0.65rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: var(--border-width) solid var(--color-line);
  }

  span.role-robot {
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-line));
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  }

  span.role-resident {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-line));
    background: color-mix(in srgb, var(--color-warning) 8%, transparent);
  }

  span.role-system,
  span.role-guardian {
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-panel-muted) 50%, transparent);
  }

  span.status-started {
    color: var(--color-ink-soft);
  }

  span.status-completed {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-line));
    background: color-mix(in srgb, var(--color-success) 8%, transparent);
  }

  span.status-failed {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-line));
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
  }

  time.timestamp {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--color-ink-soft);
    white-space: nowrap;
    flex-shrink: 0;
  }

  strong.tool-name,
  strong.metric-value {
    color: var(--color-ink-strong);
  }

  strong.tool-name {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  p.entry-copy {
    margin: 0;
    color: var(--color-ink-strong);
    line-height: 1.55;
    font-size: 0.9375rem;
  }

  code.meta {
    display: block;
    max-width: 100%;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    line-height: 1.45;
    color: var(--color-ink-soft);
    background: var(--color-input);
    border-radius: calc(var(--tx-r-sm) - 2px);
    padding: 0.5rem 0.65rem;
    border: var(--border-width) solid var(--color-line);
  }

  /* Sidebar */
  p.sidebar-card-title {
    margin: 0;
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  section.sidebar-card {
    border-radius: var(--tx-r);
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--color-line-strong) 7%, transparent),
      0 1px 0 color-mix(in srgb, var(--color-panel) 55%, transparent);
  }

  section.connection-card {
    background:
      radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--color-accent) 12%, transparent), transparent),
      var(--color-panel-muted);
  }

  div.card-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  span.state-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.25rem 0.55rem;
    border-radius: 999px;
    border: var(--border-width) solid var(--color-line);
    color: var(--color-ink-soft);
    background: var(--color-panel);
  }

  span.state-live {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-line));
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
  }

  span.state-connecting {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 40%, var(--color-line));
    background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  }

  span.state-offline {
    color: var(--color-ink-soft);
  }

  div.status-row {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
  }

  p.status-detail {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--color-ink);
  }

  span.live-dot {
    inline-size: 0.55rem;
    block-size: 0.55rem;
    border-radius: 50%;
    margin-top: 0.35rem;
    flex-shrink: 0;
    background: var(--color-line-strong);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-panel) 35%, transparent);
  }

  span.live-live {
    background: var(--color-success);
  }

  span.live-connecting {
    background: var(--color-warning);
    animation: tx-connect-pulse 1.1s var(--tx-ease) infinite;
  }

  span.live-offline {
    background: var(--color-ink-soft);
  }

  @keyframes tx-connect-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  p.feedback {
    margin: 0;
    border-radius: var(--tx-r-sm);
    padding: 0.65rem 0.85rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    background: color-mix(in srgb, var(--color-danger) 10%, var(--color-panel));
    border: var(--border-width) solid color-mix(in srgb, var(--color-danger) 28%, var(--color-line));
    color: var(--color-danger);
  }

  /* Asymmetric metrics: primary readout + stacked secondary (not 3 equal tiles) */
  section.metrics {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    grid-template-rows: 1fr 1fr;
    gap: 0.5rem;
    min-height: 6.5rem;
  }

  article.metric-card {
    border-radius: var(--tx-r-sm);
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-line-strong) 5%, transparent);
  }

  article.metric-hero {
    grid-row: 1 / -1;
    padding: 1rem 1.05rem;
    justify-content: center;
    text-align: left;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-accent) 7%, var(--color-panel)) 0%,
      var(--color-panel) 55%
    );
    border-color: color-mix(in srgb, var(--color-accent) 18%, var(--color-line));
  }

  article.metric-stack {
    padding: 0.65rem 0.75rem;
    justify-content: center;
    text-align: right;
  }

  p.metric-label {
    margin: 0;
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  p.metric-hint {
    margin: 0;
    font-size: 0.6875rem;
    color: var(--color-ink-soft);
    line-height: 1.35;
    max-width: 12rem;
  }

  strong.metric-value {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 2rem;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--color-ink-strong);
  }

  strong.metric-value-sm {
    font-size: 1.35rem;
  }

  section.panel-voice {
    align-items: center;
    text-align: center;
  }

  ul.note-list {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    gap: 0.45rem;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--color-ink-soft);
  }

  @media (prefers-reduced-motion: reduce) {
    div.skeleton-line {
      animation: none;
      background: var(--color-panel-muted);
    }

    span.live-connecting {
      animation: none;
    }

    article.entry {
      transition: none;
    }

    article.entry:hover {
      transform: none;
    }

    div.feed {
      scroll-behavior: auto;
    }
  }

  @media (max-width: 1080px) {
    section.page-grid.tx-console {
      grid-template-columns: 1fr;
      width: 100%;
      min-block-size: auto;
    }

    section.panel-feed {
      min-block-size: min(44rem, calc(100dvh - 18rem));
    }

    aside.panel-sidebar {
      position: static;
      max-block-size: none;
      overflow: visible;
      padding-right: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }

    section.connection-card,
    section.metrics {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 720px) {
    section.page-grid.tx-console {
      gap: 1rem;
    }

    header.feed-toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    div.toolbar-actions {
      justify-content: space-between;
    }

    div.segmented {
      width: 100%;
      justify-content: stretch;
    }

    button.seg-btn {
      flex: 1;
      text-align: center;
      padding-inline: 0.5rem;
    }

    div.entry-head,
    div.tool-foot {
      flex-direction: column;
      align-items: flex-start;
    }

    div.button-row {
      width: 100%;
    }

    button.btn-secondary,
    button.btn-quiet {
      flex: 1;
      text-align: center;
    }

    section.metrics {
      grid-template-columns: 1fr 1fr;
      grid-template-rows: auto auto auto;
      min-height: unset;
    }

    article.metric-hero {
      grid-column: 1 / -1;
      grid-row: auto;
    }

    article.metric-stack {
      text-align: center;
    }

    aside.panel-sidebar {
      display: flex;
    }

    div.feed {
      min-height: clamp(20rem, 48dvh, 30rem);
    }
  }
</style>
