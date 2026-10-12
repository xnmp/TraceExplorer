/** Content refreshes can change request hints/cache identity without changing anything drawn. */
import type { GraphLayout } from "./layout";
import type { GridFlow, GridRect } from "./grid-flow";

const sameRect = (a: GridRect, b: GridRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const sameMap = <T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>, equal: (a: T, b: T) => boolean) =>
  a.size === b.size && [...a].every(([key, value]) => b.has(key) && equal(value, b.get(key)!));

export const sameGridGeometry = (a: GridFlow, b: GridFlow): boolean =>
  a.width === b.width && a.height === b.height && a.rowCount === b.rowCount
  && sameMap(a.cells, b.cells, (a, b) => sameRect(a, b) && a.row === b.row && a.col === b.col)
  && a.bands.length === b.bands.length && a.bands.every((band, i) => band.id === b.bands[i].id && band.row === b.bands[i].row && sameRect(band, b.bands[i]));

export const sameGraphGeometry = (a: GraphLayout, b: GraphLayout): boolean =>
  a.width === b.width && a.height === b.height && a.orientation === b.orientation
  && sameMap(a.nodes, b.nodes, sameRect)
  && sameMap(a.junctions, b.junctions, (a, b) => a.x === b.x && a.y === b.y)
  && a.routes.length === b.routes.length && a.routes.every((route, i) => route.id === b.routes[i].id && route.path === b.routes[i].path);
