import { decodePackets } from './aac-decoder';

export interface PacketRequest { id: number; bytes: Uint8Array; sizes: number[] }
export type PacketReply = { id: number; result: Awaited<ReturnType<typeof decodePackets>> } | { id: number; error: string };
type Result = Awaited<ReturnType<typeof decodePackets>>;
type Pending = { resolve(result: Result): void; reject(error: Error): void };
const workers = new WeakMap<AudioContext, { load(bytes: Uint8Array, sizes: number[]): Promise<Result> }>();

function workerFor(context: AudioContext) {
  const existing = workers.get(context);
  if (existing) return existing;
  const worker = new Worker(new URL('./aac.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let nextId = 0, stopped = false;
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    context.removeEventListener('statechange', stateChange);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const stateChange = () => { if (context.state === 'closed') stop(new Error('Аудиоустройство закрыто')); };
  context.addEventListener('statechange', stateChange);
  worker.onmessage = (event: MessageEvent<PacketReply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if ('error' in event.data) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  };
  worker.onerror = () => stop(new Error('Не удалось запустить аудиодекодер в worker'));
  worker.onmessageerror = () => stop(new Error('Неполный ответ аудиодекодера'));
  const client = { load(bytes: Uint8Array, sizes: number[]) {
    return new Promise<Result>((resolve, reject) => {
      if (stopped || context.state === 'closed') { reject(new Error('Аудиоустройство закрыто')); return; }
      const id = ++nextId, owned = Uint8Array.from(bytes);
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, bytes: owned, sizes } satisfies PacketRequest, [owned.buffer]); }
      catch (error) { pending.delete(id); reject(error); }
    });
  } };
  workers.set(context, client);
  return client;
}

export async function decodePacketWindow(context: AudioContext, bytes: Uint8Array, sizes: number[]) {
  if (context.state === 'closed') throw new Error('Аудиоустройство закрыто');
  let result: Result;
  if (typeof Worker !== 'undefined') result = await workerFor(context).load(bytes, sizes);
  else {
    // Non-worker hosts can still use the same packet decoder with cancellation.
    const abort = new AbortController();
    const stateChange = () => { if (context.state === 'closed') abort.abort(); };
    context.addEventListener('statechange', stateChange); stateChange();
    try { result = await decodePackets(bytes, sizes, abort.signal); }
    finally { context.removeEventListener('statechange', stateChange); }
  }
  return { sampleRate: result.sampleRate, numberOfChannels: result.numberOfChannels, length: result.length,
    getChannelData: () => result.pcm.subarray(0, result.length) };
}
