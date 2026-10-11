/**
 * Plugin styles only rely on custom properties every host theme defines.
 * A `var(--x)` without a fallback, where some theme lacks `--x`, invalidates
 * the whole declaration in that theme: strokes vanish and fills turn black.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_THEME_TOKENS } from "../../integration/plugin-sdk/theme-tokens";

const ROOT = resolve(import.meta.dirname, "../..");

/** Custom properties referenced by `var()` without a fallback, in source order. */
function unguardedTokens(source: string): string[] {
  const found: string[] = [];
  const pattern = /var\(\s*(--[A-Za-z0-9_-]+)\s*/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    // Scan to this var()'s closing parenthesis; a comma at its own depth starts a fallback.
    let depth = 0, fallback = false;
    for (let index = match.index + match[0].length; index < source.length; index++) {
      const char = source[index];
      if (char === "(") depth++;
      else if (char === ")") { if (depth === 0) break; depth--; }
      else if (char === "," && depth === 0) { fallback = true; break; }
    }
    if (!fallback) found.push(match[1]);
  }
  return found;
}

/** Custom properties a file declares itself (`--x:` in CSS, `style:--x=` in markup). */
function declaredTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/(?:^|[\s;{]|style:)(--[A-Za-z0-9_-]+)\s*[:=]/g)].map((match) => match[1]));
}

function files(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path, extensions) : extensions.some((extension) => name.endsWith(extension)) ? [path] : [];
  });
}

describe("token scanning", () => {
  it("reports var() references without a fallback, including nested ones", () => {
    expect(unguardedTokens("a { stroke: var(--accent-text); fill: var(--x, red); }")).toEqual(["--accent-text"]);
    expect(unguardedTokens("b { color: color-mix(in srgb, var(--a) 45%, var(--b)); }")).toEqual(["--a", "--b"]);
    // The fallback itself is checked: the last var() of a chain must resolve.
    expect(unguardedTokens("c { color: var(--a, var(--b, var(--c))); }")).toEqual(["--c"]);
    expect(unguardedTokens("d { color: var(--a, color-mix(in srgb, var(--b) 50%, transparent)); }")).toEqual(["--b"]);
    expect(unguardedTokens("e { color: var( --spaced ); }")).toEqual(["--spaced"]);
  });

  it("ignores text without var() and tolerates malformed input", () => {
    expect(unguardedTokens("")).toEqual([]);
    expect(unguardedTokens("--a: 1px; width: calc(1px + 2px);")).toEqual([]);
    expect(unguardedTokens("x { color: var(--unclosed")).toEqual(["--unclosed"]);
  });

  it("finds properties a file declares for itself", () => {
    expect([...declaredTokens(`<div style:--gap="4px"></div><style>.a { --tone: red; color: var(--tone); }</style>`)].sort()).toEqual(["--gap", "--tone"]);
  });
});

describe("plugin styles", () => {
  const known = new Set(HOST_THEME_TOKENS);
  // Both packages built here, and the UI they share, run under the host theme.
  const sources = ["src", "integration/ui", "plugins/image-generation/frontend"].flatMap((directory) => files(join(ROOT, directory), [".svelte", ".css"]));

  it("scans the plugin's components and stylesheets", () => {
    expect(sources.some((path) => path.endsWith("TraceGraph.svelte"))).toBe(true);
    expect(sources.some((path) => path.endsWith("plugin-dialog.css"))).toBe(true);
    expect(sources.some((path) => path.endsWith("ImageConnectionsDialog.svelte"))).toBe(true);
    expect(sources.some((path) => path.endsWith("Select.svelte"))).toBe(true);
  });

  it("use only tokens every host theme defines, unless they give a fallback", () => {
    const offending = sources.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const local = declaredTokens(source);
      return unguardedTokens(source).filter((token) => !known.has(token) && !local.has(token)).map((token) => `${path.slice(ROOT.length + 1)}: ${token}`);
    });
    expect([...new Set(offending)]).toEqual([]);
  });
});

// The list mirrors the host; with a host checkout at hand, check that every
// listed token really is defined by every theme.
const HOST = resolve(process.env.TAURI_EXPLORER_DIR ?? join(ROOT, "../tauri-explorer"));
const hasHost = existsSync(join(HOST, "src/lib/themes")) && existsSync(join(HOST, "src/routes/+page.svelte"));

describe.skipIf(!hasHost)("HOST_THEME_TOKENS against the host checkout", () => {
  const defined = (text: string) => new Set([...text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]));

  it("lists only tokens defined by every theme or by the base :root", () => {
    const themeDirectory = join(HOST, "src/lib/themes");
    const themes = readdirSync(themeDirectory).filter((name) => name.endsWith(".css") && name !== "index.css" && name !== "syntax.css")
      .map((name) => [name, defined(readFileSync(join(themeDirectory, name), "utf8"))] as const);
    const palette = join(HOST, "src/lib/domain/theme-from-palette.ts");
    if (existsSync(palette)) themes.push(["theme-from-palette.ts", defined(readFileSync(palette, "utf8"))]);
    const page = readFileSync(join(HOST, "src/routes/+page.svelte"), "utf8");
    const start = page.indexOf(":global(:root)");
    const root = start < 0 ? new Set<string>() : defined(page.slice(start, page.indexOf("}", start)));
    expect(themes.length).toBeGreaterThan(1);
    const missing = HOST_THEME_TOKENS.flatMap((token) => root.has(token) ? [] : themes.filter(([, tokens]) => !tokens.has(token)).map(([name]) => `${token} (${name})`));
    expect(missing).toEqual([]);
  });
});
