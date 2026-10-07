/** Explicit generation intent selects a trace without navigating Explorer. */
let jobId = $state<number | null>(null);
let revision = 0;
export const traceViewTarget = {
  get jobId() { return jobId; },
  showJob(id: number) { revision += 1; jobId = id; },
  clear() { revision += 1; jobId = null; },
  capture() { const current = revision; return ()=>current === revision; },
};
