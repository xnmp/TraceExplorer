delete process.env.OPENAI_API_KEY;
import { readFile, writeFile } from 'node:fs/promises';
import { layoutGraph, type GraphLayout } from './baseline/layout';
import { corpus, requestFor } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { measure } from './geometry';
import { attached } from './baseline/placement';
import { svg } from './render';
const data=JSON.parse(await readFile('layout-eval/out/results.json','utf8'));
const pairs=data.rows.filter((r:any)=>r.engine==='baseline').map((b:any,i:number)=>({b,p:data.rows[i*2+1]})).filter(({b,p}:any)=>p.metrics.height>b.metrics.height+.5).sort((a:any,b:any)=>(b.p.metrics.height-b.b.metrics.height)-(a.p.metrics.height-a.b.metrics.height));
const seen=new Set<string>(),worst=[];for(const pair of pairs){if(seen.has(pair.b.case))continue;seen.add(pair.b.case);worst.push(pair);if(worst.length===3)break;}
for(const [index,{b,p}] of worst.entries()){
  const c=corpus().find(c=>c.id===b.case)!;let before:GraphLayout|undefined,after:Optimized|undefined;
  for(let step=0;step<=b.step;step++){const focus=c.focuses[step],request=requestFor(c,focus,b.width,b.imagePx,before?.readingOrder);before=layoutGraph(request);after=optimizedBand({...request,hint:after?.layout.readingOrder},{previous:after,anchorKey:focus??undefined});
    if(step===b.step){const placed=attached(before,request),metrics=measure(after.placed,request.band!.key,b.width,request.items);if(Math.abs(metrics.height-p.metrics.height)>.01)throw new Error('reproduction mismatch');
      await writeFile(`layout-eval/out/regression-${index+1}-baseline.svg`,svg(placed,request,`Regression ${index+1}: ${c.id}, ${b.width}px, preset${b.imagePx}, focus ${focus}`));
      await writeFile(`layout-eval/out/regression-${index+1}-proposed.svg`,svg(after.placed,request,`Regression ${index+1}: ${c.id}, ${b.width}px, preset${b.imagePx}, focus ${focus}`));
    }
  }
}
await writeFile('layout-eval/out/regressions.json',JSON.stringify(worst.map(({b,p}:any)=>({case:b.case,width:b.width,imagePx:b.imagePx,step:b.step,focus:b.focus,before:b.metrics,after:p.metrics,candidate:p.candidate})),null,2));
