// The server's FFmpeg worker produces AAC-LC, 48 kHz, mono, 1024 samples per packet.
// Supplying AudioSpecificConfig makes each EncodedAudioChunk raw AAC, not ADTS.
export const packetConfig: AudioDecoderConfig = {
  codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1,
  description: new Uint8Array([0x11, 0x88]),
};
export async function supportsPackets() {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') return false;
  try { return (await AudioDecoder.isConfigSupported(packetConfig)).supported === true; }
  catch { return false; }
}
export async function decodePackets(bytes: Uint8Array, sizes: number[], signal?: AbortSignal) {
  const pcm = new Float32Array(sizes.length * 1024);
  let frames = 0, failure: unknown;
  const decoder = new AudioDecoder({
    output(frame) {
      try {
        if (frame.sampleRate !== 48000 || frame.numberOfChannels !== 1 ||
          Math.round(frame.timestamp * 48000 / 1e6) !== frames || frames + frame.numberOfFrames > pcm.length) {
          throw new Error(`AAC output: rate=${frame.sampleRate}, channels=${frame.numberOfChannels}, timestamp=${frame.timestamp}, expectedSample=${frames}, frames=${frame.numberOfFrames}`);
        }
        frame.copyTo(pcm.subarray(frames, frames + frame.numberOfFrames), { planeIndex: 0, format: 'f32-planar' });
        frames += frame.numberOfFrames;
      } catch (error) { failure ??= error; }
      finally { frame.close(); }
    },
    error(error) { failure ??= error; },
  });
  const close = () => { if (decoder.state !== 'closed') decoder.close(); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    if (signal?.aborted) throw new Error('Аудиоустройство закрыто');
    decoder.configure(packetConfig);
    let at = 0;
    for (let i = 0; i < sizes.length; i++) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * 1024 * 1e6 / 48000),
        duration: Math.round((i + 1) * 1024 * 1e6 / 48000) - Math.round(i * 1024 * 1e6 / 48000),
        data: bytes.subarray(at, at + sizes[i]!) }));
      at += sizes[i]!;
    }
    await decoder.flush();
    if (failure) throw failure;
    return { sampleRate: 48000, numberOfChannels: 1, length: frames, pcm };
  } finally { signal?.removeEventListener('abort', close); close(); }
}
