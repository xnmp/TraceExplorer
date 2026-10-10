import {defineConfig} from "vite";
import {svelte} from "@sveltejs/vite-plugin-svelte";
import {resolve} from "node:path";
import {sharedHostModules} from "./vite.config";

export default defineConfig({
  plugins:[sharedHostModules(),svelte({configFile:false,compilerOptions:{runes:true}})],
  resolve:{alias:{"$lib":resolve("src/lib")}},
  build:{outDir:"plugins/image-generation/dist/frontend",lib:{entry:"plugins/image-generation/frontend/index.ts",formats:["es"],fileName:()=>"index.js",cssFileName:"index"},cssCodeSplit:false,rollupOptions:{output:{codeSplitting:false}}},
});
