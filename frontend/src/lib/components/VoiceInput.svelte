<script lang="ts">
  import { post } from '../api';
  import type { AgentModel, RecordingState } from '../types';

  let state: RecordingState = 'idle';
  let error = '';
  export let agentModel: AgentModel = 'cerebras';

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
      await post('/api/agent/voice-stop', { model: agentModel });
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
    {#if state === 'idle'}Tap the mic — talk to the agent{:else if state === 'recording'}Recording. Tap again to stop.{:else}Wrapping up…{/if}
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
    justify-content: center;
    gap: 1.25rem;
    width: 100%;
    animation: tx-fade-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes tx-fade-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  button.mic-btn {
    width: 6rem;
    height: 6rem;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 8%, transparent);
    background: var(--color-bg-strong);
    color: var(--color-ink-strong);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 
      0 4px 12px color-mix(in srgb, var(--color-ink-strong) 4%, transparent),
      inset 0 2px 0 color-mix(in srgb, #ffffff 40%, transparent);
    transition:
      background 0.2s ease,
      border-color 0.2s ease,
      transform 0.2s ease,
      box-shadow 0.2s ease;
    position: relative;
    overflow: visible;
  }

  /* Inner ring effect for polish */
  button.mic-btn::before {
    content: '';
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--color-line-strong) 6%, transparent);
    pointer-events: none;
    transition: border-color 0.2s ease;
  }

  button.mic-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg-strong));
    border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
    box-shadow: 
      0 8px 24px color-mix(in srgb, var(--color-ink-strong) 8%, transparent),
      0 4px 8px color-mix(in srgb, var(--color-accent) 10%, transparent),
      inset 0 2px 0 color-mix(in srgb, #ffffff 40%, transparent);
  }

  button.mic-btn:hover:not(:disabled)::before {
    border-color: color-mix(in srgb, var(--color-accent) 20%, transparent);
  }

  button.mic-btn:active:not(:disabled) {
    transform: translateY(0px);
    box-shadow: 
      0 2px 6px color-mix(in srgb, var(--color-ink-strong) 4%, transparent),
      inset 0 2px 0 color-mix(in srgb, #ffffff 10%, transparent);
  }

  button.mic-btn.recording {
    background: color-mix(in srgb, var(--color-danger) 10%, var(--color-bg-strong));
    border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
    color: var(--color-danger);
    animation: pulse-ring 2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    box-shadow: 0 4px 12px color-mix(in srgb, var(--color-danger) 15%, transparent);
  }

  button.mic-btn.recording::before {
    border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
  }

  button.mic-btn.processing {
    opacity: 0.6;
    cursor: not-allowed;
    background: var(--color-panel-muted);
  }

  @keyframes pulse-ring {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 30%, transparent); }
    70% { box-shadow: 0 0 0 1rem color-mix(in srgb, var(--color-danger) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 0%, transparent); }
  }

  svg.mic-icon {
    width: 2.2rem;
    height: 2.2rem;
    transition: transform 0.2s ease, color 0.2s ease;
    filter: drop-shadow(0 2px 4px color-mix(in srgb, var(--color-ink-strong) 10%, transparent));
  }

  button.mic-btn:hover:not(:disabled) svg.mic-icon {
    color: var(--color-accent);
    transform: scale(1.05);
  }

  button.mic-btn.recording svg.mic-icon {
    color: var(--color-danger);
    animation: mic-bounce 1s ease-in-out infinite;
  }

  @keyframes mic-bounce {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.1); }
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
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--color-ink-soft);
    letter-spacing: 0.02em;
    transition: color 0.2s ease;
  }

  div.voice-root:hover p.voice-label {
    color: var(--color-ink);
  }

  p.voice-error {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    text-align: center;
    max-width: 16rem;
    animation: tx-fade-up 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
</style>
