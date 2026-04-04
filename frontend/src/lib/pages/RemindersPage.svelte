<script lang="ts">
  import { onMount } from 'svelte';
  import { get, post } from '../api';
  import type { Reminder, ReminderCadence, ReminderStatus } from '../types';

  const weekdayOptions = [
    { value: '0', label: 'Sunday' },
    { value: '1', label: 'Monday' },
    { value: '2', label: 'Tuesday' },
    { value: '3', label: 'Wednesday' },
    { value: '4', label: 'Thursday' },
    { value: '5', label: 'Friday' },
    { value: '6', label: 'Saturday' },
  ];

  const presets = [
    {
      label: 'Medication order',
      title: 'Order medication refill',
      instructions: 'Place the pharmacy refill order and notify the guardian if stock is delayed.',
      cadence: 'weekly' as ReminderCadence,
      weekday: '5',
      time: '10:00',
    },
    {
      label: 'Midday meal',
      title: 'Check lunch routine',
      instructions: 'Remind the resident to eat lunch and confirm whether help is needed.',
      cadence: 'daily' as ReminderCadence,
      weekday: '1',
      time: '12:00',
    },
    {
      label: 'Hydration sweep',
      title: 'Hydration reminder',
      instructions: 'Prompt for water and log whether the reminder was acknowledged.',
      cadence: 'daily' as ReminderCadence,
      weekday: '1',
      time: '15:00',
    },
  ];

  let reminders: Reminder[] = [];
  let isLoading = true;
  let isSubmitting = false;
  let loadError = '';
  let submitError = '';
  let submitSuccess = '';

  let title = '';
  let instructions = '';
  let cadence: ReminderCadence = 'weekly';
  let weekday = '5';
  let time = '10:00';
  let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function formatDate(value: string | null) {
    if (!value) {
      return 'No next run supplied';
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function getCronFromForm() {
    const [hours = '0', minutes = '0'] = time.split(':');

    if (cadence === 'daily') {
      return `${Number(minutes)} ${Number(hours)} * * *`;
    }

    if (cadence === 'weekly') {
      return `${Number(minutes)} ${Number(hours)} * * ${weekday}`;
    }

  }

  function getScheduleLabel() {
    if (cadence === 'daily') {
      return `Every day at ${time}`;
    }

    const weekdayLabel = weekdayOptions.find((option) => option.value === weekday)?.label ?? 'Friday';
    return `Every ${weekdayLabel} at ${time}`;
  }

  function normalizeStatus(value: unknown): ReminderStatus {
    return value === 'paused' || value === 'draft' ? value : 'active';
  }

  function normalizeCadence(value: unknown, cronExpression: string): ReminderCadence {
    if (value === 'daily' || value === 'weekly' || value === 'custom') {
      return value;
    }

    const parts = cronExpression.split(/\s+/);
    if (parts.length >= 5 && parts[2] === '*' && parts[3] === '*') {
      return parts[4] === '*' ? 'daily' : 'weekly';
    }

    return 'weekly';
  }

  function normalizeReminder(raw: unknown, index: number): Reminder {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const cronExpression = String(value.cron ?? value.schedule ?? '* * * * *');

    return {
      id: String(value.id ?? value._id ?? `reminder-${index}`),
      title: String(value.title ?? value.name ?? `Reminder ${index + 1}`),
      instructions: String(value.instructions ?? value.message ?? value.description ?? ''),
      cron: cronExpression,
      cadence: normalizeCadence(value.cadence, cronExpression),
      scheduleLabel: String(value.scheduleLabel ?? value.humanReadable ?? cronExpression),
      nextRun: value.nextRun ? String(value.nextRun) : null,
      status: normalizeStatus(value.status),
      owner: value.owner ? String(value.owner) : 'Gazabot agent',
      timezone: value.timezone ? String(value.timezone) : timezone,
    };
  }

  function normalizeReminderResponse(payload: unknown) {
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(record?.reminders)
        ? (record.reminders as unknown[])
        : [];

    return list.map((item, index) => normalizeReminder(item, index));
  }

  async function loadReminders() {
    isLoading = true;
    loadError = '';

    try {
      const payload = await get<unknown>('reminders');
      reminders = normalizeReminderResponse(payload);
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Unable to load reminders.';
      reminders = [];
    } finally {
      isLoading = false;
    }
  }

  function applyPreset(preset: (typeof presets)[number]) {
    title = preset.title;
    instructions = preset.instructions;
    cadence = preset.cadence;
    weekday = preset.weekday;
    time = preset.time;
    submitSuccess = '';
    submitError = '';
  }

  async function createReminder() {
    isSubmitting = true;
    submitError = '';
    submitSuccess = '';

    const resolvedCron = getCronFromForm();

    if (!title.trim() || !instructions.trim() || !resolvedCron) {
      submitError = 'Title, instructions, and a valid schedule are required.';
      isSubmitting = false;
      return;
    }

    const payload = {
      title: title.trim(),
      instructions: instructions.trim(),
      cadence,
      cron: resolvedCron,
      scheduleLabel: getScheduleLabel(),
      timezone,
    };

    try {
      const created = await post<unknown>('reminders', payload);
      const normalized = normalizeReminder(created, reminders.length);
      reminders = [normalized, ...reminders];
      submitSuccess = 'Reminder queued successfully.';
      title = '';
      instructions = '';
      cadence = 'weekly';
      weekday = '5';
      time = '10:00';
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Unable to create reminder.';
    } finally {
      isSubmitting = false;
    }
  }

  onMount(() => {
    loadReminders();
  });

  $: resolvedCron = getCronFromForm();
  $: activeCount = reminders.filter((reminder) => reminder.status === 'active').length;
  $: pausedCount = reminders.filter((reminder) => reminder.status === 'paused').length;
</script>

<section class="page-grid">
  <section class="panel">
    <header class="panel-header">
      <div>
        <h2 class="section-heading">Add reminder</h2>
      </div>
    </header>

    <div class="preset-row" role="list" aria-label="Reminder presets">
      {#each presets as preset}
        <button class="chip" type="button" on:click={() => applyPreset(preset)}>
          {preset.label}
        </button>
      {/each}
    </div>

    <form class="reminder-form" on:submit|preventDefault={createReminder}>
      <label class="field">
        <span class="field-label">Reminder title</span>
        <input class="field-input" bind:value={title} placeholder="Order medication refill" />
      </label>

      <label class="field">
        <span class="field-label">Instructions for the robot</span>
        <textarea
          class="field-input field-textarea"
          bind:value={instructions}
          placeholder="Place the order, check for coverage issues, then notify the guardian."
        ></textarea>
      </label>

      <div class="form-row">
        <label class="field">
          <span class="field-label">Repeat</span>
          <select class="field-input" bind:value={cadence}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Time zone</span>
          <input class="field-input" bind:value={timezone} />
        </label>
      </div>

      <div class="form-row">
        {#if cadence === 'weekly'}
          <label class="field">
            <span class="field-label">Day</span>
            <select class="field-input" bind:value={weekday}>
              {#each weekdayOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        {/if}

        <label class="field">
          <span class="field-label">Time</span>
          <input class="field-input" bind:value={time} type="time" />
        </label>
      </div>

      <section class="callout">
        <p class="panel-label">Preview</p>
        <h3 class="callout-heading">{getScheduleLabel()}</h3>
        <p class="panel-copy">{timezone}</p>
      </section>

      {#if submitError}
        <p class="feedback feedback-error">{submitError}</p>
      {/if}

      {#if submitSuccess}
        <p class="feedback feedback-success">{submitSuccess}</p>
      {/if}

      <button class="action" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Saving...' : 'Save reminder'}
      </button>
    </form>
  </section>

  <section class="panel panel-secondary">
    <header class="panel-header">
      <div>
        <p class="panel-label">All</p>
        <h2 class="section-heading">Reminders</h2>
      </div>
      <button class="ghost" type="button" on:click={loadReminders}>Refresh</button>
    </header>

    <section class="metrics">
      <article class="metric-card">
        <p class="metric-label">Active</p>
        <strong class="metric-value">{activeCount}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Paused</p>
        <strong class="metric-value">{pausedCount}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Total</p>
        <strong class="metric-value">{reminders.length}</strong>
      </article>
    </section>

    {#if isLoading}
      <p class="panel-copy">Loading reminders from the backend...</p>
    {:else if loadError}
      <p class="feedback feedback-error">{loadError}</p>
    {:else if reminders.length === 0}
      <p class="panel-copy">No reminders yet.</p>
    {:else}
      <div class="stack">
        {#each reminders as reminder}
          <article class="list-card">
            <div class="list-head">
              <div>
                <p class="panel-label">{reminder.owner ?? 'Gazabot agent'}</p>
                <h3 class="list-heading">{reminder.title}</h3>
              </div>
              <span class={`status-pill status-${reminder.status}`}>{reminder.status}</span>
            </div>

            <p class="panel-copy">{reminder.instructions}</p>

            <dl class="detail-grid">
              <div>
                <dt class="detail-term">Repeat</dt>
                <dd class="detail-value">{reminder.scheduleLabel}</dd>
              </div>
              <div>
                <dt class="detail-term">Next run</dt>
                <dd class="detail-value">{formatDate(reminder.nextRun)}</dd>
              </div>
              <div>
                <dt class="detail-term">Timezone</dt>
                <dd class="detail-value">{reminder.timezone ?? timezone}</dd>
              </div>
            </dl>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</section>

<style>
  section.page-grid {
    display: grid;
    gap: 1.5rem;
    grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  }

  section.panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  header.panel-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
  }

  h2.section-heading,
  h3.callout-heading,
  h3.list-heading {
    margin: 0;
    font-family: var(--font-display);
    color: var(--color-ink-strong);
  }

  h2.section-heading {
    font-size: clamp(1.5rem, 1.8vw, 2rem);
  }

  h3.callout-heading,
  h3.list-heading {
    font-size: 1.15rem;
  }

  div.preset-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  button.chip {
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    color: var(--color-ink-strong);
    border-radius: 0;
    padding: 0.75rem 1rem;
    font: inherit;
    cursor: pointer;
    transition:
      transform 160ms ease,
      border-color 160ms ease,
      background 160ms ease;
  }

  button.chip:hover,
  button.chip:focus-visible {
    transform: translateY(-1px);
    border-color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 12%, var(--color-panel-muted));
  }

  form.reminder-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  div.form-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  label.field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  span.field-label,
  dt.detail-term,
  p.metric-label {
    font-size: 0.78rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  input.field-input,
  textarea.field-input,
  select.field-input {
    border-radius: 0;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-input);
    color: var(--color-ink-strong);
    padding: 0.95rem 1rem;
    font: inherit;
    min-height: 3.2rem;
    box-sizing: border-box;
  }

  input.field-input:focus-visible,
  textarea.field-input:focus-visible,
  select.field-input:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--color-accent) 58%, transparent);
    outline-offset: 1px;
    border-color: var(--color-accent);
  }

  textarea.field-textarea {
    min-height: 8.5rem;
    resize: vertical;
  }

  section.callout {
    border-radius: 0;
    padding: 1.1rem 1.2rem;
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, transparent), transparent),
      var(--color-panel-muted);
    border: var(--border-width) solid var(--color-line);
  }

  button.action,
  button.ghost {
    font: inherit;
    cursor: pointer;
    border-radius: 0;
    padding: 0.9rem 1.2rem;
    transition:
      transform 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
  }

  button.action {
    border: var(--border-width) solid var(--color-line);
    background: var(--color-accent);
    color: white;
    align-self: flex-start;
  }

  button.action:hover,
  button.action:focus-visible,
  button.ghost:hover,
  button.ghost:focus-visible {
    transform: translateY(-1px);
  }

  button.action:disabled {
    cursor: progress;
    opacity: 0.7;
    transform: none;
  }

  button.ghost {
    border: var(--border-width) solid var(--color-line);
    background: transparent;
    color: var(--color-ink-strong);
  }

  section.metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.9rem;
  }

  article.metric-card,
  article.list-card {
    border-radius: 0;
    background: var(--color-panel-muted);
    border: var(--border-width) solid var(--color-line);
  }

  article.metric-card {
    padding: 1rem;
  }

  strong.metric-value {
    font-family: var(--font-display);
    font-size: 1.6rem;
    color: var(--color-ink-strong);
  }

  div.stack {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  article.list-card {
    padding: 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  div.list-head,
  dl.detail-grid {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  dl.detail-grid {
    margin: 0;
    flex-wrap: wrap;
  }

  dd.detail-value {
    margin: 0.25rem 0 0;
    color: var(--color-ink-strong);
  }

  span.status-pill {
    border-radius: 0;
    padding: 0.45rem 0.75rem;
    font-size: 0.8rem;
    text-transform: capitalize;
    background: var(--color-panel);
    border: var(--border-width) solid var(--color-line);
    color: var(--color-ink-strong);
    height: fit-content;
  }

  span.status-active {
    border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-line));
    color: var(--color-success);
  }

  span.status-paused {
    border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-line));
    color: var(--color-warning);
  }

  span.status-draft {
    color: var(--color-ink-soft);
  }

  p.feedback {
    margin: 0;
    border-radius: 0;
    padding: 0.85rem 1rem;
    border: var(--border-width) solid var(--color-line);
  }

  p.feedback-error {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border-color: var(--color-line);
    color: var(--color-danger);
  }

  p.feedback-success {
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
    border-color: var(--color-line);
    color: var(--color-success);
  }

  @media (max-width: 1080px) {
    section.page-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    header.panel-header,
    div.list-head {
      flex-direction: column;
    }

    div.form-row,
    section.metrics {
      grid-template-columns: 1fr;
    }

    button.action,
    button.ghost {
      width: 100%;
    }
  }
</style>
