<script lang="ts">
  import { onMount } from 'svelte';
  import BrowserPage from './lib/pages/BrowserPage.svelte';
  import RemindersPage from './lib/pages/RemindersPage.svelte';
  import RequestedInfoPage from './lib/pages/RequestedInfoPage.svelte';
  import TranscriptionPage from './lib/pages/TranscriptionPage.svelte';
  import type { PageDefinition, PageId, ThemeMode } from './lib/types';

  const pages: PageDefinition[] = [
    {
      id: 'reminders',
      label: 'Reminders',
      shortLabel: 'Reminders',
      eyebrow: 'Reminders',
      title: 'Reminders',
      description: 'View, add, and update reminders.',
      metricLabel: 'List',
    },
    {
      id: 'transcription',
      label: 'Transcript',
      shortLabel: 'Transcript',
      eyebrow: '',
      title: 'Transcript',
      description: 'One timeline: live chat, tool calls, and what the agent is doing.',
      metricLabel: 'Live',
    },
    {
      id: 'browser',
      label: 'Browser',
      shortLabel: 'Browser',
      eyebrow: '',
      title: 'Browser',
      description: 'Current page, task, and recent actions.',
      metricLabel: 'Session',
    },
    {
      id: 'requested-info',
      label: 'Requested Info',
      shortLabel: 'Info',
      eyebrow: 'Memory',
      title: 'Requested Information',
      description: 'Review active intake forms and unified user memory.',
      metricLabel: 'Intake',
    },
  ];

  const routeLookup = new Map<PageId, PageDefinition>(pages.map((page) => [page.id, page]));
  const themeOptions: ThemeMode[] = ['light', 'dark'];

  let currentPageId: PageId = 'reminders';
  let themeMode: ThemeMode = 'light';

  function parseRoute(hash: string): PageId {
    const candidate = hash.replace(/^#\/?/, '').trim() as PageId;
    return routeLookup.has(candidate) ? candidate : 'reminders';
  }

  function applyTheme(mode: ThemeMode) {
    themeMode = mode;
    document.documentElement.dataset.theme = mode;
    window.localStorage.setItem('gazabot-theme', mode);
  }

  function syncRoute() {
    currentPageId = parseRoute(window.location.hash);
  }

  function navigate(pageId: PageId) {
    if (window.location.hash === `#/${pageId}`) {
      currentPageId = pageId;
      return;
    }

    window.location.hash = `/${pageId}`;
  }

  function toggleTheme() {
    const currentIndex = themeOptions.indexOf(themeMode);
    const nextMode = themeOptions[(currentIndex + 1) % themeOptions.length];
    applyTheme(nextMode);
  }

  onMount(() => {
    syncRoute();

    const storedTheme = window.localStorage.getItem('gazabot-theme') as ThemeMode | null;
    if (storedTheme === 'light' || storedTheme === 'dark') {
      applyTheme(storedTheme);
    } else {
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    }

    const handleHashChange = () => syncRoute();
    window.addEventListener('hashchange', handleHashChange);

    if (!window.location.hash) {
      window.location.hash = '/reminders';
    }

    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  });

  $: currentPage = routeLookup.get(currentPageId) ?? pages[0];
  $: themeLabel = themeMode === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
</script>

<svelte:head>
  <title>Sodium Dashboard</title>
  <meta
    name="description"
    content="Control surface for monitoring reminders, transcription, and browser activity on Sodium."
  />
</svelte:head>

<div class="app-shell">
  <aside class="sidebar">
    <div class="brand-block">
      <h1 class="brand-heading">Sodium</h1>
    </div>

    <nav class="navigation" aria-label="Primary">
      {#each pages as page}
        <button
          class:active={page.id === currentPageId}
          class="nav-link"
          type="button"
          on:click={() => navigate(page.id)}
        >
          <span class="nav-label">{page.label}</span>
        </button>
      {/each}
    </nav>

    <button class="toggle" type="button" on:click={toggleTheme} aria-label={themeLabel}>
      {themeMode === 'light' ? 'Dark mode' : 'Light mode'}
    </button>
  </aside>

  <main class="workspace">
    <header class="page-header">
      <div class="page-title">
        {#if currentPage.eyebrow}
          <p class="eyebrow">{currentPage.eyebrow}</p>
        {/if}
        <h1 class="heading">{currentPage.title}</h1>
      </div>
      <button class="toggle mobile-header-toggle" type="button" on:click={toggleTheme} aria-label={themeLabel}>
        {themeMode === 'light' ? '☀' : '☾'}
      </button>
    </header>

    {#if currentPageId === 'reminders'}
      <RemindersPage />
    {:else if currentPageId === 'transcription'}
      <TranscriptionPage />
    {:else if currentPageId === 'requested-info'}
      <RequestedInfoPage />
    {:else}
      <BrowserPage />
    {/if}
  </main>
</div>

<nav class="mobile-bottom-nav" aria-label="Mobile navigation">
  {#each pages as page}
    <button
      class:active={page.id === currentPageId}
      class="mobile-tab"
      type="button"
      on:click={() => navigate(page.id)}
    >
      <span class="mobile-tab-label">{page.shortLabel}</span>
    </button>
  {/each}
</nav>
