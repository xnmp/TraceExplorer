/** Metric attachment placement; packing supplies the discrete corridor/order. */
import { solveSeparation, type CoordinateVariable, type RoutingSegment, type Separation, type SeparationResult } from './separation';
import { ARROW, LANE_SEPARATION, STACK_STEM_ROOM, TRACK_HEIGHT } from './metrics';

export interface AttachmentMetric { readonly track: number; readonly stemRoom: number }
export interface AttachmentSegment extends Pick<RoutingSegment, 'id' | 'span'> {
  readonly preferred: AttachmentMetric;
  readonly pin?: AttachmentMetric;
}

/** The old cold spacing is a preference, not a clearance or a retained equality. */
export function attachmentPreferences(count: number): readonly AttachmentMetric[] {
  const step = count > 1 ? TRACK_HEIGHT + LANE_SEPARATION + 1 : TRACK_HEIGHT;
  const clearance = count > 1 ? LANE_SEPARATION + 1 : 0;
  return Array.from({ length: count }, (_, i) => ({ track: step * (i + 1),
    stemRoom: Math.max(STACK_STEM_ROOM, step * count + 2 * ARROW.length + clearance,
      step * (i + 1) + 2 * ARROW.length + step + clearance) }));
}

/** Child tops are individual variables. No later group's header constrains a pinned top. */
export function solveAttachmentChannel(segments: readonly AttachmentSegment[], apart = false, align: ReadonlySet<string> = new Set()): SeparationResult {
  const variables: CoordinateVariable[] = [];
  const separations: Separation[] = [];
  const track = (id: string) => id + ':track', top = (id: string) => id + ':top';
  for (const s of segments) {
    variables.push({ id: track(s.id), preferred: s.preferred.track, bounds: { lower: TRACK_HEIGHT },
      ...(s.pin ? { pin: { value: s.pin.track, reason: 'committed attachment track' } } : {}) });
    const tail = s.pin ? s.pin.stemRoom - s.pin.track : apart || segments.length === 1 ? 2 * ARROW.length + TRACK_HEIGHT : 2 * ARROW.length + TRACK_HEIGHT + 2 * (LANE_SEPARATION + 1);
    separations.push({ id: s.id + ':tail', before: track(s.id), after: top(s.id), gap: tail });
  }
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j];
    if (!apart && a.span[0] < b.span[1] && b.span[0] < a.span[1]) separations.push({
      id: a.id + '→' + b.id, before: track(a.id), after: track(b.id), gap: TRACK_HEIGHT + LANE_SEPARATION + 1,
    });
  }
  const alignedTop = Math.max(STACK_STEM_ROOM, ...segments.filter(s => align.has(s.id) && !s.pin).map(s => s.preferred.stemRoom));
  for (const s of segments) variables.push({ id: top(s.id), preferred: align.has(s.id) && !s.pin ? alignedTop : s.preferred.stemRoom, bounds: { lower: STACK_STEM_ROOM },
    ...(s.pin ? { pin: { value: s.pin.stemRoom, reason: 'committed child top' } } : {}) });
  return solveSeparation({ variables, order: variables.map(v => v.id), separations });
}
