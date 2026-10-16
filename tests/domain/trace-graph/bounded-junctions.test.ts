import { expect, it } from 'vitest';
import { buildInputJunctions } from '$lib/domain/trace-graph/junctions';
import { boundedJunctions } from '$lib/domain/trace-graph/bounded-junctions';

const plan = (count: number) => boundedJunctions(buildInputJunctions([
  ...Array.from({length:count},(_,i)=>({child:`p${i}`,parents:[]})),
  {child:'output',parents:Array.from({length:count},(_,i)=>`p${i}`)},
]));
it('preserves every source and consumer with bounded fan-in and distinct identities', () => {
  const transformed = plan(100), joins = new Map(transformed.joins.map(j=>[j.id,j]));
  expect(joins.size).toBe(transformed.joins.length);
  for (const join of joins.values()) {
    expect(join.inputs.length).toBeLessThanOrEqual(4);
    const parents = join.inputs.flatMap(input=>input.kind==='node' ? [input.id] : [...joins.get(input.id)!.parents]);
    expect([...new Set(parents)].sort()).toEqual([...join.parents].sort());
  }
  const last = transformed.routes.find(r=>r.to.kind==='node' && r.to.id==='output')!;
  expect(last.consumers).toHaveLength(100);
});
it('does not duplicate a complete large parent-set identity in every subjunction', () => {
  const size = (n:number) => plan(n).joins.reduce((sum,j)=>sum+j.id.length,0);
  expect(size(800)).toBeLessThan(size(400)*3);
  expect(size(1600)).toBeLessThan(size(800)*3);
});
