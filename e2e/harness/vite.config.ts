import {defineConfig} from "vite";
import {svelte} from "@sveltejs/vite-plugin-svelte";
import {resolve} from "node:path";
const repository=resolve(import.meta.dirname,"../..");
// The host's `ui/modal` is a stub here; the exact match precedes `$lib`.
export default defineConfig({root:import.meta.dirname,plugins:[svelte({configFile:false,compilerOptions:{runes:true}})],resolve:{alias:[{find:/^\$lib\/components\/Modal\.svelte$/,replacement:resolve(import.meta.dirname,"StubModal.svelte")},{find:"$lib",replacement:resolve(repository,"src/lib")}]},server:{fs:{allow:[repository]}}});
