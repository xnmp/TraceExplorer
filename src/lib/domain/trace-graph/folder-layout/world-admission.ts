/** Private paid view of the unchanged full-folder gate. Its world field recipe
 * is the gate's actual paint recipe, with no router margin or inverse transform. */
import type { GraphLayout, LayoutItem, PlacedNode, PlacedJunction, PlacedRoute } from '../layout';
import { RoutingConflictError } from '../layout';
import type { IncrementalWorkBudget } from '../band-incremental';
import type { IncrementalRoutingConflict } from '../incremental-routing';
import { chargeRoutingSnapshot } from '../routing-problem';
import { prepayIndependentAdmission } from '../routing-admission-work';
import { prepayRoutingGateSerialization, prepayRoutingSerialization } from '../routing-serialization-work';
import { chargeRoutingConsumers } from '../routing-consumer-work';
import { chargedNativeTileClearance, chargedNativeClearance } from '../native-route-clearance';
import { mapPathNumbers } from '../path-data';
import { isLayoutShape } from '../history-boundary';
import type { BandScenePlan } from '../scene';
import { folderGeometryGate } from './geometry-gate';
import type { FolderLayoutInput, FolderPlacementHistory } from './types';
import { WorldPlacementDecline, type FolderWorldPreferences } from './world-result';
import { worldKey, worldHas, worldGet, worldSet } from './world-indexes';
type Charge = (n: number, why?: string) => void;
const conflict = (reason: IncrementalRoutingConflict['reason'], ...constraints: string[]): IncrementalRoutingConflict => ({ reason, constraints });
const unsupported = (why: string): never => { throw new WorldPlacementDecline(conflict('unsupported-input', why)); };
export function prepayWorldInputs(input: FolderLayoutInput, plans: ReadonlyMap<string, {
    readonly plan: BandScenePlan;
}>, source: FolderPlacementHistory['layout'], preferences: FolderWorldPreferences, work: IncrementalWorkBudget): void {
    const charge: Charge = (n, why) => { if (!Number.isFinite(n) || n < 0 || n > work.remaining || (work.automaticRemaining !== undefined && n > work.automaticRemaining))
        throw new RoutingConflictError({ kind: 'search-exhausted', constraints: ['folder input work', why ?? 'work'] }); work.remaining -= n; if (work.automaticRemaining !== undefined)
        work.automaticRemaining -= n; };
    // Project preferences first: graph/cache properties are outside this interface.
    chargeRoutingSnapshot([input, plans, source, preferences?.cells, preferences?.cellFootprints], charge);
    if (!input || !Array.isArray(input.items) || !(plans instanceof Map) || !source || !(source.cells instanceof Map) || !(source.graphs instanceof Map) || !Array.isArray(source.bands) || !(preferences?.cells instanceof Map))
        unsupported('folder source/plans/host preferences shape');
    if (!Number.isFinite(input.width) || !input.tile || !input.grid || !Number.isFinite(source.size?.width) || !Number.isFinite(source.size?.height))
        unsupported('folder geometry dimensions');
    if (!Array.from(input.items).every(i => i && typeof i.id === 'string' && ['file', 'folder', 'stack'].includes(i.kind)) || new Set(input.items.map(i => i.id)).size !== input.items.length)
        unsupported('dense unique current host items');
    for (const [id, value] of plans) {
        const plan = value?.plan;
        if (typeof id !== 'string' || !plan?.request || !Array.isArray(plan.request.items) || !Array.from(plan.request.items).every(i => i && typeof i.key === 'string' && Array.isArray(i.parents)))
            unsupported('current band plan shape');
        if (!prepayRoutingSerialization(plan.request, charge))
            unsupported('current request serialization');
    }
    for (const [id, cell] of preferences.cells)
        if (typeof id !== 'string' || !cell || ![cell.x, cell.y, cell.width, cell.height].every(Number.isFinite) || cell.width <= 0 || cell.height <= 0 || !Number.isSafeInteger(cell.row) || cell.row < 0 || !Number.isSafeInteger(cell.col) || cell.col < 0)
            unsupported('finite host cell preference');
    // validHistory serializes the original request/layout basis; prepay its key
    // and conservative local geometry work before it executes, including cache hits.
    for (const [id, g] of source.graphs) {
        if (!g || !g.plan?.request || !Array.isArray(g.plan.request.items) || !isLayoutShape(g.attached) || !isLayoutShape(g.layout))
            unsupported('actual attached graph source shape');
        if (!prepayRoutingSerialization([id, g.plan.request, g.layout, g.attached, g.placement], charge))
            unsupported('source history serialization');
        for (const drawing of [g.layout, g.attached]) {
            chargeRoutingConsumers(drawing, charge);
            const items = g.plan.request.items.filter(i => worldHas(drawing.nodes, i.key, charge, 'history visible tile identity')).map(i => { const node = worldGet(drawing.nodes, i.key, charge, 'history physical tile identity')!; return { ...i, width: node.width, height: node.height }; });
            const tiles = chargedNativeTileClearance(drawing, charge);
            chargedNativeClearance(drawing, (n, why) => charge(2 * n, why));
            if (!prepayIndependentAdmission(drawing, items, tiles.ok ? tiles.samples : 32 * drawing.routes.reduce((n, r) => n + r.path.length, 0), charge) || !prepayRoutingGateSerialization(drawing, items, id, drawing.width, charge))
                unsupported('source local history admission reach');
        }
    }
}
export function certifyWorldFolder(folder: FolderPlacementHistory['layout'], charge: Charge): IncrementalRoutingConflict | null {
    chargeRoutingSnapshot(folder, charge);
    charge(16 * (folder.cells.size + folder.graphs.size + 1), 'folder actual paint preparation');
    const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [], items: LayoutItem[] = [];
    // The same identity transforms/hash operations execute again in the unchanged
    // oracle. Pay both views before either identity operation, including aliases.
    const identityCharge: Charge = (n, why) => charge(2 * n, why), covers = new Set<string>();
    for (const id of folder.graphs.keys()) {
        identityCharge(id.length + 1, 'folder cover identity insertion');
        covers.add(id);
    }
    for (const [id, cell] of folder.cells)
        if (!worldHas(covers, id, identityCharge, 'folder closed host membership')) {
            const key = worldKey(['cell', id], identityCharge, 'folder ordinary host key'), p = (folder.cellFootprints && worldGet(folder.cellFootprints, id, identityCharge, 'folder host footprint identity')) ?? cell;
            worldSet(nodes, key, { ...cell, ...p, key, band: 0 }, identityCharge, 'folder host obstacle identity');
            items.push({ key, width: p.width, height: p.height, parents: [], order: items.length });
        }
    for (const [id, g] of folder.graphs) {
        const key = (v: string) => worldKey(['graph', id, v], identityCharge, 'folder graph paint identity'), { attached, origin } = g;
        charge(8 * (attached.nodes.size + attached.junctions.size + attached.routes.length + g.plan.request.items.length + 1), 'folder actual paint aliases');
        chargeRoutingConsumers(attached, charge);
        for (const n of attached.nodes.values())
            worldSet(nodes, key(n.key), { ...n, key: key(n.key), x: n.x + origin.x, y: n.y + origin.y }, identityCharge, 'folder painted tile insertion');
        for (const j of attached.junctions.values())
            worldSet(junctions, key(j.id), { ...j, id: key(j.id), x: j.x + origin.x, y: j.y + origin.y, parents: j.parents.map(key) }, identityCharge, 'folder painted dot insertion');
        const tables = new Map<readonly unknown[], readonly {
            parent: string;
            child: string;
        }[]>();
        for (const r of attached.routes) {
            charge(80 * (r.path.length + 1), 'actual folder path forward and oracle');
            const c = r.consumers, range = Array.isArray(c) ? { entries: c, start: 0, end: c.length } : c as {
                entries: readonly {
                    parent: string;
                    child: string;
                }[];
                start: number;
                end: number;
            };
            let entries = tables.get(range.entries);
            if (!entries) {
                entries = range.entries.map(c => ({ parent: key(c.parent), child: key(c.child) }));
                tables.set(range.entries, entries);
            }
            routes.push({ ...r, id: key(r.id), from: { ...r.from, id: key(r.from.id) }, to: { ...r.to, id: key(r.to.id) }, consumers: { entries, start: range.start, end: range.end }, path: mapPathNumbers(r.path, (v, i) => v + (i % 2 ? origin.y : origin.x)) });
        }
        for (const item of g.plan.request.items) {
            const n = worldGet(attached.nodes, item.key, identityCharge, 'folder actual requested tile identity');
            items.push({ ...item, key: key(item.key), parents: item.parents.map(key), width: n?.width ?? item.width, height: n?.height ?? item.height });
        }
    }
    const drawing: GraphLayout = { nodes, junctions, routes, rows: [], readingOrder: new Map(), orientation: 'down', width: Math.max(folder.size.width, folder.bounds.x + folder.bounds.width), height: Math.max(folder.size.height, folder.bounds.y + folder.bounds.height) };
    if (!nodes.size)
        return folderGeometryGate(folder) ? conflict('unsupported-input', 'empty folder cell/frame validation') : null;
    const tiles = chargedNativeTileClearance(drawing, charge);
    if (!tiles.ok)
        return conflict('metric-conflict', 'actual folder native tile admission', tiles.failure);
    const native = chargedNativeClearance(drawing, (n, why) => charge(2 * n, why));
    if (native)
        return conflict('metric-conflict', 'actual folder native admission', native);
    if (!prepayIndependentAdmission(drawing, items, tiles.samples, charge))
        return conflict('unsupported-input', 'actual folder spatial reach');
    if (!prepayRoutingGateSerialization(drawing, items, nodes.keys().next().value!, drawing.width, charge))
        return conflict('unsupported-input', 'actual folder gate serialization');
    const failure = folderGeometryGate(folder);
    return failure ? conflict('metric-conflict', 'actual full folder gate', failure) : null;
}
/** Keep the product's unchanged rectangle oracle. Its possible nested hint
 * eligibility comparisons need an explicit byte bound in addition to entity
 * work; route/native identity indexes above remain linear. */
export function prepayFolderRectangles(before: FolderPlacementHistory['layout'], after: FolderPlacementHistory['layout'], charge: Charge): void {
    let bytes = 0, oldCount = before.cells.size;
    for (const folder of [before, after]) {
        for (const key of folder.cells.keys()) {
            charge(1, 'rectangle identity bound traversal');
            bytes += key.length + 1;
        }
        for (const graph of folder.graphs.values()) {
            if (folder === before)
                oldCount += graph.attached.nodes.size;
            for (const key of graph.attached.nodes.keys()) {
                charge(1, 'rectangle identity bound traversal');
                bytes += key.length + 1;
            }
        }
    }
    charge(8 * (oldCount + 2) * bytes, 'unchanged rectangle oracle identity bound');
}
