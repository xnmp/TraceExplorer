import {expect,it} from 'vitest';
import contact from './review-contact-case.json';
import minimal from './review-minimal-contact.json';
import {layoutGraph,type LayoutRequest} from '$lib/domain/trace-graph/layout';
import {attachSingleBand} from '$lib/domain/trace-graph/band-geometry';
import {bandHistorySignature} from '$lib/domain/trace-graph/band-history';
import {geometryGate} from '$lib/domain/trace-graph/geometry-gate';
import {contacts} from './contact-probe';
it.each([contact,minimal])('keeps every prefix of a minimized review contact case separate', ({width,items}) => {
  let history: LayoutRequest['history'];
  for(let size=2;size<=items.length;size++){
    const request: LayoutRequest={items:items.slice(0,size),band:{key:'n0',items},maxWidth:width,tileWidth:92,pinned:{key:'n0',x:width*.75},history};
    const layout=layoutGraph(request),placed=attachSingleBand(layout,request);
    expect(contacts(placed),`prefix${size}`).toEqual([]);
    expect(geometryGate(placed,request.items,'n0',width)).toBeNull();
    history={signature:bandHistorySignature(request),layout,placed};
  }
});
