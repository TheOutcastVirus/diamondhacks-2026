<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { createEventStream, get, post } from '../api';
  import type { ConversationState, ToolStatus, TranscriptEntry, TranscriptKind, TranscriptRole } from '../types';
  import VoiceInput from '../components/VoiceInput.svelte';

  type StreamState = 'connecting' | 'live' | 'offline';
  type FilterMode = 'all' | 'message' | 'tool';

  let entries: TranscriptEntry[] = [];
  let streamState: StreamState = 'connecting';
  let streamError = '';
  let isBootstrapping = true;
  let filterMode: FilterMode = 'all';
  let autoScroll = true;
  let eventSource: EventSource | null = null;
  let expandedTools: Set<string> = new Set();
  let conversationState: ConversationState = 'idle';
  let newConversationBusy = false;

  async function startNewConversation() {
    if (newConversationBusy) return;
    newConversationBusy = true;
    try {
      await post('/api/conversation/new');
      // entries cleared via the 'session' SSE event
    } catch {
      // non-critical — the SSE event will still arrive if the server handled it
    } finally {
      newConversationBusy = false;
    }
  }

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

  function toggleTool(id: string) {
    const next = new Set(expandedTools);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedTools = next;
  }

  function hasMetadataField(entry: TranscriptEntry, key: string) {
    return Boolean(entry.metadata && Object.prototype.hasOwnProperty.call(entry.metadata, key));
  }

  function formatDebugJson(value: unknown) {
    if (value === undefined) {
      return '';
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function appendEntries(nextEntries: TranscriptEntry[]) {
    if (nextEntries.length === 0) {
      return;
    }

    entries = [...entries, ...nextEntries].slice(-250);

    if (autoScroll) {
      requestAnimationFrame(() => {
        const feed = document.querySelector<HTMLElement>('[data-transcript-feed]');
        feed?.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  }

  async function loadTranscriptHistory() {
    isBootstrapping = true;
    streamError = '';

    try {
      const payload = await get<unknown>('transcript');
      entries = normalizeTranscriptResponse(payload);
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
    source.addEventListener('state', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { conversationState?: string };
        if (payload.conversationState === 'conversation' || payload.conversationState === 'idle') {
          conversationState = payload.conversationState;
        }
      } catch {
        // ignore malformed state events
      }
    });

    source.addEventListener('session', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { action?: string };
        if (payload.action === 'reset') {
          entries = [];
          isBootstrapping = false;
        }
      } catch {
        // ignore
      }
    });
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
  $: filteredEntries = (
    filterMode === 'all' ? entries : entries.filter((entry) => entry.kind === filterMode)
  ).slice().reverse();
</script>

<section class="page-grid tx-console" aria-label="Live transcript">
  <section class="panel panel-feed">
    <header class="feed-toolbar">
      <div class="segmented" role="tablist" aria-label="What to show in the feed">
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

      <div class="toolbar-right">
        {#if conversationState === 'conversation'}
          <div class="convo-badge" role="status" aria-live="polite">
            <span class="convo-dot" aria-hidden="true"></span>
            Listening…
          </div>
        {/if}
        <button
          class="new-convo-btn"
          type="button"
          disabled={newConversationBusy}
          on:click={startNewConversation}
          title="Archive this conversation and start fresh"
        >
          {newConversationBusy ? '…' : 'New conversation'}
        </button>
      </div>
    </header>

    <div class="feed" data-transcript-feed>
      {#if isBootstrapping}
        <div class="feed-state" role="status">
          <div class="skeleton-line wide"></div>
          <div class="skeleton-line"></div>
          <div class="skeleton-line narrow"></div>
          <p class="feed-state-label">Syncing transcript…</p>
        </div>
      {:else if filteredEntries.length === 0}
        <div class="feed-state feed-state-empty">
          <p class="feed-empty-title">
            {entries.length === 0 ? 'Nothing in the feed yet' : 'No rows for this filter'}
          </p>
          <p class="feed-empty-body">
            {entries.length === 0
              ? 'Agent replies and tool runs land here the moment they happen.'
              : 'Switch to All, Chat, or Tools to see what is buffered.'}
          </p>
        </div>
      {:else}
        {#each filteredEntries as entry}
          {#if entry.kind === 'tool'}
            <div class="tool-row">
              <button
                class="tool-toggle"
                type="button"
                on:click={() => toggleTool(entry.id)}
                aria-expanded={expandedTools.has(entry.id)}
              >
                <span class="tool-lead-icon" aria-hidden="true">
                  <svg
                    class="icon-stroke"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                </span>
                <span class="tool-toggle-name">{entry.toolName ?? 'Tool'}</span>
                <span class={`status-dot status-dot-${entry.toolStatus ?? 'started'}`}></span>
                <span class="tool-toggle-text">{entry.text}</span>
                <time class="tool-toggle-time" datetime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                <svg
                  class="tool-chevron-svg"
                  class:open={expandedTools.has(entry.id)}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {#if expandedTools.has(entry.id)}
                <div class="tool-details">
                  <div class="tool-details-row">
                    <span class={`status-pill status-${entry.toolStatus ?? 'started'}`}>
                      {entry.toolStatus ?? 'started'}
                    </span>
                    <span class="tool-role-icon" aria-label={entry.role}>
                      {#if entry.role === 'robot'}
                        <svg class="icon-stroke sm" viewBox="0 0 24 24" fill="none" stroke-width="1.75" aria-hidden="true">
                          <rect x="5" y="8" width="14" height="10" rx="2" />
                          <circle cx="9" cy="13" r="1.25" fill="currentColor" stroke="none" />
                          <circle cx="15" cy="13" r="1.25" fill="currentColor" stroke="none" />
                          <path d="M9 4v3M15 4v3" stroke-linecap="round" />
                        </svg>
                      {:else if entry.role === 'guardian' || entry.role === 'resident'}
                        <svg class="icon-stroke sm" viewBox="0 0 24 24" fill="none" stroke-width="1.75" aria-hidden="true">
                          <circle cx="12" cy="8" r="3.5" />
                          <path d="M5 20v-1a7 7 0 0 1 14 0v1" />
                        </svg>
                      {:else}
                        <svg class="icon-stroke sm" viewBox="0 0 24 24" fill="none" stroke-width="1.75" aria-hidden="true">
                          <rect x="4" y="4" width="16" height="16" rx="2" />
                          <path d="M9 9h6M9 13h4" stroke-linecap="round" />
                        </svg>
                      {/if}
                    </span>
                  </div>
                  {#if entry.metadata?.params && typeof entry.metadata.params === 'object' && Object.keys(entry.metadata.params).length > 0}
                    <div class="tool-params">
                      <span class="tool-params-label">Parameters</span>
                      <code class="meta">{formatDebugJson(entry.metadata.params)}</code>
                    </div>
                  {:else if hasMetadataField(entry, 'params')}
                    <div class="tool-params">
                      <span class="tool-params-label">Parameters</span>
                      <code class="meta">(none)</code>
                    </div>
                  {/if}
                  {#if hasMetadataField(entry, 'result')}
                    <div class="tool-params">
                      <span class="tool-params-label">Result</span>
                      <code class="meta">{formatDebugJson(entry.metadata?.['result'])}</code>
                    </div>
                  {/if}
                  {#if entry.metadata && !hasMetadataField(entry, 'params') && !hasMetadataField(entry, 'result')}
                    <code class="meta">{formatDebugJson(entry.metadata)}</code>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            {@const isUser = entry.role === 'guardian' || entry.role === 'resident'}
            <div class={`bubble-row ${isUser ? 'bubble-row-user' : 'bubble-row-bot'}`}>
              {#if !isUser}
                <div class="bubble-avatar bubble-avatar-bot" aria-label="Agent">
                  <svg class="icon-stroke avatar-svg" viewBox="0 0 24 24" fill="none" stroke-width="1.75" aria-hidden="true">
                    <rect x="5" y="8" width="14" height="10" rx="2" />
                    <circle cx="9" cy="13" r="1.25" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="13" r="1.25" fill="currentColor" stroke="none" />
                    <path d="M9 4v3M15 4v3" stroke-linecap="round" />
                  </svg>
                </div>
              {/if}
              <div class={`bubble ${isUser ? 'bubble-user' : 'bubble-bot'}`}>
                <p class="bubble-text">{entry.text}</p>
                {#if isUser}
                  <time class="bubble-time" datetime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                {/if}
              </div>
              {#if isUser}
                <div class="bubble-avatar bubble-avatar-user" aria-label="Guardian">
                  <svg class="icon-stroke avatar-svg" viewBox="0 0 24 24" fill="none" stroke-width="1.75" aria-hidden="true">
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5 20v-1a7 7 0 0 1 14 0v1" />
                  </svg>
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </section>

  <aside class="panel panel-sidebar">
    <div class="sidebar-unified">
      <!-- Connection row -->
      <div class="su-conn" role="status" aria-live="polite" aria-label={`Connection ${streamState}`}>
        <div class="su-conn-left">
          <span class={`live-dot live-${streamState}`} aria-hidden="true"></span>
        </div>
        <span class={`state-badge state-${streamState}`}>{streamState}</span>
      </div>

      {#if streamError}
        <p class="feedback feedback-error">{streamError}</p>
      {/if}

      <div class="su-divider" aria-hidden="true"></div>

      <!-- Metrics -->
      <div class="su-metrics" aria-label="Session counts">
        <div class="su-metric su-metric-hero">
          <span class="su-metric-label">Messages</span>
          <strong class="su-metric-value">{messageCount}</strong>
        </div>
        <div class="su-metric-group">
          <div class="su-metric">
            <span class="su-metric-label">Tool calls</span>
            <strong class="su-metric-value su-metric-sm">{toolCount}</strong>
          </div>
          <div class="su-metric">
            <span class="su-metric-label">In view</span>
            <strong class="su-metric-value su-metric-sm">{filteredEntries.length}</strong>
          </div>
        </div>
      </div>

      <div class="su-divider" aria-hidden="true"></div>

      <!-- Voice input -->
      <div class="su-voice">
        <VoiceInput />
      </div>

    </div>
  </aside>
</section>

<style>
  section.page-grid.tx-console {
    --tx-r: 12px;
    --tx-r-sm: 8px;
    --tx-ease: cubic-bezier(0.16, 1, 0.3, 1);
    font-family: var(--font-body);
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 25rem);
    gap: clamp(1rem, 1.8vw, 1.75rem);
    align-items: stretch;
    width: min(100%, 110rem);
    margin: 0 auto;
    min-block-size: clamp(38rem, calc(100dvh - 11rem), 72rem);
    grid-template-rows: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }

  svg.icon-stroke {
    display: block;
    stroke: currentColor;
  }

  svg.icon-stroke.sm {
    width: 1.05rem;
    height: 1.05rem;
  }

  section.page-grid.tx-console > * {
    min-width: 0;
    min-height: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  section.panel-feed {
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
    flex-shrink: 0;
  }

  div.toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  button.new-convo-btn {
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 20%, transparent);
    background: transparent;
    color: var(--color-ink-soft);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  button.new-convo-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-ink-strong) 6%, transparent);
    color: var(--color-ink);
    border-color: color-mix(in srgb, var(--color-line-strong) 40%, transparent);
  }

  button.new-convo-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  div.convo-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);
  }

  span.convo-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: convo-pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes convo-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.75); }
  }

  /* Segmented control: low-contrast track, lifted active pill (works light + dark) */
  div.segmented {
    display: inline-flex;
    align-items: stretch;
    padding: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-panel-muted) 62%, var(--color-bg-strong));
    border: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-line-strong) 4.5%, transparent);
    gap: 3px;
  }

  button.seg-btn {
    font: inherit;
    font-size: 1rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    cursor: pointer;
    border: none;
    border-radius: 999px;
    padding: 0.4rem 1.05rem;
    min-height: 2.125rem;
    color: color-mix(in srgb, var(--color-ink-soft) 88%, var(--color-ink));
    background: transparent;
    transition:
      background 0.2s var(--tx-ease),
      color 0.2s var(--tx-ease),
      box-shadow 0.2s var(--tx-ease),
      transform 0.15s var(--tx-ease);
  }

  button.seg-btn:hover:not(.active-filter) {
    color: var(--color-ink-strong);
    background: color-mix(in srgb, var(--color-ink-strong) 5%, transparent);
  }

  button.seg-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 55%, var(--color-line));
    outline-offset: 2px;
  }

  button.seg-btn.active-filter {
    color: var(--color-ink-strong);
    font-weight: 600;
    letter-spacing: -0.02em;
    background: color-mix(in srgb, var(--color-ink-strong) 11%, var(--color-panel-muted));
    box-shadow: none;
  }

  button.seg-btn.active-filter:hover {
    background: color-mix(in srgb, var(--color-ink-strong) 13%, var(--color-panel-muted));
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

  /* Scroll region — flat fill; frame = outer edge + inset rim (stays inside box; parent overflow-safe) */
  div.feed {
    position: relative;
    isolation: isolate;
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    overflow: auto;
    scroll-behavior: smooth;
    border-radius: var(--tx-r);
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    background-color: var(--color-bg-strong);
    background-clip: padding-box;
    padding: 1.25rem 1.5rem 2rem 1.25rem;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-start;
    gap: 1.25rem;
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--color-ink-strong) 5.5%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--color-ink-strong) 2.5%, transparent);
    
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--color-ink-strong) 15%, transparent) transparent;
  }

  div.feed::-webkit-scrollbar {
    width: 14px;
  }
  
  div.feed::-webkit-scrollbar-track {
    background: transparent;
  }
  
  div.feed::-webkit-scrollbar-thumb {
    background-color: color-mix(in srgb, var(--color-ink-strong) 15%, transparent);
    border-radius: 999px;
    border: 4px solid var(--color-bg-strong);
    background-clip: content-box;
  }
  
  div.feed::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--color-ink-strong) 25%, transparent);
  }

  div.feed-state {
    margin: 0;
    align-self: center;
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
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--color-ink-strong);
  }

  p.feed-empty-body {
    margin: 0;
    font-size: 1rem;
    line-height: 1.55;
    color: var(--color-ink-soft);
    max-width: 38ch;
  }

  p.feed-state-label {
    margin: 0.25rem 0 0;
    font-size: 0.9375rem;
    color: var(--color-ink-soft);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  div.skeleton-line {
    height: 0.55rem;
    width: 100%;
    max-width: 14rem;
    border-radius: 4px;
    background: var(--color-panel-muted);
    opacity: 0.75;
    animation: tx-skel-pulse 1.1s var(--tx-ease) infinite;
  }

  div.skeleton-line.wide {
    max-width: 18rem;
  }

  div.skeleton-line.narrow {
    max-width: 9rem;
  }

  @keyframes tx-skel-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 0.85;
    }
  }

  /* Chat: guardian soft pill; agent blends into feed */
  div.bubble-row {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    max-width: min(36rem, 92%);
    animation: tx-fade-up 0.3s var(--tx-ease) forwards;
  }

  @keyframes tx-fade-up {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  div.bubble-row-user {
    align-self: flex-end;
    flex-direction: row;
    margin-left: auto;
  }

  div.bubble-row-bot {
    align-self: flex-start;
    flex-direction: row;
    max-width: min(40rem, 95%);
  }

  div.bubble-avatar {
    flex-shrink: 0;
    width: 2.35rem;
    height: 2.35rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
  }

  div.bubble-avatar-bot {
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  }

  div.bubble-avatar-user {
    color: color-mix(in srgb, var(--color-warning) 85%, var(--color-ink-strong));
    background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  }

  svg.avatar-svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  div.bubble {
    border-radius: 1.15rem;
    padding: 0.65rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 100%;
    word-break: break-word;
    border: none;
    transition: transform 0.2s var(--tx-ease), box-shadow 0.2s var(--tx-ease);
  }

  div.bubble-user {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-panel-muted));
    border-bottom-right-radius: 0.35rem;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--color-ink-strong) 3%, transparent);
  }

  div.bubble-user:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 10px color-mix(in srgb, var(--color-ink-strong) 5%, transparent);
  }

  div.bubble-bot {
    background: transparent;
    padding-left: 0.15rem;
    padding-right: 0.15rem;
  }

  p.bubble-text {
    margin: 0;
    color: var(--color-ink-strong);
    line-height: 1.55;
    font-size: 1.1875rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  time.bubble-time {
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    color: var(--color-ink-soft);
    align-self: flex-end;
    white-space: nowrap;
    opacity: 0.7;
    margin-top: 0.15rem;
  }

  /* Tool rows — left-aligned column (same side as agent), readable width */
  div.tool-row {
    display: flex;
    flex-direction: column;
    align-self: flex-start;
    width: 100%;
    max-width: min(26rem, 100%);
    margin: 0;
    animation: tx-fade-up 0.3s var(--tx-ease) forwards;
  }

  span.tool-lead-icon {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-ink-soft);
    background: var(--color-panel-muted);
  }

  span.tool-lead-icon svg {
    width: 0.875rem;
    height: 0.875rem;
  }

  button.tool-toggle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    background: var(--color-panel-muted);
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 4%, transparent);
    border-radius: 999px;
    padding: 0.55rem 1rem 0.55rem 0.55rem;
    cursor: pointer;
    font: inherit;
    font-size: 1.0625rem;
    color: var(--color-ink);
    text-align: left;
    transition:
      background 0.2s var(--tx-ease),
      color 0.2s var(--tx-ease),
      transform 0.2s var(--tx-ease),
      box-shadow 0.2s var(--tx-ease);
    min-width: 0;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--color-ink-strong) 2%, transparent);
  }

  button.tool-toggle:hover {
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-muted));
    color: var(--color-ink-strong);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px color-mix(in srgb, var(--color-ink-strong) 4%, transparent);
  }

  button.tool-toggle[aria-expanded="true"] {
    border-radius: 1.1rem 1.1rem 0 0;
  }

  span.tool-toggle-name {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 1rem;
    color: var(--color-ink-strong);
    flex-shrink: 0;
  }

  span.tool-toggle-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  span.tool-toggle-time {
    font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    flex-shrink: 0;
    white-space: nowrap;
    opacity: 0.8;
  }

  svg.tool-chevron-svg {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    color: var(--color-ink-soft);
    transition: transform 0.2s var(--tx-ease);
  }

  svg.tool-chevron-svg.open {
    transform: rotate(180deg);
  }

  span.status-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--color-ink-soft);
  }

  span.status-dot-completed {
    background: var(--color-success);
  }

  span.status-dot-failed {
    background: var(--color-danger);
  }

  span.status-dot-started {
    background: var(--color-warning);
  }

  div.tool-details {
    background: var(--color-input);
    border: none;
    border-radius: 0 0 1.1rem 1.1rem;
    padding: 0.6rem 0.85rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: -0.15rem;
  }

  div.tool-details-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  span.tool-role-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.85rem;
    height: 1.85rem;
    border-radius: 50%;
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-panel-muted) 70%, transparent);
  }

  span.role-pill,
  span.status-pill {
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: none;
    font-family: var(--font-mono);
  }

  span.role-robot {
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  }

  span.role-resident {
    color: var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  }

  span.role-system,
  span.role-guardian {
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-panel-muted) 55%, transparent);
  }

  span.status-started {
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-panel-muted) 50%, transparent);
  }

  span.status-completed {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
  }

  span.status-failed {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  }

  code.meta {
    display: block;
    max-width: 100%;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre;
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-input) 70%, transparent);
    border-radius: var(--tx-r-sm);
    padding: 0.5rem 0.65rem;
    border: none;
  }

  div.tool-params {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  span.tool-params-label {
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    opacity: 0.7;
  }

  /* ── Unified sidebar card ───────────────────────────────────── */
  div.sidebar-unified {
    border-radius: var(--tx-r);
    background: var(--color-panel-muted);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-line-strong) 7%, transparent);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  div.su-divider {
    height: 1px;
    background: color-mix(in srgb, var(--color-line-strong) 9%, transparent);
  }

  div.su-conn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.9rem;
    background: color-mix(in srgb, var(--color-accent) 6%, var(--color-panel-muted));
  }

  div.su-conn-left {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  span.state-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    border: none;
    font-family: var(--font-mono);
    flex-shrink: 0;
    color: var(--color-ink-soft);
    background: color-mix(in srgb, var(--color-panel) 80%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-line-strong) 8%, transparent);
  }

  span.state-live {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-success) 28%, transparent);
  }

  span.state-connecting {
    color: var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 28%, transparent);
  }

  span.state-error {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 28%, transparent);
  }

  span.state-offline {
    color: var(--color-ink-soft);
  }

  span.live-dot {
    flex-shrink: 0;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--color-line-strong);
  }

  span.live-live {
    background: var(--color-success);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-success) 20%, transparent);
  }

  span.live-connecting {
    background: var(--color-warning);
    animation: tx-connect-pulse 1.1s var(--tx-ease) infinite;
  }

  span.live-error { background: var(--color-danger); }
  span.live-offline { background: var(--color-ink-soft); }

  @keyframes tx-connect-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  p.feedback {
    margin: 0.4rem 0.9rem;
    border-radius: var(--tx-r-sm);
    padding: 0.5rem 0.7rem;
    font-size: 0.9rem;
    line-height: 1.45;
    background: color-mix(in srgb, var(--color-danger) 10%, var(--color-panel));
    color: var(--color-danger);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 22%, transparent);
  }

  div.su-metrics {
    display: flex;
    padding: 0.65rem 0.9rem;
  }

  div.su-metric-hero {
    flex: 1.4;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding-right: 0.85rem;
    border-right: 1px solid color-mix(in srgb, var(--color-line-strong) 9%, transparent);
  }

  div.su-metric-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding-left: 0.85rem;
  }

  div.su-metric {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    justify-content: center;
  }

  div.su-metric-group div.su-metric:first-child {
    border-bottom: 1px solid color-mix(in srgb, var(--color-line-strong) 9%, transparent);
    padding-bottom: 0.4rem;
    margin-bottom: 0.4rem;
  }

  span.su-metric-label {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  strong.su-metric-value {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 1.65rem;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.03em;
    color: var(--color-ink-strong);
  }

  strong.su-metric-sm {
    font-size: 1.2rem;
  }

  div.su-voice {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 2rem 1rem;
    text-align: center;
    flex: 1;
  }

  div.su-tips {
    padding: 0.6rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  @media (prefers-reduced-motion: reduce) {
    div.skeleton-line {
      animation: none;
      opacity: 0.65;
    }

    span.live-connecting {
      animation: none;
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
      grid-template-rows: minmax(0, 1fr) auto;
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

    div.button-row {
      width: 100%;
    }

    div.feed {
      max-height: none;
      min-height: 0;
    }

    div.bubble-row {
      max-width: 95%;
    }

    div.tool-row {
      max-width: 100%;
    }
  }
</style>
