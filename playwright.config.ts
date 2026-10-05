import {defineConfig} from "@playwright/test";
export default defineConfig({
  testDir:"e2e",testMatch:"*.spec.ts",fullyParallel:true,
  use:{baseURL:"http://127.0.0.1:1541",headless:true,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{},trace:"retain-on-failure"},
  webServer:{command:"bunx vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port 1541 --strictPort",url:"http://127.0.0.1:1541",reuseExistingServer:false},
});
