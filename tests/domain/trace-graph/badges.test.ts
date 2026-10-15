import { describe, expect, it } from "vitest";
import { BADGES_SHOWN, connectedComponents, projectDag, projectReferenceBadges, visibleBadges, type ReferenceBadge } from "$lib/domain/trace-graph/projection";
import { lineageWithBadges, toneOf } from "$lib/domain/trace-graph/lineage";
import { bandFocus, planBandScene, planScene, routeStyle } from "$lib/domain/trace-graph/scene";
import { componentRoots, visibleKeys } from "$lib/domain/trace-graph/visibility";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { node, sourcesReaching } from "./fixtures";

const sharedStyle = () => projectDag([
  node("style", [], "external"), node("a"), node("b"),
  node("a1", ["a", "style"]), node("b1", ["b", "style"]), node("a2", ["a1"]),
]);

describe("reference badge projection", () => {
  it("splits chains sharing only a reference and docks the same badge on each consumer", () => {
    const source = sharedStyle(), graph = projectReferenceBadges(source);
    expect(connectedComponents(source)).toHaveLength(1);
    expect(connectedComponents(graph.dag)).toEqual([["a", "a1", "a2"], ["b", "b1"]]);
    expect(graph.badges.get("style")).toEqual({ key: "style", path: "/pictures/style.png", scope: "external", consumers: ["a1", "b1"] });
    for (const key of ["a1", "b1"]) {
      expect(graph.byConsumer.get(key)).toEqual([graph.badges.get("style")]);
      expect(graph.dag.nodes.get(key)?.parents).not.toContain("style");
    }
    expect(graph.byConsumer.has("a")).toBe(false);
    expect(source.nodes.get("a1")?.parents).toEqual(["a", "style"]);
    expect(source.children.get("style")).toEqual(["a1", "b1"]);
  });

  it("keeps foreign descendants as tiles and all direct badges, including more than three", () => {
    const refs = Array.from({ length: 5 }, (_, i) => node(`ref${i}`, [], i % 2 ? "external" : "subfolder"));
    const source = projectDag([node("cover"), node("outside", ["cover"], "external"), ...refs,
      node("consumer", ["outside", ...refs.map((ref) => ref.key), "ref0"]),
      node("placeholder", [], "external", { artifactId: null, path: null, state: "running" })]);
    const graph = projectReferenceBadges(source);
    expect(graph.dag.nodes.has("outside")).toBe(true);
    expect(graph.dag.parents.get("outside")).toEqual(["cover"]);
    expect(graph.dag.nodes.has("placeholder")).toBe(true);
    expect(graph.byConsumer.get("consumer")?.map((badge) => badge.key)).toEqual(refs.map((ref) => ref.key));
    expect(graph.byConsumer.get("consumer")).toHaveLength(5);
    expect(graph.dag.parents.get("consumer")).toEqual(["outside"]);
  });

  it("handles empty and normalized malformed graphs without inventing routes or consumers", () => {
    const empty = projectReferenceBadges(projectDag([]));
    expect(empty.badges.size).toBe(0);
    expect(empty.dag.order).toEqual([]);
    const graph = projectReferenceBadges(projectDag([node("ref", ["ref", "unknown"], "subfolder"), node("c", ["ref", "ref", "unknown"])]));
    expect(graph.badges.get("ref")?.consumers).toEqual(["c"]);
    expect(graph.dag.parents.get("c")).toEqual([]);
    expect(projectReferenceBadges(graph.dag).dag).toEqual(graph.dag);
  });

  it("treats a badge as a parent for highlight without pulling co-consumers into a child's lineage", () => {
    const graph = projectReferenceBadges(sharedStyle());
    const badge = lineageWithBadges(graph, "style");
    expect([...badge.related].sort()).toEqual(["a1", "a2", "b1", "style"]);
    expect(toneOf(badge, "style")).toBe("focus");
    expect(toneOf(badge, "a")).toBe("unrelated");
    const child = lineageWithBadges(graph, "a2");
    expect(toneOf(child, "style")).toBe("related");
    expect(toneOf(child, "b1")).toBe("unrelated");
    for (const focus of [null, "unknown"]) expect(lineageWithBadges(graph, focus).focus).toBeNull();
  });
});

