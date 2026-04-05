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
    profileId: undefined,
    configuredProfileId: undefined,
    activeTask: '',
    tabLabel: 'No active tab',
    domSnippet: '',
    recentActions: [],
  };

  let browserContext: BrowserContext = fallbackContext;
  let isLoading = true;
  let errorMessage = '';
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  let taskPrompt = '';
  let isSubmitting = false;
  let submitError = '';
  let fastPollEnd = 0;
  let isResetting = false;

  async function resetSession() {
    if (!confirm('Reset session? This clears transcript, browser history, and pending prompts. Saved memory is kept.')) return;
    isResetting = true;
    try {
      await post('/api/reset', {});
      window.location.reload();
    } catch (e) {
      alert('Reset failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
      isResetting = false;
    }
  }

  /** Bumping this remounts the iframe / busts screenshot cache so the live surface reloads. */
  let liveFeedNonce = 0;
  let liveFeedRefreshing = false;

  type FriendlyCopy = {
    short: string;
    title: string;
  };

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

  function cleanInlineText(value: string) {
    return value.replace(/\s+/g, ' ').trim();
  }

  function trimTrailingPunctuation(value: string) {
    return value.replace(/[.?!,:;]+$/g, '').trim();
  }

  function shorten(value: string, limit = 88) {
    if (value.length <= limit) return value;
    return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
  }

  function formatItemList(value: string) {
    return trimTrailingPunctuation(cleanInlineText(value)).replace(/\s+/g, ' ');
  }

  function describeActiveTask(task?: string): FriendlyCopy | null {
    if (!task) return null;
    const normalized = cleanInlineText(task);
    if (!normalized) return null;

    const cvsItems = normalized.match(/Order the following items:\s*([^.]*)\./i)?.[1];
    if (normalized.includes('https://www.cvs.com') && cvsItems) {
      const items = formatItemList(cvsItems);
      return {
        short: shorten(`Working on a CVS order for ${items}.`, 72),
        title: `The browser agent is on CVS and is trying to get ${items}. It will stop and ask if it needs anything else.`,
      };
    }

    const merchant = normalized.match(/place a delivery order from "([^"]+)"/i)?.[1];
    const foodItems = normalized.match(/Add these items to the cart:\s*([^.]*)\./i)?.[1];
    if (merchant && foodItems) {
      const items = formatItemList(foodItems);
      return {
        short: shorten(`Ordering ${items} from ${merchant}.`, 72),
        title: `The browser agent is placing an order from ${merchant} for ${items}.`,
      };
    }

    const genericMerchant = normalized.match(/Go to ([^.]+?) and order ([^.]+?) for the household\./i);
    if (genericMerchant) {
      const merchantLabel = trimTrailingPunctuation(genericMerchant[1] ?? '');
      const itemLabel = trimTrailingPunctuation(genericMerchant[2] ?? '');
      return {
        short: shorten(`Ordering ${itemLabel} from ${merchantLabel}.`, 72),
        title: `The browser agent is trying to order ${itemLabel} from ${merchantLabel}.`,
      };
    }

    return {
      short: shorten(normalized, 72),
      title: normalized,
    };
  }

  function describeSummary(summary: string, status: BrowserContext['status']): FriendlyCopy {
    const normalized = cleanInlineText(summary);
    if (!normalized) {
      return {
        short: 'No update yet.',
        title: 'No update yet.',
      };
    }

    if (normalized.startsWith('Browser Use is working on the task')) {
      return {
        short: status === 'navigating' ? 'Opening the site now.' : 'Working on your request now.',
        title: 'The browser agent is actively working and will update this panel when something changes.',
      };
    }

    const waitingMatch = normalized.match(/^Waiting for user:\s*(.+)$/i);
    if (waitingMatch) {
      const promptLabel = waitingMatch[1] ?? 'more information';
      let short = 'Needs a bit more information to continue.';
      if (/payment/i.test(promptLabel)) {
        short = 'Needs payment details to continue.';
      } else if (/delivery|address/i.test(promptLabel)) {
        short = 'Needs delivery details to continue.';
      } else if (/confirm/i.test(promptLabel)) {
        short = 'Waiting for your confirmation.';
      }
      return {
        short,
        title: `The browser agent paused because it needs ${promptLabel.toLowerCase()} before it can continue.`,
      };
    }

    if (normalized.includes('Browser Use is unreachable')) {
      return {
        short: 'Could not connect to the browser service.',
        title: 'The app could not reach the browser automation service. Check the backend connection or Browser Use settings, then try again.',
      };
    }

    if (/timed out/i.test(normalized)) {
      return {
        short: 'The browser task took too long and stopped.',
        title: 'The browser agent did not finish in time. You can try the task again.',
      };
    }

    if (/order placed/i.test(normalized)) {
      return {
        short: shorten(normalized, 88),
        title: normalized,
      };
    }

    if (/i couldn't complete|could not complete|blocked/i.test(normalized)) {
      return {
        short: shorten(normalized, 88),
        title: normalized,
      };
    }

    return {
      short: shorten(normalized, 88),
      title: normalized,
    };
  }

  function describeAction(action: BrowserAction): FriendlyCopy {
    const detail = cleanInlineText(action.detail);

    if (action.kind === 'dispatch') {
      return {
        short: 'Started the browser task.',
        title: 'The task was sent to the browser agent.',
      };
    }

    if (action.kind === 'auth') {
      return {
        short: shorten(detail, 88),
        title: detail,
      };
    }

    if (action.kind === 'cache') {
      return {
        short: shorten(detail.replace(/Deterministic rerun/gi, 'Saved flow'), 88),
        title: detail,
      };
    }

    if (action.kind === 'error') {
      return describeSummary(detail, 'blocked');
    }

    if (action.kind === 'summary') {
      return describeSummary(detail, action.status === 'failed' ? 'blocked' : 'idle');
    }

    return {
      short: shorten(detail, 88),
      title: detail,
    };
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
      profileId: container.profileId ? String(container.profileId) : undefined,
      configuredProfileId: container.configuredProfileId ? String(container.configuredProfileId) : undefined,
      activeTask: container.activeTask ? String(container.activeTask) : fallbackContext.activeTask,
      tabLabel: container.tabLabel ? String(container.tabLabel) : fallbackContext.tabLabel,
      domSnippet: container.domSnippet ? String(container.domSnippet) : '',
      previewUrl: container.previewUrl ? String(container.previewUrl) : undefined,
      screenshotUrl: container.screenshotUrl ? String(container.screenshotUrl) : undefined,
      recentActions: normalizeActions(container.recentActions ?? value.recentActions),
    };
  }

  async function loadBrowserContext(silent = false) {
    if (!silent) {
      isLoading = true;
    }
    errorMessage = '';
    try {
      const payload = await get<unknown>('browser');
      browserContext = normalizeContext(payload);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unable to load browser context.';
      browserContext = fallbackContext;
    } finally {
      if (!silent) {
        isLoading = false;
      }
    }
  }

  async function refreshLiveFeed() {
    if (liveFeedRefreshing) return;
    liveFeedRefreshing = true;
    liveFeedNonce += 1;
    try {
      await loadBrowserContext(true);
    } finally {
      liveFeedRefreshing = false;
    }
  }

  function screenshotSrc(url: string, nonce: number): string {
    try {
      const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
      parsed.searchParams.set('_rv', String(nonce));
      return parsed.toString();
    } catch {
      return `${url}${url.includes('?') ? '&' : '?'}_rv=${nonce}`;
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
  $: activeTaskCopy = describeActiveTask(browserContext.activeTask);
  $: summaryCopy = describeSummary(browserContext.summary, browserContext.status);
  $: configuredProfileShort = browserContext.configuredProfileId
    ? `${browserContext.configuredProfileId.slice(0, 8)}...${browserContext.configuredProfileId.slice(-8)}`
    : '';
  $: activeProfileShort = browserContext.profileId
    ? `${browserContext.profileId.slice(0, 8)}...${browserContext.profileId.slice(-8)}`
    : '';
</script>

<section class="page-outer">
  <!-- Prompt input -->
  <section class="prompt-section">
    <div class="prompt-shell">
      <form on:submit|preventDefault={submitTask} class="prompt-form">
        <label class="prompt-label" for="browser-task-input">Task</label>
        <div class="prompt-input-wrap">
          <textarea
            id="browser-task-input"
            bind:value={taskPrompt}
            on:keydown={handleKeydown}
            placeholder="What should the browser agent do?"
            class="prompt-input"
            rows="2"
            disabled={isSubmitting}
          ></textarea>
        </div>
        <button type="submit" class="run-btn" disabled={isSubmitting || !taskPrompt.trim()}>
          {#if isSubmitting}
            <span class="run-btn-spinner" aria-hidden="true"></span>
            Starting…
          {:else}
            Run
          {/if}
        </button>
      </form>
    </div>
    <p class="prompt-hint">
      <span class="prompt-hint-keys">
        <kbd class="kbd">⌘</kbd><span class="kbd-plus">/</span><kbd class="kbd">Ctrl</kbd><span class="kbd-plus">+</span><kbd class="kbd">Enter</kbd>
      </span>
      <span class="prompt-hint-text">to run · Enter alone starts a new line</span>
    </p>
    {#if browserContext.configuredProfileId}
      <div class="profile-banner">
        <p class="profile-banner-title">Synced browser profile is enabled by default.</p>
        <p class="profile-banner-copy">
          New browser tasks reuse the configured Browser Use cloud profile
          <code>{configuredProfileShort}</code>.
          {#if browserContext.profileId}
            Active session profile: <code>{activeProfileShort}</code>.
          {/if}
          Re-syncing cookies is still a separate manual step.
        </p>
      </div>
    {/if}
    {#if submitError}
      <p class="feedback feedback-error" role="alert">{submitError}</p>
    {/if}
  </section>

  <!-- Main two-column layout -->
  <section class="page-grid">

    <!-- Left: status + actions -->
    <aside class="panel side-panel" aria-label="Browser session">
      <section class="callout" class:callout-active={isActive}>
        <div class="callout-top">
          <p class="panel-label">Status</p>
          <strong class={`status-pill status-pill-${browserContext.status}`}>{browserContext.status}</strong>
        </div>
        {#if activeTaskCopy}
          <p class="active-task" title={activeTaskCopy.title}>{activeTaskCopy.short}</p>
        {/if}
        <p class="panel-copy callout-summary" title={summaryCopy.title}>{summaryCopy.short}</p>
        <p class="panel-copy url-copy" title={browserContext.url}>{browserContext.url}</p>
      </section>

      <div class="button-row">
        <button class="ghost" type="button" on:click={() => void loadBrowserContext()}>Refresh</button>
        <button class="ghost ghost-danger" type="button" on:click={resetSession} disabled={isResetting}>
          {isResetting ? 'Resetting…' : 'Reset Session'}
        </button>
      </div>

      <section class="panel panel-muted actions-panel">
        <p class="panel-label">Recent Actions</p>

        {#if isLoading && browserContext.recentActions.length === 0}
          <div class="actions-skeleton" aria-busy="true" aria-label="Loading actions">
            <div class="skeleton-line skeleton-line-long"></div>
            <div class="skeleton-line skeleton-line-mid"></div>
            <div class="skeleton-line skeleton-line-short"></div>
          </div>
        {:else if errorMessage}
          <p class="feedback feedback-error" role="alert">{errorMessage}</p>
        {:else if browserContext.recentActions.length === 0}
          <p class="panel-copy">No actions yet.</p>
        {:else}
          <div class="stack">
            {#each [...browserContext.recentActions].reverse() as action (action.id)}
              {@const actionCopy = describeAction(action)}
              <article class="action-card">
                <div class="action-head">
                  <strong class="action-kind">{action.kind}</strong>
                  <span class={`status status-${action.status ?? 'pending'}`}>{action.status ?? 'pending'}</span>
                </div>
                <p class="panel-copy" title={actionCopy.title}>{actionCopy.short}</p>
                <time class="timestamp" datetime={action.timestamp}>{formatTimestamp(action.timestamp)}</time>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    </aside>

    <!-- Right: live view -->
    <section class="panel live-panel">
      <header class="live-header">
        <div class="live-header-text">
          <p class="panel-label">Live View</p>
          <h2 class="section-heading">{browserContext.title}</h2>
        </div>
        <div class="live-header-actions">
          <button
            type="button"
            class="live-refresh-btn"
            on:click={() => void refreshLiveFeed()}
            disabled={liveFeedRefreshing}
            title="Reload the live stream and fetch the latest session state from the server"
          >
            <span class="live-refresh-icon" class:live-refresh-icon-spinning={liveFeedRefreshing} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
            </span>
            {liveFeedRefreshing ? 'Refreshing…' : 'Refresh live'}
          </button>
          {#if isActive}
            <span class="live-badge">
              <span class="pulse-dot" aria-hidden="true"></span>
              Live
            </span>
          {/if}
        </div>
      </header>

      <div class="live-chrome">
        {#if browserContext.previewUrl}
          {#key liveFeedNonce}
            <iframe
              class="preview-frame"
              src={browserContext.previewUrl}
              title="Live Browser Use session"
              loading="lazy"
              allow="clipboard-read; clipboard-write"
            ></iframe>
          {/key}
        {:else if browserContext.screenshotUrl}
          <img
            class="preview-image"
            src={screenshotSrc(browserContext.screenshotUrl, liveFeedNonce)}
            alt="Browser preview"
          />
        {:else}
          <div class="live-placeholder" class:live-placeholder-busy={isActive}>
            <div class="placeholder-icon" aria-hidden="true">
              <svg viewBox="0 0 64 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="6" width="56" height="36" rx="3" stroke="currentColor" stroke-width="1.5" opacity="0.35" />
                <rect x="4" y="6" width="56" height="8" rx="2" fill="currentColor" opacity="0.12" />
                <circle cx="10" cy="10" r="1.5" fill="currentColor" opacity="0.35" />
                <circle cx="15" cy="10" r="1.5" fill="currentColor" opacity="0.2" />
                <circle cx="20" cy="10" r="1.5" fill="currentColor" opacity="0.2" />
              </svg>
            </div>
            {#if isActive}
              <p class="placeholder-lead">Browser agent is working…</p>
              <p class="placeholder-sub">Live view will appear once the session connects.</p>
            {:else}
              <p class="placeholder-lead">No active session</p>
              <p class="placeholder-sub">Submit a task above to launch the browser agent.</p>
            {/if}
          </div>
        {/if}
      </div>
    </section>

  </section>
</section>

<style>
  section.page-outer {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
  }

  /* ── Prompt ────────────────────────────────── */
  section.prompt-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  div.prompt-shell {
    border-radius: 12px;
    padding: 1rem 1.1rem 1.05rem;
    background: var(--color-panel-muted);
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    border-left: 3px solid var(--color-accent);
    box-shadow: 0 1px 2px color-mix(in srgb, var(--color-ink-strong) 8%, transparent);
  }

  p.prompt-hint {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem 0.65rem;
    font-size: 0.8rem;
    color: var(--color-ink-soft);
    line-height: 1.4;
  }

  div.profile-banner {
    margin-top: 0.15rem;
    border-radius: 10px;
    padding: 0.8rem 0.95rem;
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-muted));
    border: 1px solid color-mix(in srgb, var(--color-accent) 24%, var(--color-line));
  }

  p.profile-banner-title {
    margin: 0 0 0.28rem;
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--color-ink-strong);
  }

  p.profile-banner-copy {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--color-ink-soft);
  }

  p.profile-banner-copy code {
    font-family: var(--font-mono);
    font-size: 0.76rem;
    color: var(--color-ink-strong);
  }

  span.prompt-hint-keys {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.2rem;
  }

  span.prompt-hint-text {
    color: color-mix(in srgb, var(--color-ink-soft) 88%, var(--color-ink));
  }

  kbd.kbd {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.12rem 0.4rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 18%, var(--color-line));
    background: var(--color-input);
    color: var(--color-ink-strong);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ink-strong) 12%, transparent);
  }

  span.kbd-plus {
    font-size: 0.7rem;
    color: var(--color-ink-soft);
    user-select: none;
  }

  form.prompt-form {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.55rem 0.85rem;
    align-items: end;
  }

  label.prompt-label {
    grid-column: 1 / -1;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    margin: 0;
  }

  div.prompt-input-wrap {
    border-radius: 8px;
    background: var(--color-input);
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 12%, var(--color-line));
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease;
  }

  div.prompt-input-wrap:focus-within {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 28%, transparent);
  }

  textarea.prompt-input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    font: inherit;
    font-size: 0.95rem;
    line-height: 1.45;
    padding: 0.8rem 1rem;
    border: none;
    background: transparent;
    color: var(--color-ink-strong);
    border-radius: 8px;
    outline: none;
  }

  textarea.prompt-input::placeholder {
    color: color-mix(in srgb, var(--color-ink-soft) 72%, transparent);
  }

  textarea.prompt-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  button.run-btn {
    font: inherit;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    border-radius: 8px;
    padding: 0.8rem 1.35rem;
    min-height: 2.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-panel);
    white-space: nowrap;
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ink-strong) 12%, transparent);
    transition:
      transform 160ms ease,
      background-color 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
  }

  button.run-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink-strong));
    border-color: color-mix(in srgb, var(--color-accent) 88%, var(--color-ink-strong));
    transform: translateY(-1px);
  }

  button.run-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  button.run-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  button.run-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  span.run-btn-spinner {
    width: 0.85em;
    height: 0.85em;
    border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: browser-spin 0.65s linear infinite;
  }

  @keyframes browser-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── Main grid ─────────────────────────────── */
  section.page-grid {
    display: grid;
    grid-template-columns: minmax(17rem, 0.52fr) minmax(0, 1fr);
    gap: 1.35rem;
    flex: 1;
    min-height: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* ── Left side panel ───────────────────────── */
  aside.side-panel {
    overflow-y: auto;
    padding-right: 0.15rem;
    gap: 1.1rem;
  }

  aside.side-panel::before {
    content: 'Session';
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    margin-bottom: -0.35rem;
  }

  section.callout {
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 10%, var(--color-line));
    border-left: 3px solid color-mix(in srgb, var(--color-line-strong) 25%, var(--color-line));
    background: var(--color-panel-muted);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  section.callout.callout-active {
    border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-line));
    border-left-color: var(--color-accent);
  }

  div.callout-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  strong.status-pill {
    font-weight: 600;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: capitalize;
    padding: 0.28rem 0.7rem;
    border-radius: 999px;
    border: 1px solid transparent;
    white-space: nowrap;
  }

  strong.status-pill-idle,
  strong.status-pill-pending {
    color: var(--color-warning);
    background: color-mix(in srgb, var(--color-warning) 14%, transparent);
    border-color: color-mix(in srgb, var(--color-warning) 28%, transparent);
  }

  strong.status-pill-executing,
  strong.status-pill-navigating {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
    border-color: color-mix(in srgb, var(--color-success) 30%, transparent);
  }

  strong.status-pill-blocked {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 14%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 28%, transparent);
  }

  p.active-task {
    margin: 0;
    font-size: 0.9rem;
    color: var(--color-ink-strong);
    font-weight: 500;
    line-height: 1.4;
  }

  p.url-copy {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.45;
    word-break: break-all;
    color: var(--color-ink-soft);
    font-family: var(--font-mono);
    padding: 0.5rem 0.65rem;
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-input) 85%, var(--color-panel));
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 8%, var(--color-line));
  }

  div.button-row {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }

  section.actions-panel {
    flex: 1;
    overflow-y: auto;
    min-height: 8rem;
  }

  div.actions-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    margin-top: 0.65rem;
  }

  div.skeleton-line {
    height: 0.62rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-line-strong) 12%, var(--color-line));
    animation: skeleton-pulse 1.1s ease-in-out infinite;
  }

  div.skeleton-line-long {
    width: 100%;
  }

  div.skeleton-line-mid {
    width: 72%;
  }

  div.skeleton-line-short {
    width: 44%;
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 0.85;
    }
  }

  .panel-muted {
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 10%, var(--color-line));
    background: color-mix(in srgb, var(--color-panel-muted) 92%, var(--color-panel));
    padding: 1rem 1.1rem;
  }

  div.stack {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.65rem;
  }

  article.action-card {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 8%, var(--color-line));
    background: var(--color-panel);
    padding: 0.8rem 0.9rem;
    box-shadow: 0 1px 0 color-mix(in srgb, var(--color-ink-strong) 4%, transparent);
    border-left: 3px solid color-mix(in srgb, var(--color-accent) 45%, var(--color-line));
  }

  div.action-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  strong.action-kind {
    color: var(--color-ink-strong);
    font-size: 0.82rem;
    text-transform: capitalize;
    font-weight: 600;
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
    flex-wrap: wrap;
  }

  div.live-header-text {
    min-width: 0;
    flex: 1;
  }

  div.live-header-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  button.live-refresh-btn {
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border-radius: 8px;
    padding: 0.45rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    background: color-mix(in srgb, var(--color-panel-muted) 70%, var(--color-panel));
    color: var(--color-ink-strong);
    font-size: 0.8rem;
    font-weight: 600;
    transition:
      border-color 160ms ease,
      background 160ms ease,
      opacity 160ms ease;
  }

  button.live-refresh-btn:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-line));
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-muted));
  }

  button.live-refresh-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  button.live-refresh-btn:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  span.live-refresh-icon {
    display: inline-flex;
    width: 1rem;
    height: 1rem;
  }

  span.live-refresh-icon svg {
    width: 100%;
    height: 100%;
  }

  span.live-refresh-icon-spinning {
    animation: live-feed-spin 0.75s linear infinite;
  }

  @keyframes live-feed-spin {
    to {
      transform: rotate(360deg);
    }
  }

  h2.section-heading {
    margin: 0.15rem 0 0;
    font-family: var(--font-display);
    font-weight: 650;
    color: var(--color-ink-strong);
    font-size: clamp(1.15rem, 1.5vw, 1.55rem);
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  span.live-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    flex-shrink: 0;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-success);
    padding: 0.35rem 0.65rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-success) 28%, transparent);
  }

  span.pulse-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--color-success);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-success) 45%, transparent);
    animation: pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-success) 35%, transparent);
    }
    50% {
      opacity: 0.85;
      transform: scale(0.88);
      box-shadow: 0 0 0 6px transparent;
    }
  }

  div.live-chrome {
    flex: 1;
    min-height: 32rem;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    background: var(--color-input);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--color-ink-strong) 10%, transparent);
    display: flex;
    flex-direction: column;
  }

  iframe.preview-frame {
    flex: 1;
    width: 100%;
    min-height: 28rem;
    border: none;
    background: var(--color-input);
  }

  img.preview-image {
    width: 100%;
    flex: 1;
    min-height: 28rem;
    object-fit: contain;
    object-position: top center;
    display: block;
    background: var(--color-bg);
  }

  div.live-placeholder {
    flex: 1;
    min-height: 28rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2.5rem 1.5rem;
    text-align: center;
    background: var(--color-input);
  }

  div.live-placeholder-busy {
    background: color-mix(in srgb, var(--color-success) 6%, var(--color-input));
  }

  div.placeholder-icon {
    width: 3.75rem;
    height: 2.75rem;
    margin-bottom: 0.25rem;
    padding: 0.65rem;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    background: var(--color-panel-muted);
    color: var(--color-ink-soft);
    box-sizing: border-box;
  }

  div.placeholder-icon svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  p.placeholder-lead {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-ink-strong);
    letter-spacing: -0.02em;
  }

  p.placeholder-sub {
    margin: 0;
    max-width: 20rem;
    font-size: 0.875rem;
    line-height: 1.55;
    color: var(--color-ink-soft);
  }

  /* ── Shared ────────────────────────────────── */
  p.panel-label {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
    margin: 0;
  }

  p.panel-copy {
    margin: 0;
    font-size: 0.9rem;
    color: var(--color-ink-soft);
    line-height: 1.55;
  }

  span.status {
    color: var(--color-ink-strong);
    text-transform: capitalize;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 12%, var(--color-line));
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 6px;
    background: color-mix(in srgb, var(--color-panel-muted) 80%, transparent);
  }

  span.status-idle,
  span.status-pending {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 25%, var(--color-line));
    background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  }

  span.status-executing,
  span.status-navigating,
  span.status-completed {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 25%, var(--color-line));
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
  }

  span.status-blocked,
  span.status-failed {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 25%, var(--color-line));
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  }

  time.timestamp {
    font-size: 0.72rem;
    font-family: var(--font-mono);
    color: var(--color-ink-soft);
    opacity: 0.9;
  }

  button.ghost {
    font: inherit;
    cursor: pointer;
    border-radius: 10px;
    padding: 0.55rem 1rem;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 14%, var(--color-line));
    background: color-mix(in srgb, var(--color-panel) 40%, transparent);
    color: var(--color-ink-strong);
    font-size: 0.84rem;
    font-weight: 500;
    transition:
      transform 160ms ease,
      border-color 160ms ease,
      background 160ms ease;
  }

  button.ghost:hover,
  button.ghost:focus-visible {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-line));
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-muted));
  }

  button.ghost:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  p.feedback {
    margin: 0;
    padding: 0.8rem 1rem;
    font-size: 0.88rem;
    line-height: 1.45;
    border-radius: 10px;
  }

  p.feedback-error {
    background: color-mix(in srgb, var(--color-danger) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 35%, var(--color-line));
    color: var(--color-danger);
  }

  @media (prefers-reduced-motion: reduce) {
    span.pulse-dot,
    span.run-btn-spinner,
    span.live-refresh-icon-spinning,
    div.skeleton-line {
      animation: none;
    }

    div.skeleton-line {
      opacity: 0.55;
    }

    button.run-btn,
    button.ghost {
      transition: none;
    }

    span.run-btn-spinner {
      border-top-color: transparent;
      opacity: 0.6;
    }
  }

  /* ── Responsive ────────────────────────────── */
  @media (max-width: 1080px) {
    section.page-grid {
      grid-template-columns: 1fr;
    }

    iframe.preview-frame,
    div.live-chrome {
      min-height: 22rem;
    }

    div.live-placeholder {
      min-height: 22rem;
    }
  }

  @media (max-width: 720px) {
    form.prompt-form {
      grid-template-columns: 1fr;
    }

    button.run-btn {
      width: 100%;
    }

    div.button-row {
      flex-direction: column;
      align-items: stretch;
    }

    button.ghost {
      width: 100%;
    }
  }

  button.ghost-danger {
    color: #e06c75;
    border-color: color-mix(in srgb, #e06c75 30%, var(--color-line));
  }
  button.ghost-danger:hover:not(:disabled) {
    background: color-mix(in srgb, #e06c75 12%, transparent);
  }
</style>
