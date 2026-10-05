let revision = $state(0);

export const traceInvalidation = {
  get revision() { return revision; },
  bump(): void { revision += 1; },
};
