import { layoutStage, countLayoutWork } from './layout-profile';
/** Validate untrusted committed geometry before any reuse, resize, signature or index walk. */
import type { BandHistory, GraphLayout, LayoutItem, LayoutRequest } from './layout';
import { inReach, usableRetainedRoute } from './band-incremental';
import { geometrySignature, layoutSignature } from './layout-signature';
import { attachPackedBand, attachSingleBand } from './band-geometry';
import { createBoundedCache } from './folder-layout/bounded-cache';
import { drawingClaimsViolation, geometryGate } from './geometry-gate';
import { cost, validateLayout, DEFAULT_WEIGHTS } from './layout-quality';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const coordinate = (value: unknown): value is number => typeof value === 'number' && inReach(value);
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && inReach(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && Array.from(value).every(v => typeof v === 'string');
const endpoint = (value: unknown) => object(value) && (value.kind === 'node' || value.kind === 'junction') && typeof value.id === 'string';

export function isLayoutShape(value: unknown): value is GraphLayout {
  if (!object(value) || !(value.nodes instanceof Map) || !(value.junctions instanceof Map) || !(value.readingOrder instanceof Map)
    || !Array.isArray(value.routes) || !Array.isArray(value.rows) || !coordinate(value.width) || !coordinate(value.height)
    || (value.orientation !== 'down' && value.orientation !== 'right')) return false;
  if (value.pinnedViolation !== undefined && value.pinnedViolation !== 'not-a-root') return false;
  const decision=value.decision;
  if (decision!==undefined && (!object(decision) || typeof decision.candidate!=='string' || typeof decision.stability!=='boolean'
    || decision.fallback!==undefined && typeof decision.fallback!=='string' || decision.relayout!==undefined && typeof decision.relayout!=='string'
    || decision.partition!==undefined && (!Array.isArray(decision.partition) || !Array.from(decision.partition).every(index)))) return false;
  for (const [key, n] of value.nodes) if (typeof key !== 'string' || !object(n) || n.key !== key
    || ![n.x, n.y, n.width, n.height].every(coordinate) || !(n.width as number > 0) || !(n.height as number > 0)
    || !coordinate(Number(n.x) + Number(n.width)) || !coordinate(Number(n.y) + Number(n.height))
    || !index(n.row) || !index(n.band)) return false;
  for (const [key, j] of value.junctions) if (typeof key !== 'string' || !object(j) || j.id !== key || !coordinate(j.x) || !coordinate(j.y) || !strings(j.parents)) return false;
  for (const [key, rank] of value.readingOrder) if (typeof key !== 'string' || !coordinate(rank)) return false;
  for (const row of value.rows) if (!object(row) || !index(row.index) || !index(row.band) || !coordinate(row.top) || !coordinate(row.bottom) || row.bottom < row.top || !strings(row.keys)) return false;
  const tables = new Set<unknown>();
  for (const route of value.routes) { if (!object(route) || typeof route.id !== 'string' || typeof route.terminal !== 'boolean'
    || !endpoint(route.from) || !endpoint(route.to) || !(Array.isArray(route.consumers) || object(route.consumers) && Array.isArray(route.consumers.entries) && Number.isSafeInteger(route.consumers.start) && Number.isSafeInteger(route.consumers.end) && Number(route.consumers.start) >= 0 && Number(route.consumers.end) >= Number(route.consumers.start) && Number(route.consumers.end) <= route.consumers.entries.length)
    || !usableRetainedRoute(route as unknown as GraphLayout['routes'][number])) return false;
    const entries = Array.isArray(route.consumers) ? route.consumers : (route.consumers as { entries: unknown[] }).entries;
    if (!tables.has(entries)) {
      tables.add(entries);
      if (!Array.from(entries).every(c => object(c) && typeof c.parent === 'string' && typeof c.child === 'string')) return false;
    }
  }
  for (const field of ['preferredX', 'anchorX', 'anchorY'] as const) if (value[field] !== undefined && !coordinate(value[field])) return false;
  const bounds = value.bandBounds;
  return bounds === undefined || object(bounds) && [bounds.left, bounds.width, bounds.top].every(coordinate);
}

function attachmentValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || !coordinate(value.bandTop) || !object(value.placement)) return false;
  const p = value.placement;
  if (![p.x, p.coverX, p.coverHeight, p.width, p.left, p.right].every(coordinate)) return false;
  if (Number(p.coverHeight) <= 0 || Number(p.width) <= 0 || Number(p.right) < Number(p.left) || Number(value.bandTop) < 0) return false;
  if (![p.track, p.stemRoom].every(v => v === undefined || coordinate(v) && v >= 0)) return false;
  for (const list of [p.coverColumns, p.bypassColumns]) if (list !== undefined && (!Array.isArray(list) || !Array.from(list).every(coordinate))) return false;
  return p.bridge === undefined || object(p.bridge) && coordinate(p.bridge.top) && coordinate(p.bridge.gutter);
}

