/** Transport parity uses the real worker and its retained-reply protocol. */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it.each(['clicks', 'closing', 'arrivals', 'small', 'revisits', 'merges', 'routing-publication'])('matches inline and worker geometry across %s, width changes and packed bands', mode => {
  const child = fileURLToPath(new URL('./folder-worker-child.ts', import.meta.url));
  const result = spawnSync('bun', [child, mode], {timeout: 20000, killSignal: 'SIGKILL', encoding: 'utf8'});
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  if (mode === 'revisits') expect(Number(result.stdout.trim())).toBeGreaterThan(100);
  else expect(result.stdout.trim()).toBe(mode === 'merges' ? '5' : mode === 'routing-publication' ? '10' : '20');
}, 25000);
