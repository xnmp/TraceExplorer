/** Import an untouched main evaluator's outputs; never substitute the frozen baseline.
 * bun layout-eval/reference-movement.ts <archived-main>/layout-eval/out <full-main-sha>
 */
import { createHash } from 'node:crypto';
import { movementSummary } from './movement-summary';
const [directory, commit] = process.argv.slice(2);
if (!directory || !/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('Expected main output directory and full commit SHA');
const read = async (name: string) => {
  const data = await Bun.file(`${directory}/${name}.json`).text();
  return { value: JSON.parse(data), sha256: createHash('sha256').update(data).digest('hex') };
};
const [corpus, tours] = await Promise.all([read('results'), read('reveals')]);
const bandRows = corpus.value.rows.filter((r: any) => r.engine === 'proposed');
const tourRows = (dense: boolean) => tours.value.rows.filter((r: any) => !!r.dense === dense).map((r: any) => ({ ...r, metrics: r.proposed }));
if ([...bandRows, ...tourRows(false), ...tourRows(true)].some(r => r.revisited)) throw new Error('Expected main without restore memory');
await Bun.write('layout-eval/main-movement-reference.json', JSON.stringify({ commit,
  source: { corpus: corpus.sha256, tours: tours.sha256 },
  corpus: movementSummary(bandRows), broad: movementSummary(tourRows(false)), dense: movementSummary(tourRows(true)),
}, null, 2) + '\n');
