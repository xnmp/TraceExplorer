/** Human label for a recorded run's operation id. */
export function traceOperationLabel(operation: string): string {
  if (operation === "image.crop") return "Crop";
  if (operation === "openai.image.edit") return "AI edit";
  if (operation === "openai.image.generate") return "AI image";
  return operation.replace(/^image\./, "");
}
