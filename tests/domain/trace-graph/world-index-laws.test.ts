import { expect,it } from 'vitest';
import {worldKey,worldIndex,worldGroups,worldGet,worldPositions,nextWorldPosition,sameWorldIdentities} from '../../../src/lib/domain/trace-graph/folder-layout/world-indexes';
import {routingCoordinate} from '../../../src/lib/domain/trace-graph/routing-problem';
import {captureRoutingFragments} from '../../../src/lib/domain/trace-graph/routing-fragments';
import {translatedRoutingDrawing} from '../../../src/lib/domain/trace-graph/routing-frame';
import {restoreWorldNativeLocal} from '../../../src/lib/domain/trace-graph/folder-layout/world-native-frame';
import {geometryGate} from '../../../src/lib/domain/trace-graph/geometry-gate';
const noCharge=()=>{};
it('preserves JSON address identity for escaped Unicode and exact semantic arrays',()=>{
 const scene='x"\\\n\u0000\ud800',address=['path','r"\\\u0001你好','native',10,1,'x']as const;let fee=0;
 const key=worldKey(['scene',scene,...address],n=>fee+=n);expect(key).toBe(routingCoordinate(scene,...address));expect(fee).toBeGreaterThanOrEqual(key.length);
 const values=['a,b','c"','\\d'];expect(sameWorldIdentities(values,[...values],noCharge)).toBe(true);expect(sameWorldIdentities(values,['a','b,c"','\\d'],noCharge)).toBe(false);
});
it('preserves first-match route aliases and ordered grouped membership',()=>{
 const values=[{id:'same',value:1},{id:'else',value:2},{id:'same',value:3}];expect(worldIndex(values,x=>x.id,noCharge,'first',true).get('same')).toBe(values[0]);expect(worldIndex(values,x=>x.id,noCharge,'last').get('same')).toBe(values[2]);expect(worldGroups(values,x=>x.id,noCharge,'group').get('same')).toEqual([values[0],values[2]]);
});
it('raw native position lookup exactly preserves the old forward duplicate-span search',()=>{
 const texts=['M0 0 ','L1 1 ','L1 1 ','C1 1 2 2 3 3 ','L1 1 ','L0 0 '],index=worldPositions(texts,noCharge);
 for(const text of ['L1 1 ','L0 0 ','absent'])for(let min=0;min<=texts.length+1;min++){
  const old=texts.findIndex((x,i)=>i>=min&&x===text),positions=index.get(text),actual=positions&&nextWorldPosition(positions,min,noCharge);expect(actual).toBe(old<0?undefined:old);
 }
});
it('propagates exact charge failures before lookup or key extraction',()=>{
 const marker={stop:'same object'};let reads=0;const index={get(){reads++;return 1;}}as unknown as ReadonlyMap<string,number>;
 try{worldGet(index,'long'.repeat(100),()=>{throw marker;});throw Error('no failure');}catch(e){expect(e).toBe(marker);}expect(reads).toBe(0);
 let extracted=0;try{worldIndex([{id:'r'}],x=>{extracted++;return x.id;},()=>{throw marker;},'deny');throw Error('no failure');}catch(e){expect(e).toBe(marker);}expect(extracted).toBe(0);
});
it('restores source-exact native C text with a nonempty charged frame table at nonzero origin',()=>{
 const nodes=new Map<string,any>([['a',{key:'a',x:20,y:10,width:20,height:10,row:0,band:0}],['b',{key:'b',x:50,y:60,width:20,height:10,row:1,band:0}]]),id='route"\\你好'.repeat(30),route={id,from:{kind:'node',id:'a'},to:{kind:'node',id:'b'},consumers:[{parent:'a',child:'b'}],path:'M30 20 L30 30 C30 32 32 34 34 34 L56 34 C58 34 60 36 60 38 L60 52',terminal:true};
 const local:any={nodes,junctions:new Map(),routes:[route],rows:[],readingOrder:new Map(),orientation:'down',width:100,height:100};
 const items=[{key:'a',width:20,height:10,order:0,parents:[]},{key:'b',width:20,height:10,order:1,parents:['a']}];expect(geometryGate(local,items,'a',100)).toBeNull();
 const world=translatedRoutingDrawing(local,{nodes:{x:[{operation:'add',operand:8}],y:[{operation:'add',operand:97}]},paths:{x:[{operation:'add',operand:8}],y:[{operation:'add',operand:97}]}}),frames=[{id:'exact0',input:routingCoordinate('before','tile','a','x'),output:routingCoordinate('derived','tile','a','x'),steps:[{operation:'add' as const,operand:0,result:28}]}];
 const capture=captureRoutingFragments({id:'before',space:'attached',drawing:world},{id:'derived',space:'attached',drawing:world},frames,noCharge);expect(capture.ok).toBe(true);if(!capture.ok)return;
 const source={drawing:local,origin:{x:0,y:97},nodes:new Map([['a','a'],['b','b']]),routes:new Map([[id,id]]),junctions:new Map<string,string>()},fees:Record<string,number>={};let spent=0;
 const out=restoreWorldNativeLocal({fragments:capture.retained,sources:[source]},'graph',local,{x:0,y:97},new Map([[id,world.routes[0]]]),world.nodes,new Map(),(n,why='')=>{if(n>64_000_000-spent)throw Error('bounded frame probe');spent+=n;fees[why]=(fees[why]??0)+n;});
 expect(out).toEqual(local);expect(out!.routes[0].path).toBe(route.path);expect(geometryGate(out!,items,'a',100)).toBeNull();expect(fees['local frame address serialization']).toBeGreaterThan(0);expect(fees['local native fragment selection']).toBeGreaterThan(0);expect(spent).toBeLessThan(64_000_000);
});
