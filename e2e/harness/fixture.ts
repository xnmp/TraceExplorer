import { configureBackend } from "$lib/api/common";
import type { TraceGraph } from "$lib/api/trace";
import { promptTitles } from "$lib/plugins/trace/prompt-titles.svelte";
import { traceInvalidation } from "$lib/plugins/trace/invalidation.svelte";
export const paths = {
  source: "/fixture/one/source.png",
  edit: "/fixture/one/source_edit.png",
  later: "/fixture/two/source_edit_2.png",
  unrelated: "/fixture/unrelated/unrelated.png",
  empty: "/fixture/unrelated/empty.png",
  saveParent: "/fixture/images/parent.png",
  temporary: "/fixture/managed/generated-302.png",
  revision: "/fixture/revisions/shared.png",
};
const artifact = (id: number, path: string, generatingRun: number | null) => ({
  id, path, generatingRun, digest: String(id).repeat(64).slice(0, 64),
  createdAt: "2026-10-05T00:00:00Z", pathState: "present" as const,
});
const run = (id: number, inputIds: number[], prompt: string) => ({
  id, inputIds, operation: "openai.image.edit", parameters: { prompt, resolution: "2k", aspect_ratio: "keep" },
  createdAt: "2026-10-05T00:00:00Z", status: "succeeded" as const,
  finishedAt: "2026-10-05T00:01:00Z", error: null, recovered: false,
});
export const lineage = {
  artifacts: [artifact(1, paths.source, null), artifact(2, paths.edit, 10), artifact(3, paths.later, 11)],
  runs: [run(10, [1], "Turn the rectangle blue."), run(11, [2], "Add a white stripe.")],
};
type Request = { id: number; path: string; resolve: (graph: TraceGraph | null) => void; reject: (error: Error) => void };
let requests: Request[] = [];
let sequence = 0;
type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
let suggestions: Deferred<{directory:string;filename:string}>[] = [];
let pickers: Deferred<string | null>[] = [];
let saves: Deferred<{path:string}>[] = [];
const suggestionCalls: unknown[] = [];
const pickerCalls: unknown[] = [];
const saveCalls: unknown[] = [];
let permanentPath: string | null = null;
let discarded = false;
let titleConnection = false;
const titleCalls: number[] = [];
const titleRequests = new Map<number, (title:string)=>void>();
const generationCalls: Array<{jobId:number; request:Record<string,any>}> = [];
let generationsComplete = false;
const generationDiscards = new Set<number>();
function generationGraph(jobId:number): TraceGraph {
  const first = generationCalls.find(call=>call.jobId===jobId)!;
  const cohort = first.request.batch ? generationCalls.filter(call=>call.request.batch?.id===first.request.batch.id) : [first];
  const artifacts = generationsComplete ? cohort.map(call=>({...artifact(call.jobId+1000,`/fixture/managed/batch-${call.request.batch?.index ?? 0}.png`,call.jobId),temporary:true,discarded:generationDiscards.has(call.jobId+1000)})) : [];
  return {jobId,currentArtifactId:artifacts.find(item=>!item.discarded)?.id ?? 0,selectedPath:artifacts.find(item=>!item.discarded)?.path ?? "",selectedRevisionStatus:"matched",artifacts,runs:cohort.map(call=>({...run(call.jobId,[],String(call.request.prompt)),operation:"openai.image.generate",parameters:{prompt:call.request.prompt,batch:call.request.batch,resolution:call.request.resolution,aspect_ratio:call.request.aspectRatio},status:generationsComplete ? "succeeded" : "running"}))};
}
const discardCalls: unknown[] = [];
const thumbnailCalls: string[] = [];
let holdThumbnails = false;
let thumbnailRequests: Array<() => void> = [];
const savedLineage = () => ({
  artifacts: [artifact(301, paths.saveParent, null), {...artifact(302, permanentPath ?? paths.temporary, 401), temporary: permanentPath === null, discarded}],
  runs: [run(401, [301], "Keep the same image; make the rectangle blue.")],
});
const revisions = () => ({
  artifacts: [artifact(501, paths.revision, 601), artifact(502, paths.revision, 602)],
  runs: [run(601, [], "Older recorded blue edit."), run(602, [501], "Newest recorded stripe edit.")],
});
export const controller = {
  generationCalls: () => structuredClone(generationCalls),
  completeGenerations() { generationsComplete = true; traceInvalidation.bump(); },
  titleConnection(value: boolean) { titleConnection = value; },
  configureTitles(settings = {}) { return promptTitles.configure(settings); },
  titleCalls: () => [...titleCalls],
  finishTitle(id:number,title:string) { const resolve=titleRequests.get(id); if(!resolve)throw new Error("No title request"); titleRequests.delete(id);resolve(title); },
  thumbnailCalls: () => [...thumbnailCalls],
  holdThumbnails: () => { holdThumbnails = true; },
  releaseThumbnails: () => { holdThumbnails = false; const pending = thumbnailRequests; thumbnailRequests = []; pending.forEach((resolve) => resolve()); },
  pending: () => requests.map(({ id, path }) => ({ id, path })),
  resolveTrace(id: number, graph: TraceGraph | null) {
    const request=requests.find(item=>item.id===id);
    if(!request)throw new Error(`No pending request ${id}`);
    requests=requests.filter(item=>item!==request);
    request.resolve(graph);
  },
  saveState: () => ({suggestionCalls, pickerCalls, saveCalls, discardCalls, pendingSuggestions:suggestions.length, pendingPickers:pickers.length, pendingSaves:saves.length, permanentPath}),
  suggestion(filename = "parent_edit.png") { const request=suggestions.shift(); if (!request) throw new Error("No pending save suggestion"); request.resolve({directory:"/fixture/images",filename}); },
  picker(path: string | null) { const request=pickers.shift(); if (!request) throw new Error("No pending picker"); request.resolve(path); },
  saveSuccess(path?: string) {
    const request=saves.shift(); if (!request) throw new Error("No pending save");
    permanentPath=path ?? (saveCalls.at(-1) as {target?:string}).target ?? "/fixture/images/parent_edit.png";
    request.resolve({path:permanentPath});
  },
  saveReject(message = "Destination already exists") { const request=saves.shift(); if (!request) throw new Error("No pending save"); request.reject(new Error(message)); },
  succeed(id: number, status: TraceGraph["selectedRevisionStatus"] = "matched", currentArtifactId?: number) {
    const request = requests.find((item) => item.id === id);
    if (!request) throw new Error(`No pending request ${id}`);
    requests = requests.filter((item) => item !== request);
    if (request.path.startsWith("job:")) request.resolve(generationGraph(Number(request.path.slice(4))));
    else if (request.path.startsWith('/fixture/managed/batch-')) {
      const call = generationCalls.find(call=>request.path===`/fixture/managed/batch-${call.request.batch?.index ?? 0}.png`)!;
      request.resolve({...generationGraph(call.jobId),selectedPath:request.path,currentArtifactId:call.jobId+1000});
    }
    else if (request.path === paths.empty) request.resolve(null);
    else if (request.path === paths.revision) request.resolve({...revisions(),selectedPath:request.path,currentArtifactId:currentArtifactId ?? 502,selectedRevisionStatus:status});
    else if ([paths.saveParent,paths.temporary,permanentPath].includes(request.path)) request.resolve({
      ...savedLineage(), selectedPath:request.path,currentArtifactId:request.path===paths.saveParent ? 301 : 302,selectedRevisionStatus:status,
    });
    else if (request.path === paths.unrelated) request.resolve({
      selectedPath:request.path,currentArtifactId: 101, selectedRevisionStatus: status,
      artifacts: [artifact(101, paths.unrelated, 201)], runs: [run(201, [], "Unrelated green circle.")],
    });
    else request.resolve({ ...structuredClone(lineage),
      selectedPath:request.path,currentArtifactId: lineage.artifacts.find((item) => item.path === request.path)?.id ?? 1,
      selectedRevisionStatus: status,
    });
  },
  fail(id: number, message = "Controlled refresh failure") {
    const request = requests.find((item) => item.id === id);
    if (!request) throw new Error(`No pending request ${id}`);
    requests = requests.filter((item) => item !== request);
    request.reject(new Error(message));
  },
};
configureBackend({ invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  if(method==='folder_has_trace') return Promise.resolve((params?.directory==='/fixture/one' || params?.directory==='/fixture/images' && generationCalls.length>0) as T);
  if (method === "jobs.start") {
    const jobId = 200 + generationCalls.length;
    generationCalls.push({jobId,request:structuredClone(params?.request) as Record<string,any>});
    return Promise.resolve(jobId as T);
  }
  if (method === "trace_for_job") return new Promise(resolve=>requests.push({id:++sequence,path:`job:${params?.jobId}`,resolve:resolve as Request["resolve"],reject:()=>{}}));
  if (method === "trace_title_connection") return Promise.resolve(titleConnection as T);
  if (method === "trace_prompt_title") {
    const id = Number(params?.runId); titleCalls.push(id);
    return new Promise(resolve=>titleRequests.set(id,resolve as (title:string)=>void));
  }
  if (method === "image_save_suggestion") {
    suggestionCalls.push(structuredClone(params));
    return new Promise((resolve,reject)=>suggestions.push({resolve:resolve as Deferred<{directory:string;filename:string}>["resolve"],reject}));
  }
  if (method === "discard_generated_image") {
    const id=Number(params?.artifactId);generationDiscards.add(id);
    discardCalls.push(structuredClone(params));
    if(id>=1200) return Promise.resolve({viewPath:generationGraph(id-1000).selectedPath || null} as T);
    discarded = true; return Promise.resolve({viewPath:paths.saveParent} as T);
  }
  if (method === "save_generated_image") {
    saveCalls.push(structuredClone(params));
    return new Promise((resolve,reject)=>saves.push({resolve:resolve as Deferred<{path:string}>["resolve"],reject}));
  }
  if (method !== "trace_for_image") return Promise.reject(new Error(`Unexpected method ${method}`));
  return new Promise((resolve, reject) => {
    requests.push({ id: ++sequence, path: String(params?.path), resolve: resolve as Request["resolve"], reject });
  });
} });
(globalThis as any).__TAURI_EXPLORER_PLUGIN_SDK__ = {
  sdkVersion: 1, svelteVersion: "5.56.3", modules: {},
  pickSaveFile: (options: unknown) => {
    pickerCalls.push(structuredClone(options));
    return new Promise<string | null>((resolve,reject)=>pickers.push({resolve,reject}));
  },
  thumbnailData: async (path: string) => {
    thumbnailCalls.push(path);
    if (holdThumbnails) await new Promise<void>((resolve) => thumbnailRequests.push(resolve));
    return { ok: true, data: URL.createObjectURL(new Blob([
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="${path === paths.unrelated ? "#437453" : "#4167c5"}"/><circle cx="100" cy="50" r="25" fill="white"/></svg>`,
    ], { type: "image/svg+xml" })) };
  },
};
