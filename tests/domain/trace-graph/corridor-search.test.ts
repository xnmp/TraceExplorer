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

import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { importRoutingPlan, validateRoutingPlan } from '$lib/domain/trace-graph/routing-plan';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { sourcesReaching, sharedLanes, foreignJunctionContacts } from './fixtures';
const tile = (key:string,parents:string[]=[],order=0) => ({key,parents,width:60,height:72,order});
it('keeps the source-normal departure when a solved lane differs by a quarter pixel',()=>{
  const items=[{...tile('root'),width:92,height:81},{...tile('child',['root'],1),width:92,height:81}];
  const drawing=layoutLayered({items,maxWidth:400,tileWidth:92,pinned:{key:'root',x:334.25}},{channelStyle:'orthogonal'});
  const plan=importRoutingPlan(drawing),path=plan.paths.find(path=>path.route?.from.id==='root')!;
  const start=path.points[0],next=path.points.find(point=>point.x!==start.x || point.y!==start.y)!;
  expect(start.x).toBe(334.25);
  expect(next.x).toBe(start.x);
  expect(next.y).toBeGreaterThan(start.y);
  expect(geometryGate(drawing,items,'root',400)).toBeNull();
});
it('carries explicit junction approach ports into the completed routing plan',()=>{
  const drawing=layoutLayered({items:[tile('p'),tile('q',[],1),tile('joined',['p','q'],2)],maxWidth:360});
  const plan=importRoutingPlan(drawing);
  expect(plan.meetings).toHaveLength(1);
  const meeting=plan.meetings![0];
  expect(meeting.inputs.map(p=>p.source).sort()).toEqual(['node:p','node:q']);
  expect(meeting.inputs.every(p=>plan.ports.some(port=>port.id===p.port))).toBe(true);
  expect(()=>validateRoutingPlan(plan)).not.toThrow();
  expect(()=>validateRoutingPlan({...plan,meetings:[{...meeting,inputs:meeting.inputs.slice(1)}]})).toThrow(/junction/i);
});
it('keeps distant fan-out consumers exact across several display rows',()=>{
  const items=[tile('root'),...Array.from({length:18},(_,i)=>tile('leaf'+i,['root'],i+1)),tile('end',['leaf0','leaf17'],20)];
  const drawing=layoutLayered({items,maxWidth:220});
  expect(drawing.rows.length).toBeGreaterThan(5);
  for(const node of items.slice(1)) expect([...sourcesReaching(drawing,node.key)].sort()).toEqual([...node.parents].sort());
  expect(sharedLanes(drawing)).toEqual([]);
  expect(foreignJunctionContacts(drawing,5)).toEqual([]);
});
it('keeps a long edge connected through every crossed row and separate from foreign runs',()=>{
  const items=[tile('root'),...Array.from({length:9},(_,i)=>tile('step'+i,[i?'step'+(i-1):'root'],i+1)),tile('end',['root','step8'],20)];
  const drawing=layoutLayered({items,maxWidth:240});
  expect(drawing.rows.length).toBeGreaterThan(8);
  expect([...sourcesReaching(drawing,'end')].sort()).toEqual(['root','step8']);
  expect(sharedLanes(drawing)).toEqual([]);
  expect(foreignJunctionContacts(drawing,5)).toEqual([]);
});

import { smallChannelOrder, freeBoundaryGrowth } from '$lib/domain/trace-graph/channel-domains';
it('does not mistake nominal source count for channel capacity with excluded intervals',()=>{
  expect(smallChannelOrder([{id:'a',intervals:[{low:3,high:4}]},{id:'b',intervals:[{low:3,high:4}]}],3)).toBeNull();
  expect(smallChannelOrder([{id:'a',intervals:[{low:6,high:7}]},{id:'b',intervals:[{low:0,high:2}]}],3)).toEqual(['b','a']);
  expect(smallChannelOrder(Array.from({length:9},(_,i)=>({id:String(i),intervals:[{low:0,high:100}]})),3)).toBeUndefined();
});
it('grows only from capacity bottlenecks, including their own alignment delay',()=>{
  const variables=[{id:'a',lower:8,alignmentSlack:100},{id:'b',lower:0,alignmentSlack:0},{id:'c',lower:11,alignmentSlack:0}];
  expect(freeBoundaryGrowth(variables,['a','b','c'],[{before:'a',after:'b',gap:2}],10)).toBe(1);
  expect(freeBoundaryGrowth([{id:'a',lower:9,alignmentSlack:5},{id:'b',lower:0,alignmentSlack:0}],
    ['a','b'],[{before:'a',after:'b',gap:3}],10)).toBe(7);
});
it('does not spend objective work when only one complete topology exists',()=>{
  const result=searchCorridors(s=>s.choose('only',[7]),10,{score:(value,s)=>{s.charge(100);return value;},samples:2});
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.value).toBe(7);
});
it('charges polyline imports before constructing their ports and native ink',()=>{
  const points=Array.from({length:20},(_,i)=>({x:Math.floor(i/2),y:Math.ceil(i/2)}));
  const result=searchCorridors(s=>importRoutingPlan({points},s.charge),10);
  expect(result.ok).toBe(false);
  if(!result.ok) expect(result.conflict.kind).toBe('search-exhausted');
  expect(result.work).toBeLessThanOrEqual(10);
});

