/** Transport parity uses the real worker and its retained-reply protocol. */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it.each(['clicks', 'closing', 'arrivals', 'small'])('matches inline and worker geometry across %s, width changes and packed bands', mode => {
  const child = fileURLToPath(new URL('./folder-worker-child.ts', import.meta.url));
  const result = spawnSync('bun', [child, mode], {timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8'});
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stdout.trim()).toBe('20');
}, 25000);
