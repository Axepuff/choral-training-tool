import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { encodePlayback, makeWav } from './helpers/audio-fixture.mjs';

function moduleURL(source) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
}
const decoderURL = moduleURL(await readFile(new URL('../src/audio/aac-decoder.ts', import.meta.url), 'utf8'));
const workerURL = moduleURL((await readFile(new URL('../src/audio/aac.ts', import.meta.url), 'utf8'))
  .replace("from './aac-decoder'", `from '${decoderURL}'`)
  .replace("new URL('./aac.worker.ts', import.meta.url)", "new URL('file:///mock-aac.worker.ts')"));
const { decodePacketWindow } = await import(workerURL);
const source = (await readFile(new URL('../src/audio/mp4.ts', import.meta.url), 'utf8'))
  .replace("from './aac-decoder'", `from '${decoderURL}'`).replace("from './aac'", `from '${workerURL}'`);
const { MP4Reader, AudioDecodeError } = await import(moduleURL(source));
const dir = await mkdtemp(join(tmpdir(), 'choral-mp4-test-'));
after(() => rm(dir, { recursive: true, force: true }));
const fixtures = new Map();
async function fixture(rate) {
  if (!fixtures.has(rate)) {
    const input = join(dir, `${rate}.wav`), output = join(dir, `${rate}.m4a`);
    await writeFile(input, makeWav(rate, 8.137, 2));
    encodePlayback(input, output);
    fixtures.set(rate, await readFile(output));
  }
  return fixtures.get(rate);
}
function open(bytes) {
  return MP4Reader.open(async (start, end) => {
    assert.ok(start >= 0 && end < bytes.length);
    return new Uint8Array(bytes.subarray(start, end + 1));
  });
}
function payloadOffset(bytes, path) {
  let start = 0, end = bytes.length;
  for (const type of path) {
    let at = start;
    while (at < end && bytes.toString('ascii', at + 4, at + 8) !== type) at += bytes.readUInt32BE(at);
    if (at >= end) return null;
    end = at + bytes.readUInt32BE(at); start = at + 8;
  }
  return start;
}
const timingOffset = bytes => {
  const at = payloadOffset(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
  assert.notEqual(at, null);
  return at;
};
// Known PCM ranges in the fixture's 1024-sample AAC packets, including priming.
const windows = [[0, 4, 192000, 1024], [3.123, 5.456, 111984, 2448], [4, 8, 192000, 2560], [7.95, 8.137, 8976, 2720]];

for (const rate of [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000]) {
  test(`opens server AAC converted from a real ${rate} Hz stereo WAV`, async () => {
    await open(await fixture(rate));
  });
}
test('accepts actual resampling timestamp jitter produced by the server filter', async () => {
  const bytes = await fixture(44100), at = timingOffset(bytes);
  const deltas = Array.from({ length: bytes.readUInt32BE(at + 4) }, (_, i) => bytes.readUInt32BE(at + 12 + i * 8));
  assert.ok(deltas.slice(0, -1).some(delta => delta !== 1024), 'fixture must reproduce the worker timing mismatch');
  await open(bytes);
});
for (const [name, mutate] of [
  ['empty timing table', (b, at) => b.writeUInt32BE(0, at + 4)],
  ['truncated timing table', (b, at) => b.writeUInt32BE(b.readUInt32BE(at + 4) + 1, at + 4)],
  ['zero frame count', (b, at) => b.writeUInt32BE(0, at + 8)],
  ['zero duration', (b, at) => b.writeUInt32BE(0, at + 12)],
  ['frame count mismatch', (b, at) => b.writeUInt32BE(b.readUInt32BE(at + 8) + 1, at + 8)],
  ['cumulative timing drift', (b, at) => {
    for (let i = 0; i < b.readUInt32BE(at + 4); i++) b.writeUInt32BE(1025, at + 12 + i * 8);
  }],
  ['an actual timing gap', (b, at) => b.writeUInt32BE(2048, at + 12)],
]) {
  test(`rejects ${name} instead of treating it as timestamp rounding`, async () => {
    const bytes = Buffer.from(await fixture(44100));
    mutate(bytes, timingOffset(bytes));
    await assert.rejects(open(bytes), /AAC timing/);
  });
}

for (const [code, sampleRate, length] of [
  ['AAC_SAMPLE_RATE', 44100, 194560],
  ['AAC_SHORT_PCM', 48000, 194560 - 2112],
]) {
  test(`reports concrete decoder output for ${code} without accepting invalid PCM`, async () => {
    const reader = await open(await fixture(44100));
    const context = { sampleRate: 48000, async decodeAudioData() { return { sampleRate, length, numberOfChannels: 1 }; } };
    await assert.rejects(reader.decode(context, 0, 4), error => {
      assert.ok(error instanceof AudioDecodeError);
      assert.deepEqual(error.diagnostics, { code, readerVersion: 2, decoder: 'decodeAudioData', contextRate: 48000, decodedRate: sampleRate, channels: 1,
        encodedSamples: 194560, decodedSamples: length, offset: 1024, requiredSamples: 192000, start: 0, end: 4 });
      return true;
    });
  });
}

test('native fallback describes the packet window without stale full-song metadata', async () => {
  const reader = await open(await fixture(44100));
  let metadata;
  const context = {
    sampleRate: 48000,
    async decodeAudioData(input) {
      const b = Buffer.from(input), table = timingOffset(b);
      const frames = b.readUInt32BE(table + 8), encoded = frames * b.readUInt32BE(table + 12);
      const elst = payloadOffset(b, ['moov', 'trak', 'edts', 'elst']);
      const trim = b.readUInt32BE(elst + 12);
      metadata = { b, encoded, elst, trim };
      const pcm = Float32Array.from({ length: encoded - trim }, (_, i) => i + trim);
      return { sampleRate: 48000, numberOfChannels: 1, length: pcm.length, getChannelData() { return pcm; } };
    },
    createBuffer(channels, length, sampleRate) {
      const pcm = new Float32Array(length);
      return { length, sampleRate, copyToChannel(data) { pcm.set(data); }, getChannelData() { return pcm; } };
    },
  };
  for (const [start, end, length, firstSample] of windows) {
    const output = await reader.decode(context, start, end);
    assert.equal(output.length, length);
    assert.equal(output.getChannelData(0)[0], firstSample);
    assert.equal(output.getChannelData(0).at(-1), firstSample + length - 1);
    assert.equal(metadata.trim, 0, 'the container describes the full packet window');
    assert.equal(metadata.b.readUInt32BE(metadata.elst + 8), metadata.encoded, 'edit duration covers all encoded samples');
    const mvhd = payloadOffset(metadata.b, ['moov', 'mvhd']);
    const tkhd = payloadOffset(metadata.b, ['moov', 'trak', 'tkhd']);
    const mdhd = payloadOffset(metadata.b, ['moov', 'trak', 'mdia', 'mdhd']);
    assert.equal(metadata.b.readUInt32BE(mvhd + 12), 48000, 'movie timebase preserves exact sample durations');
    assert.equal(metadata.b.readUInt32BE(mvhd + 16), metadata.encoded);
    assert.equal(metadata.b.readUInt32BE(tkhd + 20), metadata.encoded);
    assert.equal(metadata.b.readUInt32BE(mdhd + 16), metadata.encoded);
    for (const type of ['sgpd', 'sbgp']) assert.equal(payloadOffset(metadata.b, ['moov', 'trak', 'mdia', 'minf', 'stbl', type]), null, 'full-song sample groups must not leak into a short window');
  }
});

function packetContext() {
  return Object.assign(new EventTarget(), {
    sampleRate: 48000, state: 'suspended',
    decodeAudioData() { throw new Error('must not use the short-MP4 decoder'); },
    createBuffer(channels, length, sampleRate) {
      const pcm = new Float32Array(length);
      return { length, sampleRate, copyToChannel(data) { pcm.set(data); }, getChannelData() { return pcm; } };
    },
  });
}
async function withPackets(mode, run) {
  const originalDecoder = globalThis.AudioDecoder, originalChunk = globalThis.EncodedAudioChunk;
  const instances = []; let frameCount = 0, closedFrames = 0, supportChecks = 0;
  const flushing = Promise.withResolvers();
  class Decoder {
    state = 'unconfigured'; chunks = []; closes = 0;
    static async isConfigSupported(config) { supportChecks++; return { supported: mode !== 'unsupported', config }; }
    constructor(callbacks) { this.callbacks = callbacks; instances.push(this); }
    configure(config) { assert.deepEqual([...config.description], [0x11, 0x88]); this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); }
    async flush() {
      if (mode === 'pending') {
        this.pending = Promise.withResolvers(); flushing.resolve();
        await this.pending.promise;
      }
      if (mode === 'error') { this.state = 'closed'; this.callbacks.error(new Error('codec failure')); throw new Error('flush failed'); }
      for (let i = 0; i < this.chunks.length; i++) {
        const remaining = this.chunks.length * 1024 - (mode === 'short' ? 2112 : 0) - i * 1024;
        if (remaining <= 0) break;
        const frame = { sampleRate: 48000, numberOfChannels: 1, numberOfFrames: Math.min(1024, remaining),
          timestamp: this.chunks[i].timestamp + (mode === 'gap' && i === 1 ? 1000 : 0),
          copyTo(target) { for (let j = 0; j < target.length; j++) target[j] = i * 1024 + j; },
          close() { closedFrames++; },
        };
        frameCount++; this.callbacks.output(frame);
      }
    }
    close() { this.closes++; this.state = 'closed'; this.pending?.reject(new Error('decoder closed')); }
  }
  globalThis.AudioDecoder = Decoder;
  globalThis.EncodedAudioChunk = class { constructor(init) { Object.assign(this, init); } };
  try { await run({ instances, flushing: flushing.promise, counts: () => ({ frameCount, closedFrames, supportChecks }) }); }
  finally {
    if (originalDecoder === undefined) delete globalThis.AudioDecoder; else globalThis.AudioDecoder = originalDecoder;
    if (originalChunk === undefined) delete globalThis.EncodedAudioChunk; else globalThis.EncodedAudioChunk = originalChunk;
  }
}

