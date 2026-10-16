import { describe, expect, it } from "vitest";
import { crossingTable, packRuns, passageCrossings, passageRuns, PASSES_ON, planPassage, runCrossings, runsCross, type ChannelRun, type Passage } from "$lib/domain/trace-graph/passing-plan";
import { rng } from "../../../layout-eval/corpus";

/** Random runs of one channel: few distinct x's (so ties happen), a few sources, some ending at junctions others start from. */
function randomRuns(random: () => number, count: number): ChannelRun[] {
  const x = () => Math.floor(random() * 6) * 10;
  return Array.from({ length: count }, () => {
    const source = Math.floor(random() * 5), roll = random();
    return { top: x(), bottom: x(), source, end: roll < 0.5 ? PASSES_ON : 5 + Math.floor(random() * 3), weight: 1 + Math.floor(random() * 3) };
  });
}

/** The crossings of one run with the others, pair by pair. */
const bruteCrossings = (runs: readonly ChannelRun[], run: ChannelRun, self = -1) =>
  runs.reduce((sum, other, index) => index !== self && runsCross(run, other) ? sum + other.weight : sum, 0);

describe("passing plans: counting crossings", () => {
  it("counts a run as crossing another only when their ends are in opposite orders and they may not meet", () => {
    const run = (top: number, bottom: number, source: number, end = PASSES_ON): ChannelRun => ({ top, bottom, source, end, weight: 1 });
    expect(runsCross(run(0, 10, 1), run(10, 0, 2))).toBe(true);
    // Side by side, or sharing an end x: no crossing.
    expect(runsCross(run(0, 10, 1), run(10, 20, 2))).toBe(false);
    expect(runsCross(run(0, 10, 1), run(10, 10, 2))).toBe(false);
    // One source's runs branch from one trunk; a junction's inputs meet at it, and meet its output.
    expect(runsCross(run(0, 10, 1), run(10, 0, 1))).toBe(false);
    expect(runsCross(run(0, 10, 1, 7), run(10, 0, 2, 7))).toBe(false);
    expect(runsCross(run(0, 10, 1, 7), run(10, 0, 7))).toBe(false);
    expect(runsCross(run(10, 0, 7), run(0, 10, 1, 7))).toBe(false);
  });

  it("tables the crossings of every top and bottom pair as checking each run would", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed), runs = randomRuns(random, Math.floor(random() * 40));
      const tops = Array.from({ length: 1 + Math.floor(random() * 4) }, () => Math.floor(random() * 7) * 10 - 5 * Math.floor(random() * 2));
      const bottoms = Array.from({ length: 1 + Math.floor(random() * 4) }, () => Math.floor(random() * 7) * 10 - 5 * Math.floor(random() * 2));
      const source = Math.floor(random() * 5), end = random() < 0.5 ? PASSES_ON : 5 + Math.floor(random() * 3);
      const table = crossingTable(packRuns(runs), source, end, tops, bottoms);
      tops.forEach((top, i) => bottoms.forEach((bottom, j) =>
        expect(table[i * bottoms.length + j], `seed ${seed} (${top}, ${bottom})`).toBe(bruteCrossings(runs, { top, bottom, source, end, weight: 1 }))));
    }
  });

  it("counts every run's crossings in one sweep as checking each pair would, ties and exempt pairs included", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const random = rng(seed), runs = randomRuns(random, Math.floor(random() * 60));
      const each = runCrossings(packRuns(runs));
      runs.forEach((run, index) => expect(each[index], `seed ${seed} run ${index}`).toBe(bruteCrossings(runs, run, index)));
    }
  });

  it("handles no runs and a single run", () => {
    expect([...runCrossings(packRuns([]))]).toEqual([]);
    expect([...runCrossings(packRuns([{ top: 0, bottom: 5, source: 0, end: PASSES_ON, weight: 2 }]))]).toEqual([0]);
    expect([...crossingTable(packRuns([]), 0, PASSES_ON, [0, 5], [3])]).toEqual([0, 0]);
  });
});

/** Every choice of option per row. */
function* choices(passage: Passage, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === passage.rows.length) { yield prefix; return; }
  for (let option = 0; option < passage.rows[prefix.length].options.length; option++) yield* choices(passage, [...prefix, option]);
}

