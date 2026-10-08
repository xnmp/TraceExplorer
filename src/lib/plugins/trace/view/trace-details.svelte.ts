/**
 * Whether Preview's "Trace details" disclosure is open. Shared by every
 * Preview subject, so it stays as the user left it while they move between
 * images (the host remounts the section when Preview switches between
 * files and targets, and between targets).
 */
let open = $state(false);

export const traceDetails = {
  get open() { return open; },
  toggle(): void { open = !open; },
};