test('packet decoder bypasses short-MP4 decode and crops priming once at start, seeks and tail', async () => {
  await withPackets('ok', async ({ instances, counts }) => {
    const reader = await open(await fixture(44100)), context = packetContext();
    for (const [start, end, length, firstSample] of windows) {
      const pcm = await reader.decode(context, start, end);
      assert.equal(pcm.length, length);
      assert.equal(pcm.getChannelData(0)[0], firstSample);
      assert.equal(pcm.getChannelData(0).at(-1), firstSample + length - 1);
    }
    assert.equal(instances.length, 4);
    assert.ok(instances.every(d => d.closes === 1 && d.state === 'closed'));
    assert.equal(counts().frameCount, counts().closedFrames, 'all AudioData outputs are released');
    assert.equal(counts().supportChecks, 1, 'codec support is checked once per reader');
  });
});
for (const [mode, code] of [['gap', 'AAC_PACKET_DECODE'], ['error', 'AAC_PACKET_DECODE'], ['short', 'AAC_SHORT_PCM']]) {
  test(`packet decoder rejects ${mode} and releases its outputs and decoder`, async () => {
    await withPackets(mode, async ({ instances, counts }) => {
      const reader = await open(await fixture(44100));
      await assert.rejects(reader.decode(packetContext(), 0, 4), error => error instanceof AudioDecodeError &&
        error.diagnostics.code === code && error.diagnostics.decoder === 'webcodecs' && error.diagnostics.readerVersion === 2);
      assert.ok(instances.every(d => d.state === 'closed'));
      assert.equal(counts().frameCount, counts().closedFrames);
    });
  });
}
test('unsupported AAC WebCodecs config uses the guarded native fallback', async () => {
  await withPackets('unsupported', async ({ instances }) => {
    const reader = await open(await fixture(44100));
    const context = { sampleRate: 48000, async decodeAudioData() { return { sampleRate: 48000, length: 192448, numberOfChannels: 1 }; } };
    await assert.rejects(reader.decode(context, 0, 4), error => error instanceof AudioDecodeError &&
      error.diagnostics.code === 'AAC_SHORT_PCM' && error.diagnostics.decoder === 'decodeAudioData' && error.diagnostics.readerVersion === 2);
    assert.equal(instances.length, 0);
  });
});
test('closing the audio context releases a packet decoder while flush is pending', async () => {
  await withPackets('pending', async ({ instances, flushing }) => {
    const reader = await open(await fixture(44100)), context = packetContext();
    const decoding = reader.decode(context, 0, 4);
    await flushing;
    const rejected = assert.rejects(decoding, error => error instanceof AudioDecodeError && error.diagnostics.code === 'AAC_PACKET_DECODE');
    context.state = 'closed'; context.dispatchEvent(new Event('statechange'));
    await rejected;
    assert.equal(instances[0].closes, 1);
    assert.equal(instances[0].state, 'closed');
  });
});

