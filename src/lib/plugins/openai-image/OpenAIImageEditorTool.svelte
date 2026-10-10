<script lang="ts">
  import OpenAIImageForm from "./OpenAIImageForm.svelte";
  import type { PluginJobs, PluginToast } from "../api";
  import type { ImageEditorSource } from "../image-editor-registry.svelte";
  import { parentDir } from "$lib/domain/path";
  let { source, configureConnections, jobs, toast, onClose, onBusyChange, captureSelection }: {
    captureSelection?:()=>()=>boolean;
    configureConnections: () => Promise<void>;
    source: ImageEditorSource; jobs: PluginJobs; toast: PluginToast;
    onClose: () => void; onBusyChange: (busy: boolean) => void;
  } = $props();
</script>
<OpenAIImageForm open={true} inputs={[{ path: source.path, digest: source.digest, size: source.size }, ...source.referencePaths.map((path) => ({ path }))]} outputDir={parentDir(source.path)}
  {configureConnections} {jobs} {toast} {onClose} {onBusyChange} {captureSelection} />