/** Attachment changes geometry, not route identity, consumer tables, or reading order. */
function sameDrawing(a: GraphLayout, b: GraphLayout): boolean {
  return a === b || a.pinnedViolation === b.pinnedViolation
    && JSON.stringify(geometrySignature({ ...a, decision: undefined })) === JSON.stringify(geometrySignature({ ...b, decision: undefined }));
}

/**
 * Legacy standalone histories omit packing context. Accept only an identity drawing (the
 * explicit world-placement form), or the exact single-band transform determined by the saved
 * signature. Never infer an arbitrary translation from two independently safe drawings.
 */
function consistentAttachment(history: BandHistory, cover: string, items: readonly LayoutItem[]): boolean {
  try {
    if (history.attachment) return sameDrawing(attachPackedBand(history.layout, cover,
      history.attachment.bandTop, history.attachment.placement), history.placed);
    if (sameDrawing(history.layout, history.placed)) return true;
    const [maxWidth, tileWidth, pinned] = JSON.parse(history.signature) as unknown[];
    if (!coordinate(maxWidth) || maxWidth < 0 || tileWidth !== null && (!coordinate(tileWidth) || tileWidth <= 0)) return false;
    if (pinned !== null && (!object(pinned) || typeof pinned.key !== 'string' || !coordinate(pinned.x)
      || pinned.obstacles !== undefined && (!Array.isArray(pinned.obstacles) || !pinned.obstacles.every(o => object(o)
        && coordinate(o.x) && coordinate(o.width) && o.width > 0)))) return false;
    const request: LayoutRequest = { items, maxWidth, tileWidth: tileWidth === null ? undefined : tileWidth as number,
      pinned: pinned === null ? undefined : pinned as unknown as LayoutRequest['pinned'], band: { key: cover, items } };
    return sameDrawing(attachSingleBand(history.layout, request), history.placed);
  } catch { return false; }
}

/** A signature is data too: it supplies the previous parentage, never today's new edges. */
function facts(signature: string): LayoutItem[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(signature); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 4 || !Array.isArray(parsed[3])) return null;
  const result: LayoutItem[] = [], seen = new Set<string>();
  for (const f of parsed[3]) {
    if (!Array.isArray(f) || f.length !== 5 || typeof f[0] !== 'string' || seen.has(f[0]) || ![f[1], f[2]].every(coordinate) || typeof f[3] !== 'number' || !Number.isFinite(f[3])
      || f[1] <= 0 || f[2] <= 0 || !strings(f[4])) return null;
    seen.add(f[0]); result.push({ key: f[0], width: f[1], height: f[2], order: f[3], parents: f[4] });
  }
  return result;
}

const historyChecks = createBoundedCache<boolean>(() => 64, { maxEntries: 64, maxBytes: 8 * 1024 * 1024 });

interface CheckedHistory { readonly cover: string; readonly values: readonly unknown[] }
const checkedHistories = new WeakMap<object, CheckedHistory>();
type Visit = (value: unknown) => boolean;

/**
 * Walk exactly the fields validation reads, retaining primitive values as well as container
 * identities. A changed container stops comparison before it is dereferenced; a mutation of
 * an existing container is found by its length, entries or fields. Shared consumer tables are
 * walked once. This avoids reparsing every path and serializing two drawings on a warm read.
 */
