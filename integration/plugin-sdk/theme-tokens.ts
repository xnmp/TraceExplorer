/**
 * CSS custom properties every Tauri Explorer host theme defines. Plugin styles
 * may use these without a fallback; anything else (`--accent-text`,
 * `--system-caution-text`, …) is defined by only some themes and must carry a
 * fallback, because an undefined property makes the whole declaration invalid
 * (an SVG stroke becomes `none`, a fill becomes black).
 *
 * Mirrors the host (tauri-explorer) at the SDK 2 release:
 * - the intersection of the tokens defined by each theme in
 *   `src/lib/themes/*.css` (excluding `index.css` and `syntax.css`) and by
 *   generated palette themes (`src/lib/domain/theme-from-palette.ts`);
 * - the theme-independent tokens of the `:root` block in
 *   `src/routes/+page.svelte`.
 *
 * `tests/plugins/theme-tokens.test.ts` checks plugin styles against this list,
 * and checks the list against a host checkout when one is available.
 */
export const HOST_THEME_TOKENS: readonly string[] = [
  // Every theme.
  "--accent", "--accent-dark", "--accent-light",
  "--background-acrylic", "--background-card", "--background-card-secondary", "--background-mica", "--background-solid",
  "--control-fill", "--control-fill-disabled", "--control-fill-secondary", "--control-fill-tertiary",
  "--control-stroke", "--control-stroke-secondary",
  "--divider", "--focus-stroke-inner", "--focus-stroke-outer", "--mica-overlay", "--miller-bg",
  "--shadow-card", "--shadow-dialog", "--shadow-flyout", "--shadow-subtle", "--shadow-tooltip",
  "--subtle-fill", "--subtle-fill-secondary", "--subtle-fill-tertiary",
  "--surface-stroke", "--surface-stroke-flyout",
  "--system-caution", "--system-critical", "--system-success",
  "--text-on-accent", "--text-primary", "--text-secondary", "--text-tertiary",
  // :root, independent of the theme.
  "--font-family", "--font-size-body", "--font-size-caption", "--font-size-subtitle", "--font-size-title",
  "--font-weight-bold", "--font-weight-medium", "--font-weight-normal", "--font-weight-semibold",
  "--letter-spacing-normal", "--letter-spacing-tight", "--letter-spacing-wide", "--line-height-normal", "--line-height-tight",
  "--radius-lg", "--radius-md", "--radius-pill", "--radius-sm", "--radius-window",
  "--selection-indicator-width",
  "--spacing-lg", "--spacing-md", "--spacing-sm", "--spacing-xl", "--spacing-xs", "--spacing-xxs",
  "--transition-fast", "--transition-normal", "--transition-slow",
  "--z-menu", "--z-modal", "--z-modal-popover", "--z-progress", "--z-toast",
];
