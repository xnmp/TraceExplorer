/** Runs the click-stability tours across processes, longest-queue-free: each process takes the next case when it is done. */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { clickStabilityCases, summarizeClickStability, type ClickTally } from './click-stability';

const WORKER = fileURLToPath(new URL('./click-stability-worker.ts', import.meta.url));

export async function clickStabilitySweep(processes = availableParallelism()) {
  const total = clickStabilityCases().length, tallies = new Array<ClickTally>(total), timings = new Array<number>(total);
  let next = 0;
  const runner = () => new Promise<void>((resolve, reject) => {
    const child = spawn('bun', [WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
    const feed = () => { if (next < total) child.stdin.write(`${next++}\n`); else child.stdin.end(); };
    createInterface({ input: child.stdout }).on('line', (line) => {
      const { index, tally, ms } = JSON.parse(line) as { index: number; tally: ClickTally; ms: number };
      tallies[index] = tally; timings[index] = ms;
      feed();
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`click-stability worker exited with ${code}`)));
    feed();
  });
  await Promise.all(Array.from({ length: Math.min(processes, total) }, runner));
  if (tallies.filter(Boolean).length !== total) throw new Error('click-stability sweep lost cases');
  return { ...summarizeClickStability(tallies), timings };
}

if (import.meta.main) {
  const result = await clickStabilitySweep(Number(process.argv[2]) || undefined);
  const cases = clickStabilityCases(), slowest = result.timings.map((ms, i) => ({ ms, id: `${cases[i].original.id}/${cases[i].width}` })).sort((a, b) => b.ms - a.ms);
  const { timings, ...summary } = result;
  console.log(JSON.stringify(summary));
  console.log('total-cpu-s', Math.round(timings.reduce((a, b) => a + b, 0) / 1000), 'cases', cases.length);
  console.log(slowest.slice(0, 15).map((s) => `${s.ms} ${s.id}`).join('\n'));
}
