/** Test process bridge only: copied reference-table value codec. Production worker transport is unchanged. */
export function encode(value: unknown): string {
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
export function decode(text: string): any {
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

