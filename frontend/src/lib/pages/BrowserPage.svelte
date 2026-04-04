<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from '../api';
  import type { BrowserAction, BrowserContext } from '../types';

  const fallbackContext: BrowserContext = {
    url: 'No page loaded',
    title: 'Awaiting browser state',
    summary:
      'Once the backend exposes browser context, this page will mirror the active page, task, and recent browser actions.',
    status: 'idle',
    lastUpdated: new Date().toISOString(),
    activeTask: 'Waiting for browser automation',
    tabLabel: 'No active tab',
    domSnippet: '',
    recentActions: [],
  };

  let browserContext: BrowserContext = fallbackContext;
  let isLoading = true;
  let errorMessage = '';
  let autoRefresh = true;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function formatTimestamp(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function formatActionKind(value: string) {
    return value
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeActions(payload: unknown) {
    if (!Array.isArray(payload)) {
      return [];
    }

    return payload.map((action, index) => {
      const value = typeof action === 'object' && action !== null ? (action as Record<string, unknown>) : {};
      return {
        id: String(value.id ?? `action-${index}`),
        kind: String(value.kind ?? value.type ?? 'event'),
        detail: String(value.detail ?? value.message ?? value.summary ?? 'No detail supplied.'),
        timestamp: String(value.timestamp ?? value.createdAt ?? new Date().toISOString()),
        status:
          value.status === 'pending' || value.status === 'completed' || value.status === 'failed'
            ? value.status
            : undefined,
      } satisfies BrowserAction;
    });
  }

  function normalizeContext(payload: unknown): BrowserContext {
    const value = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const container =
      typeof value.browser === 'object' && value.browser !== null
        ? (value.browser as Record<string, unknown>)
        : value;

    return {
      url: String(container.url ?? fallbackContext.url),
      title: String(container.title ?? fallbackContext.title),
      summary: String(container.summary ?? container.description ?? fallbackContext.summary),
      status:
        container.status === 'navigating' ||
        container.status === 'executing' ||
        container.status === 'blocked' ||
        container.status === 'idle'
          ? container.status
          : 'idle',
      lastUpdated: String(container.lastUpdated ?? container.timestamp ?? new Date().toISOString()),
      activeTask: container.activeTask ? String(container.activeTask) : fallbackContext.activeTask,
      tabLabel: container.tabLabel ? String(container.tabLabel) : fallbackContext.tabLabel,
      domSnippet: container.domSnippet ? String(container.domSnippet) : '',
      previewUrl: container.previewUrl ? String(container.previewUrl) : undefined,
      screenshotUrl: container.screenshotUrl ? String(container.screenshotUrl) : undefined,
      recentActions: normalizeActions(container.recentActions ?? value.recentActions),
    };
  }

  async function loadBrowserContext() {
    isLoading = true;
    errorMessage = '';

    try {
      const payload = await get<unknown>('browser');
      browserContext = normalizeContext(payload);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unable to load browser context.';
      browserContext = fallbackContext;
    } finally {
      isLoading = false;
    }
  }

  function syncTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (autoRefresh) {
      refreshTimer = setInterval(() => {
        loadBrowserContext();
      }, 8000);
    }
  }

  onMount(async () => {
    await loadBrowserContext();
    syncTimer();
  });

  onDestroy(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
  });

  $: syncTimer();
</script>

