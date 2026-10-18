import { expect, test } from 'vitest';
import { chargedNativeClearance } from '$lib/domain/trace-graph/native-route-clearance';
import { captureFramedIncrementalRouting } from '$lib/domain/trace-graph/incremental-routing';
import { retainedHardObstacles } from '$lib/domain/trace-graph/retained-hard-obstacles';
import { berthsOf } from '$lib/domain/trace-graph/route-contacts';
import { constrainedIncremental, automaticIncrementalBudget, AUTOMATIC_ROUTING_WORK } from '$lib/domain/trace-graph/band-incremental';

const route=(id:string,path:string,terminal=false)=>({id,path,terminal,from:{kind:'node' as const,id:id+'-from'},to:{kind:'node' as const,id:id+'-to'},consumers:[{parent:id+'-from',child:id+'-to'}]});
const drawing=(routes:any[])=>({orientation:'down' as const,width:220,height:240,nodes:new Map(),junctions:new Map(),routes,rows:[],readingOrder:new Map()});
const finite=()=>{let used=0;return(n:number)=>{if(!Number.isSafeInteger(n)||n<0||n>16_000_000-used)throw Error('review allowance');used+=n;};};
const fixture=()=>{
  const a={key:'a',x:-0,y:0,width:40,height:40,row:0,band:0},b={key:'b',x:160,y:200,width:40,height:40,row:0,band:0};
  const old={...route('ab','M20 40 L20 46 L20 46 C20 50 24 54 28 54 L180 54 L180 192',true),from:{kind:'node' as const,id:'a'},to:{kind:'node' as const,id:'b'},consumers:[{parent:'a',child:'b'}]};
  const previous={...drawing([old]),nodes:new Map([['a',a],['b',b]])};
  const items=[{key:'a',width:40,height:40,order:0,parents:[]},{key:'b',width:40,height:40,order:1,parents:['a']}];
  const request={items,maxWidth:220,tileWidth:40,orientation:'down' as const,band:{key:'a',items}};
  const seed=captureFramedIncrementalRouting(request,previous,previous,[],finite());
  if(!('problem' in seed)||!seed.fragments)throw Error(JSON.stringify(seed));
  return {request,previous,fragments:seed.fragments};
};

test('endpoint masking is per actual route object and cannot pollute later default admission',()=>{
  const old=route('old','M20 70 C20 75 25 80 30 80'),fresh=route('fresh','M31 50 L31 110');
  const layout=drawing([old,fresh]),map=new Map([[old,{start:false,end:false}]]);
  expect(chargedNativeClearance(layout,finite(),{endpointMasks:map})).toBeNull();
  expect(chargedNativeClearance(layout,finite())).toBe('route-contact');
  expect(chargedNativeClearance(drawing([{...old},fresh]),finite(),{endpointMasks:map})).toBe('route-contact');
  map.set(old,{start:true,end:true});
  expect(chargedNativeClearance(layout,finite(),{endpointMasks:map})).toBe('route-contact');
});

test('masks preserve foreign parallel-lane and native-curve tangent rejection',()=>{
  for(const [a,b] of [
    ['M20 40 L20 140','M21 40 L21 140'],
    ['M20 40 C20 70 20 110 20 140','M21 40 C21 70 21 110 21 140'],
  ]) {
    const old=route('old',a),fresh=route('fresh',b);
    expect(chargedNativeClearance(drawing([old,fresh]),finite(),{endpointMasks:new Map([[old,{start:false,end:false}],[fresh,{start:false,end:false}]])})).toBe('route-contact');
  }
});

test('malformed paths and zero terminal shafts remain rejected under masks',()=>{
  for(const path of ['MNaN 10 L20 20','M0 0 LInfinity 2','M0 0 L0 0','M0 0 C0 0 1 1 0 0','M0 0 Z','']) {
    const old=route('old',path,true);
    expect(chargedNativeClearance(drawing([old]),finite(),{endpointMasks:new Map([[old,{start:false,end:false}]])})).not.toBeNull();
  }
});

