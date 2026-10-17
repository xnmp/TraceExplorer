/** Short, opt-in calibration of the production runtime; never part of layout:eval. */
import { createFolderLayoutRuntime } from '../src/lib/plugins/trace/view/folder-layout-runtime';
import { folderInput, makeFolder } from '../tests/domain/trace-graph/folder-layout-fixtures';
import { node } from './corpus';
import { folderBandRequests } from '../src/lib/domain/trace-graph/folder-layout/default-engine';

const samples = 20;
const sizes = process.argv.slice(2).map(Number);
for (const size of sizes.length ? sizes : [10, 40, 80, 85, 86, 87, 90, 100, 200, 400, 1000, 2000]) {
  const folder = makeFolder({ stacks: [[node('root'), ...Array.from({ length: size - 1 }, (_, i) => node(`n${i}`, ['root'], i + 1))]] });
  const input = folderInput(folder, { open: ['s0:root'], width: 900 });
  const owner = createFolderLayoutRuntime();
  const previous = owner.engine(input);
  const closed = owner.engine({ ...input, open: new Map(), previous });
  const requests = {
    restore: { ...input, previous: structuredClone(previous) },
    revisit: { ...input, previous: closed },
    status: { ...input, previous, dataRevision: 'status-only-refresh' },
  };
  const row: Record<string, number> = { tiles: size, routes: previous.graphs.get('s0:root')!.attached.routes.length,
    pathBytes: previous.graphs.get('s0:root')!.attached.routes.reduce((sum, route) => sum + 2 * route.path.length, 0) };
  for (const [kind, request] of Object.entries(requests)) {
    // Restore models the first main-thread certification after worker transport:
    // warm raw bands, cold certificate. Revisits/refreshes keep local certificates.
    const run = () => {
      const runtime = kind === 'restore' ? createFolderLayoutRuntime() : owner;
      if (kind === 'restore') runtime.remember(previous);
      const fresh = { ...request };
      const dispatchStart = performance.now();
      const inline = runtime.inline(fresh);
      // Match admitted runs' plan reuse even for rejected sizes. Production
      // short-circuits large retained drawings before planning them.
      if (!inline) folderBandRequests(fresh);
      const start = performance.now();
      const result = runtime.engine(fresh);
      const elapsed = performance.now() - start;
      if (!result.revisited) throw new Error(`${kind} did not restore at ${size}`);
      return { engine: elapsed, total: performance.now() - dispatchStart };
    };
    for (let i = 0; i < 8; i++) run();
    const times = Array.from({ length: samples }, run);
    const p95 = (values: number[]) => Number(values.sort((a, b) => a - b)[Math.ceil(samples * .95) - 1].toFixed(2));
    row[kind] = p95(times.map(time => time.engine));
    row[`${kind}WithDispatch`] = p95(times.map(time => time.total));
  }
  console.log(JSON.stringify(row));
}
