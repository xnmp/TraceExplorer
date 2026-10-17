import type { GraphLayout } from '../src/lib/domain/trace-graph/layout';
const clamp=(n:number,max:number)=>Math.max(0,Math.min(Math.max(0,max),n));
/**
 * Settled holdAnchor semantics at zoom 1. The click is scrolled toward the viewport
 * centre before capture. Both axes clamp to actual content bounds; a pane-bound
 * graph has no horizontal compensation. No browser animation is simulated.
 */
export function heldScreenMovement(previous:GraphLayout,next:GraphLayout,key:string,cover:string,width:number,height:number) {
  const a=previous.nodes.get(key),b=next.nodes.get(key);
  if(!a||!b)return {anchor:0,displacement:0};
  const contentHeight=(l:GraphLayout)=>Math.max(l.height,...[...l.nodes.values()].map(n=>n.y+n.height));
  const oldTop=clamp(a.y-height/2,contentHeight(previous)-height);
  const oldLeft=clamp(a.x-width/2,previous.width-width);
  const newTop=clamp(oldTop+b.y-a.y,contentHeight(next)-height);
  const newLeft=clamp(oldLeft+b.x-a.x,next.width-width);
  const dx=newLeft-oldLeft,dy=newTop-oldTop;
  const distances=[...next.nodes].filter(([k])=>k!==cover&&previous.nodes.has(k)).map(([k,n])=>{
    const old=previous.nodes.get(k)!;return Math.hypot(n.x-old.x-dx,n.y-old.y-dy);
  });
  return {anchor:Math.hypot(b.x-a.x-dx,b.y-a.y-dy),displacement:distances.length?distances.reduce((a,b)=>a+b,0)/distances.length:0};
}
