/** Identical serialized requests for an instrumented main archive and this checkout. */
import { corpus } from './corpus';
import { performanceWorkloads } from './perf-workloads';
import { layoutGraph } from '../src/lib/domain/trace-graph/layout';
import { profileLayout } from '../src/lib/domain/trace-graph/layout-profile';
import { writeFileSync } from 'node:fs';
const reference=process.argv.find(x=>x.startsWith('--main='))?.slice(7);
const main=reference?await import(`${reference}/src/lib/domain/trace-graph/layout.ts`):null;
const mainProfile=reference?await import(`${reference}/src/lib/domain/trace-graph/layout-profile.ts`):null;
const cases=['random-bushy-12-7321 / reveal','random-bushy-40-7601 / reveal','random-dag-100-8101 / reveal','random-dag-40-7503 / reveal','random-tree-100-8003 / reveal'];
const rows=[];
for(const workload of performanceWorkloads(corpus().filter(c=>cases.some(id=>id.startsWith(c.id+' /')))).filter(w=>cases.includes(w.case))) {
 const normalize=(layout:any)=>({...layout,routes:layout.routes.map((r:any)=>({...r,consumers:Array.isArray(r.consumers)?r.consumers:r.consumers.entries.slice(r.consumers.start,r.consumers.end)}))});
 const h=workload.proposed.history;
 const request=h?{...workload.proposed,history:{...h,layout:normalize(h.layout),placed:normalize(h.placed)}}:workload.proposed;
 for(const engine of ['main','branch']) {
  if(engine==='main'&&!main)continue;
  const run=()=> (engine==='main'?main!.layoutGraph:layoutGraph)(request);
  const profile=engine==='main'?mainProfile!.profileLayout:profileLayout;
  for(let i=0;i<12;i++)run();
  const samples=[];
  for(let i=0;i<60;i++) {const start=performance.now();const {result,profile:p}=profile(run);samples.push({ms:performance.now()-start,...p,candidate:result.decision?.candidate});}
  rows.push({case:workload.case,visible:workload.proposed.items.length,engine,samples});
 }
}
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6)??'/tmp/layout-profile.json';
writeFileSync(out,JSON.stringify(rows,null,2));
for(const row of rows){const avg=(f:(s:any)=>number)=>row.samples.reduce((sum:any,s:any)=>sum+f(s),0)/row.samples.length;console.log(row.case,row.engine,avg(s=>s.ms).toFixed(3),Object.fromEntries([...new Set(row.samples.flatMap((s:any)=>Object.keys(s.stages)))].map(k=>[k,{ms:avg(s=>s.stages[k]?.selfMs??0).toFixed(3),calls:avg(s=>s.stages[k]?.calls??0)}])),row.samples[0].counters);}