it.each([
  [bend('a',10,30),bend('b',30,60),bend('c',60,10)],
  [bend('a',10,70),bend('b',70,10)],
])('keeps every original leave/arrive contract after splitting: %j',(...input)=>{
  const value=expectDependencies(channel(input));
  for(const a of input) for(const b of input) if(a!==b && Math.abs(a.x1-b.x2)<3) {
    const departure=value.tracks.get(a.id)!,arrival=value.tracks.get(b.id)!;
    expect(departure.split?.track??departure.track).toBeLessThan(arrival.track);
  }
});
it('charges corridor alternatives and free-boundary growth to one ledger',()=>{
  const visited:{choice:number;left:number}[]=[];
  const result=searchCorridors(s=>{
    const choice=s.choose('corridor',[0,1]); visited.push({choice,left:s.growth.left});
    const solved=s.solve({variables:[{id:'pin',preferred:0,pin:{value:3,reason:'retained'}}],order:['pin'],separations:[]});
    if(!s.growth.left) s.grow(3,0);
    return solved.positions.get('pin');
  },200);
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.value).toBe(3);
  expect(visited.slice(0,2)).toEqual([{choice:0,left:0},{choice:1,left:0}]);
  expect(visited.at(-1)!.left).toBe(3);
  expect(result.work).toBeLessThanOrEqual(200);
});
it('ranks completed candidates with the supplied objective within the shared work bound',()=>{
  const result=searchCorridors(s=>s.choose('channel',[30,10,20]),100,{score:value=>value,samples:2});
  expect(result.ok).toBe(true);
  if(result.ok) {expect(result.value).toBe(10);expect(result.candidates).toBe(2);}
});
it('returns the first quality-feasible incumbent after rejecting an infeasible completed attempt',()=>{
  const scored:number[]=[];
  const result=searchCorridors(s=>s.choose('channel',[0,9,1]),100,{
    score:value=>{scored.push(value);return value===0 ? Infinity : value;},samples:1,
  });
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.value).toBe(9);
  expect(scored).toEqual([0,9]);
});
it('rejects the final assignment when every completed candidate fails quality',()=>{
  const scored:number[]=[];
  const result=searchCorridors(s=>s.choose('channel',[0,1]),100,{
    score:value=>{scored.push(value);return Infinity;},samples:1,
  });
  expect(result.ok).toBe(false);
  expect(scored).toEqual([0,1]);
});
it('stops optional optimization before unaffordable work without losing a completed solution',()=>{
  const result=searchCorridors(s=>{
    const choice=s.choose('choice',[0,1]);s.charge(choice?100:1);return choice;
  },30,{score:value=>value,samples:2});
  expect(result.ok).toBe(true);
  if(result.ok) expect(result.value).toBe(0);
  expect(result.work).toBeLessThanOrEqual(30);
});
it('rejects omitted meetings and false junction parentage in an otherwise bound plan',()=>{
  const drawing=layoutLayered({items:[tile('p'),tile('q',[],1),tile('joined',['p','q'],2)],maxWidth:360});
  const plan=importRoutingPlan(drawing);
  expect(()=>validateRoutingPlan({...plan,meetings:[]})).toThrow(/junction/i);
  expect(()=>validateRoutingPlan({...plan,meetings:plan.meetings!.map(m=>({...m,parents:['foreign']}))})).toThrow(/parent/i);
  expect(()=>validateRoutingPlan({...plan,meetings:plan.meetings!.map(m=>({...m,parents:['p','p']}))})).toThrow(/parent/i);
});
it('rejects two junction inputs that share the same approach column before convergence',()=>{
  const nodes=new Map([
    ['p',{key:'p',x:20,y:0,width:60,height:30,row:0,band:0}],
    ['q',{key:'q',x:100,y:0,width:60,height:30,row:0,band:0}],
  ]);
  const dot={id:'join',parents:['p','q'],x:50,y:100};
  const routes=[
    {id:'p-j',from:{kind:'node' as const,id:'p'},to:{kind:'junction' as const,id:'join'},path:'M50 30 L50 100',consumers:[{parent:'p',child:'out'}],terminal:false},
    {id:'q-j',from:{kind:'node' as const,id:'q'},to:{kind:'junction' as const,id:'join'},path:'M130 30 L130 50 L50 50 L50 100',consumers:[{parent:'q',child:'out'}],terminal:false},
  ];
  expect(()=>importRoutingPlan({nodes,junctions:new Map([['join',dot]]),routes})).toThrow(/junction.*(approach|independent)/i);
});
