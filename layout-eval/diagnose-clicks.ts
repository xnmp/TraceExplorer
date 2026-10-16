/** Reproduce and render moved anchors before changing construction. */
import { mkdir, writeFile } from 'node:fs/promises';
import { corpus, denseCorpus, requestFor } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { svg } from './render';
const out = process.argv[2] ?? 'docs/click-stability-evidence';
await mkdir(out, {recursive:true});
const rows: object[] = [], counts = new Map<string,number>(), samples = new Map<string,number>();
for (const original of [...corpus(), ...denseCorpus()]) for (const width of [360,454,640,900,1400]) {
  const fixture = {...original, full:false}, visited = new Set<string>();
  let focus: string|null = null, previous: Optimized|undefined, previousRequest: ReturnType<typeof requestFor>|undefined;
  for (let step=0; step<9; step++) {
    const request=requestFor(fixture,focus,width,96), next=optimizedBand(request,{previous,historyPolicy:'arrival-only'});
    const before=focus && previous?.placed.nodes.get(focus), after=focus && next.placed.nodes.get(focus);
    if (before && after && Math.hypot(after.x-before.x,after.y-before.y)>.01) {
      const dx=after.x-before.x,dy=after.y-before.y;
      const retained=[...next.placed.nodes].filter(([key])=>key!==request.band!.key && previous!.placed.nodes.has(key));
      const rigid=retained.every(([key,n])=>{const p=previous!.placed.nodes.get(key)!;return Math.abs(n.x-p.x-dx)<.01 && Math.abs(n.y-p.y-dy)<.01;});
      const category=previous!.candidate!==next.candidate?'candidate-switch':rigid?'rigid-band-translation':'same-candidate-reflow';
      const kind=original.id.startsWith('dense-')?'dense':'broad';
      counts.set(`${kind}/${category}`,(counts.get(`${kind}/${category}`)??0)+1);
      const sample=samples.get(category)??0;
      const row={case:original.id,width,step,focus,category,from:previous!.candidate,to:next.candidate,dx,dy,retained:retained.length,hidden:[...previous!.placed.nodes.keys()].filter(k=>!next.placed.nodes.has(k)).length};
      rows.push(row);
      if(sample<2){const stem=`${category}-${sample}`;await writeFile(`${out}/${stem}-before.svg`,svg(previous!.placed,previousRequest!,JSON.stringify(row)));await writeFile(`${out}/${stem}-after.svg`,svg(next.placed,request,JSON.stringify(row)));samples.set(category,sample+1);}
    }
    previous=next;previousRequest=request;
    const expandable=request.items.filter(n=>!visited.has(n.key)&&request.band!.items.some(child=>child.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));
    if(!expandable.length){if(focus===null)break;focus=null;}else{focus=expandable[0].key;visited.add(focus);}
  }
}
await writeFile(`${out}/diagnosis.json`,JSON.stringify({counts:Object.fromEntries(counts),rows},null,2));
console.log(Object.fromEntries(counts));
