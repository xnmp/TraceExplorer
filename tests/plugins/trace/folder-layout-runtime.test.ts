import { describe, expect, it } from "vitest";
import { node } from "../../../layout-eval/corpus";
import { createFolderLayoutRuntime } from "$lib/plugins/trace/view/folder-layout-runtime";
import { createDefaultEngine, engines } from "$lib/domain/trace-graph/folder-layout";
import { folderInput, handCase, makeFolder } from "../../domain/trace-graph/folder-layout-fixtures";
import { worldInput } from "../../domain/trace-graph/folder-world-fixture";

const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("fan-80")], files: 2 });

describe("folder layout runtime", () => {
  it("runs small work inline and sends a band above the workload budget elsewhere", () => {
    const runtime = createFolderLayoutRuntime();
    expect(runtime.inline(folderInput(folder, { open: ["s0:root"] }))).toBe(true);
    expect(runtime.inline(folderInput(folder, { open: ["s0:root", "s1:root"] }))).toBe(false);
  });

  it("remembered bands make the same run inline", () => {
    const runtime = createFolderLayoutRuntime();
    const input = folderInput(folder, { open: ["s0:root", "s1:root"] });
    runtime.remember(engines.default(input));
    expect(runtime.inline(input)).toBe(true);
    // The engine answers from those bands with the same geometry as a fresh run.
    expect(runtime.engine(input).graphs.get("s1:root")!.attached).toEqual(engines.default(input).graphs.get("s1:root")!.attached);
  });

  it("a kept committed band is free when another band's focus changes", () => {
    const runtime = createFolderLayoutRuntime();
    const previous = engines.default(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Saffron" }));
    expect(runtime.inline(folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s0:Ash", previous }))).toBe(true);
  });
});

it('budgets the sum of independent small band computations', () => {
  const many = makeFolder({stacks:Array.from({length:12},()=>handCase('screenshot'))});
  const runtime=createFolderLayoutRuntime();
  expect(runtime.inline(folderInput(many,{open:many.stacks.keys()}))).toBe(false);
});

it('opens the harness-sized fan inline among the other stacks and ordinary cells', () => {
  // view-fixture.ts: fan + 18 children, forest + two children, village,
  // notes.txt, plain.png and refs. Only the fan is opened in this transaction.
  const harness = makeFolder({ stacks: [
    [node('root'), ...Array.from({ length: 18 }, (_, i) => node(`fan-${i}`, ['root'], i + 1))],
    [node('root'), node('mist', ['root'], 1), node('autumn', ['root'], 2)],
    handCase('screenshot'),
  ], files: 2, directories: 1 });
  const runtime = createFolderLayoutRuntime();
  const previous = runtime.engine(folderInput(harness));
  const opening = folderInput(harness, { open: ['s0:root'], previous, width: 870 });
  expect(runtime.inline(opening)).toBe(true);
  expect(runtime.engine(opening).graphs.get('s0:root')!.attached.nodes.size).toBe(19);
});

it.each(['missing', 'malformed', 'bad-hint', 'bad-history'] as const)('ignores %s canonical cache provenance for world drawings', kind => {
  const runtime = createFolderLayoutRuntime(), initial = runtime.engine(worldInput(false));
  const arrived = runtime.engine(worldInput(true, initial));
  const previous = structuredClone(arrived);
  for (const [id, graph] of previous.graphs) {
    (previous.graphs as Map<string, typeof graph>).set(id, { ...graph,
      canonical: kind === 'missing' ? undefined : kind === 'malformed'
        ? { layout: graph.canonical!.layout } as typeof graph.canonical
        : { ...graph.canonical!, request: { ...graph.canonical!.request,
          ...(kind === 'bad-hint' ? { hint: 42 } : { history: { signature: '', layout: null } }) } } as unknown as typeof graph.canonical });
  }
  const continuation = runtime.engine(worldInput(true, previous, 'saved metadata'));
  expect(() => runtime.remember(continuation)).not.toThrow();
  const next = worldInput(true, continuation, 'another save');
  const input = { ...next, open: new Map([...next.open].filter(([id]) => id === 's0:root')) };
  expect(runtime.engine(input)).toEqual(createDefaultEngine()(structuredClone(input)));
});
