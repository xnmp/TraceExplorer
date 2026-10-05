let visible = $state(true);
export const traceVisibility = {
  get visible() { return visible; },
  toggle() { visible = !visible; },
};
