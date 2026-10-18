/** Numerical coordinates for one native convergence suffix. This is an explicit
 * encoding, not attachment history: every entry, control point and dot must
 * round-trip through one common bounded sequence of reversible operations. Full authored paths and their
 * painted ports remain pinned separately; no prefix is moved into this chart. */
import type { NativeInk } from './routing-plan';
import type { Point } from './path-sampling';
import type { ConvergenceInput } from './routing-convergence';
import { LANE_SEPARATION } from './metrics';
import { inReach } from './coordinate-space';

type Charge = (work:number,reason?:string)=>void;
interface NativeInput { readonly path:string; readonly entry:ConvergenceInput }
export interface ConvergenceChart {
  readonly kind:'numerical-chart';
  readonly offsets:readonly Point[];
  readonly dot:Point;
  readonly inputs:readonly {
    readonly path:string;
    /** Exact encoding of the already validated native convergence suffix. */
    readonly native:readonly NativeInk[];
    readonly entry:ConvergenceInput;
  }[];
}
const same=(a:Point,b:Point)=>a.x===b.x && a.y===b.y;
const separated=(a:number,b:number)=>{
  const aa=Math.round(a*100),bb=Math.round(b*100);
  return aa/100===a && bb/100===b ? Math.abs(aa-bb)>=LANE_SEPARATION*100
    : a+LANE_SEPARATION<=b || b+LANE_SEPARATION<=a;
};
export const independentConvergence=(entries:readonly ConvergenceInput[],charge:Charge):boolean=>entries.every((entry,i)=>{
  const axis=entry.side==='top' || entry.side==='bottom' ? 'x' : 'y';
  charge(entries.length-i-1,'junction approach independence');
  return entries.slice(i+1).every(other=>other.side!==entry.side || separated(entry.point[axis],other.point[axis]));
});
/** Binary64 precision changes at powers of two. In addition to nearby origins,
 * place the local dot on either side of each binade boundary in the existing
 * coordinate reach. The half-pixel lattice is finite and deterministic; it is
 * a coordinate representation choice, never a physical route displacement. */
function originsAt(value:number,charge:Charge):readonly number[] {
  const near=[0,...Array.from({length:128},(_,i)=>(i+1)/2).flatMap(n=>[n,-n]),
    ...Array.from({length:15},(_,i)=>2**(i+7)).flatMap(n=>[n,-n])];
  charge(22*2*257,'numerical chart domain');
  const boundaries=Array.from({length:22},(_,i)=>2**i).flatMap(n=>[n,-n]).flatMap(boundary=>
    Array.from({length:257},(_,i)=>boundary-Math.trunc(value)+(i-128)/2));
  return [...new Set([...near,...boundaries].filter(inReach))];
}
function encoded(inputs:readonly NativeInput[],dot:Point,offsets:readonly Point[],charge:Charge):ConvergenceChart|undefined {
  const encode=(point:Point):Point|undefined=>{
    charge(offsets.length,'numerical chart point binding');
    let current=point;
    if(!inReach(current.x) || !inReach(current.y))return undefined;
    for(const offset of offsets) {
      const next={x:current.x+offset.x,y:current.y+offset.y};
      if(!inReach(next.x) || !inReach(next.y) || next.x-offset.x!==current.x || next.y-offset.y!==current.y)return undefined;
      current=next;
    }
    return current;
  };
  const chartDot=encode(dot);if(!chartDot)return undefined;
  const result:ConvergenceChart['inputs'][number][]=[];
  for(const input of inputs) {
    charge(input.entry.suffix.length+1,'numerical chart native binding');
    const native:NativeInk[]=[];
    for(const run of input.entry.suffix) {
      charge(run.length,'numerical chart primitive binding');
      const points=run.map(encode);
      if(points.some(p=>!p))return undefined;
      native.push(points as unknown as NativeInk);
    }
    const point=encode(input.entry.point);if(!point)return undefined;
    // Primitive/parameter/face were derived from the complete pinned raw path.
    // A suffix alone cannot re-derive its face from an arbitrary curve tangent.
    const entry={...input.entry,point,suffix:native};
    result.push({path:input.path,native,entry});
  }
  return {kind:'numerical-chart',offsets,dot:chartDot,inputs:result};
}
/** Adjacent binary64 origins expose exact boundary residuals without a slack.
 * The following inverse check, not proximity, decides whether a chart exists. */
