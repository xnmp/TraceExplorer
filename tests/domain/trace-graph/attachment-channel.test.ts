import { describe, expect, it } from 'vitest';
import { attachmentPreferences, solveAttachmentChannel } from '$lib/domain/trace-graph/attachment-channel';
import { ARROW, LANE_SEPARATION, STACK_STEM_ROOM, TRACK_HEIGHT } from '$lib/domain/trace-graph/metrics';

describe('attachment constraints', () => {
  it('differentially preserves cold shared-row metrics', () => {
    for (let count = 0; count <= 30; count++) {
      // Pre-consolidation sharedAttachments, retained here as a differential oracle.
      const step = count > 1 ? 6 + LANE_SEPARATION + 1 : TRACK_HEIGHT;
      const clearance = count > 1 ? LANE_SEPARATION + 1 : 0;
      const header = Math.max(STACK_STEM_ROOM, step * count + 2 * ARROW.length + clearance);
      const expected = Array.from({ length: count }, (_, i) => ({ track: step * (i + 1),
        stemRoom: Math.max(header, step * (i + 1) + 2 * ARROW.length + step + clearance) }));
      expect(attachmentPreferences(count)).toEqual(expected);
      const result = solveAttachmentChannel(expected.map((preferred, i) => ({ id: `${i}`, preferred, span: [0, 100] })));
      expect(result.ok).toBe(true);
      if (result.ok) expected.forEach((value, i) => {
        expect(result.positions.get(`${i}:track`)).toBe(value.track);
        expect(result.positions.get(`${i}:top`)).toBe(value.stemRoom);
      });
    }
  });

  it('gives a new group deeper tracks and header without raising a retained child top', () => {
    const [a, b] = attachmentPreferences(2);
    const result = solveAttachmentChannel([
      { id: 'forest', span: [0, 200], preferred: a, pin: { track: 6, stemRoom: 34 } },
      { id: 'fan', span: [0, 350], preferred: b },
    ]);
    expect(result.ok && Object.fromEntries(result.positions)).toEqual({ 'forest:track': 6, 'fan:track': 20, 'forest:top': 34, 'fan:top': 50 });
  });

  it('returns a pin conflict when an insertion cannot fit between retained tracks', () => {
    const preferred = { track: 10, stemRoom: 40 };
    const result = solveAttachmentChannel([
      { id: 'first', span: [0, 200], preferred, pin: { track: 6, stemRoom: 34 } },
      { id: 'new', span: [0, 200], preferred },
      { id: 'last', span: [0, 200], preferred, pin: { track: 20, stemRoom: 50 } },
    ]);
    expect(result).toMatchObject({ ok: false, conflict: { kind: 'bounds' } });
    if (!result.ok) {
      expect(result.conflict.constraints).toEqual(expect.arrayContaining(['first:track:pin', 'first→new', 'new→last']));
      expect(result.conflict.constraints.at(-1)).toMatch(/^last:.*:pin$/);
    }
  });

  it('lets disjoint swept spans keep their lone tracks', () => {
    const preferred = attachmentPreferences(1)[0];
    const result = solveAttachmentChannel([
      { id: 'a', span: [0, 100], preferred }, { id: 'b', span: [112, 200], preferred },
    ], true);
    expect(result.ok && [...result.positions.values()]).toEqual([6, 6, 34, 34]);
  });
});
