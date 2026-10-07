import { invoke } from "$lib/api/common";
import type { TraceRun } from "$lib/api/trace";
import type { PluginStorage } from "../api";

let titles = $state<Readonly<Record<number,string>>>({});
let pending = $state<readonly number[]>([]);
const requested = new Set<number>();
let generation = 0;
let configured = $state(false);
let executable = "";
let settingsRevision = 0;
let unsubscribe: (()=>void) | undefined;
let queue: number[] = [];
let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const runId = queue.shift()!;
      const current = generation;
      try {
        const title = await invoke<string>("trace_prompt_title",{runId,codexPath:executable});
        if (current === generation && typeof title === "string" && title.trim()) titles = {...titles,[runId]:title};
      } catch { /* Keep the full prompt when the configured generator fails. */ }
      finally { if (current === generation) pending = pending.filter(id=>id!==runId); }
    }
  } finally { draining = false; }
}
export const promptTitles = {
  get configured() { return configured; },
  async configure(settings: Record<string,unknown>) {
    const revision = ++settingsRevision;
    configured = false;
    generation += 1; pending = []; queue = []; requested.clear();
    executable = typeof settings.titleCodexPath === "string" && settings.titleCodexPath.trim() ? settings.titleCodexPath.trim() : typeof settings.codexPath === "string" ? settings.codexPath : "";
    if (settings.titleGenerator === "disabled") return;
    const available = await invoke<boolean>("trace_title_connection",{codexPath:executable}).catch(()=>false);
    if (revision === settingsRevision) configured = available === true;
  },
  bind(storage: PluginStorage) {
    unsubscribe?.();
    const revision = settingsRevision;
    unsubscribe = storage.subscribe?.(settings=>{void this.configure(settings);});
    void storage.get().then(settings=>{if(revision===settingsRevision)void this.configure(settings);}).catch(()=>{});
  },
  unbind() { unsubscribe?.(); unsubscribe = undefined; settingsRevision += 1; configured = false; this.clear(); },
  label(run: TraceRun | undefined) { return run ? titles[run.id] || (typeof run.parameters.prompt === "string" ? run.parameters.prompt : "") : ""; },
  /** Title for a run known only by id and (possibly truncated) prompt. */
  labelFor(runId: number | null, prompt: string) { return runId === null ? "" : titles[runId] || prompt; },
  loadFor(runId: number | null, prompt: string) { if (runId !== null) this.request(runId, prompt); },
  pending(id: number) { return pending.includes(id); },
  load(run: TraceRun) { if (typeof run.parameters.prompt === "string") this.request(run.id, run.parameters.prompt); },
  request(runId: number, prompt: string) {
    if (!configured || requested.has(runId) || titles[runId] || !prompt.trim()) return;
    requested.add(runId);
    pending = [...pending,runId];
    queue = [...queue,runId];
    void drain();
  },
  clear() { generation += 1; titles = {}; pending = []; queue = []; requested.clear(); },
};
