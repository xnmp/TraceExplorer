import type { PluginBackend } from "../../../integration/plugin-sdk";
import { isVirtualPath } from "../domain/virtual-path";
export type { ApiResult } from "../../../integration/plugin-sdk";

let backend: PluginBackend | null = null;
export function configureBackend(value: PluginBackend): void { backend = value; }
export function invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!backend) return Promise.reject(new Error("TraceExplorer backend has not been activated"));
  return backend.invoke<T>(method, params);
}
export function extractError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}
export function virtualPathGuard(path: string): {ok: false; error: string} | null {
  return isVirtualPath(path) ? {ok: false, error: "TraceExplorer requires a local image"} : null;
}
