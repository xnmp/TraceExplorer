/**
 * Decoding a thumbnail before it is published (`thumbnail-cache.ts`). `HTMLImageElement.decode()`
 * can stay pending while the document is hidden (engines tie it to rendering), and a decode that
 * never settles would leave its cache entry loading for good: its views would draw the placeholder
 * and scene preparations would wait for it until their media deadline.
 *
 * So a decode is bounded: once `DECODE_BOUND_MS` has passed without it settling, the image counts
 * as decoded as soon as it has loaded (`complete`, or its `load` event; load events do not wait for
 * rendering), and as failed on its `error` event. It is then published like a failed decode: the
 * view's `<img>` draws whatever the browser makes of it, decoding it when drawn.
 */
export const DECODE_BOUND_MS = 1000;

/** The part of `HTMLImageElement` a bounded decode uses. */
export interface DecodableImage {
  decode(): Promise<void>;
  readonly complete: boolean;
  addEventListener(type: "load" | "error", listener: () => void): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
}

export function boundedDecode<T extends DecodableImage>(
  image: T,
  setTimer: (run: () => void, ms: number) => () => void = (run, ms) => { const id = setTimeout(run, ms); return () => clearTimeout(id); },
  bound = DECODE_BOUND_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const loaded = () => finish(() => resolve(image));
    const failed = () => finish(() => reject(new Error("The image could not be loaded")));
    const cancel = setTimer(() => {
      if (settled) return;
      if (image.complete) { loaded(); return; }
      image.addEventListener("load", loaded);
      image.addEventListener("error", failed);
    }, bound);
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      cancel();
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      settle();
    }
    image.decode().then(loaded, (error: unknown) => finish(() => reject(error)));
  });
}
