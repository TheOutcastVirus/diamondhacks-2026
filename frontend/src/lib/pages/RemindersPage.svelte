<script lang="ts">
  import { onMount } from 'svelte';
  import { del, get, patch, post, uploadFile } from '../api';
  import type { Reminder, ReminderCadence, ReminderStatus, UploadedFileReference } from '../types';

  type ReminderEditorState = {
    title: string;
    instructions: string;
    cadence: ReminderCadence;
    weekday: string;
    time: string;
    timezone: string;
    customCron: string;
    customScheduleLabel: string;
    status: ReminderStatus;
    attachments: UploadedFileReference[];
  };

  type FeedbackState = {
    tone: 'error' | 'success';
    text: string;
  };

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

  const DEFAULT_REMINDER_TIMEZONE = 'America/Los_Angeles';
  const FALLBACK_TIMEZONE_OPTIONS = [
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'America/Anchorage',
    'Pacific/Honolulu',
    'UTC',
  ];

  function getTimezoneOptions() {
    const supportedValuesOf = (Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }).supportedValuesOf;
    const values = supportedValuesOf?.('timeZone') ?? FALLBACK_TIMEZONE_OPTIONS;
    const unique = Array.from(new Set([DEFAULT_REMINDER_TIMEZONE, ...values]));
    return unique
      .sort((left, right) => {
        if (left === DEFAULT_REMINDER_TIMEZONE) return -1;
        if (right === DEFAULT_REMINDER_TIMEZONE) return 1;
        return left.localeCompare(right);
      })
      .map((value) => ({ value, label: formatTimezoneLabel(value) }));
  }

  function formatTimezoneLabel(value: string) {
    if (value === DEFAULT_REMINDER_TIMEZONE) {
      return 'Pacific Time (Los Angeles)';
    }

    return value.replaceAll('_', ' ');
  }

  const timezoneOptions = getTimezoneOptions();

  let reminders: Reminder[] = [];
  let isLoading = true;
  let isSubmitting = false;
  let loadError = '';
  let submitError = '';
  let submitSuccess = '';

  let createState = createEmptyEditorState();
  let editingId = '';
  let editState: ReminderEditorState | null = null;
  let createUploadBusy = false;
  let editUploadBusy = false;
  let rowBusy: Record<string, boolean> = {};
  let rowFeedback: Record<string, FeedbackState | undefined> = {};

  function createEmptyEditorState(): ReminderEditorState {
    return {
      title: '',
      instructions: '',
      cadence: 'weekly',
      weekday: '5',
      time: '10:00',
      timezone: DEFAULT_REMINDER_TIMEZONE,
      customCron: '',
      customScheduleLabel: '',
      status: 'active',
      attachments: [],
    };
  }

  function normalizeUploadedFileReference(raw: unknown): UploadedFileReference | null {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (!value.id || !value.name || !value.mimeType) {
      return null;
    }

    return {
      id: String(value.id),
      name: String(value.name),
      mimeType: String(value.mimeType),
      sizeBytes: Number(value.sizeBytes ?? 0),
      textStatus: value.textStatus === 'ready' || value.textStatus === 'failed' ? value.textStatus : 'none',
    };
  }

  function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
  }

  function padTimePart(value: string) {
    return String(Number.parseInt(value, 10) || 0).padStart(2, '0');
  }

  function parseDailyCron(cronExpression: string) {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') {
      return null;
    }

    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) {
      return null;
    }

    return {
      cadence: 'daily' as ReminderCadence,
      weekday: '1',
      time: `${padTimePart(String(hour))}:${padTimePart(String(minute))}`,
    };
  }

  function parseWeeklyCron(cronExpression: string) {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') {
      return null;
    }

    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    const weekday = parts[4] ?? '';
    if (!Number.isInteger(minute) || !Number.isInteger(hour) || !/^[0-7]$/.test(weekday)) {
      return null;
    }

    return {
      cadence: 'weekly' as ReminderCadence,
      weekday: weekday === '7' ? '0' : weekday,
      time: `${padTimePart(String(hour))}:${padTimePart(String(minute))}`,
    };
  }

  function createEditorStateFromReminder(reminder: Reminder): ReminderEditorState {
    const fromDaily = parseDailyCron(reminder.cron);
    const fromWeekly = parseWeeklyCron(reminder.cron);
    const parsed =
      reminder.cadence === 'daily'
        ? fromDaily
        : reminder.cadence === 'weekly'
          ? fromWeekly
          : fromDaily ?? fromWeekly;

    if (parsed) {
      return {
        title: reminder.title,
        instructions: reminder.instructions,
        cadence: parsed.cadence,
        weekday: parsed.weekday,
        time: parsed.time,
        timezone: reminder.timezone ?? DEFAULT_REMINDER_TIMEZONE,
        customCron: reminder.cron,
        customScheduleLabel: reminder.scheduleLabel,
        status: reminder.status,
        attachments: reminder.attachments ?? [],
      };
    }

    return {
      title: reminder.title,
      instructions: reminder.instructions,
      cadence: 'custom',
      weekday: '5',
      time: '10:00',
      timezone: reminder.timezone ?? DEFAULT_REMINDER_TIMEZONE,
      customCron: reminder.cron,
      customScheduleLabel: reminder.scheduleLabel,
      status: reminder.status,
      attachments: reminder.attachments ?? [],
    };
  }

  function formatDate(value: string | null) {
    if (!value) {
      return 'No next run scheduled';
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function getCronFromEditor(editor: ReminderEditorState) {
    if (editor.cadence === 'custom') {
      return editor.customCron.trim() || null;
    }

    const [hours = '0', minutes = '0'] = editor.time.split(':');

    if (editor.cadence === 'daily') {
      return `${Number(minutes)} ${Number(hours)} * * *`;
    }

    return `${Number(minutes)} ${Number(hours)} * * ${editor.weekday}`;
  }

  function getScheduleLabelFromEditor(editor: ReminderEditorState) {
    if (editor.cadence === 'custom') {
      return editor.customScheduleLabel.trim() || editor.customCron.trim();
    }

    if (editor.cadence === 'daily') {
      return `Every day at ${editor.time}`;
    }

    const weekdayLabel = weekdayOptions.find((option) => option.value === editor.weekday)?.label ?? 'Friday';
    return `Every ${weekdayLabel} at ${editor.time}`;
  }

  function validateEditor(editor: ReminderEditorState) {
    const resolvedCron = getCronFromEditor(editor);
    if (!editor.title.trim() || !editor.instructions.trim() || !editor.timezone.trim() || !resolvedCron) {
      return 'Title, description, timezone, and a valid schedule are required.';
    }

    if (editor.cadence === 'custom' && !getScheduleLabelFromEditor(editor)) {
      return 'Custom reminders need a cron expression or schedule label.';
    }

    return '';
  }

  function normalizeStatus(value: unknown): ReminderStatus {
    return value === 'paused' || value === 'draft' ? value : 'active';
  }

  function normalizeCadence(value: unknown, cronExpression: string): ReminderCadence {
    if (value === 'daily' || value === 'weekly' || value === 'custom') {
      return value;
    }

    const daily = parseDailyCron(cronExpression);
    if (daily) {
      return daily.cadence;
    }

    const weekly = parseWeeklyCron(cronExpression);
    if (weekly) {
      return weekly.cadence;
    }

    return 'custom';
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
      timezone: value.timezone ? String(value.timezone) : DEFAULT_REMINDER_TIMEZONE,
      attachments: Array.isArray(value.attachments)
        ? value.attachments
            .map((attachment) => normalizeUploadedFileReference(attachment))
            .filter((attachment): attachment is UploadedFileReference => attachment !== null)
        : [],
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

  function updateReminderInList(updated: Reminder) {
    reminders = reminders.map((reminder) => (reminder.id === updated.id ? updated : reminder));
  }

  function buildReminderEndpoint(reminderId: string) {
    return `/api/reminders/${encodeURIComponent(reminderId)}`;
  }

  function setRowBusy(reminderId: string, value: boolean) {
    rowBusy = { ...rowBusy, [reminderId]: value };
  }

  function setRowFeedback(reminderId: string, tone: FeedbackState['tone'], text: string) {
    rowFeedback = { ...rowFeedback, [reminderId]: { tone, text } };
  }

  function clearRowFeedback(reminderId: string) {
    if (!(reminderId in rowFeedback)) {
      return;
    }

    const next = { ...rowFeedback };
    delete next[reminderId];
    rowFeedback = next;
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
    createState = {
      ...createState,
      title: preset.title,
      instructions: preset.instructions,
      cadence: preset.cadence,
      weekday: preset.weekday,
      time: preset.time,
      customCron: '',
      customScheduleLabel: '',
      status: 'active',
    };
    submitSuccess = '';
    submitError = '';
  }

  async function uploadReminderAttachments(files: FileList | null, mode: 'create' | 'edit') {
    if (!files || files.length === 0) {
      return;
    }

    if (mode === 'create') {
      createUploadBusy = true;
      submitError = '';
      submitSuccess = '';
    } else if (editingId) {
      editUploadBusy = true;
      clearRowFeedback(editingId);
    }

    try {
      const uploaded = await Promise.all(
        Array.from(files).map(async (file) => {
          const payload = await uploadFile('files', file);
          return normalizeUploadedFileReference((payload as { file: unknown }).file);
        }),
      );

      const references = uploaded.filter((entry): entry is UploadedFileReference => entry !== null);
      if (mode === 'create') {
        createState = {
          ...createState,
          attachments: [...createState.attachments, ...references],
        };
      } else if (editState && editingId) {
        editState = {
          ...editState,
          attachments: [...editState.attachments, ...references],
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to upload attachment.';
      if (mode === 'create') {
        submitError = message;
      } else if (editingId) {
        setRowFeedback(editingId, 'error', message);
      }
    } finally {
      if (mode === 'create') {
        createUploadBusy = false;
      } else {
        editUploadBusy = false;
      }
    }
  }

  function removeAttachment(mode: 'create' | 'edit', fileId: string) {
    if (mode === 'create') {
      createState = {
        ...createState,
        attachments: createState.attachments.filter((file) => file.id !== fileId),
      };
      return;
    }

    if (!editState) {
      return;
    }

    editState = {
      ...editState,
      attachments: editState.attachments.filter((file) => file.id !== fileId),
    };
  }

  async function createReminder() {
    isSubmitting = true;
    submitError = '';
    submitSuccess = '';

    const validationError = validateEditor(createState);
    const resolvedCron = getCronFromEditor(createState);

    if (validationError || !resolvedCron) {
      submitError = validationError || 'Title, description, timezone, and a valid schedule are required.';
      isSubmitting = false;
      return;
    }

    const payload = {
      title: createState.title.trim(),
      instructions: createState.instructions.trim(),
      cadence: createState.cadence,
      cron: resolvedCron,
      scheduleLabel: getScheduleLabelFromEditor(createState),
      timezone: createState.timezone.trim(),
      attachmentFileIds: createState.attachments.map((file) => file.id),
    };

    try {
      const created = await post<unknown>('reminders', payload);
      const normalized = normalizeReminder(created, reminders.length);
      reminders = [normalized, ...reminders];
      submitSuccess = 'Reminder saved.';
      createState = createEmptyEditorState();
    } catch (error) {
      submitError = error instanceof Error ? error.message : 'Unable to create reminder.';
    } finally {
      isSubmitting = false;
    }
  }

  function startEditing(reminder: Reminder) {
    editingId = reminder.id;
    editState = createEditorStateFromReminder(reminder);
    clearRowFeedback(reminder.id);
  }

  function cancelEditing() {
    editingId = '';
    editState = null;
  }

  async function saveReminder(reminderId: string) {
    if (!editState || editingId !== reminderId) {
      return;
    }

    const validationError = validateEditor(editState);
    const resolvedCron = getCronFromEditor(editState);
    if (validationError || !resolvedCron) {
      setRowFeedback(reminderId, 'error', validationError || 'A valid schedule is required.');
      return;
    }

    clearRowFeedback(reminderId);
    setRowBusy(reminderId, true);

    try {
      const updated = await patch<unknown>(buildReminderEndpoint(reminderId), {
        title: editState.title.trim(),
        instructions: editState.instructions.trim(),
        cadence: editState.cadence,
        cron: resolvedCron,
        scheduleLabel: getScheduleLabelFromEditor(editState),
        timezone: editState.timezone.trim(),
        status: editState.status,
        attachmentFileIds: editState.attachments.map((file) => file.id),
      });
      updateReminderInList(normalizeReminder(updated, 0));
      setRowFeedback(reminderId, 'success', 'Reminder updated.');
      cancelEditing();
    } catch (error) {
      setRowFeedback(reminderId, 'error', error instanceof Error ? error.message : 'Unable to update reminder.');
    } finally {
      setRowBusy(reminderId, false);
    }
  }

  async function toggleReminder(reminder: Reminder) {
    clearRowFeedback(reminder.id);
    setRowBusy(reminder.id, true);

    try {
      const nextStatus: ReminderStatus = reminder.status === 'paused' ? 'active' : 'paused';
      const updated = await patch<unknown>(buildReminderEndpoint(reminder.id), {
        status: nextStatus,
      });
      updateReminderInList(normalizeReminder(updated, 0));
      setRowFeedback(reminder.id, 'success', nextStatus === 'paused' ? 'Reminder paused.' : 'Reminder resumed.');

      if (editingId === reminder.id && editState) {
        editState = { ...editState, status: nextStatus };
      }
    } catch (error) {
      setRowFeedback(reminder.id, 'error', error instanceof Error ? error.message : 'Unable to update reminder.');
    } finally {
      setRowBusy(reminder.id, false);
    }
  }

  async function removeReminder(reminder: Reminder) {
    const confirmed = window.confirm(`Delete "${reminder.title}"?`);
    if (!confirmed) {
      return;
    }

    clearRowFeedback(reminder.id);
    setRowBusy(reminder.id, true);

    try {
      await del(buildReminderEndpoint(reminder.id));
      reminders = reminders.filter((item) => item.id !== reminder.id);
      if (editingId === reminder.id) {
        cancelEditing();
      }
    } catch (error) {
      setRowFeedback(reminder.id, 'error', error instanceof Error ? error.message : 'Unable to delete reminder.');
      setRowBusy(reminder.id, false);
      return;
    }

    const nextBusy = { ...rowBusy };
    delete nextBusy[reminder.id];
    rowBusy = nextBusy;

    const nextFeedback = { ...rowFeedback };
    delete nextFeedback[reminder.id];
    rowFeedback = nextFeedback;
  }

  onMount(() => {
    loadReminders();
  });

  $: createPreview = getScheduleLabelFromEditor(createState) || 'Choose a schedule';
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
        <input class="field-input" bind:value={createState.title} placeholder="Order medication refill" />
      </label>

      <label class="field">
        <span class="field-label">Description for the robot</span>
        <textarea
          class="field-input field-textarea"
          bind:value={createState.instructions}
          placeholder="Place the order, check for coverage issues, then notify the guardian."
        ></textarea>
      </label>

      <div class="form-row">
        <label class="field">
          <span class="field-label">Repeat</span>
          <select class="field-input" bind:value={createState.cadence}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom cron</option>
          </select>
        </label>

        <label class="field">
          <span class="field-label">Time zone</span>
          <select class="field-input" bind:value={createState.timezone}>
            {#each timezoneOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </div>

      {#if createState.cadence === 'custom'}
        <div class="form-row">
          <label class="field">
            <span class="field-label">Cron schedule</span>
            <input class="field-input" bind:value={createState.customCron} placeholder="0 9 * * 1-5" />
          </label>

          <label class="field">
            <span class="field-label">Schedule label</span>
            <input class="field-input" bind:value={createState.customScheduleLabel} placeholder="Weekdays at 09:00" />
          </label>
        </div>
      {:else}
        <div class="form-row">
          {#if createState.cadence === 'weekly'}
            <label class="field">
              <span class="field-label">Day</span>
              <select class="field-input" bind:value={createState.weekday}>
                {#each weekdayOptions as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/if}

          <label class="field">
            <span class="field-label">Time</span>
            <input class="field-input" bind:value={createState.time} type="time" />
          </label>
        </div>
      {/if}

      <label class="field">
        <span class="field-label">Attachments</span>
        <div class="file-field">
          <input
            class="field-input file-input"
            type="file"
            multiple
            on:change={(event) => uploadReminderAttachments(event.currentTarget.files, 'create')}
          />

          {#if createState.attachments.length > 0}
            <div class="upload-chip-list">
              {#each createState.attachments as file}
                <div class="upload-chip">
                  <div class="upload-meta">
                    <strong>{file.name}</strong>
                    <span class="field-note">{formatBytes(file.sizeBytes)} | {file.textStatus}</span>
                  </div>
                  <button class="ghost chip-action" type="button" on:click={() => removeAttachment('create', file.id)}>
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          {:else}
            <span class="field-note">Upload documents to keep with this reminder.</span>
          {/if}

          {#if createUploadBusy}
            <span class="field-note">Uploading attachment...</span>
          {/if}
        </div>
      </label>

      <section class="callout">
        <p class="panel-label">Preview</p>
        <h3 class="callout-heading">{createPreview}</h3>
        <p class="panel-copy">{formatTimezoneLabel(createState.timezone)}</p>
      </section>

      {#if submitError}
        <p class="feedback feedback-error">{submitError}</p>
      {/if}

      {#if submitSuccess}
        <p class="feedback feedback-success">{submitSuccess}</p>
      {/if}

      <button class="action" disabled={isSubmitting || createUploadBusy} type="submit">
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

              <div class="control-rail">
                <span class={`status-pill status-${reminder.status}`}>{reminder.status}</span>
                <button
                  class="mini-action"
                  type="button"
                  disabled={rowBusy[reminder.id]}
                  on:click={() => startEditing(reminder)}
                >
                  Edit
                </button>
                <button
                  class="mini-action"
                  type="button"
                  disabled={rowBusy[reminder.id]}
                  on:click={() => toggleReminder(reminder)}
                >
                  {reminder.status === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button
                  class="mini-action mini-danger"
                  type="button"
                  disabled={rowBusy[reminder.id]}
                  on:click={() => removeReminder(reminder)}
                >
                  Delete
                </button>
              </div>
            </div>

            {#if editingId === reminder.id && editState}
              <form class="editor-grid" on:submit|preventDefault={() => saveReminder(reminder.id)}>
                <label class="field">
                  <span class="field-label">Title</span>
                  <input class="field-input" bind:value={editState.title} />
                </label>

                <label class="field field-span">
                  <span class="field-label">Description</span>
                  <textarea class="field-input field-textarea" bind:value={editState.instructions}></textarea>
                </label>

                <label class="field">
                  <span class="field-label">Repeat</span>
                  <select class="field-input" bind:value={editState.cadence}>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="custom">Custom cron</option>
                  </select>
                </label>

                <label class="field">
                  <span class="field-label">Status</span>
                  <select class="field-input" bind:value={editState.status}>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="draft">Draft</option>
                  </select>
                </label>

                <label class="field field-span">
                  <span class="field-label">Time zone</span>
                  <select class="field-input" bind:value={editState.timezone}>
                    {#each timezoneOptions as option}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>

                {#if editState.cadence === 'custom'}
                  <label class="field">
                    <span class="field-label">Cron schedule</span>
                    <input class="field-input" bind:value={editState.customCron} />
                  </label>

                  <label class="field">
                    <span class="field-label">Schedule label</span>
                    <input class="field-input" bind:value={editState.customScheduleLabel} />
                  </label>
                {:else}
                  {#if editState.cadence === 'weekly'}
                    <label class="field">
                      <span class="field-label">Day</span>
                      <select class="field-input" bind:value={editState.weekday}>
                        {#each weekdayOptions as option}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}

                  <label class="field">
                    <span class="field-label">Time</span>
                    <input class="field-input" bind:value={editState.time} type="time" />
                  </label>
                {/if}

                <label class="field field-span">
                  <span class="field-label">Attachments</span>
                  <div class="file-field">
                    <input
                      class="field-input file-input"
                      type="file"
                      multiple
                      on:change={(event) => uploadReminderAttachments(event.currentTarget.files, 'edit')}
                    />

                    {#if editState.attachments.length > 0}
                      <div class="upload-chip-list">
                        {#each editState.attachments as file}
                          <div class="upload-chip">
                            <div class="upload-meta">
                              <strong>{file.name}</strong>
                              <span class="field-note">{formatBytes(file.sizeBytes)} | {file.textStatus}</span>
                            </div>
                            <button class="ghost chip-action" type="button" on:click={() => removeAttachment('edit', file.id)}>
                              Remove
                            </button>
                          </div>
                        {/each}
                      </div>
                    {:else}
                      <span class="field-note">No files attached to this reminder yet.</span>
                    {/if}

                    {#if editUploadBusy}
                      <span class="field-note">Uploading attachment...</span>
                    {/if}
                  </div>
                </label>

                <section class="callout field-span">
                  <p class="panel-label">Updated schedule</p>
                  <h3 class="callout-heading">{getScheduleLabelFromEditor(editState) || 'Choose a schedule'}</h3>
                  <p class="panel-copy">{formatTimezoneLabel(editState.timezone)}</p>
                </section>

                <div class="editor-actions field-span">
                  <button class="action" type="submit" disabled={rowBusy[reminder.id] || editUploadBusy}>
                    {rowBusy[reminder.id] ? 'Saving...' : 'Save changes'}
                  </button>
                  <button class="ghost" type="button" disabled={rowBusy[reminder.id]} on:click={cancelEditing}>
                    Cancel
                  </button>
                </div>
              </form>
            {:else}
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
                  <dd class="detail-value">{formatTimezoneLabel(reminder.timezone ?? DEFAULT_REMINDER_TIMEZONE)}</dd>
                </div>
              </dl>

              {#if reminder.attachments && reminder.attachments.length > 0}
                <div class="attachment-list">
                  {#each reminder.attachments as file}
                    <div class="upload-chip">
                      <div class="upload-meta">
                        <strong>{file.name}</strong>
                        <span class="field-note">{formatBytes(file.sizeBytes)} | {file.textStatus}</span>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}

            {#if rowFeedback[reminder.id]}
              <p class={`feedback ${rowFeedback[reminder.id]?.tone === 'error' ? 'feedback-error' : 'feedback-success'}`}>
                {rowFeedback[reminder.id]?.text}
              </p>
            {/if}
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

  form.reminder-form,
  form.editor-grid {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  form.editor-grid {
    border-top: var(--border-width) solid var(--color-line);
    padding-top: 1rem;
  }

  div.form-row,
  form.editor-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  label.field,
  div.editor-actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  div.file-field,
  div.upload-chip-list,
  div.attachment-list,
  div.upload-meta {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  label.field-span,
  section.field-span,
  div.field-span,
  div.editor-actions.field-span {
    grid-column: 1 / -1;
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

  input.file-input {
    padding-block: 0.75rem;
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
  button.ghost,
  button.mini-action {
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
  button.ghost:focus-visible,
  button.mini-action:hover,
  button.mini-action:focus-visible {
    transform: translateY(-1px);
  }

  button.action:disabled,
  button.ghost:disabled,
  button.mini-action:disabled {
    cursor: progress;
    opacity: 0.7;
    transform: none;
  }

  button.ghost,
  button.mini-action {
    border: var(--border-width) solid var(--color-line);
    background: transparent;
    color: var(--color-ink-strong);
  }

  button.mini-action {
    padding: 0.55rem 0.8rem;
  }

  button.mini-danger {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-line));
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

  div.upload-chip {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 0.9rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
  }

  button.chip-action {
    align-self: center;
    padding: 0.55rem 0.8rem;
  }

  div.list-head,
  dl.detail-grid,
  div.control-rail,
  div.editor-actions {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }

  div.control-rail {
    flex: 0 0 auto;
    align-items: stretch;
    justify-content: flex-end;
    flex-wrap: nowrap;
    align-self: flex-start;
  }

  div.editor-actions {
    justify-content: flex-start;
    flex-direction: row;
  }

  div.control-rail > * {
    flex: 0 0 auto;
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
    padding: 0.55rem 0.8rem;
    font: inherit;
    line-height: 1;
    text-transform: capitalize;
    background: var(--color-panel);
    border: var(--border-width) solid var(--color-line);
    color: var(--color-ink-strong);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
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
    div.list-head,
    div.editor-actions {
      flex-direction: column;
    }

    div.control-rail {
      flex-direction: column;
    }

    div.form-row,
    section.metrics,
    form.editor-grid {
      grid-template-columns: 1fr;
    }

    button.action,
    button.ghost,
    button.mini-action {
      width: 100%;
    }
  }
</style>
