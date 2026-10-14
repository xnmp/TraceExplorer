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
  /** The mounted element for `key`, if any. */
  get(key: string): HTMLElement | SVGElement | undefined;
}

export const sectionKey = (graphId: string): string => `section:${graphId}`;
export const layerKey = (id: string): string => `layer:${id}`;
export const GRID = "grid";

export function createRenderHandles(): RenderHandles {
  const elements = new Map<string, HTMLElement | SVGElement>();
  return {
    attach: (key) => (element) => {
      elements.set(key, element);
      return () => { if (elements.get(key) === element) elements.delete(key); };
    },
    get: (key) => elements.get(key),
  };
}
