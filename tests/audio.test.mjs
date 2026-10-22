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
test('all-solo reset is immutable and repeatable under StrictMode updater replay', () => {
  const mix = Object.freeze({
    a: Object.freeze({ volume: 40, muted: false, solo: true }),
    b: Object.freeze({ volume: 80, muted: false, solo: false }),
  });
  const before = structuredClone(mix);
  const first = updateMix(mix, 'b', { solo: true });
  const replay = updateMix(mix, 'b', { solo: true });
  assert.deepEqual(mix, before);
  assert.deepEqual(first, replay);
  assert.ok(Object.values(first).every(t => !t.solo));
});
test('streamed windows share a clock for 32 twenty-minute tracks and release scheduled nodes', async t => {
  const context = clock(), engine = new AudioEngine(context, 1200), mix = {};
  t.after(() => engine.dispose());
  let requests = 0;
  for (let i = 0; i < 32; i++) {
    const id = `long-${i}`; mix[id] = { volume: 50, muted: false, solo: false };
    engine.streams.set(id, { duration: 1200, async load(start, end) {
      requests++; assert.ok(end - start <= 4); return { duration: end - start };
    } });
  }
  await engine.play(mix);
  assert.ok(context.sources.slice(0, 32).every(s => s.args[0] === .1));
  engine.pause();
  for (const offset of [600.123, 1196, 3.5, 1199]) {
    await engine.seek(offset, mix); const before = context.sources.length; await engine.play(mix);
    assert.ok(context.sources.slice(before,before+32).every(s => s.args[0] === context.currentTime + .1));
    context.currentTime += .5; engine.pause();
  }
  assert.ok(requests < 32 * 20, 'seek only loads a bounded horizon, never entire tracks');
  assert.ok(context.sources.every(s => s.stopped));
  engine.dispose(); assert.equal(engine.streams.size, 0);
});
test('slow window stops all tracks at last buffered boundary instead of drifting', async () => {
  const context = clock(), engine = new AudioEngine(context, 20);
  let finish;
  engine.streams.set('a', { duration: 20, load(start, end) {
    return start === 0 ? Promise.resolve({ duration: end - start }) : new Promise(resolve => { finish = resolve; });
  } });
  let error; engine.onError = message => { error = message; };
  await engine.play({ a: { volume: 100, muted: false, solo: false } });
  context.currentTime = 6;
  finish({ duration: 4 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.playing, false); assert.equal(engine.position, 4); assert.ok(error);
  assert.ok(context.sources.every(s => s.stopped)); engine.dispose();
});
test('all 300 streaming windows over twenty minutes stay on the original clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = clock(), engine = new AudioEngine(context, 1200), mix = {};
  t.after(() => engine.dispose());
  for (let i = 0; i < 32; i++) {
    const id = `voice-${i}`; mix[id] = { volume: 50, muted: false, solo: false };
    engine.streams.set(id, { duration: 1200, async load(start, end) { return { duration: end - start }; } });
  }
  await engine.play(mix);
  await new Promise(resolve => setImmediate(resolve));
  const epoch = context.sources[0].args[0];
  for (let step = 0; step < 300; step++) {
    context.currentTime = step * 4 + .2;
    for (const source of context.sources) {
      if (!source.ended && source.buffer && source.args[0] + source.buffer.duration <= context.currentTime) {
        source.ended = true; source.onended();
      }
    }
    t.mock.timers.tick(100);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.playing, true);
    assert.ok(context.sources.filter(s => s.buffer).length <= 96, 'at most three windows of PCM');
  }
  assert.equal(context.sources.length, 300 * 32);
  for (let window = 0; window < 300; window++) {
    assert.ok(context.sources.slice(window * 32, (window + 1) * 32).every(s => s.args[0] === epoch + window * 4));
  }
  engine.pause(); assert.ok(context.sources.every(s => !s.buffer));
});
test('a canceled in-flight streaming decode cannot restart a changed song', async () => {
  const context = clock(), engine = new AudioEngine(context, 1200);
  let finish;
  engine.streams.set('late', { duration: 1200, load: () => new Promise(resolve => { finish = resolve; }) });
  const play = engine.play({ late: { volume: 100, muted: false, solo: false } });
  await new Promise(resolve => setImmediate(resolve));
  engine.dispose(); finish({ duration: 4 }); await play;
  assert.equal(engine.playing, false); assert.equal(context.sources.length, 0);
});
test('streaming gain/solo/mute apply to current and future windows; a failed file is isolated', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = clock(), engine = new AudioEngine(context, 20);
  t.after(() => engine.dispose());
  engine.streams.set('a', { duration: 20, async load() { return { duration: 4 }; } });
  engine.streams.set('b', { duration: 20, async load() { return { duration: 4 }; } });
  engine.streams.set('bad', { duration: 20, async load() { throw new Error('404'); } });
  let failed; engine.onTrackError = id => { failed = id; };
  const mix = { a: { volume: 40, muted: false, solo: false }, b: { volume: 80, muted: false, solo: false }, bad: { volume: 100, muted: false, solo: false } };
  await engine.play(mix); await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed, 'bad'); assert.equal(engine.streams.size, 2);
  engine.setMix(updateMix(mix, 'a', { solo: true }));
  assert.ok(context.gains.every((gain, i) => gain.value === (i % 2 ? 0 : .4)));
  context.currentTime = 4; t.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve));
  assert.ok(context.gains.every((gain, i) => gain.value === (i % 2 ? 0 : .4)), 'future windows preserve latest solo');
  engine.setMix(updateMix(mix, 'b', { muted: true }));
  assert.ok(context.gains.every((gain, i) => gain.value === (i % 2 ? 0 : .4)));
});

