/** Paired legal click tours against an archived main, preserving each engine's actual history.
 * Usage: bun layout-eval/anchor-audit.ts <candidate-root> <main-root> <output-prefix>
 * Candidate archives may optionally populate globalThis.__anchorAudit with candidate observations.
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {layoutSignature,geometrySignature} from '../src/lib/domain/trace-graph/layout-signature';
import {corpus,denseCorpus,requestFor,screenshot} from './corpus';
import {svg} from './render';
import {tileMetrics,tileSize} from '../src/lib/domain/trace-graph/metrics';
const root=resolve(process.argv[2]??'.'),main=resolve(process.argv[3]??'/tmp/layout-gates-main-profile');
const prefix=process.argv[4]??'layout-eval/out/anchor-audit';
await mkdir(resolve(prefix,'..'),{recursive:true});
const [{optimizedBand:branch},{optimizedBand:baseline},{geometryGate},{attachSingleBand},{runEngine:branchPack,prefixCase},{runEngine:mainPack}]=await Promise.all([
  import(root+'/layout-eval/engine.ts'),import(main+'/layout-eval/engine.ts'),import(root+'/src/lib/domain/trace-graph/geometry-gate.ts'),import(root+'/src/lib/domain/trace-graph/band-geometry.ts'),import(root+'/layout-eval/packing-fixtures.ts'),import(main+'/layout-eval/packing-fixtures.ts')]);
const rows:any[]=[],samples=new Set<string>(),summary:Record<string,any>={};
function count(kind:string,a:boolean,b:boolean,category:string){const c=summary[kind]??={main:0,branch:0,both:0,added:0,removed:0,categories:{}};c.main+=+a;c.branch+=+b;c.both+=+(a&&b);c.added+=+(!a&&b);c.removed+=+(a&&!b);if(!a&&b)c.categories[category]=(c.categories[category]??0)+1;}
function moved(next:any,prev:any,focus:string|null,changed=true){const a=focus&&prev?.placed.nodes.get(focus),b=focus&&next.placed.nodes.get(focus);return !!(changed&&a&&b&&Math.hypot(a.x-b.x,a.y-b.y)>.01&&next.layout.decision?.fallback!=='anchor-yield');}
const requestedCases=process.argv.find(arg=>arg.startsWith('--cases='))?.slice(8).split(',');
for(const original of (process.argv.includes("--packing-only")?[]:[...corpus(),...denseCorpus()].filter(c=>!requestedCases||requestedCases.includes(c.id))))for(const width of [360,454,640,900,1400]){
  const fixture={...original,full:false},visited=new Set<string>();let focus:string|null=null,previous:any,oldMain:any,oldKeys='',oldRequest:any;
  for(let step=0;step<9;step++){
    const request=requestFor(fixture,focus,width,96),keys=request.items.map(n=>n.key).sort().join(',');
    (globalThis as any).__anchorAudit=[];
    const next=branch({...request,hint:previous?.layout.readingOrder},{previous,anchorKey:focus??undefined});
    const observations=(globalThis as any).__anchorAudit;(globalThis as any).__anchorAudit=undefined;
    const nextMain=baseline({...request,hint:oldMain?.layout.readingOrder},{previous:oldMain,anchorKey:focus??undefined});
    const a=moved(nextMain,oldMain,focus,keys!==oldKeys),b=moved(next,previous,focus,keys!==oldKeys),kind=original.id.startsWith('dense-')?'dense':'broad';
    let category='e',detail='No anchor-preserving candidate constructed';
    const candidates=(a||b?observations:[]).filter((o:any)=>o.kind==='candidate').map((o:any)=>({name:o.name,holds:o.holds,focusHolds:!!focus&&!!o.previous?.nodes.get(focus)&&!!attachSingleBand(o.layout,o.request).nodes.get(focus)&&Math.hypot(attachSingleBand(o.layout,o.request).nodes.get(focus)!.x-o.previous.nodes.get(focus).x,attachSingleBand(o.layout,o.request).nodes.get(focus)!.y-o.previous.nodes.get(focus).y)<.01,failure:geometryGate(attachSingleBand(o.layout,o.request),o.request.items,o.request.band.key,o.request.maxWidth),observation:o}));
    const stateKey=layoutSignature({...request,history:undefined,hint:undefined,anchorKey:undefined});
    const saved=previous?.displays?.find(([id]:any)=>id===stateKey);
    const restoreProof=next.revisited?{key:stateKey,identicalKey:!!saved,identicalGeometry:!!saved&&isDeepStrictEqual(geometrySignature(saved[1]),geometrySignature(next.layout))}:undefined;
    if(restoreProof&&(!restoreProof.identicalKey||!restoreProof.identicalGeometry))throw new Error('Unproved revisit');
    if(next.revisited){category='d';detail='Exact saved-state restore';}
    else if(candidates.some((c:any)=>c.holds&&c.focusHolds&&!c.failure)){category='c';detail='Certified ancestry-preserving candidate exists';}
    else if(candidates.some((c:any)=>c.focusHolds&&!c.failure)){category='c';detail='Clicked tile can hold; ancestor requirement excludes it';}
    else if(candidates.some((c:any)=>c.holds&&c.focusHolds&&c.failure)){category='a';detail='Anchor-preserving candidate rejected by independent gate';}
    if(a||b){const row={kind,case:original.id,width,step,focus,mainMoved:a,branchMoved:b,added:!a&&b,removed:a&&!b,category,detail,revisited:next.revisited??false,restoreProof,decision:next.layout.decision,mainDecision:nextMain.layout.decision,candidates:candidates.map(({observation,...c}:any)=>c),construction:observations.filter((o:any)=>['incremental','repack','constrained','repairable'].includes(o.kind))};rows.push(row);
      if(!a&&b&&!samples.has(kind+'/'+category)){samples.add(kind+'/'+category);const stem=prefix+'-'+kind+'-'+category;await writeFile(stem+'-before.svg',svg(previous.placed,oldRequest,JSON.stringify({...row,candidates:undefined,construction:undefined})));await writeFile(stem+'-after.svg',svg(next.placed,request,'After: '+JSON.stringify(next.layout.decision)));const rejected=candidates.find((c:any)=>c.holds&&c.focusHolds&&c.failure);if(rejected)await writeFile(stem+'-rejected.svg',svg(attachSingleBand(rejected.observation.layout,request),request,'Rejected '+rejected.name+': '+rejected.failure));}}
    count(kind,a,b,category);previous=next;oldMain=nextMain;oldKeys=keys;oldRequest=request;
    const choices=request.items.filter(n=>!visited.has(n.key)&&request.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));if(!choices.length){if(focus===null)break;focus=null;}else{focus=choices[0].key;visited.add(focus);}
  }
}
for(const width of [360,454,640,900,1400])for(const imagePx of [48,64,96,128]){
  const tile=tileMetrics(imagePx),columns=Math.max(1,Math.floor((width+16)/(tile.width+16))),gridWidth=columns*tile.width+(columns-1)*16,coverHeight=tileSize({foreign:false,hint:true},tile).height,fixtures=Array.from({length:Math.min(2,columns)},(_,i)=>prefixCase(screenshot,i)),active=fixtures.length-1;let prev:any=null,prevMain:any=null;
  for(const [step,name] of [null,'Saffron','Ash','Cerulean','Saffron',null].entries()){
    const focus=name?`g${active}:${name}`:null,focuses=fixtures.map((_,i)=>i===active?focus:null),next=branchPack(fixtures,focuses,gridWidth,tile,coverHeight,prev?.layout??null),nextMain=mainPack(fixtures,focuses,gridWidth,tile,coverHeight,prevMain?.layout??null);
    const asBand=(x:any)=>x&&({layout:x.placed[active],placed:x.placed[active]});const a=moved(asBand(nextMain),asBand(prevMain),focus),mainWorldMoved=a,b=moved(asBand(next),asBand(prev),focus);const category=next.revisited?'d':'e';count('packing',a,b,category);if(a||b)rows.push({kind:'packing',width,imagePx,step,focus,mainWorldMoved,mainMoved:a,branchMoved:b,added:!a&&b,removed:a&&!b,category,detail:next.revisited?'Exact saved-state restore':'Folder packing/history interaction',restoreProof:next.revisited?{key:next.displayKey,identicalKey:true,identicalGeometry:true}:undefined,decision:next.placed[active].decision,mainDecision:nextMain.placed[active].decision});prev=next;prevMain=nextMain;
  }
}
await writeFile(prefix+'.json',JSON.stringify({candidateRoot:root,mainRoot:main,summary,rows},null,2));console.log(JSON.stringify(summary,null,2));
