import { layoutStage, countLayoutWork } from '../layout-profile';
/** Displayed geometry is committed data, not an engine-local cache. Snapshots are strings so
 * no mutable Map, node or route can alias a displayed result or another history generation. */
import type { BandOptions } from '../band-layout';
import type { BandScenePlan } from '../scene';
import { layoutSignature } from '../layout-signature';
import { stableKey } from './stable-key';
import type { FolderGraph, FolderLayout, FolderLayoutInput } from './types';

export const DISPLAY_LIMIT = 64;
export interface DisplayMemory {
  readonly folder: string;
  readonly contents: string;
  readonly members: readonly (readonly [string, string])[];
  /** Oldest first. Values contain no earlier memory or arrival history. */
  readonly entries: readonly (readonly [string, string])[];
}
interface Identity extends Omit<DisplayMemory, 'entries'> { readonly key: string; readonly changed: boolean }
type Plans = ReadonlyMap<string, { readonly plan: BandScenePlan }>;

export function displayIdentity(input: FolderLayoutInput, plans: Plans, policy?: BandOptions): Identity {
  const folder = input.folderKey ?? '';
  const previous = validDisplayMemory(input.previous?.displays) ? input.previous.displays : undefined;
  const members = new Map(previous?.folder === folder ? previous.members : []);
  const present = new Set(input.items.filter(i => i.kind === 'stack').map(i => i.id));
  for (const id of members.keys()) if (!present.has(id)) members.delete(id);
  for (const [id, { plan }] of plans) members.set(id, stableKey(plan.request.band?.items.map(n => [n.key, n.order, n.parents])));
  const ordered = [...members].sort(([a], [b]) => a.localeCompare(b));
  const items = input.items.map(i => [i.id, i.kind]);
  const contents = stableKey([input.contents, [...items].sort(([a], [b]) => a.localeCompare(b))]);
  const changed = previous?.folder === folder && previous.members.some(([id, value]) => members.has(id) && members.get(id) !== value);
  // Effective expansion (including caret state), complete request geometry, and folder packing.
  // Anchor and reading history choose *new* geometry; they must not prevent a revisit hit.
  const key = stableKey([items, Math.max(0, input.width), input.tile, input.grid, policy,
    [...plans].map(([id, { plan }]) => [id,
      layoutSignature({ ...plan.request, history: undefined, hint: undefined, anchorKey: undefined }),
      [...plan.tiles].map(([key, tile]) => [key, tile.expanded, tile.togglable])])]);
  return { folder, contents, members: ordered, key, changed: !!changed };
}

/** Reference tables preserve shared consumer annotations in linear space. No JSON expansion of
 * a DAG into a tree: a fan's shared consumer table must be stored only once. */
function encode(value: unknown): string {
  const ids = new Map<object, number>(), objects: unknown[] = [];
  const ref = (v: any): any => {
    if (v === undefined) return ['undefined'];
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v,-0))) return ['number', Object.is(v,-0) ? '-0' : String(v)];
    if (!v || typeof v !== 'object') return v;
    const found = ids.get(v);
    if (found !== undefined) return ['ref', found];
    const id = objects.length; ids.set(v,id); objects.push(null);
    objects[id] = v instanceof Map ? ['map', [...v].map(([k,x])=>[ref(k),ref(x)])]
      : v instanceof Set ? ['set', [...v].map(ref)]
      : Array.isArray(v) ? ['array', v.map(ref)]
      : ['object', Object.entries(v).map(([k,x])=>[k,ref(x)])];
    return ['ref',id];
  };
  const root = ref(value);
  return JSON.stringify([root,objects]);
}
function decode(text: string): FolderLayout {
  const [root, table] = JSON.parse(text);
  const objects = table.map(([kind]: [string]) => kind === 'map' ? new Map() : kind === 'set' ? new Set() : kind === 'array' ? [] : {});
  const ref = (v: any): any => !Array.isArray(v) ? v : v[0] === 'ref' ? objects[v[1]] : v[0] === 'number' ? Number(v[1]) : undefined;
  table.forEach(([kind, entries]: [string, any[]], i: number) => {
    const target = objects[i];
    if (kind === 'map') for (const [k,v] of entries) target.set(ref(k),ref(v));
    else if (kind === 'set') for (const v of entries) target.add(ref(v));
    else if (kind === 'array') for (const v of entries) target.push(ref(v));
    else for (const [k,v] of entries) Object.defineProperty(target,k,{value:ref(v),enumerable:true,writable:true,configurable:true});
  });
  return ref(root);
}

/** History may cross a worker boundary or come from an older runtime. */
export function validDisplayMemory(value: unknown): value is DisplayMemory {
  if (!value || typeof value !== 'object') return false;
  const m = value as DisplayMemory;
  const pairs = (v: unknown): boolean => Array.isArray(v) && Array.from(v).every(e => Array.isArray(e) && e.length === 2 && Array.from(e).every(x => typeof x === 'string'));
  return typeof m.folder === 'string' && typeof m.contents === 'string' && pairs(m.members) && pairs(m.entries) && m.entries.length <= DISPLAY_LIMIT;
}

const compatible = (memory: DisplayMemory | undefined, identity: Identity) =>
  !identity.changed && validDisplayMemory(memory) && memory?.folder === identity.folder && memory.contents === identity.contents;

/** Whether `recallDisplay` would find an entry, without decoding it. */
export const holdsDisplay = (memory: DisplayMemory | undefined, identity: Identity): boolean =>
  compatible(memory, identity) && memory!.entries.some(([key]) => key === identity.key);

export function recallDisplay(memory: DisplayMemory | undefined, identity: Identity): FolderLayout | undefined {
  const endStage = layoutStage('restore-decode'); try {

  if (!compatible(memory, identity)) return undefined;
  const entry = memory!.entries.find(([key]) => key === identity.key);
  try { return entry ? decode(entry[1]) : undefined; } catch { return undefined; }

  } finally { endStage(); }
}

export function rememberDisplay(memory: DisplayMemory | undefined, identity: Identity, layout: FolderLayout, recalled = false): DisplayMemory {
  const endStage = layoutStage('memory-commit'); try {

  const entries = compatible(memory, identity) ? memory!.entries : [];
  const existing = entries.find(([key]) => key === identity.key);
  const { displays: _memory, arrivals: _arrivals, arrivalPlacement: _placement, ...snapshot } = layout;
  const clean = (graph: FolderGraph): FolderGraph => ({ ...graph,
    plan: { ...graph.plan, request: { ...graph.plan.request, history: undefined, hint: undefined } },
    ...(graph.canonical ? { canonical: { ...graph.canonical, request: { ...graph.canonical.request, history: undefined, hint: undefined } } } : {}) });
  const value = (recalled ? existing?.[1] : undefined) ?? encode({ ...snapshot, graphs: new Map([...snapshot.graphs].map(([id, graph]) => [id, clean(graph)])) });
  return { folder: identity.folder, contents: identity.contents, members: identity.members.map(([k, v]) => [k, v]),
    entries: [...entries.filter(([key]) => key !== identity.key).slice(-(DISPLAY_LIMIT - 1)).map(([k, v]) => [k, v] as const), [identity.key, value]] };

  } finally { endStage(); }
}
