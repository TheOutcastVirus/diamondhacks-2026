<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { createEventStream, get } from '../api';
  import type { ToolStatus, TranscriptEntry, TranscriptKind, TranscriptRole } from '../types';

  type StreamState = 'connecting' | 'live' | 'offline' | 'error';
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
      streamState = 'error';
      streamError = 'The live transcription stream disconnected. Reconnect to resume.';
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

<section class="page-grid">
  <section class="panel panel-feed">
    <header class="panel-header">
      <div>
        <p class="panel-label">Live</p>
        <h2 class="section-heading">Transcript</h2>
      </div>

      <div class="button-row">
        <button class="ghost" type="button" on:click={connectStream}>Reconnect</button>
        <button class="ghost" type="button" on:click={disconnectStream}>Pause stream</button>
      </div>
    </header>

    <section class="toolbar">
      <div class="filter-row" role="tablist" aria-label="Transcript filters">
        <button class:active-filter={filterMode === 'all'} class="chip" type="button" on:click={() => (filterMode = 'all')}>
          All
        </button>
        <button class:active-filter={filterMode === 'message'} class="chip" type="button" on:click={() => (filterMode = 'message')}>
          Conversation
        </button>
        <button class:active-filter={filterMode === 'tool'} class="chip" type="button" on:click={() => (filterMode = 'tool')}>
          Tools
        </button>
      </div>

      <label class="switcher">
        <input bind:checked={autoScroll} type="checkbox" />
        <span>Auto-scroll</span>
      </label>
    </section>

    <div class="feed" data-transcript-feed>
      {#if isBootstrapping}
        <p class="panel-copy">Loading transcript history...</p>
      {:else if filteredEntries.length === 0}
        <p class="panel-copy">No transcript events yet.</p>
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

  <section class="panel panel-sidebar">
    <section class="callout">
      <p class="panel-label">Status</p>
      <h2 class="section-heading">Connection</h2>
      <div class="status-line">
        <span class={`live-dot live-${streamState}`}></span>
        <strong class="status-copy">{streamState}</strong>
      </div>
      <p class="panel-copy">
        {#if lastEventAt}
          Last event: {formatLongTimestamp(lastEventAt)}
        {:else}
          Waiting for the first event from the robot.
        {/if}
      </p>

      {#if streamError}
        <p class="feedback feedback-error">{streamError}</p>
      {/if}
    </section>

    <section class="metrics">
      <article class="metric-card">
        <p class="metric-label">Messages</p>
        <strong class="metric-value">{messageCount}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Tool uses</p>
        <strong class="metric-value">{toolCount}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Visible</p>
        <strong class="metric-value">{filteredEntries.length}</strong>
      </article>
    </section>

    <section class="panel panel-note">
      <p class="panel-label">Notes</p>
      <ul class="note-list">
        <li class="note-item">Speech and actions appear together.</li>
        <li class="note-item">Use filters to narrow the feed.</li>
        <li class="note-item">Reconnect if the stream drops.</li>
      </ul>
    </section>
  </section>
</section>

<style>
  section.panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  header.panel-header,
  section.toolbar,
  div.entry-head,
  div.tool-foot,
  div.status-line {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }

  h2.section-heading {
    margin: 0;
    font-family: var(--font-display);
    color: var(--color-ink-strong);
    font-size: clamp(1.45rem, 1.8vw, 1.95rem);
  }

  div.button-row,
  div.filter-row,
  section.metrics {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  button.ghost,
  button.chip {
    font: inherit;
    cursor: pointer;
    border-radius: 0;
    padding: 0.78rem 1rem;
    border: var(--border-width) solid var(--color-line);
    transition:
      transform 160ms ease,
      border-color 160ms ease,
      background 160ms ease;
  }

  button.ghost {
    background: transparent;
    color: var(--color-ink-strong);
  }

  button.chip {
    background: var(--color-panel-muted);
    color: var(--color-ink-strong);
  }

  button.ghost:hover,
  button.ghost:focus-visible,
  button.chip:hover,
  button.chip:focus-visible,
  button.active-filter {
    transform: translateY(-1px);
    border-color: var(--color-accent);
  }

  button.active-filter {
    background: color-mix(in srgb, var(--color-accent) 14%, var(--color-panel-muted));
  }

  label.switcher {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--color-ink-soft);
  }

  div.feed {
    min-height: 34rem;
    max-height: 62vh;
    overflow: auto;
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 5%, transparent), transparent 20%),
      var(--color-panel-muted);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  article.entry {
    border-radius: 0;
    padding: 1rem 1rem 0.95rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }

  article.entry-tool {
    background: color-mix(in srgb, var(--color-accent) 9%, var(--color-panel));
  }

  div.entry-meta {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    flex-wrap: wrap;
  }

  span.role-pill,
  span.status-pill {
    border-radius: 0;
    padding: 0.35rem 0.7rem;
    font-size: 0.76rem;
    text-transform: capitalize;
    border: var(--border-width) solid var(--color-line);
  }

  span.role-robot {
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-line));
  }

  span.role-resident {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-line));
  }

  span.role-system,
  span.role-guardian {
    color: var(--color-ink-soft);
  }

  span.status-completed {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 35%, var(--color-line));
  }

  span.status-failed {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-line));
  }

  strong.tool-name,
  strong.status-copy,
  strong.metric-value {
    color: var(--color-ink-strong);
  }

  strong.tool-name {
    font-family: var(--font-display);
    font-size: 1rem;
  }

  p.entry-copy {
    margin: 0;
    color: var(--color-ink-strong);
    line-height: 1.6;
  }

  code.meta {
    display: inline-block;
    max-width: 100%;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.82rem;
    background: color-mix(in srgb, var(--color-panel-muted) 55%, transparent);
    border-radius: 0;
    padding: 0.45rem 0.6rem;
  }

  section.callout,
  article.metric-card,
  section.panel-note {
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    padding: 1rem;
  }

  section.callout {
    background:
      radial-gradient(circle at top right, color-mix(in srgb, var(--color-accent) 20%, transparent), transparent 46%),
      var(--color-panel-muted);
  }

  span.live-dot {
    inline-size: 0.8rem;
    block-size: 0.8rem;
    border-radius: 0;
    background: var(--color-line-strong);
    box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--color-line-strong) 20%, transparent);
  }

  span.live-live {
    background: var(--color-success);
    box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--color-success) 20%, transparent);
  }

  span.live-connecting {
    background: var(--color-warning);
    box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--color-warning) 20%, transparent);
  }

  span.live-error {
    background: var(--color-danger);
    box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--color-danger) 20%, transparent);
  }

  strong.metric-value {
    font-family: var(--font-display);
    font-size: 1.55rem;
  }

  ul.note-list {
    margin: 0;
    padding-left: 1.15rem;
    display: grid;
    gap: 0.65rem;
  }

  li.note-item {
    color: var(--color-ink-soft);
  }

  p.feedback {
    margin: 0.75rem 0 0;
    border-radius: 0;
    padding: 0.85rem 1rem;
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border: var(--border-width) solid var(--color-line);
    color: var(--color-danger);
  }

  @media (max-width: 720px) {
    header.panel-header,
    section.toolbar,
    div.entry-head,
    div.tool-foot {
      flex-direction: column;
      align-items: flex-start;
    }

    div.button-row,
    div.filter-row,
    section.metrics {
      width: 100%;
    }

    button.ghost,
    button.chip {
      flex: 1 1 0;
      text-align: center;
    }

    div.feed {
      max-height: none;
      min-height: 24rem;
    }
  }
</style>
