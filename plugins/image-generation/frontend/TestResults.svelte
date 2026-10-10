<script lang="ts">
  import { active, testSummary } from './domain';
  import type { TestResult } from './controller';
  let { tests, revision, oncancel, onrefresh, ondiscard }: { tests: readonly TestResult[]; revision: number; oncancel: (id: string) => Promise<void>; onrefresh: (id: string) => Promise<void>; ondiscard: (id: string) => Promise<void> } = $props();
</script>
{#if tests.length}
  <section aria-labelledby="image-tests-title">
    <h3 id="image-tests-title">Connection tests</h3>
    <p class="note">Each test is a real image generation and may be billed. Closing this dialog never discards a successful output.</p>
    <ul>
      {#each tests as test (test.requestId)}
        <li>
          <strong>{test.profileName}</strong>
          {#if test.configurationRevision !== revision}<p class="note">Result from settings revision {test.configurationRevision}; current settings are revision {revision}. Test again to verify current settings.</p>{/if}
          <p role="status">{test.status ? testSummary(test.status) : 'Waiting for the test acceptance reply…'}</p>
          {#if test.error}<p role="alert">{test.error}</p>{/if}
          <div class="actions">
            <button type="button" onclick={() => onrefresh(test.requestId)}>Refresh status</button>
            {#if active(test.status)}<button type="button" onclick={() => oncancel(test.requestId)}>Cancel test</button>{/if}
            {#if test.status?.execution.state === 'succeeded' && test.status.delivery.state !== 'discarded'}<button type="button" onclick={() => ondiscard(test.requestId)}>Discard test output</button>{/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
<style>
  section { border-top: 1px solid var(--divider); padding-top: var(--spacing-md); } h3 { font-size: var(--font-size-body); margin: 0 0 var(--spacing-sm); }
  ul { list-style: none; padding: 0; display: grid; gap: var(--spacing-md); } li { padding: var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); } p { margin: var(--spacing-sm) 0; overflow-wrap: anywhere; }
  .note { color: var(--text-secondary); font-size: var(--font-size-caption); }.actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
  button { padding: var(--spacing-sm) var(--spacing-md); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill-secondary); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
</style>
