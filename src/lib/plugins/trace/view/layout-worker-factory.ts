/**
 * Constructs the layout worker. A separate module so the browser harness can
 * alias it to a wrapper that gates the worker's replies (e2e/harness/vite.config.ts).
 */
import LayoutWorker from "./layout.worker.ts?worker&inline";

export const createLayoutWorker = (): Worker => new LayoutWorker();
