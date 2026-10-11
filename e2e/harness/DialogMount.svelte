<script lang="ts">
  import { setContext, type Component } from "svelte";
  import type { PluginDialogOptions } from "../../integration/plugin-sdk";
  let { component: Dialog, props, options, width, onClose }: {
    component: Component<any>; props: Record<string, unknown>; options?: PluginDialogOptions; width: number; onClose: () => void;
  } = $props();
  // Modal scope belongs to the host mount. Each dialog receives its own context.
  setContext("harness-dialog-scope", () => options?.scope ?? "window");
</script>
<div class="dialog-mount" style:--view-width="{width}px">
  <Dialog {...props} open={true} {onClose} />
</div>
<style>
  .dialog-mount { display: contents; }
</style>
