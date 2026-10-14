import type { GraphLayout, LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { measure, routePlan, overlapLength } from './geometry';
export { attached } from './placement';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Thick yellow strokes over every stretch two different sources' connectors share. */
function sharedLaneMarks(layout: GraphLayout): string {
    const marks: string[] = [], routes = layout.routes;
    for (let i = 0; i < routes.length; i++) for (let j = 0; j < i; j++) {
        if (routes[i].from.kind === routes[j].from.kind && routes[i].from.id === routes[j].from.id) continue;
        for (const s of routePlan(routes[i]).segments) for (const t of routePlan(routes[j]).segments) {
            if (!(overlapLength(s, t) > 0)) continue;
            // The overlap of collinear segments: the middle two of their four endpoints along the line.
            const along = (p: { x: number; y: number }) => (p.x - s[0].x) * (s[1].x - s[0].x) + (p.y - s[0].y) * (s[1].y - s[0].y);
            const [, a, b] = [s[0], s[1], t[0], t[1]].sort((p, q) => along(p) - along(q));
            marks.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#f5d547" stroke-width="5" stroke-linecap="round" opacity=".85"><title>${esc(`${routes[i].id} and ${routes[j].id} share a lane`)}</title></line>`);
        }
    }
    return marks.join('');
}
export function svg(layout: GraphLayout, request: LayoutRequest, title: string): string {
    const key = request.band!.key, cover = layout.nodes.get(key), shown = [...layout.nodes.values()], height = Math.max(layout.height, ...shown.map(n => n.y + n.height)) + 64, width = Math.max(request.maxWidth, layout.width, ...shown.map(n => n.x + n.width)) + 32;
    const m = measure(layout, key, request.maxWidth, request.items);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="-16 -48 ${width} ${height}"><defs><marker id="arrow" markerUnits="userSpaceOnUse" viewBox="0 -3.5 8 7" refX="0" refY="0" markerWidth="8" markerHeight="7" orient="auto"><path d="M0 -3.5 L8 0 L0 3.5" fill="#db8b7b"/></marker></defs><rect x="-16" y="-48" width="100%" height="100%" fill="#22252b"/><style>text{font-family:system-ui,sans-serif;fill:#eee;font-size:12px}.muted{fill:#aeb5c2;font-size:10px}</style><text x="4" y="-29">${esc(title)}</text><text class="muted" x="4" y="-11">height ${m.height.toFixed(0)} · whitespace ${(m.whitespace * 100).toFixed(1)}% · ink ${m.length.toFixed(0)} · crossings ${m.crossings} · shared lanes ${m.sharedLanePx.toFixed(0)} px</text>${cover ? `<rect x="0" y="${cover.height}" width="${request.maxWidth}" height="34" fill="#383c44" opacity=".5"/>` : ''}${layout.routes.map(r => `<path d="${r.path}" fill="none" stroke="#db8b7b" stroke-width="1.7" ${r.terminal ? 'marker-end="url(#arrow)"' : ''}><title>${esc(r.consumers.map(c => `${c.parent} → ${c.child}`).join(', '))}</title></path>`).join('')}${[...layout.junctions.values()].map(j => `<circle cx="${j.x}" cy="${j.y}" r="3" fill="#db8b7b"/>`).join('')}${m.sharedLanePx > 0 ? sharedLaneMarks(layout) : ''}${shown.map(n => { const item = request.band!.items.find(i => i.key === n.key), hasChildren = request.band!.items.some(i => i.parents.includes(n.key)), childCount = request.items.filter(i => i.parents.includes(n.key)).length; return `<g><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" fill="${n.key === key ? '#4a4044' : '#303641'}" stroke="#697384"/><rect x="${n.x + 6}" y="${n.y + 6}" width="${n.width - 12}" height="${n.height - 30 - (hasChildren ? 16 : 0)}" rx="3" fill="#45566a"/><text x="${n.x + 6}" y="${n.y + n.height - (hasChildren ? 23 : 7)}">${esc(n.key.length > 18 ? n.key.slice(0, 17) + '…' : n.key)}</text>${hasChildren ? `<text class="muted" x="${n.x + 6}" y="${n.y + n.height - 7}">${childCount ? childCount + ' children open' : 'further edit hidden'}</text>` : ''}<title>${esc(n.key)} (${item?.width}×${item?.height})</title></g>`; }).join('')}</svg>`;
}
export function gallery(files: readonly {
    name: string;
    description: string;
}[]): string { return `<!doctype html><meta charset="utf-8"><title>Trace layout evaluation</title><style>body{margin:24px;background:#171a20;color:#ddd;font:14px system-ui}main{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}figure{margin:0;max-width:100%;overflow:auto}img{max-width:100%;height:auto}figcaption{margin:8px 0}a{color:#abc8ff}</style><h1>Trace band layout evaluation</h1><p>Real tile dimensions, synthetic image blocks. Paired baseline / production. Open SVGs for route consumer tooltips.</p><main>${files.map(f => `<figure><figcaption><a href="${f.name}">${esc(f.description)}</a></figcaption><img src="${f.name}" loading="lazy"></figure>`).join('')}</main>`; }