test('overlapping seeks resume only the latest position; explicit pause cancels pending resume', async t => {
  const context = clock(), engine = new AudioEngine(context, 120);
  t.after(() => engine.dispose());
  const mix = { a: { volume: 100, muted: false, solo: false } };
  let release;
  engine.streams.set('a', { duration: 120, load(start, end) {
    return start === 20 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ duration: end - start });
  } });
  await engine.play(mix);
  await new Promise(resolve => setImmediate(resolve));
  const first = engine.seek(20, mix);
  await new Promise(resolve => setImmediate(resolve));
  const second = engine.seek(30, mix);
  release({ duration: 4 });
  await Promise.all([first, second]);
  assert.equal(engine.playing, true);
  assert.equal(engine.position, 30);
  assert.equal(context.sources.filter(s => !s.stopped)[0].args[0], context.currentTime + .1);
  const third = engine.seek(20, mix);
  await new Promise(resolve => setImmediate(resolve));
  engine.pause();
  const fourth = engine.seek(40, mix);
  release({ duration: 4 });
  await Promise.all([third, fourth]);
  assert.equal(engine.playing, false);
  assert.equal(engine.position, 40);
  assert.ok(context.sources.every(s => s.stopped));
});

test('unresolved network load cannot advance cursor beyond buffered audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = clock(), engine = new AudioEngine(context, 120);
  t.after(() => engine.dispose());
  let release, errors = 0;
  engine.onError = () => errors++;
  engine.streams.set('a', { duration: 120, load(start) {
    return start === 0 ? Promise.resolve({ duration: 4 }) : new Promise(resolve => { release = resolve; });
  } });
  await engine.play({ a: { volume: 100, muted: false, solo: false } });
  context.currentTime = 4.2;
  assert.equal(engine.position, 4);
  t.mock.timers.tick(50);
  assert.equal(engine.playing, false);
  assert.equal(engine.position, 4);
  assert.equal(errors, 1);
  context.currentTime = 20;
  t.mock.timers.tick(1000);
  assert.equal(engine.position, 4);
  assert.ok(context.sources.every(s => s.stopped));
  release({ duration: 4 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.sources.length, 1, 'late window must not restart transport');
});

test('solo file failing a later window immediately restores healthy output', async t => {
  const context = clock(), engine = new AudioEngine(context, 20);
  t.after(() => engine.dispose());
  const mix = { a: { volume: 40, muted: false, solo: true }, b: { volume: 80, muted: false, solo: false } };
  let fail;
  engine.streams.set('a', { duration: 20, load(start) {
    return start === 0 ? Promise.resolve({ duration: 4 }) : new Promise((_, reject) => { fail = reject; });
  } });
  engine.streams.set('b', { duration: 20, async load() { return { duration: 4 }; } });
  await engine.play(mix);
  assert.equal(context.gains[1].value, 0);
  fail(new Error('Range unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.playing, true);
  assert.equal(engine.streams.has('a'), false);
  engine.setMix(mix); // Even a stale React commit cannot restore an excluded Solo.
  assert.equal(context.gains[1].value, .8, 'already scheduled healthy track becomes audible');
  assert.ok(context.gains.length > 2);
  assert.ok(context.gains.slice(2).every(g => g.value === .8), 'future healthy windows remain audible');
});
