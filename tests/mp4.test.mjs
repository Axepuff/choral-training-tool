import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { encodePlayback, makeWav } from './helpers/audio-fixture.mjs';

const source = await readFile(new URL('../src/audio/mp4.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { MP4Reader, AudioDecodeError } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
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
      assert.deepEqual(error.diagnostics, { code, contextRate: 48000, decodedRate: sampleRate, channels: 1,
        encodedSamples: 194560, decodedSamples: length, offset: 1024, requiredSamples: 192000, start: 0, end: 4 });
      return true;
    });
  });
}

test('window metadata prevents implicit 2112-sample AAC trimming at start and after seeks', async () => {
  const reader = await open(await fixture(44100));
  let metadata;
  // Models the missing-edit priming policy suggested by the device report.
  // It does not run Apple's decoder; Safari still needs a physical retest.
  const context = {
    sampleRate: 48000,
    async decodeAudioData(input) {
      const b = Buffer.from(input), table = timingOffset(b);
      const frames = b.readUInt32BE(table + 8), encoded = frames * b.readUInt32BE(table + 12);
      const elst = payloadOffset(b, ['moov', 'trak', 'edts', 'elst']);
      const trim = elst === null ? 2112 : b.readUInt32BE(elst + 12);
      metadata = { b, encoded, elst, trim };
      const pcm = Float32Array.from({ length: encoded - trim }, (_, i) => i + trim);
      return { sampleRate: 48000, numberOfChannels: 1, length: pcm.length, getChannelData() { return pcm; } };
    },
    createBuffer(channels, length, sampleRate) {
      const pcm = new Float32Array(length);
      return { length, sampleRate, copyToChannel(data) { pcm.set(data); }, getChannelData() { return pcm; } };
    },
  };
  for (const [start, end] of [[0, 4], [3.123, 5.456], [4, 8], [7.95, 8.137]]) {
    const output = await reader.decode(context, start, end);
    assert.equal(output.length, Math.round((end - start) * 48000));
    assert.equal(metadata.trim, 0, 'explicit zero edit disables the implicit AAC priming policy');
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
