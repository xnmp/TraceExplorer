/** Legal click tours: every selected node must already exist in the displayed visible set. */
delete process.env.OPENAI_API_KEY;
import { writeFile } from 'node:fs/promises';
import { layoutGraph, type GraphLayout } from './baseline/layout';
import { corpus, denseCorpus, requestFor } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { measure } from './geometry';
import { heldScreenMovement } from './screen-space';
import { attached } from './baseline/placement';
import { fallbackReason } from '../src/lib/domain/trace-graph/band-layout';
const rows=[],all=rows;
const dense=new Set(denseCorpus().map(c=>c.id));
for(const original of [...corpus(),...denseCorpus()])for(const width of [360,454,640,900,1400]){
  const c={...original,full:false},visited=new Set<string>();let focus:string|null=null,previousKeys='',baseline:GraphLayout|undefined,proposed:Optimized|undefined,placedB:GraphLayout|undefined;
  for(let step=0;step<9;step++){
    const req=requestFor(c,focus,width,96,baseline?.readingOrder),keys=req.items.map(n=>n.key).sort().join(','),changed=step>0&&keys!==previousKeys;
    if(focus!==null&&previousKeys&&!previousKeys.split(',').includes(focus))throw new Error(`unavailable click ${c.id}/${focus}`);
    baseline=layoutGraph(req);const next=optimizedBand({...req,hint:proposed?.layout.readingOrder},{previous:proposed,anchorKey:focus??undefined});
    const pb=attached(baseline,req),mb=measure(pb,req.band!.key,width,req.items,changed?placedB:undefined,focus??undefined),mp=measure(next.placed,req.band!.key,width,req.items,changed?proposed?.placed:undefined,focus??undefined);
    const screen = Object.fromEntries([480,800].map(height=>[height, changed && proposed && focus ? heldScreenMovement(proposed.placed,next.placed,focus,req.band!.key,width,height) : {anchor:0,displacement:mp.displacement}]));
    rows.push({screen,case:c.id,dense:dense.has(c.id),width,step,focus,visible:req.items.length,changed,decision:next.layout.decision,reason:fallbackReason(next.layout),baseline:mb,proposed:mp});placedB=pb;proposed=next;previousKeys=keys;
    const expandable=req.items.filter(n=>!visited.has(n.key)&&req.band!.items.some(child=>child.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));
    const selected=expandable[0];if(!selected){if(focus===null)break;focus=null;}else{focus=selected.key;visited.add(focus);}
  }
}
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
const summarise=(rows:typeof all)=>Object.fromEntries(['baseline','proposed'].map(engine=>{const ms=rows.map(r=>r[engine as 'baseline'|'proposed']),changed=rows.filter(r=>r.changed).map(r=>r[engine as 'baseline'|'proposed']);return [engine,{layouts:rows.length,transitions:changed.length,height:avg(ms.map(m=>m.height)),area:avg(ms.map(m=>m.area)),displacement:avg(changed.map(m=>m.displacement)),movedFraction:avg(changed.map(m=>m.movedFraction)),tileIntersections:ms.reduce((s,m)=>s+m.tileIntersections,0),overlaps:ms.reduce((s,m)=>s+m.overlaps,0),disconnectedEdges:ms.reduce((s,m)=>s+m.disconnectedEdges,0)}];}));
// The broad corpus's tours set the displacement and height targets; dense tours are reported beside them.
const summary=summarise(all.filter(r=>!r.dense)),denseSummary=summarise(all.filter(r=>r.dense));
await writeFile('layout-eval/out/reveals.json',JSON.stringify({tour:'up to eight clicks, highest creation-order visible expandable node not clicked yet; eventual deselection',widths:[360,454,640,900,1400],imagePx:96,summary,denseSummary,rows},null,2));console.log(JSON.stringify({summary,denseSummary},null,2));
