import { expect, it } from 'vitest';
import fixture from './future-port-scene.json';
import { importRoutingPlan, validateRoutingPlan } from '$lib/domain/trace-graph/routing-plan';
import { convergenceInput } from '$lib/domain/trace-graph/routing-convergence';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { attachSingleBand, attachPackedBand } from '$lib/domain/trace-graph/band-geometry';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-history';
import { layoutGraph, layoutLayered, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { mapPathNumbers } from '$lib/domain/trace-graph/path-data';

const translatedJoin = () => {
  const dot = { id: 'join', x: 510.8, y: 100, parents: ['p', 'q'] };
  const routes = [
    { id: 'p-join', from: { kind: 'node' as const, id: 'p' }, to: { kind: 'junction' as const, id: dot.id },
      consumers: [{ parent: 'p', child: 'out' }], terminal: false, path: 'M600 30 L600 70 L513.8 70 L513.8 94 C513.8 97 510.8 97 510.8 100' },
    { id: 'q-join', from: { kind: 'node' as const, id: 'q' }, to: { kind: 'junction' as const, id: dot.id },
      consumers: [{ parent: 'q', child: 'out' }], terminal: false, path: 'M510.8 30 L510.8 100' },
  ];
  const nodes = new Map([['p', { key: 'p', x: 570, y: 0, width: 60, height: 30, row: 0, band: 0 }],
    ['q', { key: 'q', x: 480.8, y: 0, width: 60, height: 30, row: 0, band: 0 }]]);
  const offset = { x: -39.5, y: 0 };
  return { nodes: new Map([...nodes].map(([id,n])=>[id,{...n,x:n.x+offset.x}])),
    routes: routes.map(route=>({...route,path:mapPathNumbers(route.path,(v,i)=>v+(i%2?offset.y:offset.x))})),
    junctions: new Map([[dot.id,{...dot,x:dot.x+offset.x}]]) };
};

const scene = () => JSON.parse(JSON.stringify(fixture), (_key, value) => value?.__map ? new Map(value.__map) : value) as {
  previous: GraphLayout; request: LayoutRequest;
};
const merged = () => {
  const c = { ...corpus().find(c => c.id === 'merges-3')!, full: false };
  const previous = optimizedBand(requestFor(c, null, 454, 96));
  const request = requestFor(c, 'c', 454, 96);
  const next = optimizedBand(request, { previous, anchorKey: 'c' });
  expect(geometryGate(next.placed, request.items, request.band!.key, 454)).toBeNull();
  return next.placed;
};

it('imports a pruned retained dot as an exact semantic projection, including unary residuals', () => {
  const { previous } = scene(), before = structuredClone(previous);
  const plan = importRoutingPlan(previous);
  const meeting = plan.meetings!.find(m => m.id === 'j:["n3","n6"]')!;
  expect(meeting.parents).toEqual(['n3']);
  expect(meeting.projection.declaredParents).toEqual(['n3', 'n6']);
  expect(meeting.inputs).toHaveLength(1);
  expect(plan.paths.map(p => p.route)).toEqual(previous.routes);
  expect(plan.junctions).toEqual([...previous.junctions.values()]);
  expect(() => validateRoutingPlan(structuredClone(plan))).not.toThrow();
  expect(previous).toEqual(before);
});

it('imports both the retained future-port drawing and its published clicked result without repainting', () => {
  const { request, previous } = scene();
  const input = { ...request, history: { signature: bandHistorySignature(request), layout: previous, placed: previous } };
  const drawing = attachSingleBand(layoutGraph(input), input);
  expect(geometryGate(drawing, request.items, request.band!.key, request.maxWidth)).toBeNull();
  expect(importRoutingPlan(drawing).paths.map(p => p.route)).toEqual(drawing.routes);
  expect(drawing.nodes.get(request.anchorKey!)!).toMatchObject({ x: previous.nodes.get(request.anchorKey!)!.x, y: previous.nodes.get(request.anchorKey!)!.y });
}, 30000);

it('represents collinear arrivals from opposite faces as distinct native convergence inputs', () => {
  const drawing = merged(), plan = importRoutingPlan(drawing), meeting = plan.meetings![0];
  expect(meeting.inputs.map(input => input.entry.side).sort()).toEqual(['left', 'right', 'top']);
  expect(meeting.inputs.every(input => input.entry.suffix.at(-1)!.at(-1)!.x === meeting.dot.x
    && input.entry.suffix.at(-1)!.at(-1)!.y === meeting.dot.y)).toBe(true);
  expect(plan.paths.map(p => p.route)).toEqual(drawing.routes);
  expect(() => validateRoutingPlan(structuredClone(plan))).not.toThrow();
});

it('rejects changed convergence allocations, native suffixes and retained dot declarations', () => {
  const plan = importRoutingPlan(merged()), meeting = plan.meetings![0], input = meeting.inputs[0];
  expect(() => validateRoutingPlan({ ...plan, meetings: [{ ...meeting, convergence: { ...meeting.convergence, left: meeting.convergence.left - 1 } }] })).toThrow(/convergence/i);
  expect(() => validateRoutingPlan({ ...plan, meetings: [{ ...meeting, inputs: [{ ...input, entry: { ...input.entry, parameter: 0.5 } }, ...meeting.inputs.slice(1)] }] })).toThrow(/approach/i);
  expect(() => validateRoutingPlan({ ...plan, meetings: [{ ...meeting, projection: { declaredParents: ['a'] } }] })).toThrow(/projection/i);
});

it('imports bare translated approaches with one explicit exact numerical chart and unchanged painted pins', () => {
  const drawing=translatedJoin(),before=structuredClone(drawing);
  const plan=importRoutingPlan(drawing),ports=plan.meetings![0].inputs.map(input=>plan.ports.find(p=>p.id===input.port)!);
  expect(ports.map(p=>p.point.x).sort((a,b)=>a-b)).toEqual([471.3,474.29999999999995]);
  expect(()=>validateRoutingPlan(structuredClone(plan))).not.toThrow();
  expect(drawing).toEqual(before);
  expect(plan.meetings![0].chart?.kind).toBe('numerical-chart');
  expect(()=>validateRoutingPlan({...plan,meetings:plan.meetings!.map(meeting=>({...meeting,chart:undefined}))})).toThrow(/independent approach/i);
});

it('rejects a stale numerical chart and a painted approach whose gap is 2.99', () => {
  const drawing=translatedJoin(),route=drawing.routes[0];
  expect(()=>importRoutingPlan({...drawing,routes:[{...route,path:route.path.replaceAll('474.29999999999995','474.29')},drawing.routes[1]]})).toThrow(/independent approach/i);
  const plan=importRoutingPlan(drawing),meeting=plan.meetings![0];
  const chart=meeting.chart!;
  expect(()=>validateRoutingPlan({...plan,meetings:[{...meeting,chart:{...chart,dot:{...chart.dot,x:chart.dot.x+1}}}]})).toThrow(/chart/i);
});

it('imports the same bare drawing after an identity attachment without persisted provenance', () => {
  const drawing=translatedJoin();
  const layout:GraphLayout={...drawing,orientation:'down',width:640,height:150,rows:[],readingOrder:new Map(),bandBounds:{left:0,width:640,top:64}};
  const attached=attachPackedBand(layout,'p',30,{x:0,coverX:560.5,coverHeight:30,width:640,left:0,right:640,track:12,stemRoom:34});
  const plan=importRoutingPlan(attached);
  expect(plan.meetings![0].inputs.map(input=>plan.ports.find(port=>port.id===input.port)!.point.x).sort((a,b)=>a-b)).toEqual([471.3,474.29999999999995]);
  expect(attached.junctions).toEqual(drawing.junctions);
});

it.each([1,39.5,100])('imports a certified reattachment by %s using only its pinned native drawing', dx => {
  const drawing=translatedJoin();
  const layout:GraphLayout={...drawing,orientation:'down',width:640,height:170,rows:[],readingOrder:new Map(),bandBounds:{left:0,width:640,top:64},
    nodes:new Map([...drawing.nodes,['out',{key:'out',x:441.3,y:140,width:60,height:30,row:1,band:1}]]),
    routes:[...drawing.routes,{id:'j-out',from:{kind:'junction',id:'join'},to:{kind:'node',id:'out'},path:'M471.3 100 L471.3 132',terminal:true,
      consumers:[{parent:'p',child:'out'},{parent:'q',child:'out'}]}]};
  const attached=attachPackedBand(layout,'p',30,{x:dx,coverX:560.5+dx,coverHeight:30,width:740,left:0,right:740,track:12,stemRoom:34});
  const items=[{key:'p',parents:[],width:60,height:30,order:0},{key:'q',parents:[],width:60,height:30,order:1},
    {key:'out',parents:['p','q'],width:60,height:30,order:2}];
  expect(geometryGate(attached,items,'p',740)).toBeNull();
  const plan=importRoutingPlan(attached);
  expect(plan.paths.map(path=>path.route)).toEqual(attached.routes);
});

it('rejects an invented active parent even when it appears in a retained historical declaration', () => {
  const plan = importRoutingPlan(scene().previous), meeting = plan.meetings!.find(m => m.id === 'j:["n3","n6"]')!;
  expect(() => validateRoutingPlan({ ...plan, meetings: plan.meetings!.map(m => m === meeting ? { ...m, parents: ['n3', 'n6'] } : m) })).toThrow(/parent/i);
});

it('rejects retained terminal consumers whose incoming projection was removed', () => {
  const items = [{ key: 'p', parents: [], width: 60, height: 30, order: 0 },
    { key: 'q', parents: [], width: 60, height: 30, order: 1 },
    { key: 'joined', parents: ['p', 'q'], width: 60, height: 30, order: 2 }];
  const drawing = layoutLayered({ items, maxWidth: 360 });
  expect(() => importRoutingPlan({ ...drawing, routes: drawing.routes.filter(r => r.from.id !== 'q') })).toThrow(/consumer projection/i);
  const terminal = drawing.routes.find(r => r.terminal)!;
  expect(() => importRoutingPlan({ ...drawing, routes: drawing.routes.map(r => r === terminal
    ? { ...r, consumers: { entries: [{ parent: 'p', child: 'joined' }], start: 0, end: Infinity } } : r) })).toThrow(/consumer/i);
});

it.each([Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER])('rejects malformed consumer range end %s before iteration', end => {
  const drawing = merged(), route = drawing.routes.find(r => r.to.kind === 'junction')!;
  const consumers = { entries: [{ parent: 'a', child: 'abc' }], start: 0, end };
  expect(() => importRoutingPlan({ ...drawing, routes: drawing.routes.map(r => r === route ? { ...r, consumers } : r) })).toThrow(/consumer/i);
});

it('charges projection and convergence work before it can exceed a caller budget', () => {
  const drawing = merged(), reasons = new Set<string>();
  importRoutingPlan(drawing, (_work, reason) => { if (reason) reasons.add(reason); });
  expect(reasons.has('consumer projection')).toBe(true);
  expect(reasons.has('convergence suffix')).toBe(true);
  expect(() => importRoutingPlan(drawing, (_work, reason) => { if (reason === 'consumer projection') throw new Error('spent projection budget'); })).toThrow('spent projection budget');
});

it('rejects malformed native arity and nonfinite convergence geometry before root isolation', () => {
  expect(() => convergenceInput([Array(100000).fill({ x: 0, y: 0 })] as never, { x: 0, y: 0 })).toThrow(/primitive/i);
  expect(() => convergenceInput([[{ x: 0, y: 0 }, { x: Infinity, y: 0 }]], { x: 0, y: 0 })).toThrow(/finite/i);
  expect(() => convergenceInput([[{ x: 0, y: 0 }, { x: 0, y: 0 }]], { x: NaN, y: 0 })).toThrow(/finite/i);
});

it('rejects coincident approaches instead of inventing independent chart coordinates', () => {
  const drawing=translatedJoin();
  const routes=drawing.routes.map(route=>route.id==='p-join' ? {...route,path:route.path.replaceAll('474.29999999999995','471.3')} : route);
  expect(()=>importRoutingPlan({...drawing,routes})).toThrow(/independent approach/i);
});

it('rejects mutated chart origins, native control points and split metadata', () => {
  const plan=importRoutingPlan(translatedJoin()),meeting=plan.meetings![0],chart=meeting.chart!;
  for(const change of [
    {...chart,offsets:[{x:1e20,y:0}]},
    {...chart,offsets:Array(3).fill({x:0,y:0})},
    {...chart,offsets:Array(1)},
    {...chart,inputs:chart.inputs.slice(1)},
    {...chart,inputs:chart.inputs.map((input,i)=>i ? input : {...input,path:'unrelated'})},
    {...chart,inputs:chart.inputs.map((input,i)=>i ? input : {...input,native:input.native.slice(1)})},
    {...chart,inputs:chart.inputs.map((input,i)=>i ? input : {...input,entry:{...input.entry,parameter:0.25}})},
  ]) expect(()=>validateRoutingPlan({...plan,meetings:[{...meeting,chart:change}]})).toThrow(/chart/i);
});

it('rejects missing native runs, points and suffixes in imported certificates', () => {
  const plan=importRoutingPlan(translatedJoin());
  for(const remove of [
    (p:typeof plan)=>delete (p.meetings![0].chart!.inputs[0].native as unknown[])[0],
    (p:typeof plan)=>delete (p.meetings![0].chart!.inputs[0].native[0] as unknown[])[0],
    (p:typeof plan)=>delete (p.meetings![0].chart!.inputs[0].entry.suffix as unknown[])[0],
    (p:typeof plan)=>delete (p.meetings![0].inputs[0].entry.suffix as unknown[])[0],
    (p:typeof plan)=>delete (p.meetings![0].inputs[0].entry.suffix[0] as unknown[])[0],
    (p:typeof plan)=>delete (p.meetings![0].inputs[0].parents as unknown[])[0],
  ]) {
    const broken=structuredClone(plan);remove(broken);
    expect(()=>validateRoutingPlan(broken)).toThrow();
  }
});

it('imports a gate-certified convergence at a large binary64 boundary with exact local paint bindings', () => {
  const a=1048571.6200000001,b=1048574.62,x=1048576.12,shift=a-251.58;
  const nodes=new Map([['p',{key:'p',x:170+shift,y:0,width:60,height:30,row:0,band:0}],
    ['q',{key:'q',x:270+shift,y:0,width:60,height:30,row:0,band:0}],
    ['out',{key:'out',x:x-30,y:140,width:60,height:30,row:1,band:1}]]);
  const routes=[
    {id:'p-j',from:{kind:'node' as const,id:'p'},to:{kind:'junction' as const,id:'j'},
      path:`M${200+shift} 30 L${200+shift} 70 L${a} 70 L${a} 94 C${a} 97 ${x} 97 ${x} 100`,consumers:[{parent:'p',child:'out'}],terminal:false},
    {id:'q-j',from:{kind:'node' as const,id:'q'},to:{kind:'junction' as const,id:'j'},
      path:`M${300+shift} 30 L${300+shift} 70 L${b} 70 L${b} 94 C${b} 97 ${x} 97 ${x} 100`,consumers:[{parent:'q',child:'out'}],terminal:false},
    {id:'j-out',from:{kind:'junction' as const,id:'j'},to:{kind:'node' as const,id:'out'},path:`M${x} 100 L${x} 132`,
      consumers:[{parent:'p',child:'out'},{parent:'q',child:'out'}],terminal:true},
  ];
  const drawing:GraphLayout={nodes,junctions:new Map([['j',{id:'j',parents:['p','q'],x,y:100}]]),routes,
    width:350+shift,height:170,rows:[],orientation:'down',readingOrder:new Map(),bandBounds:{left:0,width:350+shift,top:64}};
  const items=[{key:'p',parents:[],width:60,height:30,order:0},{key:'q',parents:[],width:60,height:30,order:1},
    {key:'out',parents:['p','q'],width:60,height:30,order:2}];
  const attached=attachPackedBand(drawing,'p',30,{x:0,coverX:200+shift,coverHeight:30,width:drawing.width,left:0,right:drawing.width,track:12,stemRoom:34});
  for(const current of [drawing,attached]) {
    expect(geometryGate(current,items,'p',drawing.width)).toBeNull();
    const before=structuredClone(current),plan=importRoutingPlan(current);
    expect(plan.meetings![0].chart?.kind).toBe('numerical-chart');
    expect(plan.paths.map(path=>path.route)).toEqual(current.routes);
    expect(()=>validateRoutingPlan(structuredClone(plan))).not.toThrow();
    expect(current).toEqual(before);
  }
});

it('imports sequential certified attachments whose low-coordinate residue requires a reversible chart chain', () => {
  const drawing=translatedJoin();
  let current:GraphLayout={...drawing,orientation:'down',width:4194304,height:170,rows:[],readingOrder:new Map(),bandBounds:{left:0,width:640,top:64},
    nodes:new Map([...drawing.nodes,['out',{key:'out',x:441.3,y:140,width:60,height:30,row:1,band:1}]]),
    routes:[...drawing.routes,{id:'j-out',from:{kind:'junction',id:'join'},to:{kind:'node',id:'out'},path:'M471.3 100 L471.3 132',terminal:true,
      consumers:[{parent:'p',child:'out'},{parent:'q',child:'out'}]}]};
  const items=[{key:'p',parents:[],width:60,height:30,order:0},{key:'q',parents:[],width:60,height:30,order:1},
    {key:'out',parents:['p','q'],width:60,height:30,order:2}];
  for(const target of [1048574.38,4097.62]) {
    const delta=target-current.junctions.get('join')!.x,root=current.nodes.get('p')!;
    current=attachPackedBand(current,'p',current.bandBounds!.top-34,{x:current.bandBounds!.left+delta,
      coverX:root.x+root.width/2+delta,coverHeight:30,width:4194304,left:0,right:4194304,track:12,stemRoom:34});
    expect(geometryGate(current,items,'p',4194304)).toBeNull();
    const before=structuredClone(current),plan=importRoutingPlan(current);
    expect(plan.paths.map(path=>path.route)).toEqual(current.routes);
    expect(()=>validateRoutingPlan(structuredClone(plan))).not.toThrow();
    expect(current).toEqual(before);
  }
});