<section class="page-grid">
  <section class="panel">
    <header class="panel-header">
      <div>
        <p class="panel-label">Current</p>
        <h2 class="section-heading">{browserContext.title}</h2>
      </div>

      <div class="button-row">
        <label class="switcher">
          <input bind:checked={autoRefresh} type="checkbox" />
          <span>Auto-refresh</span>
        </label>
        <button class="ghost" type="button" on:click={loadBrowserContext}>Refresh now</button>
      </div>
    </header>

    <section class="callout">
      <p class="panel-label">Page</p>
      <h3 class="callout-heading">{browserContext.url}</h3>
      <p class="panel-copy">{browserContext.summary}</p>
    </section>

    <section class="overview-grid">
      <article class="metric-card">
        <p class="metric-label">Status</p>
        <strong class={`status status-${browserContext.status}`}>{browserContext.status}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Tab label</p>
        <strong class="metric-value">{browserContext.tabLabel}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Last updated</p>
        <strong class="metric-value">{formatTimestamp(browserContext.lastUpdated)}</strong>
      </article>
    </section>

    <section class="panel panel-muted">
      <p class="panel-label">Task</p>
      <h3 class="callout-heading">{browserContext.activeTask}</h3>
      <p class="panel-copy">Current browser work.</p>
    </section>

    {#if browserContext.previewUrl}
      <section class="panel panel-muted">
        <p class="panel-label">Live preview</p>
        <iframe
          class="preview-frame"
          src={browserContext.previewUrl}
          title="Live Browser Use session"
          loading="lazy"
        ></iframe>
      </section>
    {:else if browserContext.screenshotUrl}
      <section class="panel panel-muted">
        <p class="panel-label">Visual preview</p>
        <img class="preview-image" src={browserContext.screenshotUrl} alt="Robot browser preview" />
      </section>
    {/if}

    {#if browserContext.domSnippet}
      <section class="panel panel-muted">
        <p class="panel-label">DOM snippet</p>
        <pre class="snippet">{browserContext.domSnippet}</pre>
      </section>
    {/if}
  </section>

  <section class="panel">
    <section class="panel panel-muted">
      <p class="panel-label">Recent</p>
      <h2 class="section-heading">Actions</h2>

      {#if isLoading}
        <p class="panel-copy">Loading browser state...</p>
      {:else if errorMessage}
        <p class="feedback feedback-error">{errorMessage}</p>
      {:else if browserContext.recentActions.length === 0}
        <p class="panel-copy">No recent actions yet.</p>
      {:else}
        <div class="action-list">
          {#each browserContext.recentActions as action}
            <article class="action-card">
              <div class="action-rail" aria-hidden="true"></div>
              <div class="action-body">
                <div class="action-head">
                  <div class="action-meta">
                    <p class="action-label">Browser event</p>
                    <strong class="action-kind">{formatActionKind(action.kind)}</strong>
                  </div>
                  <span class={`status status-${action.status ?? 'pending'}`}>{action.status ?? 'pending'}</span>
                </div>
                <p class="panel-copy action-detail">{action.detail}</p>
                <time class="timestamp" datetime={action.timestamp}>{formatTimestamp(action.timestamp)}</time>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <section class="panel panel-muted">
      <p class="panel-label">Notes</p>
      <ul class="note-list">
        <li class="note-item">Show a screenshot when available.</li>
        <li class="note-item">Show page text when images are unavailable.</li>
        <li class="note-item">Keep recent actions short.</li>
      </ul>
    </section>
  </section>
</section>

<style>
  section.page-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(18rem, 0.8fr);
    gap: 1.5rem;
  }

  section.panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  header.panel-header,
  div.button-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }

  h2.section-heading,
  h3.callout-heading {
    margin: 0;
    font-family: var(--font-display);
    color: var(--color-ink-strong);
  }

  h2.section-heading {
    font-size: clamp(1.45rem, 1.8vw, 2rem);
  }

  h3.callout-heading {
    font-size: 1.1rem;
    word-break: break-word;
  }

  section.callout,
  section.panel-muted,
  article.metric-card {
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    padding: 1rem;
  }

  section.callout {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, transparent), transparent),
      var(--color-panel-muted);
  }

  section.overview-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.9rem;
  }

  p.metric-label {
    font-size: 0.78rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  strong.metric-value,
  strong.action-kind {
    color: var(--color-ink-strong);
  }

  strong.metric-value {
    font-size: 1rem;
    line-height: 1.5;
  }

  span.status {
    color: var(--color-ink-strong);
    text-transform: capitalize;
    border: var(--border-width) solid var(--color-line);
    padding: 0.25rem 0.5rem;
  }

  span.status-idle,
  span.status-pending {
    color: var(--color-warning);
  }

  span.status-executing,
  span.status-completed {
    color: var(--color-success);
  }

  span.status-blocked,
  span.status-failed {
    color: var(--color-danger);
  }

  button.ghost {
    font: inherit;
    cursor: pointer;
    border-radius: 0;
    padding: 0.82rem 1rem;
    border: var(--border-width) solid var(--color-line);
    background: transparent;
    color: var(--color-ink-strong);
    transition:
      transform 160ms ease,
      border-color 160ms ease;
  }

  button.ghost:hover,
  button.ghost:focus-visible {
    transform: translateY(-1px);
    border-color: var(--color-accent);
  }

  label.switcher {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--color-ink-soft);
  }

  img.preview-image {
    width: 100%;
    display: block;
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    object-fit: cover;
  }

  iframe.preview-frame {
    width: 100%;
    min-height: 24rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-input);
  }

  pre.snippet {
    margin: 0;
    padding: 1rem;
    border-radius: 0;
    background: var(--color-panel);
    border: var(--border-width) solid var(--color-line);
    color: var(--color-ink-strong);
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-word;
  }

  div.action-list {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  article.action-card {
    display: grid;
    grid-template-columns: 0.7rem minmax(0, 1fr);
    gap: 0.95rem;
    align-items: stretch;
    border: var(--border-width) solid var(--color-line);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-panel) 88%, white), var(--color-panel-muted));
    padding: 1rem;
  }

  div.action-rail {
    background: linear-gradient(180deg, var(--color-accent), color-mix(in srgb, var(--color-accent) 24%, transparent));
    min-height: 100%;
  }

  div.action-body,
  div.action-meta {
    display: flex;
    flex-direction: column;
  }

  div.action-body {
    gap: 0.55rem;
    min-width: 0;
  }

  div.action-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.85rem;
  }

  div.action-meta {
    gap: 0.2rem;
    min-width: 0;
  }

  p.action-label {
    margin: 0;
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  strong.action-kind {
    font-size: 1rem;
    line-height: 1.25;
    text-transform: capitalize;
    overflow-wrap: anywhere;
  }

  p.action-detail {
    line-height: 1.6;
    overflow-wrap: anywhere;
  }

  time.timestamp {
    display: block;
    color: var(--color-ink-soft);
    font-size: 0.86rem;
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
    margin: 0;
    border-radius: 0;
    padding: 0.85rem 1rem;
  }

  p.feedback-error {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border: 2px solid var(--color-line);
    color: var(--color-danger);
  }

  @media (max-width: 1080px) {
    section.page-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    header.panel-header,
    div.button-row {
      flex-direction: column;
      align-items: flex-start;
    }

    section.overview-grid {
      grid-template-columns: 1fr;
    }

    article.action-card {
      grid-template-columns: 0.45rem minmax(0, 1fr);
      gap: 0.75rem;
      padding: 0.9rem;
    }

    div.action-head {
      flex-direction: column;
      align-items: flex-start;
    }

    button.ghost {
      width: 100%;
    }
  }
</style>
