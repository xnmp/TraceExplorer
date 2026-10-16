/** Full production engine timings include validation, packing and display-memory encoding. */
import { corpus, focusExpanded } from './corpus';
import { projectDag, projectReferenceBadges } from '../src/lib/domain/trace-graph/projection';
import { createDefaultEngine, createBoundedCache, estimateLayoutBytes, uncachedBandRequests, type FolderLayoutInput } from '../src/lib/domain/trace-graph/folder-layout';
import { layoutWorkload, withinInlineBudget } from '../src/lib/domain/trace-graph/layout-workload';
import { tileMetrics } from '../src/lib/domain/trace-graph/metrics';
import type { GraphLayout } from '../src/lib/domain/trace-graph/layout';

export function timeInlineFolders() {
  const engine=createDefaultEngine({bandCache:null}),empty=createBoundedCache<GraphLayout>(estimateLayoutBytes);
  const rows: {case:string; p95:number; visible:number; states:number}[]=[];
  for (const fixture of corpus().filter(c=>c.nodes.length<=40 && c.nodes.length>1)) {
    const graph=projectReferenceBadges(projectDag(fixture.nodes)),members=graph.dag.order,cover=members[0],tile=tileMetrics(96);
    const input=(focus:string|null,previous:FolderLayoutInput['previous']):FolderLayoutInput=>({folderKey:fixture.id,
      items:[{id:cover,kind:'stack'}],open:new Map([[cover,{id:cover,graph,members,anchor:focus,expanded:focusExpanded(graph,members,cover,focus)}]]),
      width:454,tile,grid:{cellWidth:tile.width,cellHeight:0,gap:8},previous});
    const initial=input(null,null),before=engine(initial);
    const visible=before.graphs.get(cover)!.plan.request.items;
    const focus=visible.filter(n=>n.key!==cover && fixture.nodes.some(c=>c.parents.includes(n.key)))
      .sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key))[0]?.key;
    const requests:[string,FolderLayoutInput][]=[['open',initial]];
    if (focus) {
      const click=input(focus,before),after=engine(click);
      requests.push(['click',click],['revisit',input(null,after)]);
    }
    for (const [kind,request] of requests) {
      const work=uncachedBandRequests(request,empty).map(layoutWorkload).reduce((a,b)=>({tiles:a.tiles+b.tiles,edges:a.edges+b.edges,pathBytes:a.pathBytes+b.pathBytes}),{tiles:0,edges:0,pathBytes:0});
      if (!withinInlineBudget(work)) continue;
      for(let i=0;i<12;i++) engine(request);
      const times=Array.from({length:100},()=>{const start=performance.now();engine(request);return performance.now()-start;}).sort((a,b)=>a-b);
      rows.push({case:`${fixture.id} / ${kind}`,p95:times[94],visible:visible.length,states:request.previous?.displays?.entries.length??0});
    }
  }
  return rows;
}
