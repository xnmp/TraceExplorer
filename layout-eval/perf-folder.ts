/** Full production engine timings include validation, packing and display-memory encoding. */
import { corpus, focusExpanded } from './corpus';
import { projectDag, projectReferenceBadges } from '../src/lib/domain/trace-graph/projection';
import { createDefaultEngine, type FolderLayoutInput } from '../src/lib/domain/trace-graph/folder-layout';
import { createFolderLayoutRuntime } from '../src/lib/plugins/trace/view/folder-layout-runtime';
import { tileMetrics } from '../src/lib/domain/trace-graph/metrics';

export function timeInlineFolders() {
  const rows: {case:string; p95:number; visible:number; states:number}[]=[];
  for (const fixture of corpus().filter(c=>c.nodes.length<=40 && c.nodes.length>1)) {
    const runtime=createFolderLayoutRuntime();
    // Admission follows production cache state. Samples still pay construction on
    // open/click; warmup must not erase the work that made those requests inline.
    const engine=createDefaultEngine({bandCache:null});
    const graph=projectReferenceBadges(projectDag(fixture.nodes)),members=graph.dag.order,cover=members[0],tile=tileMetrics(96);
    const input=(focus:string|null,previous:FolderLayoutInput['previous']):FolderLayoutInput=>({folderKey:fixture.id,
      items:[{id:cover,kind:'stack'}],open:new Map([[cover,{id:cover,graph,members,anchor:focus,expanded:focusExpanded(graph,members,cover,focus)}]]),
      width:454,tile,grid:{cellWidth:tile.width,cellHeight:0,gap:8},previous});
    const initial=input(null,null),openingInline=runtime.inline(initial),before=runtime.engine(initial);
    const visible=before.graphs.get(cover)!.plan.request.items;
    const focus=visible.filter(n=>n.key!==cover && fixture.nodes.some(c=>c.parents.includes(n.key)))
      .sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key))[0]?.key;
    const requests:[string,FolderLayoutInput,boolean][]=[['open',initial,openingInline]];
    if (focus) {
      const click=input(focus,before),clickInline=runtime.inline(click),after=runtime.engine(click);
      const revisit=input(null,after);
      requests.push(['click',click,clickInline],['revisit',revisit,runtime.inline(revisit)]);
    }
    for (const [kind,request,inline] of requests) {
      if (!inline) continue;
      for(let i=0;i<12;i++) engine(request);
      const times=Array.from({length:100},()=>{const start=performance.now();engine(request);return performance.now()-start;}).sort((a,b)=>a-b);
      rows.push({case:`${fixture.id} / ${kind}`,p95:times[94],visible:visible.length,states:request.previous?.displays?.entries.length??0});
    }
  }
  return rows;
}
