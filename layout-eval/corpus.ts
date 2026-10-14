import { projectDag, projectReferenceBadges } from '../src/lib/domain/trace-graph/projection';
import { planBandScene } from '../src/lib/domain/trace-graph/scene';
import { tileMetrics } from '../src/lib/domain/trace-graph/metrics';
import type { TraceNode } from '../src/lib/domain/trace-graph/model';
import type { LayoutRequest } from '../src/lib/domain/trace-graph/layout';
export interface Case {
    readonly id: string;
    readonly nodes: readonly TraceNode[];
    readonly focuses: readonly (string | null)[];
    readonly full?: boolean;
    readonly note?: string;
}
export const node = (key: string, parents: readonly string[] = [], order = 0): TraceNode => ({ key, parents, order, artifactId: order, runId: null, path: `${key}.png`, scope: 'current', location: '', state: 'present', temporary: false, discarded: false, earlierRevision: false, prompt: key });
export const chain = (n: number) => Array.from({ length: n }, (_, i) => node(i ? `n${i}` : 'root', i ? [i === 1 ? 'root' : `n${i - 1}`] : [], i));
const fan = (n: number) => [node('root'), ...Array.from({ length: n }, (_, i) => node(`f${i}`, ['root'], i + 1))];
export const screenshot: Case = { id: 'screenshot', nodes: [node('root'), node('Cerulean', ['root'], 1), node('Saffron', ['root'], 2), node('Cerulean-hidden', ['Cerulean'], 3), node('Blastoise', ['Saffron'], 4), node('Ash', ['Saffron'], 5), node('Ash-hidden', ['Ash'], 6)], focuses: [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null], note: 'Exact seven-node topology implied by the screenshot: hidden children of Cerulean and Ash. Their filenames and creation timestamps are unavailable; this fixes sibling order to match the image.' };
const hidden = [node('root'), ...Array.from({ length: 18 }, (_, i) => node(`p${i}`, ['root'], i + 1)), ...Array.from({ length: 18 }, (_, i) => node(`q${i}`, [`p${i}`], i + 19)), ...Array.from({ length: 18 }, (_, i) => node(`r${i}`, [`q${i}`], i + 37))];
const mixed = [node('root'), node('short', ['root'], 1), ...Array.from({ length: 14 }, (_, i) => node(`long${i}`, [i ? `long${i - 1}` : 'root'], i + 2)), ...Array.from({ length: 6 }, (_, i) => node(`side${i}`, [`long${i * 2}`], i + 16))];
const merge = [node('root'), node('a', ['root'], 1), node('b', ['root'], 2), node('c', ['root'], 3), node('ab', ['a', 'b'], 4), node('abc', ['a', 'b', 'c'], 5), node('last', ['ab', 'abc'], 6)];
const shared = [node('root'), ...Array.from({ length: 8 }, (_, i) => node(`p${i}`, ['root'], i + 1)), ...Array.from({ length: 7 }, (_, i) => node(`m${i}`, [`p${i}`, `p${i + 1}`], i + 9))];
export const handCases: readonly Case[] = [screenshot,
    { id: 'empty', nodes: [], focuses: [null], full: true }, { id: 'single', nodes: [node('root')], focuses: [null] },
    ...[8, 30, 80, 200].map(n => ({ id: `fan-${n}`, nodes: fan(n), focuses: [null, 'f0'] })),
    ...[8, 20, 80, 200].map(n => ({ id: `chain-${n}`, nodes: chain(n), focuses: [null, 'n1', `n${Math.floor(n / 2)}`, `n${n - 1}`, 'n1'], full: false })),
    { id: 'mixed-depth', nodes: mixed, focuses: [null, 'long2', 'long7', 'long13', 'short'] },
    { id: 'hidden-siblings', nodes: hidden, focuses: [null, 'p0', 'p8', 'q8', 'p17', null] },
    { id: 'merges-3', nodes: merge, focuses: [null, 'a', 'ab', 'abc', 'last', null] },
    { id: 'overlapping-merges', nodes: shared, focuses: [null, 'p0', 'p4', 'm4'], full: true },
    { id: 'foreign-and-placeholder', nodes: [node('root'), { ...node('outside'), scope: 'external', path: '/outside.png' }, node('edited', ['root', 'outside'], 2), { ...node('placeholder', ['edited'], 3), path: null, state: 'running' }], focuses: [null, 'edited', 'placeholder'] },
    { id: 'malformed-cycle', nodes: [node('root'), node('a', ['root', 'b', 'a', 'unknown'], 1), node('b', ['a', 'a'], 2), node('a', ['b'], 5)], focuses: [null, 'a', 'b'] },
];
export function rng(seed: number): () => number { let value = seed >>> 0; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; }; }
function randomCase(seed: number, n: number, shape: 'tree' | 'dag' | 'bushy' | 'chainy'): Case {
    const random = rng(seed);
    const nodes = [node('root')];
    for (let i = 1; i < n; i++) {
        const parent = shape === 'chainy' && random() < .8 ? i - 1 : shape === 'bushy' ? Math.floor(random() * Math.min(i, 8)) : Math.floor(random() * i);
        const parents = new Set([nodes[parent].key]);
        if (shape === 'dag' && i > 2 && random() < .5)
            for (let j = 0; j < 1 + Math.floor(random() * 3); j++)
                parents.add(nodes[Math.floor(random() * i)].key);
        nodes.push(node(`n${i}`, [...parents], i));
    }
    return { id: `random-${shape}-${n}-${seed}`, nodes, focuses: [null, `n${Math.floor(n / 3)}`, `n${Math.floor(n * 2 / 3)}`, `n${n - 1}`, null], full: seed % 3 === 0 };
}
/**
 * Dense tour cases: most tiles merge several earlier ones (up to `fanIn` parents). The broad
 * corpus's DAGs have at most four parents per tile and merge half the time, so anchor
 * stability is measured separately at higher fan-in (reveals.ts, the "dense" tours).
 */
