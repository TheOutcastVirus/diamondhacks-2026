<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { createEventStream, get, post, uploadFile } from '../api';
  import type { PromptField, UploadedFile, UploadedFileReference, UserMemoryEntry, UserPrompt } from '../types';

  type FeedbackState = {
    tone: 'error' | 'success';
    text: string;
  };

  let prompts: UserPrompt[] = [];
  let memoryEntries: UserMemoryEntry[] = [];
  let uploadedFiles: UploadedFile[] = [];
  let isLoading = true;
  let loadError = '';
  let submitBusy: Record<string, boolean> = {};
  let submitFeedback: Record<string, FeedbackState | undefined> = {};
  let uploadBusy: Record<string, boolean> = {};
  let libraryUploadBusy = false;
  let libraryUploadFeedback: FeedbackState | null = null;
  let formValues: Record<string, Record<string, string | number | boolean | UploadedFileReference[]>> = {};
  let selectedMemoryTitle = '';
  let expandedFileId = '';
  let eventSource: EventSource | null = null;

  function formatDate(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf())
      ? value
      : new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(parsed);
  }

  function getDefaultValue(field: PromptField): string | number | boolean | UploadedFileReference[] {
    if (field.type === 'file') {
      return [];
    }

    if (field.defaultValue !== undefined && field.defaultValue !== null) {
      return field.defaultValue;
    }

    if (field.type === 'boolean') {
      return false;
    }

    if (field.type === 'int' || field.type === 'float') {
      return '';
    }

    if (field.type === 'select') {
      return field.options?.[0]?.value ?? '';
    }

    return '';
  }

  function ensurePromptState(prompt: UserPrompt) {
    const nextValues: Record<string, string | number | boolean | UploadedFileReference[]> = {
      ...(formValues[prompt.id] ?? {}),
    };

    for (const field of prompt.fields) {
      if (!(field.name in nextValues)) {
        nextValues[field.name] = getDefaultValue(field);
      }
    }

    formValues = { ...formValues, [prompt.id]: nextValues };
  }

  function normalizePromptField(raw: unknown, index: number): PromptField {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      name: String(value.name ?? `field_${index + 1}`),
      label: String(value.label ?? value.name ?? `Field ${index + 1}`),
      type:
        value.type === 'text' ||
        value.type === 'int' ||
        value.type === 'float' ||
        value.type === 'boolean' ||
        value.type === 'password' ||
        value.type === 'date' ||
        value.type === 'select' ||
        value.type === 'file'
          ? value.type
          : 'string',
      required: Boolean(value.required),
      placeholder: value.placeholder ? String(value.placeholder) : undefined,
      description: value.description ? String(value.description) : undefined,
      accept: value.accept ? String(value.accept) : undefined,
      multiple: Boolean(value.multiple),
      options: Array.isArray(value.options)
        ? value.options.map((option, optionIndex) => {
            const item = typeof option === 'object' && option !== null ? (option as Record<string, unknown>) : {};
            return {
              label: String(item.label ?? `Option ${optionIndex + 1}`),
              value: String(item.value ?? item.label ?? `option_${optionIndex + 1}`),
            };
          })
        : undefined,
      defaultValue:
        value.defaultValue === null ||
        typeof value.defaultValue === 'string' ||
        typeof value.defaultValue === 'number' ||
        typeof value.defaultValue === 'boolean'
          ? value.defaultValue
          : undefined,
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

  function normalizePrompt(raw: unknown, index: number): UserPrompt {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      id: String(value.id ?? `prompt_${index}`),
      title: String(value.title ?? `Information Request ${index + 1}`),
      description: value.description ? String(value.description) : undefined,
      fields: Array.isArray(value.fields) ? value.fields.map((field, fieldIndex) => normalizePromptField(field, fieldIndex)) : [],
      memoryKey: String(value.memoryKey ?? value.memory_key ?? `memory_${index}`),
      memoryLabel: String(value.memoryLabel ?? value.memory_label ?? value.title ?? `Record ${index + 1}`),
      status: value.status === 'completed' || value.status === 'cancelled' ? value.status : 'pending',
      createdAt: String(value.createdAt ?? value.created_at ?? new Date().toISOString()),
      response:
        typeof value.response === 'object' && value.response !== null && !Array.isArray(value.response)
          ? (value.response as Record<string, unknown>)
          : undefined,
      respondedAt: value.respondedAt ? String(value.respondedAt) : value.responded_at ? String(value.responded_at) : undefined,
    };
  }

  function normalizeUploadedFile(raw: unknown, index: number): UploadedFile {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      id: String(value.id ?? `file_${index}`),
      name: String(value.name ?? value.originalName ?? `Upload ${index + 1}`),
      originalName: String(value.originalName ?? value.name ?? `upload_${index + 1}`),
      mimeType: String(value.mimeType ?? 'application/octet-stream'),
      sizeBytes: Number(value.sizeBytes ?? 0),
      textStatus: value.textStatus === 'ready' || value.textStatus === 'failed' ? value.textStatus : 'none',
      createdAt: String(value.createdAt ?? value.created_at ?? new Date().toISOString()),
      promptId: value.promptId ? String(value.promptId) : value.prompt_id ? String(value.prompt_id) : undefined,
      promptFieldName: value.promptFieldName
        ? String(value.promptFieldName)
        : value.prompt_field_name
          ? String(value.prompt_field_name)
          : undefined,
      reminderId: value.reminderId ? String(value.reminderId) : value.reminder_id ? String(value.reminder_id) : undefined,
      extractedText: value.extractedText ? String(value.extractedText) : undefined,
    };
  }

  function normalizeMemoryEntry(raw: unknown, index: number): UserMemoryEntry {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      title: String(value.title ?? `memory_${index}`),
      content: String(value.content ?? ''),
      updatedAt: String(value.updatedAt ?? value.updated_at ?? new Date().toISOString()),
      kind: value.kind === 'structured' ? 'structured' : 'text',
      schema: Array.isArray(value.schema) ? value.schema.map((field, fieldIndex) => normalizePromptField(field, fieldIndex)) : undefined,
      data:
        typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data)
          ? (value.data as Record<string, unknown>)
          : undefined,
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

  function setFeedback(promptId: string, tone: FeedbackState['tone'], text: string) {
    submitFeedback = { ...submitFeedback, [promptId]: { tone, text } };
  }

  function clearFeedback(promptId: string) {
    if (!(promptId in submitFeedback)) {
      return;
    }

    const next = { ...submitFeedback };
    delete next[promptId];
    submitFeedback = next;
  }

  async function loadRequestedInfo() {
    isLoading = true;
    loadError = '';

    try {
      const [promptPayload, memoryPayload, filePayload] = await Promise.all([
        get<{ prompts: unknown[] }>('prompts', { query: { status: 'all' } }),
        get<{ entries: unknown[] }>('memory'),
        get<{ files: unknown[] }>('files'),
      ]);

      prompts = (promptPayload.prompts ?? []).map((prompt, index) => normalizePrompt(prompt, index));
      memoryEntries = (memoryPayload.entries ?? []).map((entry, index) => normalizeMemoryEntry(entry, index));
      uploadedFiles = (filePayload.files ?? []).map((file, index) => normalizeUploadedFile(file, index));

      for (const prompt of prompts.filter((item) => item.status === 'pending')) {
        ensurePromptState(prompt);
      }

      if (!selectedMemoryTitle && memoryEntries.length > 0) {
        selectedMemoryTitle = memoryEntries[0].title;
      } else if (selectedMemoryTitle && !memoryEntries.some((entry) => entry.title === selectedMemoryTitle)) {
        selectedMemoryTitle = memoryEntries[0]?.title ?? '';
      }

      expandedFileId = uploadedFiles.some((file) => file.id === expandedFileId)
        ? expandedFileId
        : (uploadedFiles[0]?.id ?? '');
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Unable to load requested information.';
      prompts = [];
      memoryEntries = [];
      uploadedFiles = [];
    } finally {
      isLoading = false;
    }
  }

  function handleEventRefresh() {
    void loadRequestedInfo();
  }

  function connectPromptStream() {
    eventSource?.close();
    const source = createEventStream('transcriptStream');
    eventSource = source;
    source.addEventListener('prompt', handleEventRefresh);
    source.addEventListener('tool', handleEventRefresh);
  }

  function setFieldValue(promptId: string, fieldName: string, value: string | number | boolean | UploadedFileReference[]) {
    formValues = {
      ...formValues,
      [promptId]: {
        ...(formValues[promptId] ?? {}),
        [fieldName]: value,
      },
    };
  }

  async function uploadPromptFile(prompt: UserPrompt, field: PromptField, files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    const uploadKey = `${prompt.id}:${field.name}`;
    uploadBusy = { ...uploadBusy, [uploadKey]: true };

    try {
      const uploaded = await Promise.all(
        Array.from(files).map(async (file) => {
          const payload = await uploadFile('files', file, {
            promptId: prompt.id,
            fieldName: field.name,
          });
          return normalizeUploadedFile((payload as { file: unknown }).file, 0);
        }),
      );

      const current = Array.isArray(formValues[prompt.id]?.[field.name])
        ? ((formValues[prompt.id]?.[field.name] as UploadedFileReference[]) ?? [])
        : [];
      const nextValue = field.multiple ? [...current, ...uploaded] : uploaded.slice(0, 1);
      setFieldValue(prompt.id, field.name, nextValue);
      uploadedFiles = [...uploaded, ...uploadedFiles.filter((item) => !uploaded.some((entry) => entry.id === item.id))];
      if (uploaded.length > 0) {
        expandFileSection(uploaded[0].id);
      }
    } catch (error) {
      setFeedback(prompt.id, 'error', error instanceof Error ? error.message : 'Unable to upload file.');
    } finally {
      uploadBusy = { ...uploadBusy, [uploadKey]: false };
    }
  }

  async function uploadLibraryFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      return;
    }

    libraryUploadBusy = true;
    libraryUploadFeedback = null;

    try {
      const uploaded = await Promise.all(
        Array.from(files).map(async (file) => {
          const payload = await uploadFile('files', file);
          return normalizeUploadedFile((payload as { file: unknown }).file, 0);
        }),
      );

      uploadedFiles = [...uploaded, ...uploadedFiles.filter((item) => !uploaded.some((entry) => entry.id === item.id))];
      if (uploaded.length > 0) {
        expandedFileId = uploaded[0].id;
      }
      libraryUploadFeedback = { tone: 'success', text: 'Files added to the document library.' };
    } catch (error) {
      libraryUploadFeedback = {
        tone: 'error',
        text: error instanceof Error ? error.message : 'Unable to upload files.',
      };
    } finally {
      libraryUploadBusy = false;
    }
  }

  function removePromptFile(promptId: string, fieldName: string, fileId: string) {
    const current = Array.isArray(formValues[promptId]?.[fieldName])
      ? ((formValues[promptId]?.[fieldName] as UploadedFileReference[]) ?? [])
      : [];
    setFieldValue(
      promptId,
      fieldName,
      current.filter((file) => file.id !== fileId),
    );
  }

  function isFileExpanded(fileId: string) {
    return expandedFileId === fileId;
  }

  function expandFileSection(fileId: string) {
    if (expandedFileId === fileId) {
      return;
    }

    expandedFileId = fileId;
  }

  function toggleFileSection(fileId: string) {
    if (expandedFileId === fileId) {
      expandedFileId = '';
      return;
    }

    expandedFileId = fileId;
  }

  async function submitPrompt(prompt: UserPrompt) {
    clearFeedback(prompt.id);
    submitBusy = { ...submitBusy, [prompt.id]: true };

    try {
      const response = formValues[prompt.id] ?? {};
      const payload = await post<{ memoryEntry?: UserMemoryEntry }>(
        `/api/prompts/${encodeURIComponent(prompt.id)}/respond`,
        { response },
      );
      if (payload.memoryEntry?.title) {
        selectedMemoryTitle = payload.memoryEntry.title;
      }
      setFeedback(prompt.id, 'success', 'Information saved to memory.');
      await loadRequestedInfo();
    } catch (error) {
      setFeedback(prompt.id, 'error', error instanceof Error ? error.message : 'Unable to save information.');
    } finally {
      submitBusy = { ...submitBusy, [prompt.id]: false };
    }
  }

  onMount(async () => {
    await loadRequestedInfo();
    connectPromptStream();
  });

  onDestroy(() => {
    eventSource?.close();
  });

  $: pendingPrompts = prompts.filter((prompt) => prompt.status === 'pending');
  $: completedPrompts = prompts.filter((prompt) => prompt.status === 'completed');
  $: selectedMemory =
    memoryEntries.find((entry) => entry.title === selectedMemoryTitle) ?? memoryEntries[0] ?? null;
