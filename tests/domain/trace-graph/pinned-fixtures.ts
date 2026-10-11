/** Production regression fixtures retained from the pinned-cover spike (19601c1). */
import { node, random } from "./fixtures";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { tileSize } from "$lib/domain/trace-graph/metrics";
import { visibleKeys } from "$lib/domain/trace-graph/visibility";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { LayoutItem, LayoutRequest } from "$lib/domain/trace-graph/layout";

export interface Case { id: string; name: string; nodes: TraceNode[]; cover: string; focus?: string }
const n = (key: string, parents: string[] = [], scope: TraceNode["scope"] = "current", order?: number) => node(key, parents, scope, order === undefined ? {} : { order });
export const widths = [380, 640, 1000];
// Four equal cells spanning the pane. At 380px, 92px tiles have only 3px
// gaps: this is the requested four-column context, not the production grid's
// responsive column count. Column 2 is the right middle.
export const columns = [0, 2, 3];
export function grid(width: number, column: number, cover: string): NonNullable<LayoutRequest["pinned"]> {
  const tile = tileSize({ foreign: false, hint: false });
  const center = (col: number) => (col + 0.5) * width / 4;
  return { key: cover, x: center(column), obstacles: [0, 1, 2, 3].filter((col) => col !== column).map((col) => ({ x: center(col) - tile.width / 2, width: tile.width })) };
}
export function coverOf(nodes: TraceNode[]): string {
  const byKey = new Map(nodes.map((entry) => [entry.key, entry]));
  const localRoots = nodes.filter((entry) => entry.scope === "current" && !entry.parents.some((parent) => byKey.get(parent)?.scope === "current"));
  return (localRoots.filter((entry) => entry.path).sort((a, b) => a.order - b.order)[0]
    ?? nodes.filter((entry) => entry.path).sort((a, b) => a.order - b.order)[0]).key;
}
export function itemsOf(nodes: TraceNode[]): LayoutItem[] {
  return nodes.map((entry) => ({ key: entry.key, parents: entry.parents, order: entry.order, ...tileSize({ foreign: entry.scope !== "current", hint: false }) }));
}
export function mostConnected(nodes: TraceNode[]): string {
  const dag = projectDag(nodes);
  return [...dag.order].sort((a, b) => (dag.parents.get(b)!.length + dag.children.get(b)!.length) - (dag.parents.get(a)!.length + dag.children.get(a)!.length))[0];
}
export function fixtures(): Case[] {
  const village = [n("village"), n("palette"), n("mist", [], "subfolder"), n("lantern", [], "external"),
    n("daylight", ["village"]), n("cool", ["palette"]), n("warm", ["village", "palette", "mist", "lantern"]),
    n("merge", ["daylight", "warm"]), n("evening", ["warm"]), n("rain", ["warm"])];
  const styled = [n("photo0"), ...Array.from({ length: 23 }, (_, i) => n(`photo${i + 1}`)), n("style", [], "subfolder"),
    ...Array.from({ length: 24 }, (_, i) => n(`output${i}`, [`photo${i}`, "style"]))];
  const deep = [n("cover"), n("r"), n("a", ["r"]), n("b", ["a"]), n("c", ["b"]), n("d", ["c", "cover"])];
  const partners = [n("cover"), ...Array.from({ length: 6 }, (_, i) => n(`r${i}`)), ...Array.from({ length: 6 }, (_, i) => n(`o${i}`, ["cover", `r${i}`]))];
  const roots = Array.from({ length: 8 }, (_, i) => n(`r${i}`));
  const pairs = [...roots, ...roots.flatMap((a, i) => roots.slice(i + 1).map((b) => n(`${a.key}+${b.key}`, [a.key, b.key])))];
  const diamond = [n("cover"), n("r"), n("a", ["cover"]), n("b", ["cover"]), n("c", ["a", "b", "r"])];
  const foreign = [n("cover", ["X"]), n("X", [], "external"), ...Array.from({ length: 3 }, (_, i) => n(`other${i}`, ["X"])), ...Array.from({ length: 3 }, (_, i) => n(`child${i}`, ["cover"]))];
  const reuse = [n("cover", ["X"]), n("X", [], "external"), n("c", ["cover", "X"])];
  const chain = [n("cover"), ...Array.from({ length: 20 }, (_, i) => n(`e${i + 1}`, [i ? `e${i}` : "cover"]))];
  const fan = [n("cover"), n("r0"), n("r1"), ...Array.from({ length: 30 }, (_, i) => n(`child${i}`, ["cover", ...(i < 10 ? [`r${Math.floor(i / 5)}`] : [])]))];
  const before = [n("coverA", [], "current", 0), n("a1", ["coverA"], "current", 2), n("coverB", [], "current", 1), n("b1", ["coverB"], "current", 3)];
  const after = [...before, node("m", ["coverA", "coverB"], "current", { order: 4, temporary: true, state: "running", path: null })];
  const base: Case[] = [
    { id: "01", name: "village", nodes: village, cover: "village" },
    { id: "02", name: "24 styled photos", nodes: styled, cover: "photo0" },
    { id: "03", name: "cover joins deep descendant", nodes: deep, cover: "cover" },
    { id: "04", name: "six distant partners", nodes: partners, cover: "cover" },
    { id: "05", name: "every pair of eight", nodes: pairs, cover: "r0" },
    { id: "06", name: "diamond plus root", nodes: diamond, cover: "cover" },
    { id: "07", name: "cover has external parent", nodes: foreign, cover: "cover" },
    { id: "08", name: "external parent reused by child", nodes: reuse, cover: "cover" },
    { id: "09", name: "depth twenty", nodes: chain, cover: "cover" },
    { id: "10", name: "thirty children", nodes: fan, cover: "cover" },
    ...connectedComponents(projectDag(before)).map((keys, i) => ({ id: `11-before-${i ? "B" : "A"}`, name: `before merge stack ${i ? "B" : "A"}`, nodes: before.filter((entry) => keys.includes(entry.key)), cover: i ? "coverB" : "coverA" })),
    { id: "11-after", name: "pending merged component", nodes: after, cover: coverOf(after) },
  ];
  const dag = projectDag(village);
  return [...base, ...["village", "warm", "merge"].map((focus) => {
    const visible = new Set(visibleKeys(dag, dag.order, focus));
    return { id: `12-${focus}`, name: `village visibility focus ${focus}`, nodes: village.filter((entry) => visible.has(entry.key)), cover: "village", focus };
  })];
}

/** Same family as layout.test.ts; uniform production tiles and at least two roots. */
export function randomDag(seed: number): TraceNode[] {
  const next = random(seed * 7919);
  const count = 8 + Math.floor(next() * 40), fanIn = 1 + Math.floor(next() * 4), locality = 2 + Math.floor(next() * 10);
  return Array.from({ length: count }, (_, index) => {
    const root = next() < 0.15 || index < 2;
    const parents = root ? [] : [...new Set(Array.from({ length: 1 + Math.floor(next() * fanIn) }, () => `n${Math.max(0, index - 1 - Math.floor(next() * Math.min(index, locality)))}`))];
    return n(`n${index}`, parents, "current", index);
  });
}
