import { decodePackets } from './aac-decoder';
import type { PacketReply, PacketRequest } from './aac';

// DOM's AudioDecoder types are shared with DedicatedWorker; no AudioContext is
// created here. Closing the owning context terminates this worker and its codecs.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<PacketRequest>) => void;
  postMessage(message: PacketReply, transfer: Transferable[]): void;
};
scope.onmessage = async ({ data: { id, bytes, sizes } }) => {
  try {
    const result = await decodePackets(bytes, sizes);
    scope.postMessage({ id, result }, [result.pcm.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? `${error.name}: ${error.message}` : 'AAC decode failed' }, []);
  }
};
