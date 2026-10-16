/** Shared corpus contract: identical legal tours to reveals.ts, independent of saved reports. */
import { corpus, denseCorpus, requestFor } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { nodePenalties } from './geometry';
import { heldScreenMovement } from './screen-space';
export function clickStability() {
  let anchors=0,denseAnchors=0,displacement=0,transitions=0,screenAnchors=0,denseScreenAnchors=0;
  const byVisit = {new:0,revisit:0,newDense:0,revisitDense:0};
  for(const original of [...corpus(),...denseCorpus()]) for(const width of [360,454,640,900,1400]) {
    const fixture={...original,full:false},visited=new Set<string>();
    let focus:string|null=null,previous:Optimized|undefined,oldKeys='';
    for(let step=0;step<9;step++) {
      const request=requestFor(fixture,focus,width,96),keys=request.items.map(n=>n.key).sort().join(',');
      const next=optimizedBand({...request, hint:previous?.layout.readingOrder},{previous,anchorKey:focus??undefined});
      if(previous && keys!==oldKeys) {
        const m=nodePenalties(next.placed,request.band!.key,request.items,previous.placed,focus??undefined);
        const moved = !!focus && m.anchorDisplacement>.01 && next.layout.decision?.fallback !== 'anchor-yield';
        if (moved) byVisit[(next.revisited ? 'revisit' : 'new') + (original.id.startsWith('dense-') ? 'Dense' : '') as keyof typeof byVisit]++;
        const screen = !!focus && heldScreenMovement(previous.placed,next.placed,focus,request.band!.key,width,480).anchor>.01;
        if(original.id.startsWith('dense-')) { denseAnchors+=Number(moved); denseScreenAnchors+=Number(screen); }
        else {anchors+=Number(moved);screenAnchors+=Number(screen);displacement+=m.displacement;transitions++;}
      }
      previous=next;oldKeys=keys;
      const choices=request.items.filter(n=>!visited.has(n.key)&&request.band!.items.some(c=>c.parents.includes(n.key))).sort((a,b)=>b.order-a.order||a.key.localeCompare(b.key));
      if(!choices.length){if(focus===null)break;focus=null;}else{focus=choices[0].key;visited.add(focus);}
    }
  }
  return {byVisit,anchors,denseAnchors,screenAnchors,denseScreenAnchors,displacement:displacement/transitions};
}

import { screenshot } from './corpus';
import { runEngine, prefixCase } from './packing-fixtures';
import { tileMetrics, tileSize } from '../src/lib/domain/trace-graph/metrics';
import type { FolderLayout } from '../src/lib/domain/trace-graph/folder-layout';
import type { GraphLayout } from '../src/lib/domain/trace-graph/layout';
/** Same real folder packing and click sequence as packing.ts, with no report-file dependency. */
export function packingAnchorMoves(): number {
  let moved = 0;
  for (const width of [360,454,640,900,1400]) for (const imagePx of [48,64,96,128]) {
    const tile = tileMetrics(imagePx);
    const columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16)));
    const gridWidth = columns * tile.width + (columns - 1) * 16;
    const coverHeight = tileSize({ foreign: false, hint: true }, tile).height;
    const fixtures = Array.from({ length: Math.min(2, columns) }, (_, i) => prefixCase(screenshot, i));
    const active = fixtures.length - 1;
    let committed: FolderLayout | null = null, previous: readonly GraphLayout[] | undefined;
    for (const name of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null]) {
      const focus = name ? `g${active}:${name}` : null;
      const next = runEngine(fixtures, fixtures.map((_, i) => i === active ? focus : null), gridWidth, tile, coverHeight, committed);
      const a = focus && previous?.[active].nodes.get(focus), b = focus && next.placed[active].nodes.get(focus);
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > .01 && next.placed[active].decision?.fallback !== 'anchor-yield') moved++;
      committed = next.layout; previous = next.placed;
    }
  }
  return moved;
}

import { layoutGraph as frozenLayout } from './baseline/layout';
import { attached as frozenAttached } from './baseline/placement';
/** Allocated child-band height in the acceptance report; no route-pair analysis is needed. */
function measuredHeight(layout: GraphLayout, cover: string): number {
  const children = [...layout.nodes.values()].filter(n => n.key !== cover);
  return children.length ? Math.max(0, layout.height - (layout.bandBounds?.top ?? Math.min(...children.map(n => n.y))) + 34) : 0;
}
/** Historical acceptance row, recomputed over every corpus state and size. */
export function unexplainedHeightRegressions(): readonly string[] {
  const regressions: string[] = [];
  for (const fixture of corpus()) for (const imagePx of [48,64,96,128]) for (const width of [360,454,640,900,1400]) {
    let previous: Optimized | undefined, baseline: ReturnType<typeof frozenLayout> | undefined;
    for (const focus of fixture.focuses) {
      const request = requestFor(fixture, focus, width, imagePx, baseline?.readingOrder);
      baseline = frozenLayout(request);
      const next = optimizedBand({...request, hint:previous?.layout.readingOrder}, { previous, anchorKey:focus??undefined });
      if (!next.layout.decision?.stability) {
        const baseHeight = measuredHeight(frozenAttached(baseline, request), request.band!.key);
        const height = measuredHeight(next.placed, request.band!.key);
        if (height > baseHeight * 1.1 + .01) regressions.push(`${fixture.id}/${width}/${imagePx}/${focus}`);
      }
      previous = next;
    }
  }
  return regressions;
}
