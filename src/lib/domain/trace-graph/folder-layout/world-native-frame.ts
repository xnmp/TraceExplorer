import { worldReject } from './world-result';
/** Fixed original-local native authority, checked against actual forward paint. */
import type { GraphLayout, PlacedRoute, PlacedNode } from '../layout';
import type { RetainedRoutingFragments } from '../routing-fragments';
import { importRoutingPlan, type NativeInk, type RoutingPlan } from '../routing-plan';
import { mapPathNumbers } from '../path-data';
import { pathCommands, type Point } from '../path-sampling';
import { chargeRoutingSnapshot } from '../routing-problem';
import { worldCopy, worldGet, worldSet, worldIndex, worldGroups, worldKey, worldPositions, nextWorldPosition, type WorldCharge as Charge } from './world-indexes';
export interface LocalSource {
    readonly drawing: GraphLayout;
    readonly origin: Point;
    readonly nodes: ReadonlyMap<string, string>;
    readonly routes: ReadonlyMap<string, string>;
    readonly junctions: ReadonlyMap<string, string>;
}
export interface WorldWitness {
    readonly fragments: RetainedRoutingFragments;
    readonly sources: readonly LocalSource[];
}
const empty: readonly number[] = [];
function one(text: string, charge: Charge) { charge(8 * (text.length + 5), 'local native command parsing'); return pathCommands(text[0] === 'M' ? text : 'M0 0 ' + text)?.slice(-1); }
function raw(r: PlacedRoute, charge: Charge) { charge(4 * (r.path.length + 1), 'local native raw command indexing'); return [...r.path.matchAll(/[MLC][^MLC]*/g)].map(x => x[0]); }
function mappedRaw(text: string, map: (v: number) => number, charge: Charge) { charge(40 * (text.length + 1), 'local native raw field serialization'); let changed = false; const result = mapPathNumbers(text, v => { const next = map(v); changed ||= !Object.is(v, next); return next; }); return changed ? result : text; }
function recipes(w: WorldWitness, charge: Charge) {
    const frames = worldIndex(w.fragments.frames, f => f.output, charge, 'local frame output indexes'), cache = new Map<string, readonly number[]>();
    return (address: readonly (string | number)[]): readonly number[] => {
        charge(1, 'local frame address request');
        if (!frames.size)
            return empty;
        const key = worldKey(['scene', w.fragments.preferred.id, ...address], charge, 'local frame address serialization'), prior = worldGet(cache, key, charge, 'local frame cache lookup');
        if (prior)
            return prior;
        const frame = worldGet(frames, key, charge, 'local frame output lookup');
        charge((frame?.steps.length ?? 0) + 1, 'local frame ordered steps');
        const result = frame?.steps.map(s => s.operation === 'add' ? s.operand : -s.operand) ?? empty;
        worldSet(cache, key, result, charge, 'local frame cache insertion');
        return result;
    };
}
function planIndexes(plan: RoutingPlan, charge: Charge) {
    return {
        paths: worldIndex(plan.paths, p => p.id, charge, 'local imported path indexes'), ports: worldIndex(plan.ports, p => p.id, charge, 'local imported port indexes'), stubs: worldIndex(plan.stubs, p => p.id, charge, 'local imported stub indexes'),
        meetings: worldIndex(plan.meetings ?? [], m => m.id, charge, 'local imported meeting indexes'), inputs: new Map((plan.meetings ?? []).map(m => { charge(m.id.length + 1, 'local meeting input owner'); return [m.id, worldIndex(m.inputs, i => i.path, charge, 'local meeting input indexes')] as const; })),
    };
}
/** Hint additions precede rebasing; whole-component equal motion is locally
 * identity. Both independent actual forward recipes remain mandatory. */
