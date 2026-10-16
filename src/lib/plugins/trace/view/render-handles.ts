/**
 * Render handles (docs/scene-transactions.md §6 "Remaining DOM reads"): the elements the
 * renderers drew for presented records, registered by key while they are mounted, so the motion
 * driver can apply native effects to them without querying the DOM for membership.
 *
 * Keys: a live record's entity id (a cover's is its cell), `section:<graph id>` for a stack's
 * section, `layer:<entity id>` for a live connector's or junction's motion layer, a retiree's
 * render id, and `grid`.
 */
import type { Attachment } from "svelte/attachments";

export interface RenderHandles {
  /** Registers the element it is attached to under `key` while that element is mounted. */
  attach(key: string): Attachment<HTMLElement | SVGElement>;
  /** All copies of a shared motion container (route and tile paint planes). */
  all?(key: string): readonly (HTMLElement | SVGElement)[];
  /** The mounted element for `key`, if any. */
  get(key: string): HTMLElement | SVGElement | undefined;
}

export const sectionKey = (graphId: string): string => `section:${graphId}`;
export const layerKey = (id: string): string => `layer:${id}`;
export const exitBodyKey = (id: string): string => `exit-body:${id}`;
export const GRID = "grid";

export function createRenderHandles(): RenderHandles {
  const elements = new Map<string, Set<HTMLElement | SVGElement>>();
  return {
    attach: (key) => (element) => {
      const copies = elements.get(key) ?? new Set<HTMLElement | SVGElement>();
      copies.add(element); elements.set(key, copies);
      return () => { copies.delete(element); if (!copies.size) elements.delete(key); };
    },
    get: (key) => elements.get(key)?.values().next().value,
    all: (key) => [...elements.get(key) ?? []],
  };
}
