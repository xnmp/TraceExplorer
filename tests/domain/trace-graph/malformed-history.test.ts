import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./malformed-history-child.ts', import.meta.url));
const paths = [
  'M100 1e20 L200 1e20',
  'M100 -1e20 L200 -1e20',
  'M1e20 100 L1e20 200',
  'M100 0 L100 1e7',
  'M100 100 C100 1e20 200 1e20 200 100',
  'M100 1e309 L200 1e309',
  'M100 NaN L200 NaN',
  'M100 100 L',
];
for (const mode of ['band', 'folder', 'incremental']) {
  it.each([...paths, ...(mode === 'incremental' ? [] : ['attachment:x', 'attachment:stemRoom'])])(`rejects unusable retained routes and lays out afresh (${mode}: %s)`, path => {
    const result = spawnSync('bun', [child, mode, path], { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8' });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim()).toBe('fresh geometry');
  }, 5000);
}

it.each(paths.slice(0, 3))('validates huge finite route coordinates without a non-advancing loop (%s)', path => {
  const result = spawnSync('bun', [child, 'validation', path], { timeout: 2000, killSignal: 'SIGKILL', encoding: 'utf8' });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout.trim()).toBe('fresh geometry');
}, 5000);
