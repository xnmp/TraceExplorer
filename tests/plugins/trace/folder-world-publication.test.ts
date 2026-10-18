import './svelte-host';
import { expect, it } from 'vitest';
import { createSceneController } from '$lib/plugins/trace/view/scene-controller.svelte';
import { createFolderLayoutRuntime } from '$lib/plugins/trace/view/folder-layout-runtime';
import { installSceneInstrumentation } from '$lib/plugins/trace/view/scene-instrumentation';
import type { SceneIntent } from '$lib/plugins/trace/view/scene-inputs';
import type { Publication } from '$lib/plugins/trace/view/presentation';
import type { ComponentData, FolderIndex } from '$lib/domain/trace-graph/folder-data';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { makeFolder, corpusNode as node, entry } from '../../domain/trace-graph/folder-layout-fixtures';

it('publishes a generated batch, four separate saves and a discard inline without moving its cover or blinking a collapsed layout', async () => {
  const runtime = createFolderLayoutRuntime(), publications: Publication[] = [], failures: string[] = [];
  const computed: number[] = [];
  const data = {
    index: null as FolderIndex | null,
    components: new Map<string, ComponentData>(),
    isStale: () => false,
    acquireComponents: () => { throw new Error('Complete fixture data must be available'); },
  };
  const controller = createSceneController({
    paneId: 'batch', data, inline: runtime.inline,
    engine: input => { const result = runtime.engine(input); computed.push(result.columns); return result; },
    runLayout: async () => { throw new Error('This sequence must run inline'); },
    tick: () => Promise.resolve(),
  });
  const restore = installSceneInstrumentation({
    failure: event => failures.push(event.message),
  });
  controller.onPresented(() => publications.push(controller.published!));
  const tile = tileMetrics(64);
  let version = 0;
  async function offer(generated: boolean, saved: number, discarded = false) {
    const outputs = generated ? Array.from({ length: discarded ? 3 : 4 }, (_, i) => ({
      ...node(`out${i}`, ['root'], i + 3), temporary: i >= saved,
      path: i < saved ? `/f/saved-${i}.png` : `/managed/output-${i}.png`,
    })) : [];
    const folder = makeFolder({ stacks: [
      [node('root'), node('a', ['root'], 1), node('b', ['root'], 2), ...outputs],
      [node('root'), node('child', ['root'], 1)],
    ], files: 1 });
    const token = String(++version);
    const listing = [folder.entries.at(-1)!, ...folder.entries.slice(0, -1),
      ...outputs.slice(0, saved).map((_, i) => entry(`/f/saved-${i}.png`))];
    const members = new Map(folder.index.members);
    for (let i = 0; i < Math.min(saved, outputs.length); i++) members.set(`/f/saved-${i}.png`, { componentId: 'c:s0:root', key: `s0:out${i}` });
    data.index = { ...folder.index, token, members };
    data.components = new Map([...folder.stacks.values()].map(stack => [stack.componentId, {
      directory: '/f', token, version, nodes: stack.nodes, dag: stack.graph.dag, members: stack.graph.dag.order,
    }]));
    const intent: SceneIntent = {
      directory: '/f', listing, claimed: new Set(), open: new Set(folder.stacks.keys()),
      focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null,
      expansion: { choices: new Map([...folder.stacks.values()].flatMap(stack => stack.nodes.map(n => [n.key, true] as const))), reveals: [] },
      width: 880, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: '[]',
    };
    controller.offer(intent, { index: data.index, components: data.components });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(failures).toEqual([]);
    expect(controller.published?.scene.inputs.layoutInput.dataRevision).toBe(token);
    return controller.published!;
  }
  try {
    const initial = await offer(false, 0), cover = initial.scene.layout.cells.get('s0:root')!;
    expect(cover.x).toBeGreaterThan(0);
    const generated = await offer(true, 0);
    expect(generated.scene.layout.graphs.get('s0:root')!.worldPlaced).toBe(true);
    for (let saved = 1; saved <= 4; saved++) {
      const publication = await offer(true, saved);
      const output = publication.scene.inputs.layoutInput.open.get('s0:root')!.graph.dag.nodes.get(`s0:out${saved - 1}`)!;
      expect(output.temporary).toBe(false);
      expect(publication.scene.layout.size).toEqual(generated.scene.layout.size);
      expect(publication.scene.layout.cells).toEqual(generated.scene.layout.cells);
      expect(publication.scene.layout.bands).toEqual(generated.scene.layout.bands);
      for (const [id, graph] of generated.scene.layout.graphs) {
        expect(publication.scene.layout.graphs.get(id)!.attached).toEqual(graph.attached);
      }
    }
    const discarded = await offer(true, 3, true);
    expect(discarded.scene.layout.graphs.get('s0:root')!.attached.nodes.has('s0:out3')).toBe(false);
    expect(publications.length).toBeGreaterThanOrEqual(7);
    expect(computed.every(columns => columns === initial.scene.layout.columns)).toBe(true);
    for (const publication of publications) {
      const layout = publication.scene.layout;
      expect(folderGeometryGate(layout)).toBeNull();
      expect(layout.decision?.fallback).toBeUndefined();
      expect(layout.cells.get('s0:root')!.x).toBe(cover.x);
      expect(layout.size.width).toBeLessThanOrEqual(publication.scene.inputs.layoutInput.width);
    }
  } finally { controller.dispose(); restore(); }
});
