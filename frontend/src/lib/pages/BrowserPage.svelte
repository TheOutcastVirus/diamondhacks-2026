<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get, post } from '../api';
  import type { BrowserAction, BrowserContext } from '../types';

  const fallbackContext: BrowserContext = {
    url: 'No page loaded',
    title: 'Awaiting browser state',
    summary:
      'Submit a task above to start browser automation.',
    status: 'idle',
    lastUpdated: new Date().toISOString(),
    activeTask: '',
    tabLabel: 'No active tab',
    domSnippet: '',
    recentActions: [],
  };

  let browserContext: BrowserContext = fallbackContext;
  let isLoading = true;
  let errorMessage = '';
  let autoRefresh = true;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  let taskPrompt = '';
  let isSubmitting = false;
  let submitError = '';
  let fastPollEnd = 0;

  function formatTimestamp(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function normalizeActions(payload: unknown) {
    if (!Array.isArray(payload)) return [];
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

  function currentInterval() {
    return Date.now() < fastPollEnd ? 2000 : 8000;
  }

  function syncTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (!autoRefresh) return;
    const interval = currentInterval();
    refreshTimer = setInterval(async () => {
      await loadBrowserContext();
      // If we're in fast-poll mode and have a previewUrl, we can slow down
      if (Date.now() >= fastPollEnd && refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
        syncTimer();
      }
    }, interval);
  }

  function startFastPoll() {
    fastPollEnd = Date.now() + 120_000; // fast-poll for up to 2 minutes
    syncTimer();
  }

  async function submitTask() {
    if (!taskPrompt.trim() || isSubmitting) return;
    isSubmitting = true;
    submitError = '';
    try {
      await post('/api/agent/turn', {
        message: taskPrompt.trim(),
        source: 'dashboard',
        forceBrowser: true,
      });
      taskPrompt = '';
      await loadBrowserContext();
      startFastPoll();
    } catch (err) {
      submitError = err instanceof Error ? err.message : 'Failed to start browser task.';
    } finally {
      isSubmitting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      void submitTask();
    }
  }

  onMount(async () => {
    await loadBrowserContext();
    syncTimer();
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  $: syncTimer();

  $: isActive = browserContext.status === 'executing' || browserContext.status === 'navigating';
</script>

<section class="page-outer">
  <!-- Prompt input -->
  <section class="prompt-section">
    <form on:submit|preventDefault={submitTask} class="prompt-form">
      <textarea
        bind:value={taskPrompt}
        on:keydown={handleKeydown}
        placeholder="Describe a task for the browser agent… (⌘↵ to submit)"
        class="prompt-input"
        rows="2"
        disabled={isSubmitting}
      ></textarea>
      <button type="submit" class="run-btn" disabled={isSubmitting || !taskPrompt.trim()}>
        {isSubmitting ? 'Starting…' : 'Run'}
      </button>
    </form>
    {#if submitError}
      <p class="feedback feedback-error">{submitError}</p>
    {/if}
  </section>

  <!-- Main two-column layout -->
  <section class="page-grid">

    <!-- Left: status + actions -->
    <section class="panel side-panel">
      <section class="callout" class:callout-active={isActive}>
        <p class="panel-label">Status</p>
        <strong class={`status status-${browserContext.status}`}>{browserContext.status}</strong>
        {#if browserContext.activeTask}
          <p class="active-task">{browserContext.activeTask}</p>
        {/if}
        <p class="panel-copy url-copy">{browserContext.url}</p>
      </section>

      <div class="button-row">
        <label class="switcher">
          <input bind:checked={autoRefresh} type="checkbox" />
          <span>Auto-refresh</span>
        </label>
        <button class="ghost" type="button" on:click={loadBrowserContext}>Refresh</button>
      </div>

      <section class="panel panel-muted actions-panel">
        <p class="panel-label">Recent Actions</p>

        {#if isLoading && browserContext.recentActions.length === 0}
          <p class="panel-copy">Loading…</p>
        {:else if errorMessage}
          <p class="feedback feedback-error">{errorMessage}</p>
        {:else if browserContext.recentActions.length === 0}
          <p class="panel-copy">No actions yet.</p>
        {:else}
          <div class="stack">
            {#each [...browserContext.recentActions].reverse() as action (action.id)}
              <article class="action-card">
                <div class="action-head">
                  <strong class="action-kind">{action.kind}</strong>
                  <span class={`status status-${action.status ?? 'pending'}`}>{action.status ?? 'pending'}</span>
                </div>
                <p class="panel-copy">{action.detail}</p>
                <time class="timestamp" datetime={action.timestamp}>{formatTimestamp(action.timestamp)}</time>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    </section>

    <!-- Right: live view -->
    <section class="panel live-panel">
      <header class="live-header">
        <div>
          <p class="panel-label">Live View</p>
          <h2 class="section-heading">{browserContext.title}</h2>
        </div>
        {#if isActive}
          <span class="pulse-dot"></span>
        {/if}
      </header>

      {#if browserContext.previewUrl}
        <iframe
          class="preview-frame"
          src={browserContext.previewUrl}
          title="Live Browser Use session"
          loading="lazy"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      {:else if browserContext.screenshotUrl}
        <img class="preview-image" src={browserContext.screenshotUrl} alt="Browser preview" />
      {:else}
        <div class="live-placeholder">
          {#if isActive}
            <p class="placeholder-lead">Browser agent is working…</p>
            <p class="placeholder-sub">Live view will appear once the session connects.</p>
          {:else}
            <p class="placeholder-lead">No active session</p>
            <p class="placeholder-sub">Submit a task above to launch the browser agent.</p>
          {/if}
        </div>
      {/if}
    </section>

  </section>
</section>

<style>
  section.page-outer {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    height: 100%;
  }

  /* ── Prompt ────────────────────────────────── */
  section.prompt-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  form.prompt-form {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }

  textarea.prompt-input {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 0.95rem;
    padding: 0.75rem 1rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-input);
    color: var(--color-ink-strong);
    border-radius: 0;
    outline: none;
    transition: border-color 160ms ease;
  }

  textarea.prompt-input:focus {
    border-color: var(--color-accent);
  }

  textarea.prompt-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  button.run-btn {
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 0;
    padding: 0.75rem 1.5rem;
    border: var(--border-width) solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-panel);
    white-space: nowrap;
    transition:
      opacity 160ms ease,
      transform 160ms ease;
  }

  button.run-btn:hover:not(:disabled) {
    opacity: 0.88;
    transform: translateY(-1px);
  }

  button.run-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ── Main grid ─────────────────────────────── */
  section.page-grid {
    display: grid;
    grid-template-columns: minmax(16rem, 0.55fr) minmax(0, 1fr);
    gap: 1.25rem;
    flex: 1;
    min-height: 0;
  }

  section.panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Left side panel ───────────────────────── */
  section.side-panel {
    overflow-y: auto;
  }

  section.callout {
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  section.callout.callout-active {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent),
      var(--color-panel-muted);
  }

  p.active-task {
    margin: 0;
    font-size: 0.9rem;
    color: var(--color-ink-strong);
    font-weight: 500;
  }

  p.url-copy {
    font-size: 0.78rem;
    word-break: break-all;
    color: var(--color-ink-soft);
  }

  div.button-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }

  section.actions-panel {
    flex: 1;
    overflow-y: auto;
  }

  section.panel-muted {
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    padding: 1rem;
  }

  div.stack {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    margin-top: 0.75rem;
  }

  article.action-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    padding: 0.75rem;
  }

  div.action-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  strong.action-kind {
    color: var(--color-ink-strong);
    font-size: 0.85rem;
    text-transform: capitalize;
  }

  /* ── Right live panel ──────────────────────── */
  section.live-panel {
    min-height: 0;
  }

  header.live-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  h2.section-heading {
    margin: 0;
    font-family: var(--font-display);
    color: var(--color-ink-strong);
    font-size: clamp(1.1rem, 1.4vw, 1.5rem);
  }

  span.pulse-dot {
    display: inline-block;
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    background: var(--color-success);
    animation: pulse 1.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.7); }
  }

  iframe.preview-frame {
    flex: 1;
    width: 100%;
    min-height: 32rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-input);
  }

  img.preview-image {
    width: 100%;
    border: var(--border-width) solid var(--color-line);
    object-fit: cover;
    display: block;
  }

  div.live-placeholder {
    flex: 1;
    min-height: 32rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: var(--border-width) dashed var(--color-line);
    background: var(--color-panel-muted);
    padding: 2rem;
    text-align: center;
  }

  p.placeholder-lead {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-ink-strong);
  }

  p.placeholder-sub {
    margin: 0;
    font-size: 0.88rem;
    color: var(--color-ink-soft);
  }

  /* ── Shared ────────────────────────────────── */
  p.panel-label {
    font-size: 0.75rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    margin: 0;
  }

  p.panel-copy {
    margin: 0;
    font-size: 0.9rem;
    color: var(--color-ink-soft);
    line-height: 1.5;
  }

  span.status {
    color: var(--color-ink-strong);
    text-transform: capitalize;
    border: var(--border-width) solid var(--color-line);
    padding: 0.2rem 0.45rem;
    font-size: 0.8rem;
  }

  span.status-idle,
  span.status-pending {
    color: var(--color-warning);
  }

  span.status-executing,
  span.status-navigating,
  span.status-completed {
    color: var(--color-success);
  }

  span.status-blocked,
  span.status-failed {
    color: var(--color-danger);
  }

  strong.status {
    font-size: 0.9rem;
  }

  time.timestamp {
    font-size: 0.75rem;
    color: var(--color-ink-soft);
  }

  button.ghost {
    font: inherit;
    cursor: pointer;
    border-radius: 0;
    padding: 0.5rem 0.85rem;
    border: var(--border-width) solid var(--color-line);
    background: transparent;
    color: var(--color-ink-strong);
    font-size: 0.85rem;
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
    font-size: 0.85rem;
  }

  p.feedback {
    margin: 0;
    padding: 0.75rem 1rem;
    font-size: 0.88rem;
  }

  p.feedback-error {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border: 2px solid var(--color-line);
    color: var(--color-danger);
  }

  /* ── Responsive ────────────────────────────── */
  @media (max-width: 1080px) {
    section.page-grid {
      grid-template-columns: 1fr;
    }

    iframe.preview-frame,
    div.live-placeholder {
      min-height: 22rem;
    }
  }

  @media (max-width: 720px) {
    form.prompt-form,
    div.button-row {
      flex-direction: column;
      align-items: stretch;
    }

    button.run-btn {
      align-self: flex-end;
    }

    button.ghost {
      width: 100%;
    }
  }
</style>
