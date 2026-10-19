/** Request-local semantic indexes; string construction/hash lookup pays key
 * bytes before the operation. No identity or native span is sampled. */
export type WorldCharge = (work: number, reason?: string) => void;
export function worldHas(index: ReadonlyMap<string, unknown> | ReadonlySet<string>, key: string, charge: WorldCharge, why = 'world semantic membership'): boolean { charge(key.length + 1, why); return index.has(key); }
export function worldEntries<T>(values: Iterable<readonly [
    string,
    T
]>, charge: WorldCharge, why: string): Map<string, T> { const result = new Map<string, T>(); for (const [key, value] of values)
    worldSet(result, key, value, charge, why); return result; }
export function sameWorldIdentities(a: readonly string[], b: readonly string[], charge: WorldCharge): boolean { charge(1, 'ordered semantic identities'); if (a.length !== b.length)
    return false; for (let i = 0; i < a.length; i++) {
    charge(a[i].length + b[i].length + 1, 'ordered semantic identity bytes');
    if (a[i] !== b[i])
        return false;
} return true; }
export function worldGet<T>(m: ReadonlyMap<string, T>, key: string, charge: WorldCharge, why = 'world semantic lookup'): T | undefined { charge(key.length + 1, why); return m.get(key); }
export function worldSet<T>(m: Map<string, T>, key: string, value: T, charge: WorldCharge, why = 'world semantic insertion'): void { charge(key.length + 1, why); m.set(key, value); }
export function worldIndex<T>(values: Iterable<T>, keyOf: (v: T) => string, charge: WorldCharge, why: string, first = false): Map<string, T> {
    const m = new Map<string, T>();
    for (const v of values) {
        charge(1, why);
        const key = keyOf(v);
        charge(3 * (key.length + 1), why);
        if (!first || !m.has(key))
            m.set(key, v);
    }
    return m;
}
export function worldGroups<T>(values: Iterable<T>, keyOf: (v: T) => string, charge: WorldCharge, why: string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const v of values) {
        charge(1, why);
        const key = keyOf(v);
        charge(2 * (key.length + 1), why);
        let group = m.get(key);
        if (!group) {
            group = [];
            m.set(key, group);
        }
        group.push(v);
    }
    return m;
}
export function worldCopy<T>(values: ReadonlyMap<string, T>, charge: WorldCharge, why: string): Map<string, T> {
    const m = new Map<string, T>();
    for (const [key, v] of values)
        worldSet(m, key, v, charge, why);
    return m;
}
/** JSON escaping uses at most six output bytes per UTF-16 unit; a numeric
 * scalar's finite serialization fits within32. Prepay before stringifying. */
export function worldKey(values: readonly (string | number)[], charge: WorldCharge, why = 'world identity serialization'): string { charge(2 + values.reduce<number>((n, v) => n + (typeof v === 'string' ? 6 * v.length + 3 : 33), 0), why); return JSON.stringify(values); }
export function worldPositions(texts: readonly string[], charge: WorldCharge): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        charge(2 * (text.length + 1), 'native raw position indexing');
        let positions = m.get(text);
        if (!positions) {
            positions = [];
            m.set(text, positions);
        }
        positions.push(i);
    }
    return m;
}
export function nextWorldPosition(positions: readonly number[], minimum: number, charge: WorldCharge): number | undefined {
    let lo = 0, hi = positions.length;
    while (lo < hi) {
        charge(1, 'native span ordered lookup');
        const mid = Math.floor((lo + hi) / 2);
        if (positions[mid] < minimum)
            lo = mid + 1;
        else
            hi = mid;
    }
    return positions[lo];
}
