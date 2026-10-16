import {corpus,denseCorpus,requestFor} from './corpus';
import {canonicalLayers, canonicalExpansion, projectCanonical, canonicalSkeleton, type CanonicalOrder} from './canonical-construction';
import {layoutGraph,type GraphLayout} from '../src/lib/domain/trace-graph/layout';
import {attachSingleBand} from '../src/lib/domain/trace-graph/band-geometry';
import {measure} from './geometry';
const variant = process.argv[2] ?? 'depth';
const order = variant as CanonicalOrder;
function construct(r: Parameters<typeof layoutGraph>[0]): GraphLayout {
  const merged = r.band!.items.some(n => n.parents.length > 1);
  if (variant === 'skeleton') return canonicalSkeleton(r, layoutGraph);
  if (variant === 'layers') return merged ? canonicalLayers(r, layoutGraph) : canonicalExpansion(r, layoutGraph, 'depth');
  if (variant === 'hybrid-cold' && r.items.length === r.band!.items.length) return layoutGraph(r);
  if (variant === 'projection' || ((variant === 'hybrid' || variant === 'hybrid-cold') && merged)) {
    return projectCanonical(layoutGraph({ ...r, items: r.band!.items }), r);
  }
  return canonicalExpansion(r, layoutGraph, variant.startsWith('hybrid') ? 'depth' : order);
}
let anchors=0,denseAnchors=0,disp=0,n=0,height=0,broadHeight=0,broadCount=0,count=0,fallbacks=0;const moved=[];
for(const original of [...corpus(),...denseCorpus()])for(const width of [454,900]){
const c={...original,full:false},visited=new Set<string>();let focus:string|null=null,previous:GraphLayout|undefined,old='';
for(let step=0;step<9;step++){
const r=requestFor(c,focus,width,96),raw=construct(r),next=attachSingleBand(raw,r),keys=r.items.map(n=>n.key).sort().join(',');
const m=measure(next,r.band!.key,width,r.items,keys!==old?previous:undefined,focus??undefined);height+=m.height;count++;if(!c.id.startsWith('dense-')){broadHeight+=m.height;broadCount++;}fallbacks+=Number(!!raw.decision?.fallback);
if(previous&&keys!==old){if(c.id.startsWith('dense-'))denseAnchors+=Number(!!focus&&m.anchorDisplacement>.01);else{anchors+=Number(!!focus&&m.anchorDisplacement>.01);disp+=m.displacement;n++;}if(focus&&m.anchorDisplacement>.01)moved.push([c.id,width,step,focus,m.anchorDisplacement,raw.decision]);}
previous=next;old=keys;
const choices=r.items.filter(n=>!visited.has(n.key)&&r.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));if(!choices.length){if(focus===null)break;focus=null;}else{focus=choices[0].key;visited.add(focus);}
}}
console.log(JSON.stringify({order,anchors,denseAnchors,displacement:disp/n,height:height/count,broadHeight:broadHeight/broadCount,count,fallbacks,moved}));
