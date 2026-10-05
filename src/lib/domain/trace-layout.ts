/** Small, deterministic layered layout for an artifact/run DAG. */
export function traceOperationLabel(operation: string): string {
  if (operation === "image.crop") return "Crop";
  if (operation === "openai.image.edit") return "OpenAI edit";
  if (operation === "openai.image.generate") return "OpenAI image";
  return operation.replace(/^image\./, "");
}

export interface TraceLayoutInput {
  readonly artifacts: readonly { readonly id: number; readonly generatingRun: number | null }[];
  readonly runs: readonly { readonly id: number; readonly inputIds: readonly number[] }[];
}

export interface TraceLayoutNode {
  readonly key: string;
  readonly kind: "artifact" | "run";
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TraceLayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly path: string;
}

export interface TraceLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly TraceLayoutNode[];
  readonly edges: readonly TraceLayoutEdge[];
}

const ARTIFACT_WIDTH = 146;
const ARTIFACT_HEIGHT = 128;
const RUN_WIDTH = 90;
const RUN_HEIGHT = 38;
const COLUMN_GAP = 14;
const ROW_GAP = 30;
const PADDING = 14;

export function layoutTraceGraph(graph: TraceLayoutInput): TraceLayout {
  const artifacts = new Map(graph.artifacts.map((artifact) => [artifact.id, artifact]));
  const runs = new Map(graph.runs.map((run) => [run.id, run]));
  const outputRuns = new Set(graph.artifacts.flatMap((artifact) => artifact.generatingRun == null ? [] : [artifact.generatingRun]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();

  function rank(key: string): number {
    const cached = ranks.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return 0; // malformed cycle: keep layout bounded
    visiting.add(key);
    let value = 0;
    if (key.startsWith("a:")) {
      const artifact = artifacts.get(Number(key.slice(2)));
      if (artifact?.generatingRun != null && runs.has(artifact.generatingRun)) {
        value = rank(`r:${artifact.generatingRun}`);
      }
    } else {
      const run = runs.get(Number(key.slice(2)));
      if (run?.inputIds.length) {
        value = Math.max(...run.inputIds.filter((id) => artifacts.has(id)).map((id) => rank(`a:${id}`))) + 1;
        if (!Number.isFinite(value)) value = 1;
      }
    }
    visiting.delete(key);
    ranks.set(key, value);
    return value;
  }

  const levels = new Map<number, { key: string; kind: TraceLayoutNode["kind"]; id: number }[]>();
  for (const artifact of graph.artifacts) {
    const key = `a:${artifact.id}`;
    const depth = rank(key);
    levels.set(depth, [...(levels.get(depth) ?? []), { key, kind: "artifact", id: artifact.id }]);
  }
  for (const run of graph.runs.filter((run) => !outputRuns.has(run.id))) {
    const key = `r:${run.id}`;
    const depth = rank(key);
    levels.set(depth, [...(levels.get(depth) ?? []), { key, kind: "run", id: run.id }]);
  }
  const sortedLevels = [...levels].sort(([a], [b]) => a - b);
  const rowWidth = (items: readonly { kind: TraceLayoutNode["kind"] }[]) =>
    items.reduce((sum, item) => sum + (item.kind === "artifact" ? ARTIFACT_WIDTH : RUN_WIDTH), 0)
      + Math.max(0, items.length - 1) * COLUMN_GAP;
  const width = Math.max(320, ...sortedLevels.map(([, items]) => rowWidth(items) + PADDING * 2));
  const nodes: TraceLayoutNode[] = [];
  let y = PADDING;
  for (const [, unsorted] of sortedLevels) {
    const items = [...unsorted].sort((a, b) => a.id - b.id);
    const height = items.some((item) => item.kind === "artifact") ? ARTIFACT_HEIGHT : RUN_HEIGHT;
    let x = (width - rowWidth(items)) / 2;
    for (const item of items) {
      const itemWidth = item.kind === "artifact" ? ARTIFACT_WIDTH : RUN_WIDTH;
      nodes.push({ ...item, x, y, width: itemWidth, height: item.kind === "artifact" ? ARTIFACT_HEIGHT : RUN_HEIGHT });
      x += itemWidth + COLUMN_GAP;
    }
    y += height + ROW_GAP;
  }
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const edges: TraceLayoutEdge[] = [];
  const connected = new Set<string>();
  function connect(from: string, to: string): void {
    const key = `${from}->${to}`;
    if (connected.has(key)) return;
    const source = byKey.get(from);
    const target = byKey.get(to);
    if (!source || !target) return;
    connected.add(key);
    const startX = source.x + source.width / 2;
    const startY = source.y + source.height;
    const endX = target.x + target.width / 2;
    const endY = target.y;
    const middleY = (startY + endY) / 2;
    edges.push({ from, to, path: `M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}` });
  }
  for (const run of graph.runs) {
    const outputs = graph.artifacts.filter((artifact) => artifact.generatingRun === run.id);
    for (const input of run.inputIds) {
      if (outputs.length) for (const output of outputs) connect(`a:${input}`, `a:${output.id}`);
      else connect(`a:${input}`, `r:${run.id}`);
    }
  }
  return { width, height: Math.max(0, y - ROW_GAP + PADDING), nodes, edges };
}
