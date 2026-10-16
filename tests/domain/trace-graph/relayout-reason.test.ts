import { expect, it } from 'vitest';
import { createDefaultEngine } from '../../../src/lib/domain/trace-graph/folder-layout/default-engine';
import { tileMetrics } from '../../../src/lib/domain/trace-graph/metrics';
import { folderInput, makeFolder, handCase } from './folder-layout-fixtures';
import { layoutGraph } from '../../../src/lib/domain/trace-graph/layout';
import { requestFor } from '../../../layout-eval/corpus';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';

it.each(['pane-width','tile-size'] as const)('records the explicit %s relayout through the folder and band boundaries', reason=>{
  const fixture={id:'resize',nodes:handCase('screenshot'),focuses:[null]};
  const folder=makeFolder({stacks:[fixture.nodes]}),engine=createDefaultEngine();
  const first=folderInput(folder,{open:['s0:root'],width:640,tile:tileMetrics(64)});
  const previous=engine(first);
  const next={...first,previous,...(reason==='pane-width'?{width:360}:{tile:tileMetrics(96)})};
  expect(engine(next).decision?.relayout).toBe(reason);
  const before=requestFor(fixture,null,640,64),raw=layoutGraph(before);
  const history={signature:bandHistorySignature(before),layout:raw,placed:attachSingleBand(raw,before)};
  const request=requestFor(fixture,null,reason==='pane-width'?360:640,reason==='tile-size'?96:64);
  expect(layoutGraph({...request,history}).decision?.relayout).toBe(reason);
});
