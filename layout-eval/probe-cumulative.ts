import {corpus,denseCorpus,requestFor} from './corpus';
import {canonicalExpansion,type CanonicalOrder} from './canonical-construction';
import {layoutGraph,type GraphLayout} from '../src/lib/domain/trace-graph/layout';
import {attachSingleBand} from '../src/lib/domain/trace-graph/band-geometry';
import {measure} from './geometry';
import {projectDag,projectReferenceBadges} from '../src/lib/domain/trace-graph/projection';
import {planBandScene} from '../src/lib/domain/trace-graph/scene';
import {NO_EXPANSION,openStack,expandNode,expandedKeys} from '../src/lib/domain/trace-graph/expansion';
import {tileMetrics} from '../src/lib/domain/trace-graph/metrics';
const order=(process.argv[2]??'depth') as CanonicalOrder;
let anchors=0,denseAnchors=0,disp=0,n=0,denseDisp=0,denseN=0,height=0,broadHeight=0,broadCount=0,count=0,fallbacks=0,hiddenRetained=0;const moved=[];
for(const original of [...corpus(),...denseCorpus()])for(const width of [454,900]){
const c={...original,full:false},visited=new Set<string>();let focus:string|null=null,previous:GraphLayout|undefined,old='';
const initial=requestFor(c,null,width,96),graph=projectReferenceBadges(projectDag(c.nodes)),scope={graph,members:graph.dag.order,cover:initial.band!.key};let expansion=openStack(NO_EXPANSION,scope.cover);
for(let step=0;step<9;step++){
const r=planBandScene(graph,scope.members,null,width,{pinned:initial.pinned!,tile:tileMetrics(96),expanded:expandedKeys(expansion,scope)}).request;
const raw=canonicalExpansion(r,layoutGraph,order),next=attachSingleBand(raw,r),keys=r.items.map(n=>n.key).sort().join(',');
const m=measure(next,r.band!.key,width,r.items,keys!==old?previous:undefined,focus??undefined);height+=m.height;count++;if(!c.id.startsWith('dense-')){broadHeight+=m.height;broadCount++;}fallbacks+=Number(!!raw.decision?.fallback);
if(previous&&keys!==old){hiddenRetained+=[...previous.nodes.keys()].filter(k=>!next.nodes.has(k)).length;if(c.id.startsWith('dense-')){denseAnchors+=Number(!!focus&&m.anchorDisplacement>.01);denseDisp+=m.displacement;denseN++;}else{anchors+=Number(!!focus&&m.anchorDisplacement>.01);disp+=m.displacement;n++;}if(focus&&m.anchorDisplacement>.01)moved.push([c.id,width,step,focus,m.anchorDisplacement,raw.decision]);}
previous=next;old=keys;
const choices=r.items.filter(n=>!visited.has(n.key)&&r.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));if(!choices.length)break;focus=choices[0].key;visited.add(focus);expansion=expandNode(expansion,scope,focus);
}}
console.log(JSON.stringify({order,model:'cumulative-expandNode',anchors,denseAnchors,displacement:disp/n,denseDisplacement:denseDisp/denseN,height:height/count,broadHeight:broadHeight/broadCount,count,transitions:n,denseTransitions:denseN,fallbacks,hiddenRetained,moved}));
