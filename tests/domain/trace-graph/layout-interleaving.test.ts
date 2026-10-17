import {expect,it} from 'vitest';
import {corpus,requestFor} from '../../../layout-eval/corpus';
import {optimizedBand,type Optimized} from '../../../layout-eval/engine';
it('keeps repeated and interleaved requests deterministic without mutating inputs or prior outputs',()=>{
  let checked=0;
  for(const c of corpus().filter(c=>c.nodes.length<=40)){
    let previous: Optimized|undefined;
    for(const focus of c.focuses.slice(0,3)){
      const request=requestFor(c,focus,640,48),options={previous,anchorKey:focus??undefined};
      const before=structuredClone({request,options});
      const a=optimizedBand(request,options),snapshot=structuredClone(a);
      optimizedBand(requestFor(c,null,360,96));
      expect(optimizedBand(request,options),`${c.id}/${focus}`).toEqual(snapshot);
      expect(a).toEqual(snapshot);
      expect({request,options}).toEqual(before);
      previous=a;checked++;
    }
  }
  expect(checked).toBeGreaterThan(100);
},30000);
