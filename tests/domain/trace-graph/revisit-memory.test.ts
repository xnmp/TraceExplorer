import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { NO_EXPANSION, openStack, toggleNode } from '$lib/domain/trace-graph/expansion';
import { folderInput, makeFolder, handCase } from './folder-layout-fixtures';

it('builds a new expansion from the displayed drawing and click anchor', () => {
  const folder = makeFolder({ stacks: [handCase('screenshot')] }), stack = folder.stacks.get('s0:root')!;
  const scope = { graph: stack.graph, members: stack.graph.dag.order, cover: stack.cover };
  const engine = createDefaultEngine();
  const expansion = openStack(NO_EXPANSION, stack.cover);
  const before = engine(folderInput(folder, { open: [stack.cover], expansion }));
  const after = engine(folderInput(folder, { open: [stack.cover], previous: before, expansion: toggleNode(expansion, scope, 's0:Saffron') }));
  const request = after.graphs.get(stack.cover)!.plan.request;
  expect(request.anchorKey).toBe('s0:Saffron');
  expect(request.history?.placed).toEqual(before.graphs.get(stack.cover)!.attached);
});
