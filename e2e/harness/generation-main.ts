import {mount} from "svelte";
import {controller} from "./fixture";
import GenerationHarness from "./GenerationHarness.svelte";
mount(GenerationHarness,{target:document.querySelector("#app")!});
(window as any).traceGeneration=controller;
