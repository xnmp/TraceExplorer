/**
 * An injective text key for plain structured-cloneable data: equal keys mean structurally equal
 * values, so a cache keyed by it never answers for a different input. Two equal values built in
 * a different property or insertion order may get different keys; that only costs a miss.
 */
export function stableKey(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    switch (typeof current) {
      case "number": parts.push(Number.isFinite(current) ? (Object.is(current, -0) ? "-0" : String(current)) : `#${current}`); return;
      case "string": parts.push(JSON.stringify(current)); return;
      case "boolean": parts.push(current ? "t" : "f"); return;
      case "undefined": parts.push("u"); return;
      case "bigint": parts.push(`${current}n`); return;
      case "object": break;
      default: throw new TypeError(`unkeyable ${typeof current}`);
    }
    if (current === null) { parts.push("n"); return; }
    // A shared (not cyclic) object is keyed again in each place it occurs; a cycle is not plain data.
    if (seen.has(current)) throw new TypeError("cyclic value");
    seen.add(current);
    if (Array.isArray(current)) {
      parts.push("[");
      for (let i = 0; i < current.length; i++) { if (i) parts.push(","); visit(current[i]); }
      parts.push("]");
    } else if (current instanceof Map) {
      parts.push("M{");
      let first = true;
      for (const [key, entry] of current) { if (!first) parts.push(","); first = false; visit(key); parts.push(":"); visit(entry); }
      parts.push("}");
    } else if (current instanceof Set) {
      parts.push("S[");
      let first = true;
      for (const entry of current) { if (!first) parts.push(","); first = false; visit(entry); }
      parts.push("]");
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("only plain objects, arrays, maps and sets can be keyed");
      parts.push("{");
      let first = true;
      for (const key of Object.keys(current)) {
        if (!first) parts.push(",");
        first = false;
        parts.push(JSON.stringify(key), ":");
        visit((current as Record<string, unknown>)[key]);
      }
      parts.push("}");
    }
    seen.delete(current);
  };
  visit(value);
  return parts.join("");
}
