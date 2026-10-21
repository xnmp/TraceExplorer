/** Construction obstacles from an already captured fragment authority. This is
 * only a geometric view: output routes keep their original IDs and free cores
 * are subsequently closed by the shared affected metric solver. */
import type { PlacedRoute } from './layout';
import type { ConstructionFragments } from './routing-fragments';
import type { IncrementalRoutingConflict } from './incremental-routing';
import { CORNER_BERTH, type Berth } from './route-contacts';
import { routingCoordinate } from './routing-problem';
import { PORT_BERTH } from './metrics';
import type { NativeEndpointMask } from './native-route-clearance';

type Point = { readonly x:number; readonly y:number };
interface Piece {
  readonly first:number;
  readonly last:number;
  readonly start:Point;
  readonly end:Point;
  readonly raw:string;
  readonly extent:boolean;
}
const samePoint=(a:Point,b:Point)=>a.x===b.x&&a.y===b.y;

export function retainedHardObstacles(retained: ConstructionFragments,
  charge: (work:number,reason?:string)=>void):
  { readonly ok:true; readonly routes:ReadonlyMap<string,readonly PlacedRoute[]>;
    readonly ports:ReadonlyMap<string,readonly Berth[]>;
    readonly endpointMasks:ReadonlyMap<PlacedRoute,NativeEndpointMask> }
  | { readonly ok:false; readonly conflict:IncrementalRoutingConflict } {
  const plan=retained.source.plan;
  charge(plan.paths.length+plan.ports.length+plan.stubs.length+retained.fragments.length+retained.intervals.length+1,
    'hard fragment view tables');
  const routes=new Map<string,PlacedRoute[]>(),ports=new Map<string,Berth[]>();
  const endpointMasks=new Map<PlacedRoute,NativeEndpointMask>();
  const pieces=new Map<string,Piece[]>();
  const originals=new Map<string,PlacedRoute>();
  for(const path of plan.paths) {
    charge(path.id.length+1,'hard fragment route identity');
    if(!path.route)return {ok:false,conflict:{reason:'unsupported-input',constraints:['hard fragment route identity',path.id]}};
    routes.set(path.id,[]);ports.set(path.id,[]);pieces.set(path.id,[]);originals.set(path.id,path.route);
  }
  const coordinate=(...address:readonly(string|number)[]):number|undefined=>{
    let bytes=retained.preferred.id.length+32;
    for(const value of address)bytes+=typeof value==='string'?value.length+4:24;
    charge(bytes,'hard fragment coordinate address');
    return retained.pins.get(routingCoordinate(retained.preferred.id,...address));
  };
  const point=(...address:readonly(string|number)[])=>{
    const x=coordinate(...address,'x'),y=coordinate(...address,'y');
    return typeof x==='number'&&Number.isFinite(x)&&typeof y==='number'&&Number.isFinite(y)?{x,y}:null;
  };
  const append=(id:string,build:()=>string,bytes:number,mask:NativeEndpointMask,terminal=false):boolean=>{
    charge(8*(id.length+bytes+32),'hard fragment native piece copy');
    const path=build();
    const route=originals.get(id),list=routes.get(id);if(!route||!list)return false;
    const part={id:JSON.stringify(['hard-fragment',id,list.length]),path,terminal,from:route.from,to:route.to,consumers:route.consumers};
    list.push(part);endpointMasks.set(part,mask);return true;
  };
  const failure=(id:string)=>({ok:false as const,conflict:{reason:'unsupported-input' as const,constraints:['hard fragment bound coordinate',id]}});
  for(const fragment of retained.fragments) {
    charge(fragment.native.length+fragment.raw.length+fragment.route.length+1,'hard fragment protected span');
    const start=fragment.native[0],end=fragment.native.at(-1)!;
    const list=pieces.get(fragment.route);if(!list)return failure(fragment.route);
    list.push({first:fragment.primitive,last:fragment.primitive,start,end,raw:fragment.raw,
      extent:fragment.native.some(p=>!samePoint(p,start))});
  }
  for(const interval of retained.intervals) {
    charge(8+interval.route.length,'hard fragment source interval');
    const list=pieces.get(interval.route);if(!list)return failure(interval.route);
    list.push({first:interval.primitive,last:interval.primitive,start:interval.start,end:interval.boundary,
      raw:` L${interval.boundary.x} ${interval.boundary.y}`,extent:!samePoint(interval.start,interval.boundary)});
  }
  for(const path of plan.paths) {
    charge(path.id.length+path.start.length+path.end.length+1,'hard fragment semantic ports');
    const actualPorts:Point[]=[];
    for(const [i,port] of [path.start,path.end].entries()) {
      const p=point('port',port,'point');if(!p)return failure(port);
      actualPorts.push(p);
      const owner=i?path.route!.to:path.route!.from;
      const node=retained.preferred.drawing.nodes.get(owner.id),dot=retained.preferred.drawing.junctions.get(owner.id);
      const onOutline=node&&p.x>=node.x-.01&&p.x<=node.x+node.width+.01&&p.y>=node.y-.01&&p.y<=node.y+node.height+.01
        &&Math.min(Math.abs(p.x-node.x),Math.abs(p.x-node.x-node.width),Math.abs(p.y-node.y),Math.abs(p.y-node.y-node.height))<.01;
      const radius=owner.kind==='junction'&&dot&&Math.hypot(dot.x-p.x,dot.y-p.y)<.01?0:i&&path.route!.terminal||onOutline?PORT_BERTH:CORNER_BERTH;
      if(radius)ports.get(path.id)!.push({...p,radius});
    }
    const list=pieces.get(path.id)!;
    charge(list.length*(1+Math.ceil(Math.log2(Math.max(1,list.length)))),'hard fragment span order');
    list.sort((a,b)=>a.first-b.first);
    const grouped:Piece[]=[];
    for(const piece of list) {
      const previous=grouped.at(-1);
      charge(piece.raw.length+(previous?.raw.length??0)+1,'hard contiguous span assembly');
      if(previous&&previous.last+1===piece.first&&samePoint(previous.end,piece.start))
        grouped[grouped.length-1]={...previous,last:piece.last,end:piece.end,raw:previous.raw+piece.raw,extent:previous.extent||piece.extent};
      else grouped.push(piece);
    }
    for(const piece of grouped) {
      // A protected zero-length alias remains captured, but paints no route.
      if(!piece.extent)continue;
      const mask={start:samePoint(piece.start,actualPorts[0]),end:samePoint(piece.end,actualPorts[1])};
      if(!append(path.id,()=>`M${piece.start.x} ${piece.start.y}`+piece.raw,piece.raw.length+128,mask))return failure(path.id);
    }
    if(path.stub) {
      charge(path.stub.length+1,'hard fragment arrow identity');
      const a=point('stub',path.stub,'shaft',0),b=point('stub',path.stub,'shaft',1);
      // The arrow helper extends b to the actual target port. Its shaft start
      // is an artificial cut; its true arrow base/corner is retained normally.
      if(!a||!b||!append(path.id,()=>`M${a.x} ${a.y} L${b.x} ${b.y}`,256,
        {start:samePoint(a,actualPorts[0]),end:true},true))return failure(path.stub);
    }
  }
  return {ok:true,routes,ports,endpointMasks};
}

export type HardRetainedObstacles=Extract<ReturnType<typeof retainedHardObstacles>,{readonly ok:true}>;
