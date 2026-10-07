let mode = $state<"unopened"|"open"|"closed">("unopened");
export const traceVisibility = {
  get visible() { return mode !== "closed"; },
  get isOpen() { return mode === "open"; },
  opened() { if(mode === "unopened") mode="open"; },
  toggle() { mode = mode === "open" ? "closed" : "open"; },
};
