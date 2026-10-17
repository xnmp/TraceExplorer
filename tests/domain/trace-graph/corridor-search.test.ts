import { describe, expect, it } from 'vitest';
import { searchCorridors } from '$lib/domain/trace-graph/corridor-search';
import { solveChannelTopology, type ChannelBend } from '$lib/domain/trace-graph/channel-topology';
import { junctionInputPorts } from '$lib/domain/trace-graph/routing-plan';
import { buildInputJunctions, endpointKey } from '$lib/domain/trace-graph/junctions';

const bend = (id: string, x1: number, x2: number): ChannelBend => ({id,source:id,target:null,x1,x2});
const channel = (bends: readonly ChannelBend[], budget?: number) => searchCorridors(s => solveChannelTopology(bends,bends.flatMap(b=>[b.x1,b.x2]),100,s),budget);
const expectDependencies = (result: ReturnType<typeof channel>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.conflict));
  for (const edge of result.value.dependencies) expect(result.value.positions.get(edge.after)! - result.value.positions.get(edge.before)!).toBeGreaterThanOrEqual(edge.gap);
  return result.value;
};

describe('explicit junction inputs', () => {
  it.each([2,3,4,5,6,7,8])('reserves independent convergence ports for %i exact inputs', count => {
    const parents = Array.from({length:count},(_,i)=>'p'+i), plan = buildInputJunctions([{child:'output',parents}]);
    const join = plan.joins[0];
    const ports = junctionInputPorts(join, 50, join.inputs.map((input,i)=>({source:endpointKey(input),x:i*10})));
    expect(ports.map(p=>p.source).sort()).toEqual(join.inputs.map(endpointKey).sort());
    expect(new Set(ports.map(p=>p.id)).size).toBe(count);
    expect(new Set(ports.map(p=>p.x)).size).toBe(count);
    for (let i=1;i<ports.length;i++) expect(ports[i].x-ports[i-1].x).toBeGreaterThanOrEqual(3);
    expect(ports.every(p=>p.junction===join.id && p.dotX===50)).toBe(true);
  });
  it('keeps a reused subset as a distinct input with its original parentage', () => {
    const plan = buildInputJunctions([{child:'a',parents:['p','q']},{child:'b',parents:['p','q','r']},{child:'c',parents:['p','q']}]);
    const subset = plan.joins.find(j=>j.parents.length===2)!, larger = plan.joins.find(j=>j.parents.length===3)!;
    expect(larger.inputs).toContainEqual({kind:'junction',id:subset.id});
    const ports = junctionInputPorts(larger, 50, larger.inputs.map((input,i)=>({source:endpointKey(input),x:i*10})));
    expect(ports.map(p=>p.source)).toContain('junction:'+subset.id);
    expect(plan.routes.filter(r=>r.from.kind==='junction' && r.from.id===subset.id && r.to.kind==='node').map(r=>r.to.id).sort()).toEqual(['a','c']);
  });
});

it('splits a forced three-way leave/arrive cycle without losing a dependency', () => {
  const value = expectDependencies(channel([bend('a',10,30),bend('b',30,60),bend('c',60,10)]));
  expect([...value.tracks.values()].some(t=>t.split)).toBe(true);
  expect(new Set(value.tracks.keys())).toEqual(new Set(['a','b','c']));
});
it('routes a swap through an explicit split with ordered departure and arrival', () => {
  const value = expectDependencies(channel([bend('a',10,70),bend('b',70,10)]));
  const split = [...value.tracks.values()].find(t=>t.split)!;
  expect(split.track).toBeGreaterThan(split.split!.track);
  expect(split.split!.x).toBeGreaterThan(10);
  expect(split.split!.x).toBeLessThan(70);
});
it('returns a conflict for budget exhaustion, including retries and metric work', () => {
  const result = searchCorridors(s => {
    const n = s.choose('channel',[0,1,2,3,4,5,6,7]);
    s.solve({variables:[{id:'x',preferred:n}],order:['x'],separations:[]});
    return s.reject(['blocked']);
  },40);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.conflict.kind).toBe('search-exhausted');
  expect(result.work).toBeLessThanOrEqual(40);
  expect(result.candidates).toBeGreaterThan(1);
});
it('tries another corridor on a metric conflict and leaves pins exact', () => {
  const result = searchCorridors(s=>{
    const upper = s.choose('channel',[1,20]);
    return s.solve({variables:[{id:'pin',preferred:0,pin:{value:5,reason:'retained'}},{id:'free',preferred:0,bounds:{upper}}],order:['pin','free'],
      separations:[{id:'clearance',before:'pin',after:'free',gap:3}]}).positions;
  });
  expect(result.ok).toBe(true);
  if (result.ok) { expect(result.candidates).toBe(2); expect([...result.value.values()]).toEqual([5,8]); }
});
it.each([NaN,Infinity,-1,.5])('rejects malformed budgets: %s', budget => expect(searchCorridors(()=>null,budget).ok).toBe(false));
it('is deterministic and does not mutate the supplied channel', () => {
  const input = Object.freeze([Object.freeze(bend('a',10,70)),Object.freeze(bend('b',70,10))]);
  expect(channel(input)).toEqual(channel(input));
});
