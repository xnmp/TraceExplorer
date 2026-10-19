import { expect, test } from 'vitest';
import { chargedNativeClearance } from '$lib/domain/trace-graph/native-route-clearance';
import { captureFramedIncrementalRouting } from '$lib/domain/trace-graph/incremental-routing';
import { retainedHardObstacles } from '$lib/domain/trace-graph/retained-hard-obstacles';
import { berthsOf } from '$lib/domain/trace-graph/route-contacts';

const route=(id:string,path:string,terminal=false)=>({id,path,terminal,from:{kind:'node' as const,id:id+'-from'},to:{kind:'node' as const,id:id+'-to'},consumers:[{parent:id+'-from',child:id+'-to'}]});
const drawing=(routes:any[])=>({orientation:'down' as const,width:220,height:240,nodes:new Map(),junctions:new Map(),routes,rows:[],readingOrder:new Map()});
const allowance=()=>{let work=0;return(n:number)=>{work+=n;if(work>16_000_000)throw Error('finite contract allowance');};};

test('artificial C cut endpoints admit the same transverse crossing as the complete original',()=>{
  const old=route('old','M20 40 L20 70 C20 75 25 80 30 80 L100 80 L100 150 L180 150 L180 192');
  const cut={...old,path:'M20 70 C20 75 25 80 30 80'},fresh=route('fresh','M31 50 L31 110');
  expect(chargedNativeClearance(drawing([old,fresh]),allowance())).toBeNull();
  expect(chargedNativeClearance(drawing([cut,fresh]),allowance())).toBe('route-contact');
  expect(chargedNativeClearance(drawing([cut,fresh]),allowance(),{endpointMasks:new Map([[cut,{start:false,end:false}]])})).toBeNull();
  // The default helper used by final gates still rejects a real endpoint.
  expect(chargedNativeClearance(drawing([cut,fresh]),allowance())).toBe('route-contact');
});

test('the partial source-six cut has no invented berth at its open end',()=>{
  const old=route('old','M132 1729.5 L143 1729.5'),cut={...old,path:'M132 1729.5 L138 1729.5'};
  const fresh=route('fresh','M138 1720 L138 1740');
  expect(chargedNativeClearance(drawing([old,fresh]),allowance())).toBeNull();
  expect(chargedNativeClearance(drawing([cut,fresh]),allowance(),{endpointMasks:new Map([[cut,{start:true,end:false}]])})).toBeNull();
});

test('actual source ports remain protected while artificial endpoints are suppressed',()=>{
  const cut=route('old','M132 1729.5 L138 1729.5'),fresh=route('fresh','M133 1720 L133 1740');
  expect(chargedNativeClearance(drawing([cut,fresh]),allowance(),{endpointMasks:new Map([[cut,{start:true,end:false}]])})).toBe('route-contact');
});

test('immutable internal turns retain their berth in native and lane checks',()=>{
  const corner=route('old','M20 40 L20 60 L40 60'),fresh=route('fresh','M19 50 L19 70');
  expect(chargedNativeClearance(drawing([corner,fresh]),allowance(),{endpointMasks:new Map([[corner,{start:false,end:false}]])})).toBe('route-contact');
  expect(berthsOf([[{x:20,y:40},{x:20,y:60}],[{x:20,y:60},{x:40,y:60}]],{start:3,end:3},{start:false,end:false})).toContainEqual({x:20,y:60,radius:3});
});

test('protected contiguous native spans group before endpoint masks; zero aliases paint no separate route',()=>{
  const a={key:'a',x:0,y:0,width:40,height:40,row:0,band:0},b={key:'b',x:160,y:200,width:40,height:40,row:0,band:0};
  const old={...route('ab','M20 40 L20 46 L20 46 C20 50 24 54 28 54 L180 54 L180 192',true),from:{kind:'node' as const,id:'a'},to:{kind:'node' as const,id:'b'},consumers:[{parent:'a',child:'b'}]};
  const previous={...drawing([old]),nodes:new Map([['a',a],['b',b]])};
  const items=[{key:'a',width:40,height:40,order:0,parents:[]},{key:'b',width:40,height:40,order:1,parents:['a']}];
  const request={items,maxWidth:220,tileWidth:40,orientation:'down' as const,band:{key:'a',items}};
  const charge=allowance(),seed=captureFramedIncrementalRouting(request,previous,previous,[],charge);
  if(!('problem'in seed)||!seed.fragments)throw Error(JSON.stringify(seed));
  const before=structuredClone(seed.fragments),hard=retainedHardObstacles(seed.fragments,charge);if(!hard.ok)throw Error(JSON.stringify(hard));
  const pieces=hard.routes.get('ab')!;
  expect(pieces.some(p=>p.path.includes('L20 46 L20 46 C20 50 24 54 28 54'))).toBe(true);
  expect(pieces.some(p=>p.path==='M20 46L20 46 ')).toBe(false);
  expect(pieces.filter(p=>hard.endpointMasks.get(p)?.start)).toHaveLength(1);
  expect(pieces.filter(p=>hard.endpointMasks.get(p)?.end)).toHaveLength(1);
  expect(seed.fragments).toEqual(before);
});

test('the arrow base and actual target remain protected for a cut terminal shaft',()=>{
  const shaft=route('old','M100 100 L100 108',true),fresh=route('fresh','M90 114 L110 114');
  expect(chargedNativeClearance(drawing([shaft,fresh]),allowance(),{endpointMasks:new Map([[shaft,{start:false,end:true}]])})).toBe('route-contact');
});
