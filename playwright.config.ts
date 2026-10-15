import {defineConfig} from "@playwright/test";

/**
 * Specs whose frames and motion WebKit draws differently from Chromium (WebKitGTK is the native
 * host's engine: scrollbar gutters, ResizeObserver and animation timing). They run in both browsers.
 */
const WEBKIT_SPECS = ["themed-select", "motion-scrollbars", "scene-snap", "tab-switch", "selection-blink", "band-motion", "scene-transactions", "scene-windowing", "motion-driver", "motion-frames", "scene-media", "explicit-expansion"].map((name) => `${name}.spec.ts`);

export default defineConfig({
  testDir:"e2e",testMatch:"*.spec.ts",fullyParallel:true,
  use:{baseURL:"http://127.0.0.1:1541",headless:true,trace:"retain-on-failure"},
  projects:[
    {name:"chromium",use:{browserName:"chromium",launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}}},
    {name:"webkit",use:{browserName:"webkit"},testMatch:WEBKIT_SPECS},
  ],
  webServer:{command:"bunx vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port 1541 --strictPort",url:"http://127.0.0.1:1541/view.html",reuseExistingServer:false},
});