function adjacent(value:number,direction:1|-1):number {
  if(value===0)return direction*Number.MIN_VALUE;
  const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,value);
  bytes.setBigUint64(0,bytes.getBigUint64(0)+(Math.sign(value)===direction?1n:-1n));
  return bytes.getFloat64(0);
}
export function convergenceChart(inputs:readonly NativeInput[],dot:Point,charge:Charge):ConvergenceChart|undefined {
  const coordinate=(axis:'x'|'y'):readonly [number,number]|undefined=>{
    const relevant=(entry:ConvergenceInput)=>(entry.side==='top' || entry.side==='bottom')===(axis==='x');
    if(independentConvergence(inputs.map(input=>input.entry).filter(relevant),charge))return [0,0];
    charge(inputs.length+1,'numerical chart recentering domain');
    const references=[dot[axis],...inputs.map(input=>input.entry.point[axis])];
    const recenterings=[...new Set([0,...references.flatMap(value=>[Math.round(value*2)/2-value,Math.round(value)-value])])];
    for(const recenter of recenterings) {
      const first={x:axis==='x'?recenter:0,y:axis==='y'?recenter:0};
      const centered=encoded(inputs,dot,[first],charge);if(!centered)continue;
      for(const origin of originsAt(centered.dot[axis],charge)) for(const value of [origin,adjacent(origin,-1),adjacent(origin,1)]) {
        charge(1,'numerical chart alternative');
        if(!inReach(value))continue;
        const second={x:axis==='x'?value:0,y:axis==='y'?value:0};
        const chart=encoded(inputs,dot,[first,second],charge);
        if(chart && independentConvergence(chart.inputs.map(input=>input.entry).filter(relevant),charge))return [recenter,value];
      }
    }
    return undefined;
  };
  const x=coordinate('x');if(!x)return undefined;
  const y=coordinate('y');if(!y)return undefined;
  const offsets=[{x:x[0],y:y[0]},{x:x[1],y:y[1]}].filter(offset=>offset.x!==0 || offset.y!==0);
  return encoded(inputs,dot,offsets,charge);
}
export function validateConvergenceChart(chart:ConvergenceChart,inputs:readonly NativeInput[],dot:Point,charge:Charge):readonly ConvergenceInput[] {
  charge(1,'numerical chart origin validation');
  if(chart.kind!=='numerical-chart' || !Array.isArray(chart.offsets) || !chart.offsets.length || chart.offsets.length>2)
    throw new RangeError('Invalid numerical chart operations');
  charge(chart.offsets.length,'numerical chart operation validation');
  if(Array.from(chart.offsets).some(offset=>!offset || !inReach(offset.x) || !inReach(offset.y)))
    throw new RangeError('Invalid numerical chart origin');
  const expected=encoded(inputs,dot,chart.offsets,charge);
  if(!expected || !chart.dot || !same(expected.dot,chart.dot) || !Array.isArray(chart.inputs) || chart.inputs.length!==expected.inputs.length)
    throw new RangeError('Invalid numerical chart native binding');
  charge(expected.inputs.reduce((sum,input)=>sum+5*input.native.length+5*input.entry.suffix.length+1,0),'numerical chart certificate');
  for(let i=0;i<expected.inputs.length;i++) {
    const a=chart.inputs[i],b=expected.inputs[i];
    if(!a || a.path!==b.path || !Array.isArray(a.native) || !a.entry || !Array.isArray(a.entry.suffix))throw new RangeError('Invalid numerical chart input');
    const equalInk=(x:readonly NativeInk[],y:readonly NativeInk[])=>x.length===y.length && Array.from(x).every((run,j)=>Array.isArray(run)
      && run.length===y[j].length && Array.from(run).every((p,k)=>p && same(p,y[j][k])));
    if(!equalInk(a.native,b.native) || a.entry.primitive!==b.entry.primitive || a.entry.parameter!==b.entry.parameter
      || a.entry.side!==b.entry.side || !a.entry.point || !same(a.entry.point,b.entry.point) || !equalInk(a.entry.suffix,b.entry.suffix))
      throw new RangeError('Numerical chart changed native ink');
  }
  return expected.inputs.map(input=>input.entry);
}
