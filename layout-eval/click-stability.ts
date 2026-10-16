/** Shared corpus contract: identical legal tours to reveals.ts, independent of saved reports. */
import { corpus, denseCorpus, requestFor } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { measure } from './geometry';
export function clickStability() {
  let anchors=0,denseAnchors=0,displacement=0,transitions=0;
  for(const original of [...corpus(),...denseCorpus()]) for(const width of [360,454,640,900,1400]) {
    const fixture={...original,full:false},visited=new Set<string>();
    let focus:string|null=null,previous:Optimized|undefined,oldKeys='';
    for(let step=0;step<9;step++) {
      const request=requestFor(fixture,focus,width,96),keys=request.items.map(n=>n.key).sort().join(',');
      const next=optimizedBand(request,{previous,historyPolicy:'arrival-only'});
      if(previous && keys!==oldKeys) {
        const m=measure(next.placed,request.band!.key,width,request.items,previous.placed,focus??undefined);
        if(original.id.startsWith('dense-')) denseAnchors+=Number(!!focus && m.anchorDisplacement>.01);
        else {anchors+=Number(!!focus && m.anchorDisplacement>.01);displacement+=m.displacement;transitions++;}
      }
      previous=next;oldKeys=keys;
      const choices=request.items.filter(n=>!visited.has(n.key)&&request.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));
      if(!choices.length){if(focus===null)break;focus=null;}else{focus=choices[0].key;visited.add(focus);}
    }
  }
  return {anchors,denseAnchors,displacement:displacement/transitions};
}
