declare module "*.css";
declare module "$lib/components/Modal.svelte" {
  import type { Component, Snippet } from "svelte";
  const Modal: Component<{open: boolean; onClose: () => void; canClose?: () => boolean; overlayClass?: string; labelledby?: string; label?: string; children?: Snippet}>;
  export default Modal;
}
declare module "$lib/components/ImageCropEditor.svelte" {
  import type { Component } from "svelte";
  const ImageEditor: Component<{path: string; name: string; referencePaths?: string[]; initialTool?: string; onSelectSource?: (path: string) => void; onclose: () => void}>;
  export default ImageEditor;
}
