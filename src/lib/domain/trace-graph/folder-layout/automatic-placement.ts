import { worldReject, WorldPlacementDecline, guardedWorld, type FolderWorldRoutingResult, type FolderWorldPreferences } from './world-result';
import { worldCopy, worldGet, worldSet, worldIndex, worldKey,worldHas,worldEntries,sameWorldIdentities, type WorldCharge } from './world-indexes';
import { prepayWorldInputs, certifyWorldFolder,prepayFolderRectangles } from './world-admission';
import { layoutStage, countLayoutWork } from '../layout-profile';
/** Extend one committed folder drawing in world coordinates, so packing is also pinned. */
import { captureTranslatedRouting, rebaseRetainedRoutingFrame } from '../routing-frame';
import { captureFramedIncrementalRouting, type IncrementalRoutingSeed } from '../incremental-routing';
import { bindRoutingFragmentTopology } from '../routing-fragments';
import { hintRoutingFrame } from '../hint-routing';
import { chargeRoutingSnapshot } from '../routing-problem';
import { preferredWorldNativeTemplates, restoreWorldNativeLocal, type LocalSource, type WorldWitness } from './world-native-frame';
import { projectCommittedRouting, type IncrementalRoutingConflict } from '../incremental-routing';
import { RoutingImportError } from '../routing-plan';
import type { CommittedRoutingProblem } from '../routing-problem';
import { constrainedIncremental, automaticIncrementalBudget, incrementalWorld, incrementalWorkBudget, type IncrementalWorkBudget } from '../band-incremental';
import { isLayoutShape, validHistory } from '../history-boundary';
import { bandHistorySignature, resizedLayout } from '../band-history';
import { TILE } from '../metrics';
import { mapPathNumbers } from '../path-data';
import { rerouteResizedHistory } from '../hint-resize';
import { repairRouteContacts } from '../repair-route-contacts';
import { filterRouteConsumers, eachConsumer } from '../route-consumers';
import type { Consumer } from '../junctions';
import { RoutingConflictError, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedJunction, type PlacedNode, type PlacedRoute } from '../layout';
import type { BandScenePlan } from '../scene';
import type { GridBand, GridCell, GridRect } from '../grid-flow';
import { centeredCellFootprint, withCellFootprints } from './cell-footprints';
import { folderGeometryGate } from './geometry-gate';
import { paneRouteBounds, unionRect } from './route-bounds';
import type { FolderGraph, FolderLayout, FolderLayoutInput, GraphId, FolderPlacementHistory } from './types';

type Plan = { readonly plan: BandScenePlan };
const scope = (kind: string, id: string, key = '') => JSON.stringify([kind, id, key]);
const MARGIN = 16;
/** The router's leftmost legal lane is x=8; translating it back must stay nonnegative. */
const ORIGIN_X = 8;
const ROOT = JSON.stringify(['folder-placement-anchor']);

export function preservesFolderRectangles(result: FolderLayout, snapshot: FolderPlacementHistory['layout']): boolean {
  if (!(snapshot?.cells instanceof Map) || !(snapshot.graphs instanceof Map)) return false;
  const same = (a: GridRect, b: GridRect) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const current = new Map<string, GridRect>([...result.cells].map(([id, cell]) => [id, result.cellFootprints?.get(id) ?? cell]));
  for (const graph of result.graphs.values()) for (const [key, n] of graph.attached.nodes)
    current.set(key, { ...n, x: n.x + graph.origin.x, y: n.y + graph.origin.y });
  const oldNodes = new Map<string, GridRect>([...snapshot.cells].map(([id, cell]) => [id, snapshot.cellFootprints?.get(id) ?? cell]));
  for (const graph of snapshot.graphs.values()) {
    if (!graph?.attached || !(graph.attached.nodes instanceof Map) || !graph.origin) return false;
    for (const [key, n] of graph.attached.nodes) {
      if (!n) return false;
      oldNodes.set(key, { ...n, x: n.x + graph.origin.x, y: n.y + graph.origin.y });
    }
  }
  const resized = [...oldNodes].filter(([key, old]) => Math.abs((current.get(key)?.height ?? old.height) - old.height) === TILE.hint);
  const retained = (key: string, old: GridRect, now: GridRect): boolean => {
    if (now.x !== old.x || now.width !== old.width || ![0, TILE.hint, -TILE.hint].includes(now.height - old.height)) return false;
    if (now.y === old.y) return true;
    return now.y - old.y === TILE.hint && resized.some(([upperKey, upper]) => upperKey !== key
      && current.get(upperKey)!.height - upper.height === now.y - old.y
      && old.y >= upper.y + upper.height && old.x < upper.x + upper.width && upper.x < old.x + old.width);
  };
  for (const [id, cell] of snapshot.cells) {
    const now = result.cells.get(id);
    if (now ? !same({ ...cell, y: now.y }, now) || !retained(id, snapshot.cellFootprints?.get(id) ?? cell, result.cellFootprints?.get(id) ?? now)
      : current.has(id) && !retained(id, snapshot.cellFootprints?.get(id) ?? cell, current.get(id)!)) return false;
  }
  for (const graph of snapshot.graphs.values()) {
    if (!graph?.attached || !(graph.attached.nodes instanceof Map) || !graph.origin) return false;
    for (const [key, old] of graph.attached.nodes) {
      if (!old) return false;
      const n = current.get(key);
      if (n && !retained(key, { ...old, x: old.x + graph.origin.x, y: old.y + graph.origin.y }, n)) return false;
    }
  }
  return true;
}

