/** Stable cover identities, independent of component IDs and grid cells. */
import type { ComponentSummary } from "$lib/domain/trace-graph/model";

export const pathIdentity = (path: string): string => `path:${path}`;
export const revisionIdentity = (key: string): string => `revision:${key}`;
/** Missing covers may return, but must not accumulate for the entire session. */
export const MAX_UNRESOLVED_OPEN_STACKS = 256;
/** `cover.path` can be the title's reference badge, rather than the drawn cover.
 * Only use a path the folder index assigns to this stack; unlisted covers use
 * their revision key, which fresh node pages can resolve after a merge.
 */
export const coverIdentity = (summary: ComponentSummary, members: ReadonlyMap<string, { readonly componentId: string }>): string =>
  summary.cover?.present && members.get(summary.cover.path)?.componentId === summary.id
    ? pathIdentity(summary.cover.path) : revisionIdentity(summary.coverKey);

export interface OpenStackComponent {
  readonly coverKey: string;
  /** Stable identity of the current cover, used to forget missing predecessors on close. */
  readonly coverIdentity?: string;
  /** Present paths/revisions belonging to this component, including former covers. */
  readonly identities: ReadonlySet<string>;
}

/**
 * Re-resolve remembered covers against current membership. Keep predecessor
 * identities through a merge: a later split follows each remembered cover.
 * Keep the most recently remembered unresolved identities so disappearing
 * covers reopen when they return. Resolved identities do not consume that
 * budget. Input order is recency; resolution does not change it.
 * No component ID is persisted here.
 */
export function resolveOpenStacks(remembered: unknown, components: readonly OpenStackComponent[], previousOwners: ReadonlyMap<string, string> = new Map()) {
  const keys = remembered instanceof Set || Array.isArray(remembered) ? [...remembered] : [];
  const owners = new Map<string, string>();
  for (const component of components) for (const identity of component.identities) owners.set(identity, component.coverKey);
  const retained = new Set<string>(), unresolved = new Set<string>(), open = new Set<string>();
  const coverOwners = new Map<string, string>();
  for (const component of components) for (const identity of component.identities) {
    coverOwners.set(identity, component.coverIdentity ?? revisionIdentity(component.coverKey));
  }
  const rememberedOwners = new Map<string, string>();
  for (const key of keys) {
    if (typeof key !== "string" || !/^(?:path|revision):.+$/s.test(key)) continue;
    retained.add(key);
    const cover = owners.get(key);
    if (cover) open.add(cover);
    else unresolved.add(key);
    const previous = previousOwners.get(key);
    const owner = coverOwners.get(key) ?? (previous && (coverOwners.get(previous) ?? previous));
    if (owner) rememberedOwners.set(key, owner);
  }
  for (const key of unresolved) {
    if (unresolved.size <= MAX_UNRESOLVED_OPEN_STACKS) break;
    unresolved.delete(key);
    retained.delete(key);
    rememberedOwners.delete(key);
  }
  return { remembered: retained, open, unresolved, owners: rememberedOwners };
}

/** Closing a stack also forgets missing covers last resolved into that stack. */
export function forgetOpenStack(state: ReturnType<typeof resolveOpenStacks>, component: OpenStackComponent): ReadonlySet<string> {
  const owner = component.coverIdentity ?? revisionIdentity(component.coverKey);
  return new Set([...state.remembered].filter((key) => key !== owner && !component.identities.has(key) && state.owners.get(key) !== owner));
}
