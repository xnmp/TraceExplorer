/**
 * Allocation-light scanning of SVG path data. Layout and attachment read and
 * shift connector coordinates for every candidate they score, so these replace
 * regular-expression tokenising on that path. Numbers follow
 * `-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?`, which covers everything `String(number)`
 * emits, exponents included.
 */

const isDigit = (code: number) => code >= 48 && code <= 57;
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));

/** End of the number starting at `i`, or -1 if none starts there. `plus` also admits a leading `+`. */
function numberEnd(s: string, i: number, plus = false): number {
  let j = i;
  const sign = s.charCodeAt(j);
  if (sign === 45 || (plus && sign === 43)) j++;
  const start = j;
  while (isDigit(s.charCodeAt(j))) j++;
  if (j > start) {
    if (s.charCodeAt(j) === 46) { j++; while (isDigit(s.charCodeAt(j))) j++; }
  } else {
    if (s.charCodeAt(j) !== 46 || !isDigit(s.charCodeAt(j + 1))) return -1;
    j += 2;
    while (isDigit(s.charCodeAt(j))) j++;
  }
  const e = s.charCodeAt(j);
  if (e === 101 || e === 69) {
    let k = j + 1;
    const exponentSign = s.charCodeAt(k);
    if (exponentSign === 45 || exponentSign === 43) k++;
    if (isDigit(s.charCodeAt(k))) { while (isDigit(s.charCodeAt(k))) k++; j = k; }
  }
  return j;
}

/** Command letters and numbers in order; any other character is skipped. */
export function pathTokens(d: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (let i = 0; i < d.length;) {
    const code = d.charCodeAt(i);
    const end = numberEnd(d, i);
    if (end > 0) { tokens.push(Number(d.slice(i, end))); i = end; }
    else { if (isLetter(code)) tokens.push(d[i]); i++; }
  }
  return tokens;
}

/** Every number in the path, in order (x, y alternate for M/L/C data); at most `limit`. */
export function pathNumbers(d: string, limit = Infinity): number[] {
  const values: number[] = [];
  for (let i = 0; i < d.length && values.length < limit;) {
    const end = numberEnd(d, i);
    if (end > 0) { values.push(Number(d.slice(i, end))); i = end; } else i++;
  }
  return values;
}

/** The path with its `index`-th number replaced by `map(value, index)`; all other text is kept. */
export function mapPathNumbers(d: string, map: (value: number, index: number) => number): string {
  let out = "", copied = 0, index = 0;
  for (let i = 0; i < d.length;) {
    const end = numberEnd(d, i);
    if (end < 0) { i++; continue; }
    out += d.slice(copied, i) + String(map(Number(d.slice(i, end)), index++));
    copied = i = end;
  }
  return out + d.slice(copied);
}

/** True when the text holds only M/L/C commands (either case), signed numbers, whitespace and commas. */
export function isPlainPathData(d: string): boolean {
  for (let i = 0; i < d.length;) {
    const code = d.charCodeAt(i);
    if (code === 77 || code === 76 || code === 67 || code === 109 || code === 108 || code === 99 || code === 44 || isSpace(code)) { i++; continue; }
    const end = numberEnd(d, i, true);
    if (end < 0) return false;
    i = end;
  }
  return true;
}