function mapRouteConsumers(routes: readonly PlacedRoute[], map: (c: Consumer) => Consumer): PlacedRoute[] {
  const tables = new Map<readonly Consumer[], readonly Consumer[]>();
  return routes.map(route => {
    const c = route.consumers;
    if (Array.isArray(c)) return { ...route, consumers: c.map(map) };
    const range = c as { readonly entries: readonly Consumer[]; readonly start: number; readonly end: number };
    let entries = tables.get(range.entries);
    if (!entries) { entries = range.entries.map(map); tables.set(range.entries, entries); }
    return { ...route, consumers: { ...range, entries } };
  });
}

/**
 * Existing tiles and wires from every component are obstacles to every insertion. The neutral
 * anchor has no edges: its only purpose is adapting the band router's root parameter. It is
 * removed before certification. A failed bounded search withholds this candidate; it does not
 * prove that retained placement is infeasible.
 */
/** Compatibility wrapper; new callers supply one outer allowance explicitly. */
export function pinnedFolderPlacement(input:FolderLayoutInput,plans:ReadonlyMap<GraphId,Plan>,snapshot:FolderPlacementHistory['layout'],preferences:FolderWorldPreferences,work=incrementalWorkBudget('folder')):FolderLayout|null {
 const result=automaticFolderPlacement(input,plans,snapshot,preferences,work);return result.ok?result.drawing:null;
}
/** Actual attached snapshot is the only source. Preferences contain no routes. */
export function automaticFolderPlacement(input:FolderLayoutInput,plans:ReadonlyMap<GraphId,Plan>,snapshot:FolderPlacementHistory['layout'],preferences:FolderWorldPreferences,work:IncrementalWorkBudget):FolderWorldRoutingResult {
 const endStage=layoutStage('pinned-folder'),start=work?.remaining;
 const fail=(conflict:IncrementalRoutingConflict):FolderWorldRoutingResult=>({ok:false,conflict,work:Number.isFinite(start)&&Number.isFinite(work?.remaining)?start-work.remaining:0});
 if(!work||!Number.isSafeInteger(start)||start<0||work.automaticRemaining!==undefined&&(!Number.isSafeInteger(work.automaticRemaining)||work.automaticRemaining<0)
   ||work.automaticPools!==undefined&&!['fallback','second','probes'].every(key=>Number.isSafeInteger(work.automaticPools![key as keyof typeof work.automaticPools])&&work.automaticPools![key as keyof typeof work.automaticPools]>=0)){endStage();return fail({reason:'unsupported-input',constraints:['finite nonnegative integer shared folder work allowance/pools']});}
 try {
  prepayWorldInputs(input,plans,snapshot,preferences,work);
  const drawing=place(input,plans,snapshot,preferences,false,work,true);
  return drawing?{ok:true,drawing,work:start-work.remaining}:fail({reason:'metric-conflict',constraints:['folder world candidate withheld']});
 }catch(error){
  if(error instanceof WorldPlacementDecline)return fail(error.conflict);
  if(error instanceof RoutingConflictError)return fail({reason:error.conflict.kind==='search-exhausted'?'budget-exhaustion':error.conflict.kind==='invalid'?'unsupported-input':error.conflict.kind==='metric'?'metric-conflict':'topology-conflict',constraints:error.conflict.constraints});
  if(error instanceof RoutingImportError)return fail({reason:'unsupported-input',constraints:[error.message]});
  throw error;
 }finally{endStage();}
}

