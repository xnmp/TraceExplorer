/** Last connected graphs survive inspector remounts during folder navigation. */
import type { TraceGraph } from "$lib/api/trace";
import { samePath } from "$lib/domain/path";
import { traceThumbnails } from "./thumbnail-cache";
import { promptTitles } from "./prompt-titles.svelte";
import { traceViewTarget } from "./view-target.svelte";

let snapshots: readonly TraceGraph[] = [];
let emptyPaths:readonly string[]=[];
let viewedPath="";
export function lastTracePath():string{return viewedPath;}
export function cachedTraceJob(id: number): TraceGraph | null { return snapshots.find(graph=>graph.jobId===id) ?? null; }
export function noteTracePath(path:string):void{viewedPath=path;}
export function cachedTrace(path: string): TraceGraph | null {
  if(!path)return null;
  if(emptyPaths.some((empty)=>samePath(empty,path)))return null;
  return snapshots.find((graph) => samePath(graph.selectedPath ?? "",path) || graph.artifacts.some((artifact) => samePath(artifact.path, path))) ?? null;
}
export function hasTraceSnapshot(path:string):boolean{return !!path&&(emptyPaths.some((empty)=>samePath(empty,path))||cachedTrace(path)!==null);}
export function rememberEmptyTrace(path:string):void{emptyPaths=[path,...emptyPaths.filter((old)=>!samePath(old,path))].slice(0,2);}
export function rememberTrace(graph: TraceGraph): void {
  emptyPaths=emptyPaths.filter((path)=>!samePath(path,graph.selectedPath??"")&&!graph.artifacts.some((artifact)=>samePath(artifact.path,path)));
  const ids = new Set(graph.artifacts.map((artifact) => artifact.id));
  snapshots = [graph, ...snapshots.filter((previous) => !previous.artifacts.some((artifact) => ids.has(artifact.id)))].slice(0, 2);
}
export function clearTraceCache(): void { snapshots = []; emptyPaths=[]; viewedPath=""; traceThumbnails.clear(); promptTitles.clear(); traceViewTarget.clear(); }