export function localNativeCoordinate(value: number, hint: readonly number[], sourceOrigin: number, targetOrigin: number): number {
    const d = targetOrigin - sourceOrigin;
    if (hint.reduce((n, v) => n + v, 0) === d)
        return value;
    let next = value;
    for (const x of hint)
        next += x;
    return d === 0 ? next : next - d;
}
export function restoreWorldNativeLocal(w: WorldWitness, graphId: string, drawing: GraphLayout, origin: Point, worldRoutes: ReadonlyMap<string, PlacedRoute>, nodeWorld: ReadonlyMap<string, PlacedNode>, worldJoins: ReadonlyMap<string, Point & {
    id: string;
}>, charge: Charge): GraphLayout | null {
    chargeRoutingSnapshot([drawing, origin], charge);
    const recipe = recipes(w, charge), nodes = worldCopy(drawing.nodes, charge, 'local node index copy'), joins = worldCopy(drawing.junctions, charge, 'local dot index copy'), routes = worldIndex(drawing.routes, r => r.id, charge, 'local route indexes');
    const routeEntries = worldIndex(worldRoutes, e => e[1].id, charge, 'world route alias indexes', true), joinEntries = worldIndex(worldJoins, e => e[1].id, charge, 'world dot alias indexes', true), sourceWorld = planIndexes(w.fragments.source.plan, charge);
    const heldByRoute = worldGroups(w.fragments.fragments, f => f.route, charge, 'local native fragment route indexes'), intervals = worldGroups(w.fragments.intervals, i => i.route, charge, 'local departure interval indexes');
    const sourcePlans = new Map<LocalSource, {
        plan: RoutingPlan;
        indexes: ReturnType<typeof planIndexes>;
    }>(), primitiveIndices = new Map<string, Map<number, number>>();
    const localJoin = (source: LocalSource, key: string) => { const id = worldGet(source.junctions, key, charge, 'source dot identity lookup'); return id ? worldGet(joinEntries, id, charge, 'world dot identity lookup')?.[0] : undefined; };
    for (const source of w.sources) {
        chargeRoutingSnapshot(source.drawing, charge);
        charge(8 * (source.drawing.nodes.size + source.drawing.routes.length + 1), 'local source frame indexes');
        const sourcePlan = importRoutingPlan(source.drawing, charge), beforeIndexes = planIndexes(sourcePlan, charge);
        charge(1, 'local source plan cache insertion');
        sourcePlans.set(source, { plan: sourcePlan, indexes: beforeIndexes });
        for (const [key, old] of source.drawing.nodes) {
            const worldKey = worldGet(source.nodes, key, charge, 'source tile identity lookup'), now = worldGet(nodes, key, charge, 'local tile lookup');
            if (!worldKey || !now)
                continue;
            const metric = worldGet(nodeWorld, worldKey, charge, 'world tile lookup');
            if (!metric)
                return worldReject('retained world tile missing', 'topology-conflict');
            const restored = { ...now };
            for (const axis of ['x', 'y'] as const) {
                const ops = recipe(['tile', worldKey, axis]);
                restored[axis] = localNativeCoordinate(old[axis], ops, source.origin[axis], origin[axis]);
                const routed = axis === 'x' ? (restored.x + origin.x) + 8 : restored.y + origin.y;
                let painted = old[axis] + source.origin[axis];
                for (const d of ops)
                    painted += d;
                if (!Object.is(routed, metric[axis]) || !Object.is(restored[axis] + origin[axis], painted))
                    return worldReject('source local tile/actual paint frame');
            }
            worldSet(nodes, key, restored, charge, 'local tile frame publication');
        }
        for (const [key, old] of source.drawing.junctions) {
            const worldId = worldGet(source.junctions, key, charge, 'source dot alias lookup'), localId = localJoin(source, key), now = localId && worldGet(joins, localId, charge, 'local dot lookup'), metric = localId && worldGet(worldJoins, localId, charge, 'world dot lookup');
            if (!worldId || !localId || !now || !metric)
                continue;
            const restored = { ...now };
            for (const axis of ['x', 'y'] as const) {
                const ops = recipe(['dot', worldId, axis]);
                restored[axis] = localNativeCoordinate(old[axis], ops, source.origin[axis], origin[axis]);
                let painted = old[axis] + source.origin[axis];
                for (const d of ops)
                    painted += d;
                if (!Object.is(restored[axis] + origin[axis], painted) || !Object.is(axis === 'x' ? (restored.x + origin.x) + 8 : restored.y + origin.y, metric[axis]))
                    return worldReject('source local painted dot frame');
            }
            worldSet(joins, localId, restored, charge, 'local dot frame publication');
        }
        for (const path of sourcePlan.paths) {
            const worldId = worldGet(source.routes, path.id, charge, 'source route identity lookup');
            if (!worldId)
                continue;
            const entry = worldGet(routeEntries, worldId, charge, 'world route identity lookup');
            if (!entry)
                continue;
            const [localId, routed] = entry, next = worldGet(routes, localId, charge, 'local retained route lookup');
            if (!next)
                return worldReject('retained local route missing', 'topology-conflict');
            const parts = raw(next, charge), worldParts = raw(routed, charge), oldParts = raw(path.route!, charge);
            charge(8 * (routed.path.length + 1), 'world native command parsing');
            const worldCommands = pathCommands(routed.path);
            if (!worldCommands)
                return worldReject('world native command shape');
            const rawPositions = worldPositions(worldParts, charge), changed = new Set<number>();
            const paintPins: {
                command: number;
                scalar: number;
                old: number;
                axis: 'x' | 'y';
                ops: readonly number[];
            }[] = [];
            const transform = (v: number, axis: 'x' | 'y', address: readonly (string | number)[]) => localNativeCoordinate(v, recipe([...address, axis]), source.origin[axis], origin[axis]);
            const protectedPart = (command: number, sourcePart: number, primitive: number, native: NativeInk) => {
                if (!parts[command] || !oldParts[sourcePart] || !one(oldParts[sourcePart], charge)?.length)
                    return false;
                let scalar = 0;
                parts[command] = mappedRaw(oldParts[sourcePart], v => { const index = scalar, pair = Math.floor(scalar / 2), axis = scalar++ % 2 ? 'y' : 'x', j = native.length === 4 ? pair + 1 : 1, ops = recipe(['path', worldId, 'native', primitive, j, axis]); paintPins.push({ command, scalar: index, old: v, axis, ops }); return localNativeCoordinate(v, ops, source.origin[axis], origin[axis]); }, charge);
                changed.add(command);
                return true;
            };
            let headScalar = 0;
            parts[0] = mappedRaw(oldParts[0], v => { const scalar = headScalar, axis = headScalar++ % 2 ? 'y' : 'x', ops = recipe(['path', worldId, 'native', 0, 0, axis]); paintPins.push({ command: 0, scalar, old: v, axis, ops }); return localNativeCoordinate(v, ops, source.origin[axis], origin[axis]); }, charge);
            changed.add(0);
            let cursor = 0;
            for (const fragment of worldGet(heldByRoute, worldId, charge, 'local native fragment selection') ?? []) {
                const matches = worldGet(rawPositions, fragment.raw, charge, 'world native raw span lookup'), found = matches && nextWorldPosition(matches, cursor + 1, charge);
                if (found === undefined || found < 1)
                    return worldReject('protected native span identity');
                let positions = worldGet(primitiveIndices, worldId, charge, 'native primitive owner lookup');
                if (!positions) {
                    positions = new Map();
                    worldSet(primitiveIndices, worldId, positions, charge, 'native primitive owner insertion');
                }
                charge(1, 'native primitive position insertion');
                positions.set(fragment.primitive, found - 1);
                const originalNative = path.native[fragment.primitive];
                if (!protectedPart(found, fragment.primitive + 1, fragment.primitive, originalNative))
                    return worldReject('original local native span shape');
                const start = originalNative[0], address = ['path', worldId, 'native', fragment.primitive, 0] as const, previous = one(parts[found - 1], charge);
                if (!previous?.length)
                    return worldReject('protected native preceding command');
                const values = [...previous[0].values];
                values[values.length - 2] = transform(start.x, 'x', address);
                values[values.length - 1] = transform(start.y, 'y', address);
                paintPins.push({ command: found - 1, scalar: values.length - 2, old: start.x, axis: 'x', ops: recipe([...address, 'x']) }, { command: found - 1, scalar: values.length - 1, old: start.y, axis: 'y', ops: recipe([...address, 'y']) });
                let n = 0;
                parts[found - 1] = mappedRaw(parts[found - 1], () => values[n++], charge);
                changed.add(found - 1);
                cursor = found;
            }
            if (path.stub) {
                const localStub = worldGet(beforeIndexes.stubs, path.stub, charge, 'source arrow stub lookup')!, worldPath = worldGet(sourceWorld.paths, worldId, charge, 'world source path lookup')!, end = parts.length - 1, c = one(parts[end], charge);
                if (!c?.length)
                    return worldReject('local terminal command shape');
                const values = [...c[0].values];
                for (const [axis, index] of [['x', values.length - 2], ['y', values.length - 1]] as const) {
                    const ops = recipe(['stub', worldPath.stub!, 'base', axis]);
                    values[index] = localNativeCoordinate(localStub.base[axis], ops, source.origin[axis], origin[axis]);
                    paintPins.push({ command: end, scalar: index, old: localStub.base[axis], axis, ops });
                }
                let n = 0;
                parts[end] = mappedRaw(parts[end], () => values[n++], charge);
                changed.add(end);
            }
            const restored = { ...next, path: parts.join('') };
            for (const pin of paintPins) {
                const command = one(parts[pin.command], charge);
                if (!command?.length)
                    return worldReject('local paint command');
                const actual = command[0].values[pin.scalar] + origin[pin.axis];
                let expected = pin.old + source.origin[pin.axis];
                for (const d of pin.ops)
                    expected += d;
                if (!Object.is(actual, expected))
                    return worldReject('local actual paint differs from source frame');
            }
            charge(40 * (restored.path.length + 1), 'local route forward field serialization');
            const forward = mapPathNumbers(restored.path, (v, i) => v + (i % 2 ? origin.y : origin.x + 8)), forwardParts = raw({ ...restored, path: forward }, charge);
            for (const command of changed) {
                const a = one(forwardParts[command], charge), b = worldCommands[command];
                if (!a?.length || !b || a[0].kind !== b.kind || a[0].values.some((v, i) => !Object.is(v, b.values[i])))
                    return worldReject('local native forward/metric frame');
            }
            worldSet(routes, localId, restored, charge, 'local native route publication');
        }
    }
    const result = { ...drawing, nodes, junctions: joins, routes: drawing.routes.map(r => worldGet(routes, r.id, charge, 'local drawing route publication')!) }, after = importRoutingPlan(result, charge), afterIndexes = planIndexes(after, charge);
    for (const source of w.sources) {
        charge(1, 'local source plan cache lookup');
        const { plan: before, indexes: beforeIndexes } = sourcePlans.get(source)!;
        for (const p of before.paths) {
            const id = worldGet(source.routes, p.id, charge, 'source route validation identity'), entry = id && worldGet(routeEntries, id, charge, 'world route validation identity');
            if (!entry)
                continue;
            const q = worldGet(afterIndexes.paths, entry[0], charge, 'local route validation identity');
            if (!q)
                return worldReject('retained local path missing', 'topology-conflict');
            for (const [oldId, newId] of [[p.start, q.start], [p.end, q.end]]) {
                const a = worldGet(beforeIndexes.ports, oldId, charge, 'source native port lookup')!, b = worldGet(afterIndexes.ports, newId, charge, 'local native port lookup');
                if (!b)
                    return worldReject('retained native port missing', 'topology-conflict');
                const owner = a.owner.kind === 'junction' ? (localJoin(source, a.owner.id) ?? a.owner.id) : a.owner.id;
                charge(owner.length + b.owner.id.length + 1, 'local native port semantic comparison');
                if (a.owner.kind !== b.owner.kind || owner !== b.owner.id || a.side !== b.side)
                    return worldReject('retained native port owner/face');
            }
            for (const interval of worldGet(intervals, id!, charge, 'local departure intervals') ?? []) {
                const native = p.native[interval.primitive], actual = q.native[interval.primitive], axis = interval.axis, other = axis === 'x' ? 'y' : 'x', head = p.native[0][0];
                if (!actual || actual.length !== 2)
                    return worldReject('local departure interval primitive');
                const boundary = { ...native[0], [axis]: head[axis] + (interval.forward ? 6 : -6) }, expected = { x: localNativeCoordinate(boundary.x, recipe(['path', id!, 'native', interval.primitive, 0, 'x']), source.origin.x, origin.x), y: localNativeCoordinate(boundary.y, recipe(['path', id!, 'native', interval.primitive, 0, 'y']), source.origin.y, origin.y) };
                if (actual[0][other] !== expected[other] || actual[1][other] !== expected[other] || (interval.forward ? actual[1][axis] < expected[axis] : actual[1][axis] > expected[axis]))
                    return worldReject('local exact departure interval');
            }
            if (p.stub) {
                const a = worldGet(beforeIndexes.stubs, p.stub, charge, 'source terminal stub validation')!, b = q.stub && worldGet(afterIndexes.stubs, q.stub, charge, 'local terminal stub validation'), wp = worldGet(sourceWorld.paths, id!, charge, 'source world terminal path')!;
                if (!b)
                    return worldReject('retained arrow stub missing', 'topology-conflict');
                for (const field of ['base', 'tip'] as const)
                    for (const axis of ['x', 'y'] as const) {
                        const expected = localNativeCoordinate(a[field][axis], recipe(['stub', wp.stub!, field, axis]), source.origin[axis], origin[axis]);
                        if (!Object.is(expected, b[field][axis]))
                            return worldReject('source local terminal field frame');
                    }
            }
        }
        for (const meeting of before.meetings ?? []) {
            const target = localJoin(source, meeting.id) ?? meeting.id, actualMeeting = worldGet(afterIndexes.meetings, target, charge, 'local retained meeting lookup'), inputs = actualMeeting && worldGet(afterIndexes.inputs, target, charge, 'local retained meeting input owner');
            for (const input of meeting.inputs) {
                const worldId = worldGet(source.routes, input.path, charge, 'source convergence route identity'), entry = worldId && worldGet(routeEntries, worldId, charge, 'world convergence route identity');
                if (!entry)
                    continue;
                const current = inputs && worldGet(inputs, entry[0], charge, 'local convergence input identity'), positions = worldGet(primitiveIndices, worldId!, charge, 'convergence native primitive owner');
                charge(1, 'convergence native primitive position');
                const primitive = positions?.get(input.entry.primitive);
                if (!current || current.entry.side !== input.entry.side || current.entry.primitive !== primitive || !Object.is(current.entry.parameter, input.entry.parameter))
                    return worldReject('local complete convergence cut identity');
                for (const axis of ['x', 'y'] as const) {
                    const expected = localNativeCoordinate(input.entry.point[axis], recipe(['path', worldId!, 'native', input.entry.primitive, 0, axis]), source.origin[axis], origin[axis]);
                    if (!Object.is(current.entry.point[axis], expected))
                        return worldReject('local convergence source-field point');
                }
            }
        }
    }
    return result;
}
/** Select protected original-local templates before construction, never from a draft. */
export function preferredWorldNativeTemplates(w: WorldWitness, preferred: GraphLayout, targetOrigins: ReadonlyMap<string, Point>, charge: Charge): GraphLayout | null {
    const recipe = recipes(w, charge), routes = worldIndex(preferred.routes, r => r.id, charge, 'preferred route indexes'), held = worldGroups(w.fragments.fragments, f => f.route, charge, 'preferred fragment route indexes');
    for (const source of w.sources) {
        chargeRoutingSnapshot(source.drawing, charge);
        const plan = importRoutingPlan(source.drawing, charge);
        for (const path of plan.paths) {
            const id = worldGet(source.routes, path.id, charge, 'preferred source route identity'), route = id && worldGet(routes, id, charge, 'preferred world route lookup'), target = id && worldGet(targetOrigins, id, charge, 'preferred target origin lookup');
            if (!id || !route || !target)
                continue;
            const sourceRaw = raw(path.route!, charge), parts = raw(route, charge);
            charge(8 * (route.path.length + 1), 'preferred native command parsing');
            const commands = pathCommands(route.path);
            if (!commands)
                return worldReject('preferred template command shape');
            const selected = new Set((worldGet(held, id, charge, 'preferred native fragment lookup') ?? []).map(f => f.primitive + 1));
            selected.add(0);
            for (const command of selected) {
                const primitive = command ? command - 1 : 0, native = path.native[primitive];
                let scalar = 0;
                const text = mappedRaw(sourceRaw[command], v => { const pair = Math.floor(scalar / 2), axis = scalar++ % 2 ? 'y' : 'x', point = command ? (native.length === 4 ? pair + 1 : 1) : 0, local = localNativeCoordinate(v, recipe(['path', id, 'native', primitive, point, axis]), source.origin[axis], target[axis]); return local + (axis === 'x' ? target.x + 8 : target.y); }, charge), parsed = one(text, charge), actual = commands[command];
                if (!parsed?.length || !actual || parsed[0].kind !== actual.kind || parsed[0].values.some((v, i) => !Object.is(v, actual.values[i])))
                    return worldReject('source-field template cannot represent selected world frame');
                parts[command] = text;
            }
            worldSet(routes, id, { ...route, path: parts.join('') }, charge, 'preferred raw template publication');
        }
    }
    return { ...preferred, routes: preferred.routes.map(r => worldGet(routes, r.id, charge, 'preferred drawing route publication')!) };
}
