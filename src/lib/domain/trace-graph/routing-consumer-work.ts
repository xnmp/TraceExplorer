/** Prepay expanded semantic relationship work, including shared-table aliases. */
import type { GraphLayout, PlacedRoute } from './layout';
import { eachConsumer } from './route-consumers';
export const sameRoutingOwnership = (before: PlacedRoute, after: PlacedRoute, charge: (work: number, reason?: string) => void): boolean => {
  const count = (route: PlacedRoute) => Array.isArray(route.consumers) ? route.consumers.length
    : (route.consumers as { readonly start: number; readonly end: number }).end - (route.consumers as { readonly start: number }).start;
  const size = count(before);
  charge(8 * (size + count(after) + before.from.id.length + before.to.id.length + after.from.id.length + after.to.id.length + 8),
    'retained route ownership');
  if (before.from.kind !== after.from.kind || before.from.id !== after.from.id || before.to.kind !== after.to.kind
    || before.to.id !== after.to.id || before.terminal !== after.terminal || size !== count(after)) return false;
  const left = eachConsumer(before)[Symbol.iterator](), right = eachConsumer(after)[Symbol.iterator]();
  for (let i = 0; i < size; i++) {
    const a = left.next().value!, b = right.next().value!;
    charge(8 * (a.parent.length + a.child.length + b.parent.length + b.child.length + 4), 'retained consumer ownership bytes');
    if (a.parent !== b.parent || a.child !== b.child) return false;
  }
  return true;
};
export const chargeRoutingConsumers = (drawing: GraphLayout, charge: (work: number, reason?: string) => void) => {
  charge(drawing.routes.length + 1, 'fragment native relationship passes');
  for (const route of drawing.routes) {
    const count = Array.isArray(route.consumers) ? route.consumers.length
      : (route.consumers as { readonly start: number; readonly end: number }).end - (route.consumers as { readonly start: number }).start;
    charge(count + 1, 'fragment expanded consumer iteration');
    for (const consumer of eachConsumer(route))
      charge(16 * (consumer.parent.length + consumer.child.length + 8), 'fragment native consumer identity bytes');
  }
};
