/**
 * Allocation-light scanning of SVG path data. Layout and attachment read and
 * shift connector coordinates for every candidate they score, so these replace
 * regular-expression tokenising on that path. Numbers follow
 * `-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?`, which covers everything `String(number)`
 * emits, exponents included.
 */

const isDigit = (code: number) => code >= 48 && code <= 57;
export const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
/** Exactly the characters `String.prototype.trim` and `\s` treat as white space. */
export const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));

/** Exact powers of ten: every one up to 1e22 is representable. */
const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

/** `[0]` holds the value of the number most recently found by {@link scanNumber} (a cell, not a live binding, so reads stay cheap). */
export const scanned = new Float64Array(1);

/**
 * {@link numberEnd} (without `+`) and `Number` of the matched text in one pass: returns the
 * end, or -1, and leaves the value in `scanned[0]`. With at most 15 digits and 22
 * decimals the mantissa and the power of ten are exact doubles, so their correctly rounded
 * quotient is the correctly rounded decimal `Number` returns (Clinger's fast path);
 * exponents and longer numbers use `Number` itself.
 */
export function scanNumber(s: string, i: number): number {
  let j = i, negative = false, mantissa = 0, digits = 0, scale = 0;
  let code = s.charCodeAt(j);
  if (code === 45) { negative = true; code = s.charCodeAt(++j); }
  const start = j;
  while (code >= 48 && code <= 57) { mantissa = mantissa * 10 + (code - 48); digits++; code = s.charCodeAt(++j); }
  if (j > start) {
    if (code === 46) {
      code = s.charCodeAt(++j);
      while (code >= 48 && code <= 57) { mantissa = mantissa * 10 + (code - 48); digits++; scale++; code = s.charCodeAt(++j); }
    }
  } else {
    if (code !== 46 || !isDigit(s.charCodeAt(j + 1))) return -1;
    code = s.charCodeAt(++j);
    while (code >= 48 && code <= 57) { mantissa = mantissa * 10 + (code - 48); digits++; scale++; code = s.charCodeAt(++j); }
  }
  if (code === 101 || code === 69) {
    let k = j + 1;
    const exponentSign = s.charCodeAt(k);
    if (exponentSign === 45 || exponentSign === 43) k++;
    if (isDigit(s.charCodeAt(k))) {
      while (isDigit(s.charCodeAt(k))) k++;
      scanned[0] = Number(s.slice(i, k));
      return k;
    }
  }
  if (digits > 15 || scale > 22) scanned[0] = Number(s.slice(i, j));
  else { const value = mantissa / POW10[scale]; scanned[0] = negative ? -value : value; }
  return j;
}

/** Whether a number can start with this character (`numberEnd` is -1 for every other). */
export const numberStart = (code: number) => (code >= 48 && code <= 57) || code === 45 || code === 46;

/** End of the number starting at `i`, or -1 if none starts there. `plus` also admits a leading `+`. */
export function numberEnd(s: string, i: number, plus = false): number {
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
    const end = numberStart(code) ? scanNumber(d, i) : -1;
    if (end > 0) { tokens.push(scanned[0]); i = end; }
    else { if (isLetter(code)) tokens.push(d[i]); i++; }
  }
  return tokens;
}

/** Every number in the path, in order (x, y alternate for M/L/C data); at most `limit`. */
export function pathNumbers(d: string, limit = Infinity): number[] {
  const values: number[] = [];
  for (let i = 0; i < d.length && values.length < limit;) {
    const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
    if (end > 0) { values.push(scanned[0]); i = end; } else i++;
  }
  return values;
}

/** Calls `visit` with every number in the path, in order: {@link pathNumbers} without the array. */
export function forEachPathNumber(d: string, visit: (value: number) => void): void {
  for (let i = 0; i < d.length;) {
    const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
    if (end > 0) { visit(scanned[0]); i = end; } else i++;
  }
}

/** The path with its `index`-th number replaced by `map(value, index)`; all other text is kept. */
export function mapPathNumbers(d: string, map: (value: number, index: number) => number): string {
  let out = "", copied = 0, index = 0;
  for (let i = 0; i < d.length;) {
    const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
    if (end < 0) { i++; continue; }
    out += d.slice(copied, i) + String(map(scanned[0], index++));
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