test('worker routes concurrent replies by request ID and rejects all pending jobs on context close', async () => {
  const original = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    jobs = []; terminations = 0;
    constructor() { instances.push(this); }
    postMessage(request) { this.jobs.push(request); }
    terminate() { this.terminations++; }
  };
  try {
    const context = packetContext();
    const first = decodePacketWindow(context, new Uint8Array([1]), [1]);
    const second = decodePacketWindow(context, new Uint8Array([2]), [1]);
    assert.equal(instances.length, 1, 'one worker is shared by tracks of one context');
    const worker = instances[0], result = value => ({ sampleRate: 48000, numberOfChannels: 1, length: 1, pcm: new Float32Array([value]) });
    worker.onmessage({ data: { id: worker.jobs[1].id, result: result(.5) } });
    worker.onmessage({ data: { id: worker.jobs[0].id, result: result(.25) } });
    assert.equal((await first).getChannelData(0)[0], .25);
    assert.equal((await second).getChannelData(0)[0], .5);
    const pending = [decodePacketWindow(context, new Uint8Array([3]), [1]), decodePacketWindow(context, new Uint8Array([4]), [1])];
    const rejected = pending.map(p => assert.rejects(p, /Аудиоустройство закрыто/));
    context.state = 'closed'; context.dispatchEvent(new Event('statechange'));
    await Promise.all(rejected);
    assert.equal(worker.terminations, 1);
    await assert.rejects(decodePacketWindow(context, new Uint8Array([5]), [1]), /Аудиоустройство закрыто/);
    assert.equal(instances.length, 1, 'a closed context never creates another worker');
  } finally { if (original === undefined) delete globalThis.Worker; else globalThis.Worker = original; }
});