test('arrow corner and tip protection survives suppressed artificial shaft start',()=>{
  const old=route('old','M100 100 L100 108',true);
  const map=new Map([[old,{start:false,end:true}]]);
  for(const path of ['M90 108 L110 108','M90 114 L110 114'])
    expect(chargedNativeClearance(drawing([old,route('fresh',path)]),finite(),{endpointMasks:map})).toBe('route-contact');
  const berths=berthsOf([[{x:100,y:100},{x:100,y:108}]],{start:3,end:6,arrow:true},{start:false,end:true});
  expect(berths).toContainEqual({x:100,y:108,radius:3});
  expect(berths).toContainEqual({x:100,y:116,radius:6});
  expect(berths.some(p=>p.y===100)).toBe(false);
});

test('hard construction view retains actual semantic source/target ports independently of masks',()=>{
  const {fragments}=fixture(),hard=retainedHardObstacles(fragments,finite());
  if(!hard.ok)throw Error(JSON.stringify(hard));
  expect(hard.ports.get('ab')).toContainEqual({x:20,y:40,radius:6});
  expect(hard.ports.get('ab')).toContainEqual({x:180,y:200,radius:6});
  expect(hard.routes.get('ab')!.some(p=>p.path.includes('C20 50 24 54 28 54'))).toBe(true);
});

test('constructor hard view ignores extra source metadata and preserves captured bytes and signed zeros',()=>{
  const {fragments}=fixture();
  const before=structuredClone(fragments),source=fragments.source.plan.paths[0].route!;
  Object.defineProperty(source,'extra',{enumerable:true,get(){throw Error('unrelated metadata read');}});
  expect(retainedHardObstacles(fragments,finite()).ok).toBe(true);
  expect(fragments.fragments).toEqual(before.fragments);
  expect(fragments.intervals).toEqual(before.intervals);
  expect(fragments.pins).toEqual(before.pins);
  expect([...before.pins.values()].some(value=>Object.is(value,-0))).toBe(true);
  for(const [id,value] of before.pins)expect(Object.is(fragments.pins.get(id),value)).toBe(true);
});

test('new helper and options preserve charge and accessor exception identity',()=>{
  const sentinel={sentinel:true}, {fragments}=fixture();
  try { retainedHardObstacles(fragments,()=>{throw sentinel;});throw Error('did not throw'); } catch(error){expect(error).toBe(sentinel);}
  const old=route('old','M20 70 C20 75 25 80 30 80');
  try { chargedNativeClearance(drawing([old]),()=>{throw sentinel;},{endpointMasks:new Map()});throw Error('did not throw'); } catch(error){expect(error).toBe(sentinel);}
  try { chargedNativeClearance(drawing([old]),finite(),{endpointMasks:{get(){throw sentinel;}} as any});throw Error('did not throw'); } catch(error){expect(error).toBe(sentinel);}
});

test('long source identities are charged before native identity serialization',()=>{
  let previous=0;
  for(const size of [1,1_000,10_000]) {
    const old=route('x'.repeat(size),'M20 40 L20 140');let work=0;
    expect(chargedNativeClearance(drawing([old]),n=>{work+=n;})).toBeNull();
    expect(work).toBeGreaterThan(previous);previous=work;
  }
});

test('invalid and zero whole-constructor allowances do not execute uncharged attempts',()=>{
  const {request,previous}=fixture();
  for(const allowance of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
    const budget=automaticIncrementalBudget(),before=structuredClone({request,previous,budget});
    const result=constrainedIncremental(request as any,previous,budget,undefined,allowance,source=>({preferred:source,frames:[]}));
    expect(result.ok).toBe(false);
    expect(result.work).toBe(0);
    expect({request,previous,budget}).toEqual(before);
  }
  expect(AUTOMATIC_ROUTING_WORK).toBe(1_024_000_000);
  expect(automaticIncrementalBudget()).toEqual({fallback:6_400_000,second:6_400_000,probes:64_000});
});