describe("band scene", () => {
  /** A band whose cover (and `expanded`) the user expanded. */
  const band = (graph: ReturnType<typeof projectReferenceBadges>, members: readonly string[], expanded: readonly string[], cover = members[0], x = 80, anchor: string | null = null) =>
    planBandScene(graph, members, anchor, 640, { pinned: { key: cover, x }, expanded: new Map([cover, ...expanded].map((key) => [key, true])) });
  const tones = (graph: ReturnType<typeof projectReferenceBadges>, members: readonly string[], focus: string | null, hover: string | null = null) => {
    const { lineage } = bandFocus(graph, members, focus, hover);
    return (key: string) => toneOf(lineage, key);
  };

  it("hover and selection tone the expanded deep neighborhood; neither is a band input", () => {
    const graph = projectReferenceBadges(projectDag([node("root"), node("ref", [], "external"), node("a", ["root", "ref"]), node("b", ["a"]), node("c", ["b"]), node("d", ["c"])]));
    const plan = band(graph, graph.dag.order, ["a", "b", "c"]);
    expect([...plan.tiles.keys()]).toEqual(["root", "a", "b", "c", "d"]);
    expect(tones(graph, graph.dag.order, "c", "ref")("c")).toBe("focus");
    expect(tones(graph, graph.dag.order, "c")("root")).toBe("related");
    // Planned neutral: selection and hover tone the scene later, never the plan.
    expect([...plan.tiles.values()].every((tile) => tile.tone === "neutral")).toBe(true);
    expect(plan.lineage.focus).toBeNull();
  });

  it("hover highlights shared consumers in another band", () => {
    const graph = projectReferenceBadges(sharedStyle());
    for (const members of connectedComponents(graph.dag)) {
      const tone = tones(graph, members, "a2", "style");
      expect(tone(members.find((key) => key.endsWith("1"))!)).toBe("related");
      if (members.includes("a2")) expect(tone("a2")).toBe("focus");
    }
  });

  it("plans 500 bands in a 10,000-image folder without traversing every other badge consumer", () => {
    const nodes = [node("ref", [], "external"), ...Array.from({ length: 500 }, (_, chain) =>
      Array.from({ length: 20 }, (_, step) => node(`c${chain}-${step}`, step ? [`c${chain}-${step - 1}`, "ref"] : []))).flat()];
    const graph = projectReferenceBadges(projectDag(nodes));
    const components = connectedComponents(graph.dag);
    expect(components).toHaveLength(500);
    const start = performance.now();
    // The shared badge expanded in every band: all of its consumers show.
    const scenes = components.map((members) => ({ plan: band(graph, members, ["ref"]), focus: bandFocus(graph, members, "ref") }));
    const ms = performance.now() - start;
    console.info(`badge band planning: 500 bands / 10,000 images ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
    for (const { plan, focus } of scenes) {
      expect(plan.tiles.size).toBe(20);
      expect(focus.lineage.related.size).toBe(20); // the badge and 19 outputs, within this band
      expect([...plan.tiles.keys()].filter((key) => toneOf(focus.lineage, key) === "related")).toHaveLength(19);
    }
  }, 30_000);

  it("pins a reference-generated cover as a drawable root, retaining its preview badge and no reference routes", () => {
    const source = projectDag([node("ref", [], "external"), node("cover", ["ref"]), node("child", ["cover", "ref"])]);
    const graph = projectReferenceBadges(source);
    const scene = planBandScene(graph, graph.dag.order, null, 1000, { pinned: { key: "cover", x: 800 }, expanded: new Map([["cover", true]]) });
    expect(scene.request.orientation).toBe("down");
    expect([...scene.tiles.keys()]).toEqual(["cover", "child"]);
    expect(scene.badges.get("cover")?.[0].path).toBe("/pictures/ref.png");
    expect(scene.badges.get("child")?.[0].scope).toBe("external");
    const layout = layoutGraph(scene.request);
    expect(layout.pinnedViolation).toBeUndefined();
    expect(layout.rows[0].keys).toEqual(["cover"]);
    expect(layout.nodes.get("cover")!.x + layout.nodes.get("cover")!.width / 2).toBe(800);
    expect([...sourcesReaching(layout, "cover")]).toEqual([]);
    expect([...sourcesReaching(layout, "child")]).toEqual(["cover"]);
    // The current call path retains reference tiles and its automatic orientation.
    const legacy = planScene(source, source.order, null, 1000);
    expect(legacy.tiles.has("ref")).toBe(true);
    expect(legacy.request.orientation).toBe("right");
  });

  it("highlights consumers in separate bands when a shared badge is focused", () => {
    const graph = projectReferenceBadges(sharedStyle());
    for (const members of connectedComponents(graph.dag)) {
      const scene = band(graph, members, []);
      const consumer = members.find((key) => key.endsWith("1"))!;
      const focus = bandFocus(graph, members, "style");
      expect(toneOf(focus.lineage, consumer)).toBe("related");
      expect(focus.lineage.focus).toBe("style");
      expect(scene.tiles.has("style")).toBe(false);
      expect(scene.badges.get(consumer)?.[0].key).toBe("style");
    }
    const [members] = connectedComponents(graph.dag);
    const unrelated = bandFocus(graph, members, "b");
    expect(members.every((key) => toneOf(unrelated.lineage, key) === "unrelated")).toBe(true);
  });

  it("shows deeper direct badge consumers and their ancestors when the badge is expanded, not when it is focused", () => {
    const source = projectDag([node("root"), node("a", ["root"]), node("b", ["a"]), node("ref", [], "subfolder"), node("c", ["b", "ref"])]);
    const graph = projectReferenceBadges(source);
    const idle = band(graph, graph.dag.order, [], "root");
    expect([...idle.tiles.keys()]).toEqual(["root", "a"]);
    expect([...band(graph, graph.dag.order, [], "root", 80, "ref").tiles.keys()], "an anchor alone shows nothing").toEqual(["root", "a"]);
    // The badge is drawn on c, which is hidden: expanding it shows c, and c's inputs.
    const expanded = band(graph, graph.dag.order, ["ref"], "root");
    expect([...expanded.tiles.keys()]).toEqual(["root", "a"]);
    const shown = band(graph, graph.dag.order, ["a", "b"], "root");
    expect([...shown.tiles.keys()]).toEqual(["root", "a", "b", "c"]);
    const focus = bandFocus(graph, graph.dag.order, "ref");
    expect(toneOf(focus.lineage, "c")).toBe("related");
    expect(toneOf(focus.lineage, "b")).toBe("unrelated");
    const selected = bandFocus(graph, graph.dag.order, "c");
    for (const route of layoutGraph(shown.request).routes) expect(routeStyle(route, graph.dag, selected.lineage).related).toBe(true);
  });

  it("opts into current-folder roots without changing the legacy reference-only fallback", () => {
    const dag = projectDag([node("ref", [], "external"), node("child", ["ref"], "subfolder")]);
    expect(componentRoots(dag, dag.order)).toEqual(["ref"]);
    expect(componentRoots(dag, dag.order, "in-folder")).toEqual([]);
    expect(visibleKeys(dag, dag.order, null, { roots: "in-folder" })).toEqual([]);
    expect(visibleKeys(dag, dag.order, "child", { roots: "in-folder" })).toEqual(["ref", "child"]);
  });
});

describe("visibleBadges: the badges a tile draws", () => {
  const badge = (key: string): ReferenceBadge => ({ key, path: `/elsewhere/${key}.png`, scope: "external", consumers: ["c"] });
  const five = ["r0", "r1", "r2", "r3", "r4"].map(badge);
  const keys = (badges: readonly ReferenceBadge[]) => badges.map((item) => item.key);

  it("draws every badge up to three, and none of an empty list", () => {
    expect(BADGES_SHOWN).toBe(3);
    expect(visibleBadges([], new Set())).toEqual([]);
    expect(keys(visibleBadges(five.slice(0, 3), new Set()))).toEqual(["r0", "r1", "r2"]);
  });

  it("draws the first three of more, in order, then the selected ones behind +n", () => {
    expect(keys(visibleBadges(five, new Set()))).toEqual(["r0", "r1", "r2"]);
    expect(keys(visibleBadges(five, new Set(["r4", "r1", "unknown"])))).toEqual(["r0", "r1", "r2", "r4"]);
    expect(keys(visibleBadges(five, new Set(["r4", "r3"])))).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("draws every badge once the overflow is open", () => {
    expect(keys(visibleBadges(five, new Set(), true))).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });
});
