<script lang="ts">
  import { untrack } from "svelte";
  import OpenAIImageForm from "./OpenAIImageForm.svelte";
  import type { PluginJobs, PluginToast } from "../api";
  import type { ImageEditorSource } from "../image-editor-registry.svelte";
  import { parentDir } from "$lib/domain/path";
  let { source, configureConnections, jobs, toast, onClose, onBusyChange, captureSelection, outputsShownIn }: {
    captureSelection?:()=>()=>boolean;
    /** Captures, as the tool opens, the Trace view its jobs' outputs show in (`onStart`). */
    outputsShownIn?: () => ((paths: readonly string[]) => void) | undefined;
    configureConnections: () => Promise<void>;
    source: ImageEditorSource; jobs: PluginJobs; toast: PluginToast;
    onClose: () => void; onBusyChange: (busy: boolean) => void;
  } = $props();
  const onStart = untrack(() => outputsShownIn?.());
</script>
<OpenAIImageForm open={true} inputs={[{ path: source.path, digest: source.digest, size: source.size }, ...source.referencePaths.map((path) => ({ path }))]} outputDir={parentDir(source.path)}
  {configureConnections} {jobs} {toast} {onClose} {onBusyChange} {captureSelection} {onStart} />
