import fs from 'node:fs';
import {expect,it} from 'vitest';
import {decode} from './routing-hint-next-click-codec';
import {createDefaultEngine} from '../../../src/lib/domain/trace-graph/folder-layout/default-engine';
import {folderGeometryGate} from '../../../src/lib/domain/trace-graph/folder-layout/geometry-gate';
it('keeps the clicked tile at its actual committed world position after a hint world continuation',()=>{
 const input=decode(fs.readFileSync(new URL('./routing-hint-next-click.fixture.json',import.meta.url),'utf8'));
 expect(folderGeometryGate(input.previous)).toBeNull();
 const before=input.previous.graphs.get('s0:r'),old=before.attached.nodes.get('s0:p');
 const out=createDefaultEngine()(input);
 expect(folderGeometryGate(out)).toBeNull();
 const after=out.graphs.get('s0:r')!,now=after.attached.nodes.get('s0:p')!;
 expect([now.x+after.origin.x,now.y+after.origin.y,now.width,now.height]).toEqual(
  [old.x+before.origin.x,old.y+before.origin.y,old.width,old.height]);
});