function denseCase(seed: number, n: number, fanIn: number): Case {
    const random = rng(seed);
    const nodes = [node('root')];
    for (let i = 1; i < n; i++) {
        const parents = new Set([nodes[Math.floor(random() * i)].key]);
        if (i > 2 && random() < .8)
            for (let j = 0; j < 1 + Math.floor(random() * (fanIn - 1)); j++)
                parents.add(nodes[Math.floor(random() * i)].key);
        nodes.push(node(`n${i}`, [...parents], i));
    }
    return { id: `dense-f${fanIn}-${n}-${seed}`, nodes, focuses: [null] };
}
export function denseCorpus(): readonly Case[] { return [4, 10].flatMap(fanIn => [40, 100].flatMap(n => [1, 2, 3].map(k => denseCase(20000 + 100 * fanIn + n + k, n, fanIn)))); }
export function corpus(): readonly Case[] { return [...handCases, ...(['tree', 'dag', 'bushy', 'chainy'] as const).flatMap((shape, s) => [12, 40, 100, 200].flatMap(n => [1, 2, 3].map(k => randomCase(7000 + 100 * s + 10 * n + k, n, shape))))]; }
export function requestFor(c: Case, focus: string | null, width: number, imagePx: number, hint?: ReadonlyMap<string, number>): LayoutRequest {
    const graph = projectReferenceBadges(projectDag(c.nodes));
    const members = graph.dag.order;
    const tile = tileMetrics(imagePx);
    const pin = { key: members.includes('root') ? 'root' : members[0] ?? 'root', x: Math.max(tile.width / 2, Math.min(width - tile.width / 2, width * .75)) };
    const request = planBandScene(graph, members, focus, width, { pinned: pin, tile, hint }).request;
    return c.full ? { ...request, items: request.band!.items } : request;
}
