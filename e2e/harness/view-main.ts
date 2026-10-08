import { mount } from "svelte";
import "./view-fixture";
import { applyTheme } from "./themes";
const query = new URLSearchParams(location.search);
applyTheme(query.get("theme"));
// `?scrollbars=host` styles scrollbars as the host does (classic 8px bars that take layout space).
if (query.get("scrollbars") === "host") document.head.append(Object.assign(document.createElement("style"), {
  textContent: "::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--text-tertiary,#999);border:2px solid transparent;border-radius:4px;background-clip:padding-box}",
}));
// `?zoom=1.25` zooms the whole document the way the host applies its zoom level (CSS zoom on the root).
if (query.has("zoom")) document.documentElement.style.zoom = query.get("zoom")!;
import { promptTitles } from "$lib/plugins/trace/prompt-titles.svelte";
import ViewHarness from "./ViewHarness.svelte";
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const application = mount(ViewHarness, { target: document.querySelector("#app")! }) as { harness: Record<string, unknown> };
(window as any).trace = { ...application.harness, errors, configureTitles: (settings: Record<string, unknown> = {}) => promptTitles.configure(settings) };