describe("passing plans: choosing slots", () => {
  const randomPassage = (random: () => number): { passage: Passage; others: Map<number, ChannelRun[]> } => {
    const rows = 1 + Math.floor(random() * 3), others = new Map<number, ChannelRun[]>();
    for (let channel = 0; channel <= rows; channel++) others.set(channel, randomRuns(random, Math.floor(random() * 12)).map((run) => ({ ...run, source: run.source + 10 })));
    const passage: Passage = {
      source: 1,
      start: { channel: 0, x: Math.floor(random() * 6) * 10, weight: 2 },
      rows: Array.from({ length: rows }, () => ({ options: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ x: Math.floor(random() * 6) * 10 + 5, cost: Math.floor(random() * 3) / 4 })), weight: 2 })),
      ends: [{ channel: rows, x: Math.floor(random() * 6) * 10, end: 3, weight: 1 }, ...(random() < 0.5 ? [{ channel: rows, x: Math.floor(random() * 6) * 10, end: 4, weight: 1 }] : [])],
    };
    return { passage, others };
  };
  const costOf = (passage: Passage, choice: readonly number[], others: (channel: number) => ReturnType<typeof packRuns>) =>
    passageCrossings(passage, choice, others) + choice.reduce((sum, option, row) => sum + passage.rows[row].options[option].cost, 0);

  it("takes the cheapest choice of all, counting each crossing once per edge a run carries", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const random = rng(seed), { passage, others } = randomPassage(random);
      const packed = new Map([...others].map(([channel, runs]) => [channel, packRuns(runs)]));
      const lookup = (channel: number) => packed.get(channel) ?? packRuns([]);
      const plan = planPassage(passage, lookup)!;
      const best = Math.min(...[...choices(passage)].map((choice) => costOf(passage, choice, lookup)));
      expect(plan.cost, `seed ${seed}`).toBeCloseTo(best, 9);
      expect(plan.cost).toBeCloseTo(costOf(passage, plan.choice, lookup), 9);
      expect(plan.crossings).toBe(passageCrossings(passage, plan.choice, lookup));
    }
  });

  it("prices a reference choice as its own plan would be priced", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed), { passage, others } = randomPassage(random);
      const packed = new Map([...others].map(([channel, runs]) => [channel, packRuns(runs)]));
      const lookup = (channel: number) => packed.get(channel) ?? packRuns([]);
      const reference = passage.rows.map((row) => Math.floor(random() * row.options.length));
      const { taken } = planPassage(passage, lookup, undefined, reference)!;
      expect(taken!.cost, `seed ${seed}`).toBeCloseTo(costOf(passage, reference, lookup), 9);
      expect(taken!.crossings).toBe(passageCrossings(passage, reference, lookup));
    }
  });

  it("adds what the price charges for a run, and counts it apart from the crossings", () => {
    // Straight down is free of crossings but charged; the detour crosses once.
    const passage: Passage = { source: 1, start: { channel: 0, x: 0, weight: 1 }, rows: [{ options: [{ x: 0, cost: 0 }, { x: 20, cost: 0 }], weight: 1 }], ends: [{ channel: 1, x: 0, end: 3, weight: 1 }] };
    const runs = new Map([[0, packRuns([{ top: 10, bottom: 10, source: 2, end: PASSES_ON, weight: 1 }])], [1, packRuns([{ top: 10, bottom: 30, source: 2, end: PASSES_ON, weight: 1 }])]]);
    const lookup = (channel: number) => runs.get(channel)!;
    expect(planPassage(passage, lookup)!.choice).toEqual([0]);
    const charged = planPassage(passage, lookup, (channel, tops, bottoms) => channel === 0 ? Float64Array.from(tops.flatMap((top) => bottoms.map((bottom) => top === bottom ? 5 : 0))) : null)!;
    expect(charged.choice).toEqual([1]);
    expect(charged.crossings).toBe(2);
  });

  it("orders runs by x and draws them where they run on the canvas", () => {
    const passage: Passage = { source: 1, start: { channel: 0, x: 50, weight: 1 }, rows: [{ options: [{ x: -1e9, at: 4, cost: 0 }], weight: 1 }], ends: [{ channel: 1, x: 30, end: 3, weight: 1 }] };
    expect(passageRuns(passage, [0]).map(({ channel, run, from, to }) => [channel, run.top, run.bottom, from, to])).toEqual([[0, 50, -1e9, 50, 4], [1, -1e9, 30, 4, 30]]);
  });

  it("finds no plan through a row without options", () => {
    const passage: Passage = { source: 1, start: { channel: 0, x: 0, weight: 1 }, rows: [{ options: [], weight: 1 }], ends: [{ channel: 1, x: 0, end: 3, weight: 1 }] };
    expect(planPassage(passage, () => packRuns([]))).toBeNull();
  });
});
