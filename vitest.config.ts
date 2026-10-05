import {defineConfig,mergeConfig} from "vitest/config";
import vite from "./vite.config";
export default mergeConfig(vite,defineConfig({test:{include:["tests/**/*.test.ts"],exclude:["tauri-explorer-worktree/**"],environment:"node"}}));
