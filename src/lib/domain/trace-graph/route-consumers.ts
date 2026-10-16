import type { Consumer } from './junctions';

/** A range in a shared immutable table survives structured cloning without duplicating its contents. */
export type ConsumerSet = readonly Consumer[] | {
  readonly entries: readonly Consumer[];
  readonly start: number;
  readonly end: number;
};
export const consumerCount = ({ consumers }: { readonly consumers: ConsumerSet }): number =>
  Array.isArray(consumers) ? consumers.length : (consumers as Exclude<ConsumerSet, readonly Consumer[]>).end - (consumers as Exclude<ConsumerSet, readonly Consumer[]>).start;

export function routeConsumers({ consumers }: { readonly consumers: ConsumerSet }): readonly Consumer[] {
  if (Array.isArray(consumers)) return consumers;
  const range = consumers as Exclude<ConsumerSet, readonly Consumer[]>;
  return range.entries.slice(range.start, range.end);
}

/** Filter a shared table once, then translate all its ranges by prefix counts. */
export function filterRouteConsumers<T extends { readonly consumers: ConsumerSet }>(routes: readonly T[], keep: (c: Consumer) => boolean): T[] {
  const tables = new Map<readonly Consumer[], { entries: readonly Consumer[]; prefix: Uint32Array }>();
  return routes.flatMap(route => {
    const c = route.consumers;
    if (Array.isArray(c)) {
      const entries = c.filter(keep);
      return entries.length ? [{ ...route, consumers: entries.length === c.length ? c : entries }] : [];
    }
    const range = c as Exclude<ConsumerSet, readonly Consumer[]>;
    let table = tables.get(range.entries);
    if (!table) {
      const entries: Consumer[] = [], prefix = new Uint32Array(range.entries.length + 1);
      range.entries.forEach((entry, i) => { if (keep(entry)) entries.push(entry); prefix[i + 1] = entries.length; });
      table = { entries: entries.length === range.entries.length ? range.entries : entries, prefix };
      tables.set(range.entries, table);
    }
    const start = table.prefix[range.start], end = table.prefix[range.end];
    return end > start ? [{ ...route, consumers: table.entries === range.entries ? c : { entries: table.entries, start, end } }] : [];
  });
}

export function* eachConsumer({ consumers }: { readonly consumers: ConsumerSet }): Iterable<Consumer> {
  if (Array.isArray(consumers)) { yield* consumers; return; }
  const range = consumers as Exclude<ConsumerSet, readonly Consumer[]>;
  for (let i = range.start; i < range.end; i++) yield range.entries[i];
}
