import { invoke } from "$lib/api/common";
import type { TraceRun } from "$lib/api/trace";
import type { PluginContext } from "../api";

interface TitleContext { configurationRevision: number; fingerprint: string }
interface Description { version: number; enabled: boolean; available: boolean; configurationRevision: number; context?: TitleContext | null }
interface TitleResult extends TitleContext { title: string }
let titles = $state<Readonly<Record<number,string>>>({});
let pending = $state<readonly number[]>([]);
let configured = $state(false);
let generation = 0;
let context: TitleContext | null = null;
const requested = new Set<number>();
let queue: number[] = [];
let draining: number | null = null;
let active: { requestId: string; generation: number } | null = null;
let subscriptions: (() => void)[] = [];
let binding = 0;
let sequence = 0;
const session = globalThis.crypto.randomUUID();

function invalidate() {
  generation += 1;
  configured = false;
  context = null;
  titles = {};
  pending = [];
  queue = [];
  requested.clear();
  draining = null;
  if (active) void invoke("trace_cancel_prompt_title", { requestId: active.requestId }).catch(() => {});
  active = null;
}

async function drain() {
  if (draining === generation || !context) return;
  const current = generation;
  const admittedContext = context;
  draining = current;
  try {
    while (current === generation && queue.length) {
      const runId = queue.shift()!;
      const requestId = `title-${session}-${++sequence}`;
      active = { requestId, generation: current };
      try {
        const result = await invoke<TitleResult>("trace_prompt_title", {
          runId, requestId, expectedConfigurationRevision: admittedContext.configurationRevision,
        });
        if (current === generation && result?.configurationRevision === admittedContext.configurationRevision
          && result.fingerprint === admittedContext.fingerprint && typeof result.title === "string"
          && result.title.trim() && [...result.title].length <= 120 && !/[\u0000-\u001f\u007f]/.test(result.title)) {
          titles = { ...titles, [runId]: result.title };
        }
      } catch { /* The original persisted prompt remains readable. */ }
      finally {
        if (current === generation) { pending = pending.filter(id => id !== runId); active = null; }
      }
    }
  } finally { if (draining === current) draining = null; }
}

export const promptTitles = {
  get configured() { return configured; },
  async configure(settings: Record<string,unknown>) {
    invalidate();
    const current = generation;
    if (settings.summarizePrompts === false) return;
    const description = await invoke<Description>("trace_title_context", {}).catch(() => null);
    if (current === generation && description?.version === 1 && description.enabled && description.available
      && description.context?.configurationRevision === description.configurationRevision
      && /^[a-f0-9]{64}$/.test(description.context.fingerprint)) {
      context = description.context;
      configured = true;
    }
  },
  bind(ctx: Pick<PluginContext, "storage" | "text">) {
    this.unbind();
    if (!ctx.text) return;
    const owner = binding;
    let preferences: Record<string, unknown> | null = null;
    let storageRevision = 0;
    subscriptions.push(ctx.storage.subscribe?.(settings => {
      if (owner !== binding) return;
      storageRevision += 1;
      preferences = settings;
      void this.configure(settings);
    }) ?? (() => {}));
    subscriptions.push(ctx.text.subscribe(() => {
      if (owner === binding && preferences) void this.configure(preferences);
    }));
    const revision = storageRevision;
    void ctx.storage.get().then(settings => {
      if (owner !== binding || revision !== storageRevision) return;
      preferences = settings;
      void this.configure(settings);
    }).catch(() => {});
  },
  unbind() { binding += 1; subscriptions.forEach(unsubscribe => unsubscribe()); subscriptions = []; invalidate(); },
  label(run: TraceRun | undefined) { return run ? titles[run.id] || (typeof run.parameters.prompt === "string" ? run.parameters.prompt : "") : ""; },
  labelFor(runId: number | null, prompt: string) { return runId === null ? "" : titles[runId] || prompt; },
  loadFor(runId: number | null, prompt: string) { if (runId !== null) this.request(runId, prompt); },
  pending(id: number) { return pending.includes(id); },
  load(run: TraceRun) { if (typeof run.parameters.prompt === "string") this.request(run.id, run.parameters.prompt); },
  request(runId: number, prompt: string) {
    if (!configured || !Number.isSafeInteger(runId) || runId <= 0 || requested.has(runId) || titles[runId] || !prompt.trim()) return;
    requested.add(runId);
    pending = [...pending,runId];
    queue = [...queue,runId];
    void drain();
  },
  clear() { invalidate(); },
};