</script>

<section class="page-grid">
  <section class="panel panel-queue">
    <header class="panel-header">
      <div>
        <p class="panel-label">Requested Info</p>
        <h2 class="section-heading">Intake Queue</h2>
      </div>
      <button class="ghost" type="button" on:click={loadRequestedInfo}>Refresh</button>
    </header>

    <section class="metrics">
      <article class="metric-card">
        <p class="metric-label">Pending</p>
        <strong class="metric-value">{pendingPrompts.length}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">Memory</p>
        <strong class="metric-value">{memoryEntries.length}</strong>
      </article>
      <article class="metric-card">
        <p class="metric-label">History</p>
        <strong class="metric-value">{completedPrompts.length}</strong>
      </article>
    </section>

    {#if isLoading}
      <p class="panel-copy">Loading information requests...</p>
    {:else if loadError}
      <p class="feedback feedback-error">{loadError}</p>
    {:else if pendingPrompts.length === 0}
      <section class="empty-state">
        <p class="panel-label">Queue</p>
        <h3 class="callout-heading">No active requests</h3>
        <p class="panel-copy">When the agent asks for deeper user details, the JSON-defined form will appear here.</p>
      </section>
    {:else}
      <div class="stack">
        {#each pendingPrompts as prompt}
          <article class="request-card">
            <div class="request-head">
              <div>
                <p class="panel-label">{prompt.memoryLabel}</p>
                <h3 class="callout-heading">{prompt.title}</h3>
              </div>
              <span class="key-pill">{prompt.memoryKey}</span>
            </div>

            {#if prompt.description}
              <p class="panel-copy">{prompt.description}</p>
            {/if}

            <form class="dynamic-form" on:submit|preventDefault={() => submitPrompt(prompt)}>
              {#each prompt.fields as field}
                <label class={`field ${field.type === 'text' || field.type === 'file' ? 'field-span' : ''}`}>
                  <span class="field-label">
                    {field.label}
                    {#if field.required}
                      <span class="required-mark">*</span>
                    {/if}
                  </span>

                  {#if field.type === 'text'}
                    <textarea
                      class="field-input field-textarea"
                      rows="4"
                      placeholder={field.placeholder ?? ''}
                      value={String(formValues[prompt.id]?.[field.name] ?? '')}
                      on:input={(event) => setFieldValue(prompt.id, field.name, event.currentTarget.value)}
                    ></textarea>
                  {:else if field.type === 'boolean'}
                    <span class="toggle-row">
                      <input
                        checked={Boolean(formValues[prompt.id]?.[field.name])}
                        type="checkbox"
                        on:change={(event) => setFieldValue(prompt.id, field.name, event.currentTarget.checked)}
                      />
                      <span class="panel-copy">Yes</span>
                    </span>
                  {:else if field.type === 'select'}
                    <select
                      class="field-input"
                      value={String(formValues[prompt.id]?.[field.name] ?? '')}
                      on:change={(event) => setFieldValue(prompt.id, field.name, event.currentTarget.value)}
                    >
                      {#each field.options ?? [] as option}
                        <option value={option.value}>{option.label}</option>
                      {/each}
                    </select>
                  {:else if field.type === 'file'}
                    <div class="file-field">
                      <input
                        class="field-input file-input"
                        type="file"
                        accept={field.accept ?? undefined}
                        multiple={field.multiple}
                        on:change={(event) => uploadPromptFile(prompt, field, event.currentTarget.files)}
                      />

                      {#if Array.isArray(formValues[prompt.id]?.[field.name])}
                        <div class="upload-chip-list">
                          {#each (formValues[prompt.id]?.[field.name] as UploadedFileReference[]) ?? [] as file}
                            <div class="upload-chip">
                              <button class="file-link" type="button" on:click={() => expandFileSection(file.id)}>
                                {file.name}
                              </button>
                              <span class="field-note">{formatBytes(file.sizeBytes)} | {file.textStatus}</span>
                              <button class="ghost chip-action" type="button" on:click={() => removePromptFile(prompt.id, field.name, file.id)}>
                                Remove
                              </button>
                            </div>
                          {/each}
                        </div>
                      {/if}

                      {#if uploadBusy[`${prompt.id}:${field.name}`]}
                        <span class="field-note">Uploading file…</span>
                      {/if}
                    </div>
                  {:else}
                    <input
                      class="field-input"
                      type={field.type === 'password' ? 'password' : field.type === 'date' ? 'date' : field.type === 'int' || field.type === 'float' ? 'number' : 'text'}
                      step={field.type === 'float' ? 'any' : undefined}
                      placeholder={field.placeholder ?? ''}
                      value={String(formValues[prompt.id]?.[field.name] ?? '')}
                      on:input={(event) => setFieldValue(prompt.id, field.name, event.currentTarget.value)}
                    />
                  {/if}

                  {#if field.description}
                    <span class="field-note">{field.description}</span>
                  {/if}
                </label>
              {/each}

              <div class="form-footer">
                <button class="action" type="submit" disabled={submitBusy[prompt.id]}>
                  {submitBusy[prompt.id] ? 'Saving...' : prompt.fields.length === 0 ? 'Done' : 'Save to memory'}
                </button>
              </div>
            </form>

            {#if submitFeedback[prompt.id]}
              <p class={`feedback ${submitFeedback[prompt.id]?.tone === 'error' ? 'feedback-error' : 'feedback-success'}`}>
                {submitFeedback[prompt.id]?.text}
              </p>
            {/if}
          </article>
        {/each}
      </div>
    {/if}

    <section class="history-panel">
      <div class="history-head">
        <div>
          <p class="panel-label">Completed</p>
          <h3 class="callout-heading">Request History</h3>
        </div>
      </div>

      {#if completedPrompts.length === 0}
        <p class="panel-copy">Completed requests will be listed here.</p>
      {:else}
        <div class="history-list">
          {#each completedPrompts.slice(0, 8) as prompt}
            <article class="history-card">
              <div class="history-meta">
                <strong>{prompt.title}</strong>
                <time datetime={prompt.respondedAt ?? prompt.createdAt}>
                  {formatDate(prompt.respondedAt ?? prompt.createdAt)}
                </time>
              </div>
              <p class="history-copy">{prompt.memoryKey}</p>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </section>

  <section class="panel panel-memory">
    <header class="panel-header">
      <div>
        <p class="panel-label">Machine Memory</p>
        <h2 class="section-heading">Unified Memory</h2>
      </div>
    </header>

    {#if memoryEntries.length === 0}
      <section class="empty-state">
        <p class="panel-label">Memory</p>
        <h3 class="callout-heading">No memory entries</h3>
        <p class="panel-copy">The robot's notes will appear here</p>
      </section>
    {:else}
      <div class="memory-layout">
        <div class="memory-list" role="tablist" aria-label="Memory entries">
          {#each memoryEntries as entry}
            <button
              class:active-memory={selectedMemory?.title === entry.title}
              class="memory-item"
              type="button"
              on:click={() => (selectedMemoryTitle = entry.title)}
            >
              <span class="memory-item-label">{entry.title}</span>
              <span class="memory-item-key">{entry.kind}</span>
            </button>
          {/each}
        </div>

        {#if selectedMemory}
          <article class="memory-detail">
            <div class="memory-detail-head">
              <div>
                <p class="panel-label">Memory Entry</p>
                <h3 class="callout-heading">{selectedMemory.title}</h3>
              </div>
              <span class="key-pill">{selectedMemory.kind}</span>
            </div>

            <dl class="detail-grid">
              <div>
                <dt class="detail-term">Updated</dt>
                <dd class="detail-value">{formatDate(selectedMemory.updatedAt)}</dd>
              </div>
              <div>
                <dt class="detail-term">Storage</dt>
                <dd class="detail-value">{selectedMemory.kind === 'structured' ? 'JSON-backed memory' : 'Plain text memory'}</dd>
              </div>
            </dl>

            {#if selectedMemory.kind === 'structured' && selectedMemory.schema && selectedMemory.data}
              <section class="schema-panel">
                <p class="panel-label">Schema</p>
                <div class="schema-chips">
                  {#each selectedMemory.schema as field}
                    <span class="schema-chip">{field.name}: {field.type}</span>
                  {/each}
                </div>
              </section>

              <section class="json-panel">
                <p class="panel-label">Stored JSON</p>
                <pre class="json-block">{JSON.stringify(selectedMemory.data, null, 2)}</pre>
              </section>
            {:else}
              <section class="json-panel">
                <p class="panel-label">Stored Text</p>
                <pre class="json-block">{selectedMemory.content}</pre>
              </section>
            {/if}
          </article>
        {/if}
      </div>
    {/if}

    <section class="history-panel">
      <div class="history-head">
        <div>
          <p class="panel-label">Uploaded Files</p>
          <h3 class="callout-heading">Document Library</h3>
        </div>
      </div>

      <div class="file-field">
        <input class="field-input file-input" type="file" multiple on:change={(event) => uploadLibraryFiles(event.currentTarget.files)} />
        <span class="field-note">Upload documents directly to the shared library or attach them while filling a request or editing a reminder.</span>
        {#if libraryUploadBusy}
          <span class="field-note">Uploading files...</span>
        {/if}
        {#if libraryUploadFeedback}
          <p class={`feedback ${libraryUploadFeedback.tone === 'error' ? 'feedback-error' : 'feedback-success'}`}>
            {libraryUploadFeedback.text}
          </p>
        {/if}
      </div>

      {#if uploadedFiles.length === 0}
        <p class="panel-copy">Uploaded prescriptions, delivery instructions, and other documents will appear here.</p>
      {:else}
        <div class="document-library" aria-label="Uploaded files">
          {#each uploadedFiles as file}
            <article class={`document-card ${isFileExpanded(file.id) ? 'document-open' : ''}`}>
              <button
                aria-expanded={isFileExpanded(file.id)}
                class="document-toggle"
                type="button"
                on:click={() => toggleFileSection(file.id)}
              >
                <div class="document-heading">
                  <div class="document-title-block">
                    <p class="panel-label">Uploaded File</p>
                    <h4 class="document-title">{file.name}</h4>
                  </div>

                  <div class="document-summary">
                    <span class="key-pill">{file.textStatus}</span>
                    <span class="document-summary-copy">{formatBytes(file.sizeBytes)} | {formatDate(file.createdAt)}</span>
                  </div>
                </div>

                <div class="document-subrow">
                  <div class="schema-chips">
                    <span class="schema-chip">{file.mimeType}</span>
                    {#if file.promptId}
                      <span class="schema-chip">prompt {file.promptId}</span>
                    {/if}
                    {#if file.reminderId}
                      <span class="schema-chip">reminder {file.reminderId}</span>
                    {/if}
                  </div>
                  <span class="document-toggle-label">{isFileExpanded(file.id) ? 'Collapse' : 'Expand'}</span>
                </div>
              </button>

              {#if isFileExpanded(file.id)}
                <div class="document-body">
                  <dl class="detail-grid">
                    <div>
                      <dt class="detail-term">Uploaded</dt>
                      <dd class="detail-value">{formatDate(file.createdAt)}</dd>
                    </div>
                    <div>
                      <dt class="detail-term">Size</dt>
                      <dd class="detail-value">{formatBytes(file.sizeBytes)}</dd>
                    </div>
                  </dl>

                  <section class="json-panel">
                    <p class="panel-label">Extracted Text</p>
                    <pre class="json-block file-text-block">{file.extractedText ?? 'No extracted text available.'}</pre>
                  </section>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </section>
</section>

<style>
  section.page-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
    gap: 1.5rem;
  }

  section.panel {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }

  header.panel-header,
  div.request-head,
  div.history-meta,
  div.memory-detail-head,
  div.form-footer {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
  }

  h2.section-heading,
  h3.callout-heading {
    margin: 0;
    font-family: var(--font-display);
    color: var(--color-ink-strong);
  }

  h2.section-heading {
    font-size: clamp(1.5rem, 1.8vw, 2rem);
  }

  h3.callout-heading {
    font-size: 1.2rem;
  }

  section.metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.9rem;
  }

  article.metric-card,
  article.request-card,
  section.history-panel,
  article.memory-detail,
  section.empty-state {
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
  }

  article.metric-card {
    padding: 1rem;
  }

  strong.metric-value {
    font-family: var(--font-display);
    font-size: 1.65rem;
    color: var(--color-ink-strong);
  }

  section.empty-state,
  article.request-card,
  section.history-panel,
  article.memory-detail {
    padding: 1.1rem;
  }

  div.stack,
  div.history-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  article.request-card {
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 16%, transparent), transparent 60%),
      var(--color-panel-muted);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  span.key-pill,
  span.schema-chip {
    display: inline-flex;
    align-items: center;
    border: var(--border-width) solid var(--color-line);
    color: var(--color-ink-strong);
    background: var(--color-panel);
  }

  span.key-pill {
    padding: 0.5rem 0.75rem;
    font-size: 0.78rem;
    font-family: var(--font-mono);
  }

  form.dynamic-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  label.field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  div.file-field,
  div.upload-chip-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  div.upload-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.8rem 0.9rem;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
  }

  div.document-library {
    display: flex;
    flex-direction: column;
    gap: 1.15rem;
    margin-top: 0.4rem;
  }

  label.field-span {
    grid-column: 1 / -1;
  }

  span.field-label,
  p.metric-label,
  dt.detail-term {
    font-size: 0.78rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-ink-soft);
  }

  span.required-mark {
    color: var(--color-danger);
  }

  input.field-input,
  textarea.field-input,
  select.field-input {
    min-height: 3.15rem;
    box-sizing: border-box;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-input);
    color: var(--color-ink-strong);
    padding: 0.95rem 1rem;
    font: inherit;
  }

  input.file-input {
    padding-block: 0.75rem;
  }

  input.field-input:focus-visible,
  textarea.field-input:focus-visible,
  select.field-input:focus-visible,
  button.ghost:focus-visible,
  button.action:focus-visible,
  button.memory-item:focus-visible,
  button.file-link:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--color-accent) 60%, transparent);
    outline-offset: 1px;
    border-color: var(--color-accent);
  }

  textarea.field-textarea {
    min-height: 8rem;
    resize: vertical;
  }

  span.field-note,
  p.history-copy {
    color: var(--color-ink-soft);
    font-size: 0.92rem;
  }

  span.toggle-row {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    min-height: 3.15rem;
    padding: 0 0.2rem;
  }

  button.action,
  button.ghost,
  button.memory-item {
    font: inherit;
    cursor: pointer;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    color: var(--color-ink-strong);
    transition:
      transform 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
  }

  button.file-link {
    padding: 0;
    background: transparent;
    border: none;
    color: var(--color-ink-strong);
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  button.document-toggle {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem 1.35rem;
    text-align: left;
    cursor: pointer;
    border: none;
    background: transparent;
    color: inherit;
  }

  button.chip-action {
    padding: 0.45rem 0.7rem;
    white-space: nowrap;
  }

  button.action,
  button.ghost {
    padding: 0.9rem 1.15rem;
  }

  button.action {
    background: var(--color-accent);
    color: white;
  }

  button.action:hover,
  button.ghost:hover,
  button.memory-item:hover,
  button.action:focus-visible,
  button.ghost:focus-visible,
  button.memory-item:focus-visible,
  button.active-memory {
    transform: translateY(-1px);
  }

  button.action:disabled {
    opacity: 0.7;
    cursor: progress;
    transform: none;
  }

  p.feedback {
    margin: 0;
    padding: 0.85rem 1rem;
    border: var(--border-width) solid var(--color-line);
  }

  p.feedback-error {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  }

  p.feedback-success {
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
  }

  section.history-panel {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-bg-strong) 55%, transparent), transparent 30%),
      var(--color-panel-muted);
  }

  article.history-card {
    border-top: var(--border-width) solid var(--color-line);
    padding-top: 0.9rem;
  }

  article.document-card {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 6%, transparent), transparent 50%),
      color-mix(in srgb, var(--color-panel-muted) 82%, var(--color-panel));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-line) 45%, transparent);
  }

  article.document-open {
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 58%),
      color-mix(in srgb, var(--color-panel-muted) 88%, var(--color-panel));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 28%, transparent);
  }

  div.document-heading,
  div.document-subrow {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
  }

  div.document-title-block,
  div.document-summary,
  div.document-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  div.document-summary {
    align-items: flex-end;
    text-align: right;
    flex: 0 0 auto;
  }

  h4.document-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.05rem;
    color: var(--color-ink-strong);
    overflow-wrap: anywhere;
    word-break: break-word;
    text-wrap: balance;
  }

  span.document-summary-copy,
  span.document-toggle-label {
    font-size: 0.85rem;
    color: var(--color-ink-soft);
  }

  span.document-toggle-label {
    min-width: 4.75rem;
    text-align: right;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  div.document-body {
    gap: 1.15rem;
    padding: 0 1.35rem 1.35rem;
  }

  article.document-card .key-pill,
  article.document-card .schema-chip {
    border: none;
    background: color-mix(in srgb, var(--color-panel) 74%, transparent);
  }

  article.document-card .schema-chips {
    gap: 0.55rem;
  }

  div.memory-layout {
    display: grid;
    grid-template-columns: minmax(14rem, 0.7fr) minmax(0, 1fr);
    gap: 1rem;
    min-height: 32rem;
  }

  div.memory-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  button.memory-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
    padding: 1rem;
    text-align: left;
  }

  button.active-memory {
    background: color-mix(in srgb, var(--color-accent) 15%, var(--color-panel));
    border-color: var(--color-accent);
  }

  span.memory-item-label {
    font-family: var(--font-display);
    font-size: 1rem;
  }

  span.memory-item-key {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--color-ink-soft);
  }

  article.memory-detail {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 8%, transparent), transparent 28%),
      var(--color-panel-muted);
  }

  dl.detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.9rem;
    margin: 0;
  }

  dd.detail-value {
    margin: 0.3rem 0 0;
    color: var(--color-ink-strong);
  }

  section.schema-panel,
  section.json-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  div.schema-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
  }

  span.schema-chip {
    padding: 0.45rem 0.7rem;
    font-size: 0.8rem;
    font-family: var(--font-mono);
  }

  pre.json-block {
    margin: 0;
    padding: 1rem;
    overflow: auto;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel);
    color: var(--color-ink-strong);
    font: 0.88rem/1.55 var(--font-mono);
  }

  pre.file-text-block {
    max-height: 26rem;
    padding: 1.2rem 1.25rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    border: none;
    background: color-mix(in srgb, var(--color-panel) 84%, transparent);
  }

  @media (max-width: 1180px) {
    section.page-grid,
    div.memory-layout {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    section.metrics,
    form.dynamic-form,
    dl.detail-grid {
      grid-template-columns: 1fr;
    }

    header.panel-header,
    div.request-head,
    div.history-meta,
    div.memory-detail-head,
    div.form-footer,
    div.document-heading,
    div.document-subrow {
      flex-direction: column;
    }

    button.action,
    button.ghost,
    button.memory-item,
    button.chip-action {
      width: 100%;
    }

    div.upload-chip {
      flex-direction: column;
      align-items: flex-start;
    }

    div.document-summary {
      align-items: flex-start;
      text-align: left;
    }

    span.document-toggle-label {
      text-align: left;
    }
  }
</style>
