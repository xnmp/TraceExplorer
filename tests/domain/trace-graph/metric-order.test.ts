/** The affected metric derives every separation's side from one drawn order
 * (coordinate, then identity) and solves once. A complete drawing whose
 * separations hold, with curve-flattening noise and foreign straight runs that
 * a port corner also names, must be admitted rather than reported as a
 * metric conflict. The fixture is legacy's complete drawing of an insertion
 * (inventory key 45bed924bab484b2) with the request and committed drawing. */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { captureFramedIncrementalRouting, solveIncrementalTopology } from '$lib/domain/trace-graph/incremental-routing';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

const revive = (_k: string, v: any) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v;
const { request, previous, legacy } = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/metric-order-legacy-drawing.json.gz', import.meta.url))).toString(), revive);

it('admits a complete drawing whose separations hold in the drawn order', () => {
  const seed = captureFramedIncrementalRouting(request, previous, previous, [], () => {}, { meetingEntries: true });
  if (!('problem' in seed)) throw new Error(`capture declined: ${seed.reason}`);
  const result = solveIncrementalTopology(request, seed, legacy, 1_024_000_000);
  expect(result.ok ? null : result.conflict).toBeNull();
  if (!result.ok) return;
  expect(geometryGate(result.drawing, request.items, request.band.key, request.maxWidth)).toBeNull();
});
