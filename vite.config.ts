import { defineConfig, normalizePath, type Plugin as VitePlugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

// Compiled components must use the exact host runtime instance. Virtual
// bindings contain references only, so no Svelte runtime enters the package.
function sharedHostModules(): VitePlugin {
  const special: Record<string, {key: string; names: string[]}> = {
    "$lib/components/Modal.svelte": {key: "ui/modal", names: ["default"]},
    "$lib/components/ImageCropEditor.svelte": {key: "ui/image-editor", names: ["default"]},
  };
  for (const [name, binding] of Object.entries(special)) {
    special[normalizePath(resolve("src/lib", name.slice(5)))] = binding;
  }
  return {
    name: "plugin-shared-host-modules", enforce: "pre",
    resolveId(id) { const normalized=normalizePath(id); if (normalized === "svelte" || normalized.startsWith("svelte/internal/") || normalized in special) return `\0host:${JSON.stringify(normalized)}.js`; },
    async load(id) {
      if (!id.startsWith("\0host:")) return;
      const name = JSON.parse(id.slice(6, -3)) as string;
      const binding = special[name] ?? {key: name, names: Object.keys(await import(name))};
      const access = `globalThis.__TAURI_EXPLORER_PLUGIN_SDK__.modules[${JSON.stringify(binding.key)}]`;
      return binding.names.map((key, index) => `const host_binding_${index} = ${access}[${JSON.stringify(key)}]; export { host_binding_${index} as ${key} };`).join("\n");
    },
  };
}

export default defineConfig({
  plugins: [sharedHostModules(), svelte({configFile: false, compilerOptions: {runes: true}})],
  resolve: {alias: {"$lib": resolve("src/lib")}},
  build: {outDir: "dist/frontend", lib: {entry: "src/index.ts", formats: ["es"], fileName: () => "index.js", cssFileName: "index"}, cssCodeSplit: false, rollupOptions: {output: {codeSplitting: false}}},
});
