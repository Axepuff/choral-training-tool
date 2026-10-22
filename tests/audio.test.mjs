import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/audio/engine.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { AudioEngine, updateMix, mediaURL } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
function clock() {
  const sources = [], gains = [];
  return { currentTime: 0, sources, gains, destination: {}, resume: async () => {}, close: async () => {},
    createBufferSource() { const node = { connect() {}, disconnect() {}, stop() { this.stopped = true; }, start(...args) { this.args = args; } }; sources.push(node); return node; },
    createGain() { const node = { connect() {}, disconnect() {}, gain: { setTargetAtTime(value) { node.value = value; } } }; gains.push(node); return node; } };
}
test('32 arbitrary IDs share exact clock across repeated pause, seek, resume; short tracks end in silence', async () => {
  const context = clock(), engine = new AudioEngine(context, 120);
  const mix = {};
  for (let i = 0; i < 32; i++) { const id = `uuid-${i}`; engine.buffers.set(id, { duration: i === 0 ? 1 : 120 }); mix[id] = { volume: 70, muted: false, solo: false }; }
  await engine.play(mix);
  assert.equal(context.sources.length, 32);
  assert.ok(context.sources.every(s => s.args[0] === .04 && s.args[1] === 0));
  for (let i = 0; i < 20; i++) {
    context.currentTime += 2;
    engine.pause(); const pos = engine.position;
    context.currentTime += 5;
    assert.equal(engine.position, pos);
    await engine.play(mix);
    assert.equal(engine.position, pos);
    await engine.seek(20 + i, mix);
    assert.equal(engine.position, 20 + i);
    assert.ok(context.sources.slice(-31).every(s => s.args[0] === context.currentTime + .04 && s.args[1] === 20 + i));
  }
  engine.dispose(); assert.equal(engine.buffers.size, 0); assert.ok(context.sources.every(s => s.stopped));
});
test('gain, mutually exclusive solo/mute and all-solo reset affect output gains', async () => {
  const context = clock(), engine = new AudioEngine(context, 10);
  engine.buffers.set('a', { duration: 10 }); engine.buffers.set('b', { duration: 10 });
  let mix = { a: { volume: 40, muted: false, solo: false }, b: { volume: 80, muted: false, solo: false } };
  await engine.play(mix); assert.deepEqual(context.gains.map(g => g.value), [.4, .8]);
  mix = updateMix(mix, 'a', { solo: true }); engine.setMix(mix); assert.deepEqual(context.gains.map(g => g.value), [.4, 0]);
  mix = updateMix(mix, 'a', { muted: true }); assert.equal(mix.a.solo, false);
  mix = updateMix(mix, 'a', { solo: true }); assert.equal(mix.a.muted, false);
  mix = updateMix(mix, 'b', { solo: true }); assert.ok(Object.values(mix).every(t => !t.solo));
  engine.dispose();
});
test('late resume cannot start disposed or paused song; media URLs remain local', async () => {
  const context = clock(); let resume;
  context.resume = () => new Promise(resolve => { resume = resolve; });
  const engine = new AudioEngine(context, 10);
  engine.buffers.set('x', { duration: 10 });
  const pending = engine.play({ x: { volume: 100, muted: false, solo: false } });
  engine.dispose(); resume(); await pending; assert.equal(engine.playing, false); assert.equal(context.sources.length, 0);
  assert.throws(() => mediaURL('https://other.test/audio')); assert.throws(() => mediaURL('/api/v1/../private'));
});
