import type { TraceGraph, TraceRun } from "$lib/api/trace";
import type { TraceLayout } from "./trace-layout";

export function traceBatch(run: TraceRun | undefined): {id:string; index:number; count:number} | null {
  const value = run?.parameters.batch;
  if (!value || typeof value !== "object") return null;
  const {id,index,count} = value as Record<string,unknown>;
  return typeof id === "string" && /^[a-f\d-]{32,36}$/i.test(id)
    && typeof index === "number" && Number.isInteger(index) && index >= 0
    && typeof count === "number" && Number.isInteger(count) && count >= 2 && count <= 8 && index < count
    ? {id,index,count} : null;
}

export function traceBatchGroups(graph: TraceGraph, layout: TraceLayout) {
  const groups = new Map<string, {count:number; keys:string[]}>();
  for (const run of graph.runs) {
    const batch = traceBatch(run);
    if (!batch) continue;
    const group = groups.get(batch.id) ?? {count:batch.count,keys:[]};
    const outputs = graph.artifacts.filter(artifact => artifact.generatingRun === run.id && !artifact.discarded);
    group.keys.push(...(outputs.length ? outputs.map(artifact=>`a:${artifact.id}`) : [`r:${run.id}`]));
    groups.set(batch.id,group);
  }
  return [...groups].flatMap(([id,group])=>{
    const nodes = layout.nodes.filter(node=>group.keys.includes(node.key));
    if (!nodes.length) return [];
    const x = Math.min(...nodes.map(node=>node.x)) - 6;
    const y = Math.min(...nodes.map(node=>node.y)) - 18;
    return [{id,count:group.count,x,y,width:Math.max(...nodes.map(node=>node.x+node.width))-x+6,height:Math.max(...nodes.map(node=>node.y+node.height))-y+6}];
  });
}
