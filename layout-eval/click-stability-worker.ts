/** One sweep process: reads case indices from stdin, writes one JSON tally per line. */
import { createInterface } from 'node:readline';
import { clickStabilityCase } from './click-stability';
for await (const line of createInterface({ input: process.stdin })) {
  const index = Number(line), started = performance.now();
  const tally = clickStabilityCase(index);
  process.stdout.write(`${JSON.stringify({ index, tally, ms: Math.round(performance.now() - started) })}\n`);
}