function historyValues(history: BandHistory, visit: Visit): boolean {
  const endStage = layoutStage('history-walk'); try {

  const tables = new Set<readonly unknown[]>();
  const list = (values: readonly unknown[] | undefined): boolean => visit(values)
    && (values === undefined || visit(values.length) && values.every(visit));
  const consumers = (entries: readonly { readonly parent: string; readonly child: string }[]): boolean => {
    if (!visit(entries)) return false;
    if (tables.has(entries)) return true;
    tables.add(entries);
    if (!visit(entries.length)) return false;
    for (const entry of entries) if (!visit(entry) || !visit(entry.parent) || !visit(entry.child)) return false;
    return true;
  };
  const drawing = (layout: GraphLayout): boolean => {
    if (!visit(layout)) return false;
    const d=layout.decision;
    if (!visit(d) || d && (!visit(d.candidate) || !visit(d.stability) || !visit(d.fallback) || !visit(d.relayout) || !list(d.partition))) return false;
    if (!visit(layout.orientation) || !visit(layout.width) || !visit(layout.height) || !visit(layout.pinnedViolation)
      || !visit(layout.nodes) || !visit(layout.nodes.size)) return false;
    for (const [key, n] of layout.nodes) if (!visit(key) || !visit(n) || !visit(n.key) || !visit(n.x) || !visit(n.y)
      || !visit(n.width) || !visit(n.height) || !visit(n.row) || !visit(n.band)) return false;
    if (!visit(layout.junctions) || !visit(layout.junctions.size)) return false;
    for (const [key, j] of layout.junctions) if (!visit(key) || !visit(j) || !visit(j.id) || !visit(j.x) || !visit(j.y) || !list(j.parents)) return false;
    if (!visit(layout.readingOrder) || !visit(layout.readingOrder.size)) return false;
    for (const [key, rank] of layout.readingOrder) if (!visit(key) || !visit(rank)) return false;
    if (!visit(layout.rows) || !visit(layout.rows.length)) return false;
    for (const row of layout.rows) if (!visit(row) || !visit(row.index) || !visit(row.band) || !visit(row.top) || !visit(row.bottom) || !list(row.keys)) return false;
    if (!visit(layout.routes) || !visit(layout.routes.length)) return false;
    for (const route of layout.routes) {
      if (!visit(route) || !visit(route.id) || !visit(route.terminal) || !visit(route.path)
        || !visit(route.from) || !visit(route.from.kind) || !visit(route.from.id)
        || !visit(route.to) || !visit(route.to.kind) || !visit(route.to.id) || !visit(route.consumers)) return false;
      const c = route.consumers;
      if (Array.isArray(c)) { if (!consumers(c)) return false; }
      else {
        const range = c as Exclude<typeof c, readonly unknown[]>;
        if (!visit(range.start) || !visit(range.end) || !consumers(range.entries)) return false;
      }
    }
    if (!visit(layout.preferredX) || !visit(layout.anchorX) || !visit(layout.anchorY) || !visit(layout.bandBounds)) return false;
    const bounds = layout.bandBounds;
    return !bounds || visit(bounds.left) && visit(bounds.width) && visit(bounds.top);
  };
  if (!visit(history.signature) || !drawing(history.layout) || !drawing(history.placed) || !visit(history.attachment)) return false;
  const a = history.attachment;
  if (!a) return true;
  if (!visit(a.bandTop) || !visit(a.placement)) return false;
  const p = a.placement;
  return visit(p.x) && visit(p.coverX) && visit(p.coverHeight) && visit(p.width) && visit(p.left) && visit(p.right)
    && visit(p.track) && visit(p.stemRoom) && list(p.coverColumns) && list(p.bypassColumns) && visit(p.bridge)
    && (!p.bridge || visit(p.bridge.top) && visit(p.bridge.gutter));

  } finally { endStage(); }
}

function unchangedHistory(value: object, cover: string): boolean {
  const known = checkedHistories.get(value);
  if (!known || known.cover !== cover) return false;
  let at = 0;
  return historyValues(value as BandHistory, next => at < known.values.length && Object.is(known.values[at++], next)) && at === known.values.length;
}

function rememberHistory(value: BandHistory, cover: string): void {
  const values: unknown[] = [];
  historyValues(value, next => { values.push(next); return true; });
  checkedHistories.set(value, { cover, values });
}

export function validHistory(value: unknown, cover: string): value is BandHistory {
  const endStage = layoutStage('history'); try {

  if (object(value) && unchangedHistory(value, cover)) return true;
  if (!object(value) || typeof value.signature !== 'string' || !isLayoutShape(value.layout) || !isLayoutShape(value.placed) || !attachmentValid(value.attachment)) return false;
  let key: string;
  try { key = JSON.stringify([cover, layoutSignature({ items: [], maxWidth: 0, history: value as unknown as BandHistory })]); }
  catch { return false; }
  const known = historyChecks.get(key);
  if (known !== undefined) {
    if (known) rememberHistory(value as unknown as BandHistory, cover);
    return known;
  }
  const items = facts(value.signature);
  if (!items || !consistentAttachment(value as unknown as BandHistory, cover, items)) return false;
  for (const layout of [value.layout, value.placed]) {
    const visible = items.filter(n => layout.nodes.has(n.key)).map(n => ({ ...n, width: layout.nodes.get(n.key)!.width, height: layout.nodes.get(n.key)!.height }));
    if (visible.length !== layout.nodes.size || !layout.nodes.has(cover)) return false;
    // Packing replaces provisional cover stems. Their clearance is not a property of
    // the displayed drawing, but their claims, tile avoidance and connectivity still
    // must be valid. The exact attachment comparison above binds both drawings.
    if (layout === value.layout && layout !== value.placed) {
      if (drawingClaimsViolation(layout) || !Number.isFinite(cost(validateLayout(layout, cover, layout.width, visible), 92,
        { ...DEFAULT_WEIGHTS, sharedLanes: 'priced' }))) return false;
    } else if (geometryGate(layout, visible, cover, layout.width)) return false;
  }
  historyChecks.set(key, true);
  rememberHistory(value as unknown as BandHistory, cover);
  return true;

  } catch { return false; } finally { endStage(); }
}
