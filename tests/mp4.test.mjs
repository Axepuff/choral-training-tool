import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { encodePlayback, makeWav } from './helpers/audio-fixture.mjs';

const source = await readFile(new URL('../src/audio/mp4.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { MP4Reader } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
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
function timingOffset(bytes) {
  let start = 0, end = bytes.length;
  for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']) {
    let at = start;
    while (at < end && bytes.toString('ascii', at + 4, at + 8) !== type) at += bytes.readUInt32BE(at);
    assert.ok(at < end, `missing ${type}`);
    end = at + bytes.readUInt32BE(at); start = at + 8;
  }
  return start;
}

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
