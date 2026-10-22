import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'choral-audio-'));
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn) { for (let i = 0; i < 200; i++) { try { if (await fn()) return; } catch { /* startup */ } await sleep(100); } throw new Error('Timeout'); }
function start(cmd, args, env = {}) { const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' }); children.push(p); }
const wav = Buffer.alloc(44 + 48000 * 2 * 8);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 48000 * 8; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 48000) * 8000), 44 + i * 2);
await writeFile(join(dir, 'fixture.wav'), wav);
execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'fixture.wav'), '-ac', '1', '-ar', '48000', '-c:a', 'aac', '-b:a', '96k', join(dir, 'fixture.m4a')]);
const aac = await readFile(join(dir, 'fixture.m4a'));
const song = { id: 'fixture', title: 'Audio fixture', bpm: 120, beatsPerBar: 3, beatUnit: 8, durationMs: 8000, barCount: 11, notes: 'Synthetic fixture', tracks: Array.from({ length: 32 }, (_, i) => ({ id: `stable-${i}`, name: `Voice ${i}`, gain: .5, durationMs: 8000, mediaUrl: `/api/v1/media/${i}`, peaksUrl: '/api/v1/peaks' })) };
const requests = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url, cookie: req.headers.cookie });
  if (req.url.startsWith('/api/v1/public/shares/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ kind: 'song', songs: [song], nextCursor: null })); }
  else if (req.url === '/api/v1/peaks') res.end(JSON.stringify({ startMs: 0, stepMs: 100, durationMs: 8000, points: Array.from({ length: 80 }, () => [-.25, .25]) }));
  else if (req.url.startsWith('/api/v1/media/') && req.url !== '/api/v1/media/31') { res.setHeader('Content-Type', 'audio/mp4'); res.end(aac); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(5188, '127.0.0.1', r));
let ws; const pending = new Map(); let id = 0;
function send(method, params = {}) { return new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
try {
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5189', '--strictPort'], { CHORAL_API_PROXY: 'http://127.0.0.1:5188', VITE_APP_DEMO: 'false' });
  await poll(async () => (await fetch('http://127.0.0.1:5189')).ok);
  start('/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank']);
  let port; await poll(async () => { port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port; });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const d = JSON.parse(e.data), p = pending.get(d.id); if (p) { pending.delete(d.id); if (d.error) p.reject(d.error); else p.resolve(d.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5189/?song=fixture' });
  await poll(() => evaluate(`document.body.textContent.includes('Аудио недоступно')`));
  assert.equal(await evaluate(`document.querySelectorAll('polygon').length`), 32);
  assert.equal(await evaluate(`document.querySelectorAll('polygon')[0].getAttribute('points').length > 100`), true);
  for (const [width, height] of [[320, 640], [360, 740], [740, 360], [1280, 800]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${width} overflow ${await evaluate('JSON.stringify({inner:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,sections:Array.from(document.querySelectorAll("section")).map(e=>[e.className,e.clientWidth,e.scrollWidth,getComputedStyle(e).overflowX])})')}: ${await evaluate("JSON.stringify(Array.from(document.querySelectorAll('*')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width,e.getBoundingClientRect().right]))")}`);
  }
  // CDP mouse input is a trusted user gesture; autoplay policy stays enabled.
  const point = await evaluate(`(() => { const r = document.querySelector('[aria-label="Воспроизвести"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .2`));
  await evaluate(`document.querySelector('[aria-label="Пауза"]').click()`); await sleep(100);
  const stopped = await evaluate(`Number(document.querySelector('input[type=range]').value)`); await sleep(150);
  assert.equal(await evaluate(`Number(document.querySelector('input[type=range]').value)`), stopped);
  await evaluate(`document.querySelector('[aria-label="Solo: Voice 0"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Solo: Voice 0"]').getAttribute('aria-pressed')`), 'true');
  await evaluate(`(() => {
    const slider = document.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '4');
    slider.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) === 4`));
  await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').click()`);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > 4.1`));
  await evaluate(`(() => {
    window.closedAudioContexts = 0;
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function() { window.closedAudioContexts++; return close.call(this); };
    history.pushState(null, '', '?song=next-fixture'); window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  await poll(() => evaluate('window.closedAudioContexts > 0'));
  await poll(() => evaluate(`document.body.textContent.includes('Аудио недоступно')`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Пауза"]') === null`), true);
  assert.ok(requests.filter(r => r.url.includes('/media/') || r.url.includes('/peaks')).every(r => !r.cookie));
  const rendered = await evaluate(`(async () => {
    const {AudioEngine} = await import('/src/audio/engine.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    // Offline contexts have no resume-before-render API; only that gesture adapter is replaced.
    context.resume = async () => {};
    const engine = new AudioEngine(context, 1);
    const buffer = context.createBuffer(1, 48000, 48000);
    buffer.getChannelData(0).fill(.25);
    engine.buffers.set('one', buffer); engine.buffers.set('two', buffer);
    await engine.play({one:{volume:100,solo:false,muted:false},two:{volume:100,solo:false,muted:false}});
    const output = await context.startRendering(); const data = output.getChannelData(0);
    return {before:data[1919],first:data[1920],middle:data[10000]};
  })()`);
  assert.equal(rendered.before, 0); assert.equal(rendered.first, .5); assert.equal(rendered.middle, .5);
  console.log('PASS Chrome: real AAC-LC decode/play, sample-exact OfflineAudioContext mix, 32 channels with individual 404, peaks, gesture, clock cursor/pause, Solo, 320/360/landscape/desktop overflow.');
} finally { ws?.close(); for (const child of children) child.kill('SIGTERM'); server.closeAllConnections(); server.close(); await sleep(300); await rm(dir, { recursive: true, force: true }); }
