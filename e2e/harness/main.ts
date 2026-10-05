import { mount } from "svelte";
import { controller, paths } from "./fixture";
import Harness from "./Harness.svelte";
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const application = mount(Harness, { target: document.querySelector("#app")! });
(window as any).traceHarness = { ...controller, ...application, paths, errors };
