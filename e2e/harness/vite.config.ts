import {defineConfig} from "vite";
import {svelte} from "@sveltejs/vite-plugin-svelte";
import {resolve} from "node:path";
const repository=resolve(import.meta.dirname,"../..");
export default defineConfig({root:import.meta.dirname,plugins:[svelte({configFile:false,compilerOptions:{runes:true}})],resolve:{alias:{"$lib":resolve(repository,"src/lib")}},server:{fs:{allow:[repository]}}});
