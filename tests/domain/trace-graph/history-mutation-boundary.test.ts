import { expect, it } from 'vitest';
import { validHistory } from '$lib/domain/trace-graph/history-boundary';
import { layoutGraph } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-history';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { node, requestFor } from '../../../layout-eval/corpus';

it.each(['layout', 'placed'])('ignores null drawings after certification: %s', field => {
  const request = requestFor({ id: 'review', nodes: [node('root'), node('a', ['root'], 1)], focuses: [null] }, null, 640, 48);
  const raw = layoutGraph(request);
  const history: any = { signature: bandHistorySignature(request), layout: raw, placed: attachSingleBand(raw, request) };
  expect(validHistory(history, 'root')).toBe(true);
  history[field] = null;
  expect(validHistory(structuredClone(history), 'root')).toBe(false);
  expect(validHistory(history, 'root')).toBe(false);
});
