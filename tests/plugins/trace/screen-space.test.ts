import { afterEach, expect, it, vi } from 'vitest';
import { heldScreenMovement } from '../../../layout-eval/screen-space';
import { holdAnchor } from '$lib/plugins/trace/view/motion';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';
afterEach(()=>vi.unstubAllGlobals());
const drawing=(x:number,y:number,width:number,height:number):GraphLayout=>({orientation:'down',width,height,
  nodes:new Map([['anchor',{key:'anchor',x,y,width:40,height:40,row:0,band:0}]]),routes:[],junctions:new Map(),rows:[],readingOrder:new Map()});
it.each([
  [20,100,60,140,200,300,200,400], // No overflow: neither shift can be compensated.
  [20,300,20,500,200,900,200,1100], // Vertical range is available.
  [20,300,20,20,200,900,200,300], // Collapse clamps at the top.
  [20,700,20,800,200,900,200,840], // Requested offset exceeds the new bottom.
  [250,300,420,500,700,900,500,1100], // Horizontal range shrinks.
])('matches the actual hold at clamped screen bounds (%s,%s → %s,%s)',(x,y,nx,ny,w,h,nw,nh)=>{
  const width=200,height=400,before=drawing(x,y,w,h),after=drawing(nx,ny,nw,nh);
  const clamp=(n:number,max:number)=>Math.max(0,Math.min(Math.max(0,max),n));
  let left=clamp(x-width/2,w-width),top=clamp(y-height/2,h-height),current=before;
  vi.stubGlobal('getComputedStyle',()=>({width:'200px',boxSizing:'border-box'}));
  const horizontal=Object.assign(new EventTarget(),{clientWidth:width});
  Object.defineProperties(horizontal,{scrollWidth:{get:()=>current.width},scrollLeft:{get:()=>left,set:(n:number)=>{left=clamp(n,current.width-width);}}});
  const surface=Object.assign(new EventTarget(),{clientWidth:width,clientHeight:height,scrollLeft:0,contains:()=>true,getBoundingClientRect:()=>({width,left:0,top:0})});
  Object.defineProperties(surface,{scrollHeight:{get:()=>current.height},scrollTop:{get:()=>top,set:(n:number)=>{top=clamp(n,current.height-height);}}});
  const element={closest:()=>horizontal,getBoundingClientRect:()=>{const n=current.nodes.get('anchor')!;return {left:n.x-left,top:n.y-top};}};
  const captured=element.getBoundingClientRect();
  const hold=holdAnchor(surface as unknown as HTMLElement,element as unknown as HTMLElement,{frames:()=>()=>{}});
  current=after;top=clamp(top,nh-height);left=clamp(left,nw-width);hold.update();
  const actual=element.getBoundingClientRect(),measured=heldScreenMovement(before,after,'anchor','root',width,height);
  expect(measured.anchor).toBeCloseTo(Math.hypot(actual.left-captured.left,actual.top-captured.top),8);
  expect(measured.displacement).toBeCloseTo(measured.anchor,8);
  hold.release();
});
