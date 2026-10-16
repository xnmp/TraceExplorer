/// <reference lib="webworker" />
/**
 * Off-thread layout: pure computation only, no host or DOM access. One message kind: a whole
 * folder (`folder` → `folder`), run by the registered default engine on a complete input.
 *
 * The input's `previous` may come by reference (`layout-protocol.ts`): one of this worker's own
 * last replies, whose copy the client holds. The engine reads `previous` as a value, so this
 * original and the client's copy lay out alike. Bands are cached by the engine; a whole-input
 * cache would only add a walk of every input (see `folder-layout-runtime.ts`).
 */
import { engines } from "$lib/domain/trace-graph/folder-layout";
import { createReplyStore, type LayoutJobMessage, type LayoutReplyMessage } from "./layout-protocol";

const replies = createReplyStore();
const reply = (message: LayoutReplyMessage) => (self as unknown as Worker).postMessage(message);

self.onmessage = (event: MessageEvent<LayoutJobMessage>) => {
  const { id } = event.data;
  try {
    const input = replies.input(event.data);
    if (!input) { reply({ id, missing: true }); return; }
    const folder = engines.default(input);
    reply({ id, folder });
    // Kept once sent: the client counts every reply that reaches it.
    replies.sent(id, folder);
  } catch (error) {
    reply({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
