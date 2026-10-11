import { describe, expect, it } from "vitest";
import { aiEditIntent, type AIEditEntry } from "$lib/domain/ai-edit-intent";

const image = (path: string): AIEditEntry => ({ path, name: path.split(/[\\/]/).at(-1)!, kind: "file" });

describe("AI edit intent", () => {
  it("generates only for an empty selection", () => {
    expect(aiEditIntent([])).toEqual({ kind: "generate" });
  });

  it("edits one to eight supported images in selection order", () => {
    const paths = ["/pictures/z.WebP", "/pictures/a.JPEG", ...Array.from({ length: 6 }, (_, i) => `/pictures/${i}.png`)];
    expect(aiEditIntent(paths.map(image))).toEqual({ kind: "edit", inputs: paths });
    expect(aiEditIntent([image(paths[0])])).toEqual({ kind: "edit", inputs: [paths[0]] });
  });

  it("deduplicates images selected across panes without changing their first position", () => {
    const first = image("/pictures/a.png"), second = image("/elsewhere/b.jpg");
    expect(aiEditIntent([first, second, first])).toEqual({ kind: "edit", inputs: [first.path, second.path] });
    const eight = Array.from({ length: 8 }, (_, i) => image(`/pictures/${i}.png`));
    expect(aiEditIntent([...eight, ...eight])).toEqual({ kind: "edit", inputs: eight.map(({ path }) => path) });
  });

  it("rejects excessive selections", () => {
    for (const length of [9, 10000]) {
      expect(aiEditIntent(Array.from({ length }, (_, i) => image(`/pictures/${i}.png`)))).toMatchObject({ kind: "invalid", reason: expect.any(String) });
    }
  });

  it("never turns unsupported or malformed selections into generation", () => {
    for (const selection of [
      [image("/pictures/a.gif")], [image("demo://a.png")], [image("relative.png")],
      [{ ...image("/pictures/a.png"), kind: "directory" }],
      [image("/pictures/a.png"), image("/pictures/a.txt")],
      [image("/pictures/a\0.png")], [image(`/pictures/${"a".repeat(4096)}.png`)],
      [null], [{ path: null, name: "a.png", kind: "file" }], null,
    ]) {
      expect(aiEditIntent(selection as readonly AIEditEntry[])).toMatchObject({ kind: "invalid" });
    }
  });
});
