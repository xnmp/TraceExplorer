import {mount} from "svelte";
import {controller,paths} from "./fixture";
import ContributionHarness from "./ContributionHarness.svelte";
const errors:string[]=[];
window.addEventListener("error",event=>errors.push(event.message));
window.addEventListener("unhandledrejection",event=>errors.push(String(event.reason)));
const application=mount(ContributionHarness,{target:document.querySelector("#app")!});
(window as any).traceContribution={...controller,...application,paths,errors};
