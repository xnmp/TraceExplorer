/**
 * Host theme tokens for the view harness, copied from Tauri Explorer's
 * `src/lib/themes/light.css` and `dark.css` (their default, non-premium
 * values) plus the base `:root` tokens in `src/routes/+page.svelte`.
 *
 * Like most host themes, neither defines `--accent-text` or the
 * `--system-*-text` variants, so the harness renders the plugin the way most
 * users see it. `?theme=dark` selects the dark theme; light is the default.
 */
const base = {
  "--radius-sm": "8px", "--radius-md": "12px", "--radius-lg": "16px", "--transition-fast": "80ms cubic-bezier(0.25, 0.1, 0.25, 1)",
  "--font-size-caption": "11px", "--font-size-body": "14px", "--line-height-normal": "1.5",
};

export const THEMES = {
  light: {
    ...base,
    "--accent": "#0066cc", "--accent-light": "#60cdff", "--accent-dark": "#004a94",
    "--text-primary": "#1d1d1f", "--text-secondary": "#5d5d5d", "--text-tertiary": "#6b6b6f", "--text-on-accent": "#ffffff",
    "--background-solid": "#f5f5f7", "--background-card": "rgba(255, 255, 255, 0.72)", "--background-card-secondary": "rgba(249, 249, 251, 0.55)",
    "--surface-stroke": "rgba(0, 0, 0, 0.05)", "--divider": "rgba(0, 0, 0, 0.06)",
    "--control-fill": "rgba(255, 255, 255, 0.7)", "--control-fill-secondary": "rgba(249, 249, 249, 0.5)",
    "--subtle-fill": "transparent", "--subtle-fill-secondary": "rgba(0, 0, 0, 0.035)", "--subtle-fill-tertiary": "rgba(0, 0, 0, 0.022)",
    "--control-stroke": "rgba(0, 0, 0, 0.05)", "--control-stroke-secondary": "rgba(0, 0, 0, 0.14)",
    "--focus-stroke-outer": "#000000", "--focus-stroke-inner": "#ffffff",
    "--system-critical": "#c42b1c", "--system-success": "#0f7b0f", "--system-caution": "#9d5d00",
  },
  dark: {
    ...base,
    "--accent": "#4cc2f4", "--accent-light": "#98ecff", "--accent-dark": "#0078d4",
    "--text-primary": "#e8e8ed", "--text-secondary": "#afafb4", "--text-tertiary": "#9f9fa2", "--text-on-accent": "#000000",
    "--background-solid": "#1c1c1e", "--background-card": "rgba(44, 44, 46, 0.6)", "--background-card-secondary": "rgba(38, 38, 40, 0.5)",
    "--surface-stroke": "rgba(255, 255, 255, 0.08)", "--divider": "rgba(255, 255, 255, 0.06)",
    "--control-fill": "rgba(255, 255, 255, 0.07)", "--control-fill-secondary": "rgba(255, 255, 255, 0.09)",
    "--subtle-fill": "transparent", "--subtle-fill-secondary": "rgba(255, 255, 255, 0.07)", "--subtle-fill-tertiary": "rgba(255, 255, 255, 0.04)",
    "--control-stroke": "rgba(255, 255, 255, 0.1)", "--control-stroke-secondary": "rgba(255, 255, 255, 0.08)",
    "--focus-stroke-outer": "#ffffff", "--focus-stroke-inner": "#000000",
    "--system-critical": "#ff6b6b", "--system-success": "#69db7c", "--system-caution": "#ffd43b",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

export function applyTheme(name: string | null): ThemeName {
  const theme: ThemeName = name === "dark" ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  for (const [token, value] of Object.entries(THEMES[theme])) root.style.setProperty(token, value);
  return theme;
}
