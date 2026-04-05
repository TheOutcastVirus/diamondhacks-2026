<script lang="ts">
  import { post } from '../api';
  import type { RecordingState } from '../types';

  let state: RecordingState = 'idle';
  let error = '';

  async function startRecording() {
    error = '';
    try {
      await post('/api/agent/voice-start');
      state = 'recording';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to start recording.';
    }
  }

  async function stopRecording() {
    state = 'processing';
    try {
      await post('/api/agent/voice-stop');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to process voice input.';
    } finally {
      state = 'idle';
    }
  }

  function toggle() {
    if (state === 'idle') startRecording();
    else if (state === 'recording') stopRecording();
  }
</script>

<div class="voice-root">
  <button
    class="mic-btn"
    class:recording={state === 'recording'}
    class:processing={state === 'processing'}
    type="button"
    disabled={state === 'processing'}
    on:click={toggle}
    aria-label={state === 'recording' ? 'Stop recording' : 'Start recording'}
  >
    {#if state === 'processing'}
      <span class="spinner"></span>
    {:else}
      <svg class="mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3"/>
        <path d="M5 10a7 7 0 0 0 14 0"/>
        <line x1="12" y1="19" x2="12" y2="22"/>
        <line x1="8" y1="22" x2="16" y2="22"/>
      </svg>
    {/if}
  </button>

  <p class="voice-label">
    {#if state === 'idle'}Tap to speak{:else if state === 'recording'}Recording… tap to stop{:else}Processing…{/if}
  </p>

  {#if error}
    <p class="voice-error">{error}</p>
  {/if}
</div>

<style>
  div.voice-root {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  button.mic-btn {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 50%;
    border: var(--border-width) solid var(--color-line);
    background: var(--color-panel-muted);
    color: var(--color-ink-strong);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      transform 160ms ease;
  }

  button.mic-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: var(--color-accent);
  }

  button.mic-btn.recording {
    background: color-mix(in srgb, var(--color-danger) 18%, var(--color-panel-muted));
    border-color: var(--color-danger);
    animation: pulse-ring 1.2s ease-in-out infinite;
  }

  button.mic-btn.processing {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @keyframes pulse-ring {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 40%, transparent); }
    50% { box-shadow: 0 0 0 0.5rem color-mix(in srgb, var(--color-danger) 0%, transparent); }
  }

  svg.mic-icon {
    width: 1.4rem;
    height: 1.4rem;
  }

  span.spinner {
    width: 1.2rem;
    height: 1.2rem;
    border: 2px solid var(--color-line);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  p.voice-label {
    margin: 0;
    font-size: 0.78rem;
    color: var(--color-ink-soft);
    letter-spacing: 0.05em;
  }

  p.voice-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--color-danger);
    text-align: center;
    max-width: 16rem;
  }
</style>