function place(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, Plan>, snapshot: FolderPlacementHistory['layout'], candidate: FolderWorldPreferences, shiftHintColumns: boolean, work: IncrementalWorkBudget, automatic = false): FolderLayout | null {
  const charge=chargeWorld(work),scope=(kind:string,id:string,key='')=>worldKey([kind,id,key],charge);
  if (!(snapshot.cells instanceof Map) || !(snapshot.graphs instanceof Map)) return worldReject('snapshot cell/graph maps','unsupported-input');
  if (!Array.isArray(snapshot.bands)) return worldReject('snapshot bands array','unsupported-input');
  const oldBands = worldIndex(snapshot.bands,band=>band.id,charge,'source band identity index');
  for (const [id, graph] of snapshot.graphs) {
    const cell = worldGet(snapshot.cells,id,charge,'source cell identity'), band = worldGet(oldBands,id,charge,'source band identity');
    if (!cell || !band || !isLayoutShape(graph.attached) || !isLayoutShape(graph.layout)
      || graph.origin?.x !== 0 || graph.origin?.y !== cell.y
      || !validHistory({ signature: bandHistorySignature(graph.plan.request), layout: graph.layout, placed: graph.attached,
        ...(!graph.worldPlaced ? { attachment: { bandTop: band.y - cell.y, placement: graph.placement } } : {}) }, id)) return worldReject('actual attached source/history frame','unsupported-input');
  }
  const sourceConflict=certifyWorldFolder(snapshot,chargeWorld(work));if(sourceConflict)throw new WorldPlacementDecline({...sourceConflict,reason:'unsupported-input',constraints:['actual committed source invalid',...sourceConflict.constraints]});

  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [];
  const items: LayoutItem[] = [], identities = new Map<string, { graph: string; key: string }>();
  const oldJunctions = new Map<string, string>(), oldRoutes = new Map<string, string>();
  const cells = new Map<string, GridCell>();
  let appendedY = Math.max(snapshot.size.height, snapshot.bounds.y + snapshot.bounds.height) + MARGIN;
  let appendedRow = [...snapshot.cells.values()].reduce((row, c) => Math.max(row, c.row + 1), 0);
  for (const item of input.items) {
    const old = worldGet(snapshot.cells,item.id,charge,'retained host identity'), fresh = worldGet(candidate.cells,item.id,charge,'new host preference identity');
    if (!old && !fresh) return worldReject('new host cell preference missing','unsupported-input');
    const cell = old ?? { ...fresh!, x: 0, y: appendedY, row: appendedRow++, col: 0 };
    worldSet(cells,item.id,cell,charge,'current host identity insertion');
    if (!old) appendedY += cell.height + MARGIN;
  }
  for (const [id, cell] of cells) if (!worldHas(plans,id,charge,'current host plan identity')) {
    const key = scope('cell', id);
    const footprint = centeredCellFootprint(cell, (candidate.cellFootprints&&worldGet(candidate.cellFootprints,id,charge,'new host footprint identity'))?.width ?? cell.width);
    worldSet(nodes,key, { ...cell, ...footprint, key, x: footprint.x + ORIGIN_X, band: 0 },charge,'new host obstacle identity');
    items.push({ key, width: footprint.width, height: footprint.height, order: items.length, parents: [] });
  }
  // Tile identity survives component merges. Component ids only scope the new
  // output; they must never decide which visible geometry remains pinned.
  const retained = worldEntries<PlacedNode>([...snapshot.cells].map(([key, cell]) =>
    [key, { ...cell, ...((snapshot.cellFootprints&&worldGet(snapshot.cellFootprints,key,charge,'retained host footprint identity')) ?? cell), key, band: 0 }]as const),charge,'retained host obstacle index');
  for (const graph of snapshot.graphs.values()) for (const [key, node] of graph.attached.nodes)
    worldSet(retained,key, { ...node, x: node.x + graph.origin.x, y: node.y + graph.origin.y },charge,'retained actual tile identity');
  const owners = worldEntries([...plans].flatMap(([id, { plan }]) => plan.request.items.map(item => [item.key, id] as const)),charge,'current tile owner index');
  const nodeKeyWithCharge=(key:string,pay:WorldCharge)=>worldKey(['node',worldGet(owners,key,pay,'current node owner lookup')??'',key],pay);
  const nodeKey = (key: string) => nodeKeyWithCharge(key,charge);
  for (const [id, { plan }] of plans) {
    const cell = worldGet(cells,id,charge,'current graph host identity')!;
    for (const item of plan.request.items) {
      const key = nodeKey(item.key), old = worldGet(retained,item.key,charge,'current retained tile identity');
      worldSet(identities,key, { graph: id, key: item.key },charge,'current scoped tile identity');charge(item.key.length+id.length+1,'current cover identity comparison');const cover=item.key===id;
      items.push({ ...item, key, parents: item.parents.map(nodeKey), width: old?.width ?? item.width, height: cover ? old?.height ?? cell.height : item.height });
      if (old) worldSet(nodes,key, { ...old, key, x: old.x + ORIGIN_X, y: old.y },charge,'current retained tile obstacle');
      else if (cover) worldSet(nodes,key, { key, x: cell.x + (cell.width - item.width) / 2 + ORIGIN_X,
        y: cell.y, width: item.width, height: cell.height, row: 0, band: 0 },charge,'new cover policy target');
    }
  }
  const sourceLocals:LocalSource[]=[];
  let oracle:IncrementalRoutingSeed|undefined;
  let witness:WorldWitness|undefined;
  const frames = new Map<string, { readonly problem: CommittedRoutingProblem; readonly origin: { readonly x: number; readonly y: number } }>();
  const hasHintChanges = items.some(item => {const node=worldGet(nodes,item.key,charge,'hint retained tile lookup');return node!==undefined&&node.height!==item.height;});
  const visibleItems = [...plans.values()].flatMap(({ plan }) => plan.request.items);
  for (const [id, graph] of snapshot.graphs) {
    const { attached, origin } = graph;
    const joinKey = (key: string) => scope('junction', id, key);
    const owner=worldGet(owners,id,charge,'retained original owner identity');charge((owner?.length??0)+id.length+1,'retained original owner comparison');const sameOwner=owner===id;
    const retainedId = (kind: string, key: string) => sameOwner ? key : scope(kind, id, key);
    if (!hasHintChanges && !automatic) {
      const projected = projectCommittedRouting(attached, { items: visibleItems, maxWidth: input.width }, charge);
      const renamed: GraphLayout = { ...projected,
        junctions: new Map([...projected.junctions].map(([key, dot]) => [retainedId('retained-junction', key), { ...dot, id: retainedId('retained-junction', key) }])),
        routes: projected.routes.map(route => ({ ...route, id: retainedId('retained-route', route.id),
          from: route.from.kind === 'junction' ? { ...route.from, id: retainedId('retained-junction', route.from.id) } : route.from,
          to: route.to.kind === 'junction' ? { ...route.to, id: retainedId('retained-junction', route.to.id) } : route.to })),
      };
      const captured = captureTranslatedRouting(renamed, {
        nodes: { x: [{ operation: 'add', operand: origin.x }, { operation: 'add', operand: ORIGIN_X }], y: [{ operation: 'add', operand: origin.y }] },
        paths: { x: [{ operation: 'add', operand: origin.x + ORIGIN_X }], y: [{ operation: 'add', operand: origin.y }] },
      }, charge);
      if (!captured.ok) {
        countLayoutWork('incremental-legacy-fallback:unsupported-input');
        return worldReject('pinned-placement.ts:192');
      }
      frames.set(id, { problem: captured.problem, origin });
    }
    if (automatic) {
      chargeRoutingSnapshot(attached, charge);
      sourceLocals.push({ drawing: structuredClone(attached), origin: { ...origin },
        nodes: worldEntries([...attached.nodes.keys()].map(key=>[key,nodeKey(key)]as const),charge,'source local tile aliases'),
        routes: worldEntries(attached.routes.map((route:PlacedRoute)=>[route.id,scope('route',id,route.id)]as const),charge,'source local route aliases'),
        junctions:worldEntries([...attached.junctions.keys()].map(key=>[key,joinKey(key)]as const),charge,'source local dot aliases') });
    }
    for (const j of attached.junctions.values()) {
      const key = joinKey(j.id); worldSet(oldJunctions,key,retainedId('retained-junction', j.id),charge,'source world dot identity');
      worldSet(junctions,key, { ...j, id: key, x: j.x + origin!.x + ORIGIN_X, y: j.y + origin!.y, parents: j.parents.map(nodeKey) },charge,'source world dot import');
    }
    const scoped = mapRouteConsumers(attached?.routes ?? [], c => ({ parent: nodeKey(c.parent), child: nodeKey(c.child) }));
    for (const route of scoped) {
      const key = scope('route', id, route.id); worldSet(oldRoutes,key,retainedId('retained-route', route.id),charge,'source world route identity');
      const endpoint = (end: PlacedRoute['from']) => ({ ...end, id: end.kind === 'node' ? nodeKey(end.id) : joinKey(end.id) });
      charge(40*(route.path.length+1),'source world path field serialization');
      routes.push({ ...route, id: key, from: endpoint(route.from), to: endpoint(route.to),
        path: mapPathNumbers(route.path, (v, i) => v + (i % 2 ? origin!.y : origin!.x + ORIGIN_X)) });
    }
  }
  const visible = new Set<string>();for(const item of items){charge(item.key.length+1,'visible tile identity insertion');visible.add(item.key);}
  const retainedRoutes = filterRouteConsumers(routes, c => worldHas(visible,c.parent,charge,'visible source parent identity')&&worldHas(visible,c.child,charge,'visible source child identity'));
  const referenced=new Set<string>();for(const route of retainedRoutes)for(const endpoint of [route.from,route.to])if(endpoint.kind==='junction'){charge(endpoint.id.length+1,'referenced dot identity insertion');referenced.add(endpoint.id);}
  for (const key of junctions.keys()) if (!worldHas(referenced,key,charge,'referenced dot identity')){charge(key.length+1,'unreferenced dot removal');junctions.delete(key);}
  // Roots require no wiring. Seed them beyond the retained drawing before routing descendants.
  for (const item of items) if (!worldHas(nodes,item.key,charge,'unplaced current root identity') && !item.parents.length) {
    worldSet(nodes,item.key, { ...item, x: ORIGIN_X, y: appendedY, row: appendedRow++, band: 0 },charge,'new current root policy target');
    appendedY += item.height + MARGIN;
  }
  const missing = items.filter(item => !worldHas(nodes,item.key,charge,'current missing tile identity'));
  worldSet(nodes,ROOT, { key: ROOT, x: 0, y: 0, width: 1, height: 1, row: 0, band: 0 },charge,'neutral adapter anchor identity');
  items.unshift({ key: ROOT, width: 1, height: 1, order: -1, parents: [] });
  const maxWidth = input.width + ORIGIN_X;
  const unresized: GraphLayout = { nodes, junctions, routes: retainedRoutes, rows: [], readingOrder: new Map(), orientation: 'down',
    width: maxWidth, height: Math.max(snapshot.size.height, snapshot.bounds.y + snapshot.bounds.height, appendedY - MARGIN) };
  const heights = worldEntries(items.filter(item => {const node=worldGet(nodes,item.key,charge,'retained hint tile identity');return node!==undefined&&node.height!==item.height;}).map(item => [item.key,item.height]as const),charge,'retained hint height identities');
  if(automatic&&heights.size){
    const beforeFacts=[...snapshot.graphs.values()].flatMap(g=>g.plan.request.band?.items??g.plan.request.items);
    const afterFacts=[...plans.values()].flatMap(g=>g.plan.request.band?.items??g.plan.request.items);
    chargeRoutingSnapshot([beforeFacts,afterFacts,heights],charge);
    const old=worldIndex(beforeFacts,n=>n.key,charge,'original complete member facts'),now=worldIndex(afterFacts,n=>n.key,charge,'current complete member facts');
    const children=(facts:readonly LayoutItem[])=>{const keys=new Set<string>();for(const fact of facts)for(const key of fact.parents){charge(key.length+1,'complete output membership index');keys.add(key);}return keys;};
    const hadChildren=children(beforeFacts),hasChildren=children(afterFacts);
    for(const [key,height]of heights){const identity=worldGet(identities,key,charge,'changed hint tile identity'),a=identity&&worldGet(old,identity.key,charge,'old hint member fact'),b=identity&&worldGet(now,identity.key,charge,'current hint member fact'),node=worldGet(nodes,key,charge,'old hint tile rectangle');
      if(!a||!b||!node||a.width!==b.width||a.order!==b.order||!sameWorldIdentities(a.parents,b.parents,charge)
        ||!(height-node.height===16&&!worldHas(hadChildren,a.key,charge,'old first-output fact')&&worldHas(hasChildren,a.key,charge,'new first-output fact')
          ||node.height-height===16&&worldHas(hadChildren,a.key,charge,'old last-output fact')&&!worldHas(hasChildren,a.key,charge,'new last-output fact')))return worldReject('complete facts do not authorize hint','unsupported-input');
    }
  }
  const request: LayoutRequest = { items, maxWidth, tileWidth: input.tile.width, band: { key: ROOT, items } };
  const unplacedCells = cells;
  if (automatic) {
    const policy=hintRoutingFrame(heights);
    const result=constrainedIncremental(request,unresized,{...(work.automaticPools??automaticIncrementalBudget())},{left:ORIGIN_X,right:maxWidth},
      Math.min(work.remaining,work.automaticRemaining??work.remaining),(source,charge,choose)=>guardedWorld(()=>{
        const selected=policy(source,charge,choose);
        if ('reason' in selected)return selected;
        const provisional=captureFramedIncrementalRouting(request,unresized,selected.preferred,selected.frames,charge);
        if (!('problem'in provisional))return provisional;
        const rawWitness={fragments:provisional.fragments!,sources:sourceLocals},targetOrigins=new Map<string,{x:number;y:number}>();
        for(const local of sourceLocals)for(const route of local.drawing.routes){
          const consumer=eachConsumer(route)[Symbol.iterator]().next().value,owner=consumer&&worldGet(owners,consumer.parent,charge,'preferred source route owner'),cover=owner&&worldGet(selected.preferred.nodes,nodeKeyWithCharge(owner,charge),charge,'preferred source owner frame');
          if(!owner||!cover)continue;const old=worldGet(snapshot.graphs,owner,charge,'preferred original graph origin');
          worldSet(targetOrigins,worldGet(local.routes,route.id,charge,'preferred retained route alias')!,{x:old?.origin.x??0,y:cover.y},charge,'preferred retained route origin');
        }
        const preferred=preferredWorldNativeTemplates(rawWitness,selected.preferred,targetOrigins,charge);
        if(!preferred)return {reason:'metric-conflict' as const,constraints:['source-local protected template/world frame']};
        const captured=captureFramedIncrementalRouting(request,unresized,preferred,selected.frames,charge);
        if (!('problem'in captured))return captured;
        oracle=captured;witness={fragments:captured.fragments!,sources:sourceLocals};
        return {...selected,preferred};
      }), (drawing,admitCharge)=>guardedWorld(()=>{
        // finish is a pure recomposition from fixed source facts. Its independent
        // source-local and actual-world checks run inside this exact attempt.
        return finish(drawing,admitCharge)?null:{reason:'metric-conflict' as const,constraints:['world final source/local/publication frame']};
      }));
    work.remaining-=result.work;if(work.automaticRemaining!==undefined)work.automaticRemaining-=result.work;
    countLayoutWork('incremental-routing-work',result.work);
    if(!result.ok)throw new WorldPlacementDecline(result.conflict);
    return finish(result.drawing,charge);
  }
  // Search both retained-wire choices: reserving future departures can protect the next insertion,
  // while an unreserved route can leave the existing departure-repair pass a viable alternative.
  const retainedRequest = { ...request, items: items.filter(item => nodes.has(item.key)) };
  const histories = [
    () => !shiftHintColumns ? resizedLayout(unresized, heights) : null,
    () => rerouteResizedHistory(request, unresized, heights, shiftHintColumns, ORIGIN_X),
    () => missing.length ? rerouteResizedHistory(retainedRequest, unresized, heights, shiftHintColumns, ORIGIN_X) : null,
  ];
  for (const history of histories) {
    const previous = history();
    if (!previous) continue;
    const placed = missing.length || !hasHintChanges ? incrementalWorld(request, previous, undefined, ORIGIN_X)
      ?? incrementalWorld({ ...request, maxWidth: Math.min(100_000, maxWidth + missing.reduce((sum,n) => sum + n.width + 64,64)) }, previous, undefined, ORIGIN_X) : previous;
    const result = placed && finish(placed);
    if (result) return result;
    const repaired = placed && repairRouteContacts(placed, request, 'folder');
    const repairedResult = repaired && finish(repaired);
    if (repairedResult) return repairedResult;
  }
  return worldReject('pinned-placement.ts:271');

  function finish(placed: GraphLayout, charge:(n:number,s?:string)=>void=()=>{}): FolderLayout | null {
    const scope=(kind:string,id:string,key='')=>worldKey([kind,id,key],charge),nodeKey=(key:string)=>nodeKeyWithCharge(key,charge);
    if(automatic){chargeRoutingSnapshot(placed,charge);charge(64*(placed.nodes.size+placed.routes.length+placed.junctions.size+unplacedCells.size+1)**2
      +placed.routes.reduce((sum,r)=>sum+128*r.path.length,0),'world finish bounded preparation');}
    const cells = worldCopy(unplacedCells,charge,'published host cell identity index');
    // Host cells follow their already validated world tile, never a band's allocation height.
    for (const [id, cell] of cells) {
      charge(id.length+1,'published host owner lookup');const cover = worldGet(placed.nodes,plans.has(id) ? nodeKey(id) : scope('cell', id),charge,'published host cover lookup');
      if (!cover) return worldReject('completed world host cover missing','topology-conflict');
      worldSet(cells,id, { ...cell, y: cover.y },charge,'published host cover position');
    }

    const graphs = new Map<GraphId, FolderGraph>(), bands: GridBand[] = [];
    const ownerRoutes = new Map<string, PlacedRoute[]>(), ownerJoins = new Map<string, Set<string>>();
    const placedRouteIndex=worldIndex(placed.routes,route=>route.id,charge,'published original world route indexes');
    const publishedRoutes=new Map<string,ReadonlyMap<string,PlacedRoute>>(),publishedJoins=new Map<string,ReadonlyMap<string,PlacedJunction>>();
    for (const r of placed.routes) {
      const consumer = eachConsumer(r)[Symbol.iterator]().next().value, owner = consumer && worldGet(identities,consumer.parent,charge,'published route owner identity')?.graph;
      if (!owner) return worldReject('completed route owner missing','topology-conflict');
      const list = worldGet(ownerRoutes,owner,charge,'published route owner group') ?? []; list.push(r); worldSet(ownerRoutes,owner,list,charge,'published route owner grouping');
      const joins = worldGet(ownerJoins,owner,charge,'published dot owner group') ?? new Set<string>();
      for (const e of [r.from, r.to]) if (e.kind === 'junction'){charge(e.id.length+1,'published dot endpoint identity');joins.add(e.id);}
      worldSet(ownerJoins,owner,joins,charge,'published dot owner grouping');
    }
    let bounds: GridRect | null = { x: 0, y: 0, width: snapshot.size.width, height: snapshot.size.height };
    for (const cell of cells.values()) bounds = unionRect(bounds, cell);
    for (const [id, { plan }] of plans) {
      const old = worldGet(snapshot.graphs,id,charge,'published original graph identity'), cell = worldGet(cells,id,charge,'published graph host cell')!, origin = { x: old?.origin.x??0, y: cell.y };
      const localNodes = new Map<string, PlacedNode>(), localJoins = new Map<string, PlacedJunction>();
      const routeWorld = new Map<string, PlacedRoute>(), joinWorld = new Map<string, PlacedJunction>();
      const localNode = (key: string) => worldGet(identities,key,charge,'published local tile identity')!.key;
      const localJoin = (key: string) => worldGet(oldJunctions,key,charge,'published local dot identity') ?? scope('folder-junction', key);
      let envelope: GridRect | null = null;
      for (const item of plan.request.items) {
        const n = worldGet(placed.nodes,scope('node', id, item.key),charge,'published local tile lookup'); if (!n) return worldReject('completed visible tile missing','topology-conflict');
        const local = { ...n, key: item.key, x: n.x - origin.x - ORIGIN_X, y: n.y - origin.y };
        worldSet(localNodes,item.key,local,charge,'published local tile insertion'); bounds = unionRect(bounds, { ...n, x: n.x - ORIGIN_X });
        if (item.key !== id) envelope = unionRect(envelope, { ...n, x: n.x - ORIGIN_X });
      }
      for (const key of worldGet(ownerJoins,id,charge,'published owner dots') ?? []) {
        const j = worldGet(placed.junctions,key,charge,'published dot lookup'); if (!j) return worldReject('completed referenced junction missing','topology-conflict');
        const local = localJoin(key);
        worldSet(joinWorld,local,j,charge,'published actual dot alias');
        worldSet(localJoins,local,{ ...j, id: local, x: j.x - origin.x - ORIGIN_X, y: j.y - origin.y, parents: j.parents.map(localNode) },charge,'published local dot insertion');
      }
      const localRoutes = mapRouteConsumers(worldGet(ownerRoutes,id,charge,'published owner routes') ?? [], c => ({ parent: localNode(c.parent), child: localNode(c.child) })).map(r => {
        const endpoint = (e: PlacedRoute['from']) => ({ ...e, id: e.kind === 'node' ? localNode(e.id) : localJoin(e.id) });
        bounds = unionRect(bounds, paneRouteBounds(r.path, input.width, -ORIGIN_X));
        const routeId = worldGet(oldRoutes,r.id,charge,'published retained route identity') ?? scope('folder-route', r.id);
        worldSet(routeWorld,routeId,worldGet(placedRouteIndex,r.id,charge,'published original world route')!,charge,'published actual route alias');charge(40*(r.path.length+1),'published local path field serialization');
        return { ...r, id: routeId, from: endpoint(r.from), to: endpoint(r.to),
          path: mapPathNumbers(r.path, (v, i) => v - (i % 2 ? origin.y : origin.x + ORIGIN_X)) };
      });
      worldSet(publishedRoutes,id,routeWorld,charge,'published owner route alias indexes');worldSet(publishedJoins,id,joinWorld,charge,'published owner dot alias indexes');
      const { routingAttachment: _rawFrame, ...priorDrawing } = old?.attached??{orientation:'down' as const,readingOrder:new Map<string,number>()};
      let attached: GraphLayout = { ...priorDrawing, nodes: localNodes, junctions: localJoins, routes: localRoutes, rows: [],
        width: Math.max(0, Math.max(snapshot.size.width, placed.width - ORIGIN_X) - origin.x), height: placed.height - origin.y, bandBounds: undefined,
        decision: { candidate: 'folder-pinned-extension', stability: true } };
      if(automatic){
        if(!witness)return worldReject('pinned-placement.ts:328');
        const restored=restoreWorldNativeLocal(witness,id,attached,origin,routeWorld,placed.nodes,joinWorld,charge);
        if(!restored)return worldReject('pinned-placement.ts:330');
        attached={...restored,decision:{candidate:hasHintChanges?'folder-hint-constrained-world':'folder-constrained-extension',stability:true}};
      }
      if (placed.decision?.candidate === 'constrained-incremental-world' && !hasHintChanges && !automatic) {
        for (const [sourceId, frame] of frames) {
          if (owners.get(sourceId) !== id) continue;
          const world: GraphLayout = { ...attached,
            nodes: new Map([...attached.nodes].map(([key, n]) => [key, { ...n, x: placed.nodes.get(nodeKey(key))!.x, y: placed.nodes.get(nodeKey(key))!.y }])),
            junctions: new Map([...attached.junctions].map(([key, dot]) => {
              const world = joinWorld.get(key)!;
              return [key, { ...dot, x: world.x, y: world.y }];
            })),
            routes: attached.routes.map(route => ({ ...route, path: routeWorld.get(route.id)!.path })),
          };
          const rebased = rebaseRetainedRoutingFrame(frame.problem, world, attached, { source: frame.origin, target: origin,
            targetTransform: {
              nodes: { x: [{ operation: 'add', operand: origin.x }, { operation: 'add', operand: ORIGIN_X }], y: [{ operation: 'add', operand: origin.y }] },
              paths: { x: [{ operation: 'add', operand: origin.x + ORIGIN_X }], y: [{ operation: 'add', operand: origin.y }] },
            } }, charge);
          if (!rebased.ok) {
            countLayoutWork('incremental-legacy-fallback:metric-conflict');
            return worldReject('pinned-placement.ts:351');
          }
          attached = rebased.drawing;
        }
        attached = { ...attached, decision: { candidate: 'folder-constrained-extension', stability: true } };
      }
      // The raw band cache remains keyed by its request. World placement is only the attached
      // drawing; caching it as a raw band would reattach it and make later clicks path-dependent.
      // A world drawing is never raw cache authority. Omit unavailable canonical metadata.
      const {canonical:_oldCanonical,...metadata}=old??{};
      const placement=old?.placement??{x:0,coverX:cell.x+cell.width/2,coverHeight:cell.height,width:input.width,left:0,right:input.width};
      worldSet(graphs,id,{...metadata,id,placement,plan,layout:attached,attached,origin,worldPlaced:true},charge,'published graph identity insertion');
      const band = envelope ?? { x: cell.x, y: cell.y + cell.height, width: 0, height: 0 };
      bands.push({ ...band, id, row: cell.row });
    }
    const rowBounds = new Map<number, GridRect>();
    for (const band of bands) rowBounds.set(band.row, unionRect(rowBounds.get(band.row) ?? null, band)!);
    const rowBands = [...rowBounds].map(([row, rect]) => ({ ...rect, row, id: `row:${row}` }));
    const result: FolderLayout = { columns: snapshot.columns, size: { width: Math.max(snapshot.size.width, bounds!.x + bounds!.width), height: Math.max(snapshot.size.height, bounds!.y + bounds!.height) },
      bounds: bounds!, cells, bands, rowBands, graphs };
    const painted = withCellFootprints(result, input);
    if(automatic){
      if(!oracle?.fragments)return worldReject('pinned-placement.ts:371');
      const worldNodes=worldCopy(placed.nodes,charge,'actual painted tile index'),worldJoins=worldCopy(placed.junctions,charge,'actual painted dot index');
      const routes=new Map<string,PlacedRoute>();
      for(const [id,g]of painted.graphs){
        const routeAliases=worldGet(publishedRoutes,id,charge,'actual owner route aliases')!,joinAliases=worldGet(publishedJoins,id,charge,'actual owner dot aliases')!;
        for(const [key,j]of g.attached.junctions){const worldKey=worldGet(joinAliases,key,charge,'actual dot identity alias')?.id;if(!worldKey)return worldReject('actual dot identity missing','topology-conflict');worldSet(worldJoins,worldKey,{...j,id:worldKey,x:(j.x+g.origin.x)+ORIGIN_X,y:j.y+g.origin.y,parents:j.parents.map(nodeKey)},charge,'actual painted dot publication');}
        for(const [key,n]of g.attached.nodes){const worldKey=nodeKey(key);worldSet(worldNodes,worldKey,{...n,key:worldKey,x:(n.x+g.origin.x)+ORIGIN_X,y:n.y+g.origin.y},charge,'actual painted tile publication');}
        for(const route of g.attached.routes){const actual=worldGet(routeAliases,route.id,charge,'actual route identity alias');if(!actual)return worldReject('actual route identity missing','topology-conflict');
          charge(40*(route.path.length+1),'actual painted path field serialization');worldSet(routes,actual.id,{...actual,path:mapPathNumbers(route.path,(v,i)=>v+(i%2?g.origin.y:g.origin.x+ORIGIN_X))},charge,'actual painted route publication');}
      }
      const world:GraphLayout={...placed,nodes:worldNodes,junctions:worldJoins,routes:placed.routes.map(route=>worldGet(routes,route.id,charge,'actual world route publication')??route)};
      const held=bindRoutingFragmentTopology(oracle.fragments,world,charge,true);if(!held.ok){return worldReject('pinned-placement.ts:384');}
    }
    const finalConflict=certifyWorldFolder(painted,charge);if(finalConflict)throw new WorldPlacementDecline(finalConflict);
    prepayFolderRectangles(snapshot,painted,charge);
    if(!preservesFolderRectangles(painted,snapshot))return worldReject('retained folder rectangle frame','metric-conflict');
    return painted;
  }
}

function chargeWorld(work:IncrementalWorkBudget){return (amount:number,reason?:string)=>{if(!Number.isFinite(amount)||amount<0||amount>work.remaining||(work.automaticRemaining!==undefined&&amount>work.automaticRemaining))throw new RoutingConflictError({kind:'search-exhausted',constraints:['shared folder work',reason??'world work']});work.remaining-=amount;if(work.automaticRemaining!==undefined)work.automaticRemaining-=amount;countLayoutWork('incremental-routing-work',amount);};}
