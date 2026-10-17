import {expect,it} from 'vitest';
import {createDefaultEngine} from '$lib/domain/trace-graph/folder-layout/default-engine';
import {createBoundedCache,estimateFolderLayoutBytes} from '$lib/domain/trace-graph/folder-layout/bounded-cache';
import {folderInput,makeFolder,handCase} from './folder-layout-fixtures';
it('charges retained arrival geometry to the folder cache budget', () => {
  const engine=createDefaultEngine();
  const plain=engine(folderInput(makeFolder({stacks:[]}),{open:[]}));
  const large=engine(folderInput(makeFolder({stacks:[handCase('fan-80')]}),{open:['s0:root']}));
  const retained={...plain,arrivalPlacement:{basis:'basis',layout:large}};
  const cache=createBoundedCache(estimateFolderLayoutBytes,{maxBytes:estimateFolderLayoutBytes(plain)+10});
  cache.set('x',retained);
  expect(cache.size).toBe(0);
});
