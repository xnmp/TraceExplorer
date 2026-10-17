/** Painted dimensions shared by renderers and independent geometry certification. */
export const JUNCTION_RADIUS = 2.8;
export const JUNCTION_STROKE_WIDTH = 1;
export const CONNECTOR_STROKE = { normal: 1.35, branch: 1.6, highlight: 2.3 } as const;
/** Any styling state may be applied without running layout again. */
export const JUNCTION_CLEARANCE = JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2
  + Math.max(...Object.values(CONNECTOR_STROKE)) / 2;
