/** Compatibility entry point for the former unbounded column fallback. */
import type { GraphLayout, LayoutRequest } from './layout';
import { safeLayout } from './safe-layout';

export function safeColumns(request: LayoutRequest): GraphLayout {
  return safeLayout(request);
}
