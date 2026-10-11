import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Run the same fixtures against either checkout without copying source files.
export default defineConfig({
  resolve: { alias: {
    $lib: resolve(process.env.LAYOUT_TREE ?? ".", "src/lib"),
    "$compare-lib": resolve(process.env.LAYOUT_COMPARE_TREE ?? process.env.LAYOUT_TREE ?? ".", "src/lib"),
  } },
  test: {
    include: ["tests/domain/trace-graph/layout-benchmark.ts"],
    environment: "node",
    maxWorkers: 1,
    disableConsoleIntercept: true,
    testTimeout: 180_000,
  },
});
