import { solveSeparation, type SeparationResult } from './separation';

/** A plain zone: port departure bound, ordered centers, trailing berth, free end. */
export function solveOrderedTracks(count: number, minimumHeight: number, leading: number, clearance: number): SeparationResult {
  if (!Number.isSafeInteger(count) || count < 1 || ![minimumHeight, leading, clearance].every(v => Number.isFinite(v) && v >= 0))
    return { ok: false, conflict: { kind: 'invalid', variable: 'zone', constraints: ['zone bounds'] } };
  // Existing spreading is a feasible preference. The end boundary remains a
  // free variable, so an added track can grow this zone without squeezing it.
  const preferredEnd = Math.max(minimumHeight, (count - 1) * clearance + clearance + leading);
  const last = preferredEnd - clearance;
  const order = Array.from({ length: count }, (_, i) => `${i}`);
  const variables = order.map((id, i) => ({ id,
    preferred: count === 1 ? (leading + last) / 2 : leading + (last - leading) * i / (count - 1), bounds: { lower: leading } }));
  return solveSeparation({ variables: [...variables, { id: 'end', preferred: minimumHeight, bounds: { lower: minimumHeight } }], order: [...order, 'end'],
    separations: [...order.slice(1).map((id, i) => ({ id: `track:${id}`, before: order[i], after: id, gap: clearance })),
      { id: 'trailing berth', before: order.at(-1)!, after: 'end', gap: clearance }] });
}
