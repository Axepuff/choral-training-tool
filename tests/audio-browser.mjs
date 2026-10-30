import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePlayback, makeWav, playbackArgs } from './helpers/audio-fixture.mjs';
const dir = await mkdtemp(join(tmpdir(), 'choral-audio-'));
const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn) { for (let i = 0; i < 200; i++) { try { if (await fn()) return; } catch { /* startup */ } await sleep(100); } throw new Error('Timeout'); }
function start(cmd, args, env = {}) { const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' }); children.push(p); }
await writeFile(join(dir, 'fixture.wav'), makeWav(44100));
encodePlayback(join(dir, 'fixture.wav'), join(dir, 'fixture.m4a'));
await writeFile(join(dir, 'second.wav'), makeWav(44100, 8, 2));
encodePlayback(join(dir, 'second.wav'), join(dir, 'second.m4a'));
execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1200', ...playbackArgs, '-y', join(dir, 'long.m4a')]);
const longAAC = await readFile(join(dir, 'long.m4a'));
const aac = await readFile(join(dir, 'fixture.m4a'));
const secondAAC = await readFile(join(dir, 'second.m4a'));
// Chrome's full MP4 decode differs on timestamp-jitter fixtures; use an independent PCM oracle.
const referencePCM = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', join(dir, 'fixture.m4a'), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 });
assert.equal(referencePCM.length, 8 * 48000 * 4);
const song = { id: 'fixture', title: 'Я'.repeat(160), bpm: 120, beatsPerBar: 3, beatUnit: 8, durationMs: 8000, barCount: 11, notes: 'Ж'.repeat(1000), tracks: Array.from({ length: 32 }, (_, i) => ({ id: `stable-${i}`, name: `Voice ${i}`, gain: .5, durationMs: 8000, mediaUrl: `/api/v1/media/${i}`, peaksUrl: '/api/v1/peaks' })) };
const longSong = { ...song, id:'long-fixture', durationMs:1200000, tracks: song.tracks.map((t,i) => ({...t, durationMs:1200000, mediaUrl:`/api/v1/long/${i}`, peaksUrl:'/api/v1/long-peaks'})) };
const requests = [];
let changedTrack = false, revokeMedia = false;
const server = createServer((req, res) => {
  requests.push({ url: req.url, cookie: req.headers.cookie, range: req.headers.range });
  if (req.url === '/api/v1/reference-pcm') res.end(referencePCM);
  else if (req.url.startsWith('/api/v1/public/shares/')) {
    const selected = req.url.includes('meter-32-fixture') ? { ...song, id:'meter-32-fixture', bpm:300, beatsPerBar:32, beatUnit:32 } : req.url.includes('device-retry-fixture') ? { ...song, id: 'device-retry-fixture', tracks: song.tracks.slice(0, 1) } : req.url.includes('long-fixture') ? longSong : song;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ kind: 'song', songs: [selected], nextCursor: null }));
  }
  else if (req.url === '/api/v1/peaks') res.end(JSON.stringify({ startMs: 0, stepMs: 100, durationMs: 8000, points: Array.from({ length: 80 }, () => [-.25, .25]) }));
  else if (req.url === '/api/v1/long-peaks') res.end(JSON.stringify({startMs:0,stepMs:100,durationMs:1200000,points:Array.from({length:12000},()=>[-.125,.125])}));
  else if ((req.url.startsWith('/api/v1/media/') && req.url !== '/api/v1/media/31') || req.url.startsWith('/api/v1/long/')) {
    if (revokeMedia) { res.statusCode=404; res.end(); return; }
    res.setHeader('Content-Type', 'audio/mp4'); res.setHeader('ETag', changedTrack && req.url==='/api/v1/long/0' ? '"changed"' : '"fixture"');
    const payload = req.url.startsWith('/api/v1/long/') ? longAAC : Number(req.url.split('/').at(-1)) % 2 ? secondAAC : aac;
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (range) { const start = Number(range[1]), end = Math.min(payload.length - 1, Number(range[2])); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${payload.length}`); res.end(payload.subarray(start, end + 1)); }
    else res.end(payload); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(5188, '127.0.0.1', r));
let ws; const pending = new Map(); let id = 0;
function send(method, params = {}) { return new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
async function clickPlayback(label) {
  const point = await evaluate(`(() => { const r = document.querySelector('[aria-label="${label}"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function deferMedia() {
  await evaluate(`(() => {
    const fetch = window.fetch;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.deferredMediaRequests = 0;
    window.releaseMediaRequests = () => { window.fetch = fetch; release(); };
    window.fetch = async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('/api/v1/media/')) {
        window.deferredMediaRequests++;
        await gate;
      }
      return fetch(...args);
    };
  })()`);
}
async function waitForPendingPlayback(position) {
  await poll(() => evaluate('window.deferredMediaRequests > 0'));
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]')?.getAttribute('aria-busy') === 'true'`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Пауза"]').disabled`), false);
  assert.equal(await evaluate(`document.body.textContent.includes('Загрузка аудио…')`), true);
  const starts = await evaluate('window.transportSourceStarts');
  const playCalls = await evaluate('window.transportPlayCalls');
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) === ${position}`));
  assert.equal(await evaluate('window.transportSourceStarts'), starts, 'no sound before media arrives');
  await evaluate('window.releaseMediaRequests()');
  await evaluate('window.transportPlay');
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]')?.getAttribute('aria-busy') === 'false'`));
  assert.equal(await evaluate('window.transportPlayCalls'), playCalls, 'one requested start after loading');
  assert.ok(await evaluate('window.transportSourceStarts') > starts);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Пауза"]').getAttribute('aria-busy')`), 'false');
  assert.equal(await evaluate(`document.body.textContent.includes('Загрузка аудио…')`), false);
}
try {
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5189', '--strictPort'], { CHORAL_API_PROXY: 'http://127.0.0.1:5188', VITE_APP_DEMO: 'false' });
  await poll(async () => (await fetch('http://127.0.0.1:5189')).ok);
  start(process.env.CHORAL_CHROME_BIN ?? '/usr/bin/google-chrome', ['--headless', '--mute-audio', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank']);
  let port; await poll(async () => { port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return port; });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const d = JSON.parse(e.data), p = pending.get(d.id); if (p) { pending.delete(d.id); if (d.error) p.reject(d.error); else p.resolve(d.result); } };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.setCookie', {name:'audio-test',value:'synthetic',url:'http://127.0.0.1:5189/',path:'/'});
  await send('Page.navigate', { url: 'http://127.0.0.1:5189/?song=fixture' });
  await poll(() => evaluate(`document.body.textContent.includes('Аудио недоступно')`));
  assert.equal(await evaluate('document.querySelector("h1").textContent'), song.title);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('p')).some(p => p.textContent === ${JSON.stringify(song.notes)})`), true, 'full API notes are rendered');
  const chunkDecode = await evaluate(`(async () => {
    const {MP4Reader} = await import('/src/audio/mp4.ts');
    const context = new AudioContext({sampleRate:48000});
    const read = async (a,b) => new Uint8Array(await (await fetch('/api/v1/media/0', {credentials:'omit',headers:{Range:'bytes='+a+'-'+b}})).arrayBuffer());
    const reference = new Float32Array(await (await fetch('/api/v1/reference-pcm', {credentials:'omit'})).arrayBuffer());
    if (context.sampleRate !== 48000 || reference.length !== 8 * 48000) throw new Error('Invalid reference PCM');
    const nativeDecoder = globalThis.AudioDecoder, nativeDecode = context.decodeAudioData.bind(context);
    const support = await nativeDecoder.isConfigSupported({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:1,description:new Uint8Array([0x11,0x88])});
    if (!support.supported) throw new Error('This browser must support AAC WebCodecs for the packet regression');
    const errors = [];
    for (const decoder of ['webcodecs','decodeAudioData']) {
    globalThis.AudioDecoder = decoder === 'webcodecs' ? nativeDecoder : undefined;
    // The packet path must work even when the MP4 decoder fails, as on the iPhone.
    context.decodeAudioData = decoder === 'webcodecs' ? async () => { throw new Error('broken short-MP4 decode'); } : nativeDecode;
    const reader = await MP4Reader.open(read);
    for (const [start,end] of [[0,2],[0,4],[2,4],[3.123,5.456],[4,8],[6,8],[7.95,8]]) {
      const part = await reader.decode(context, start, end);
      let max = 0, rms = 0;
      const actual = part.getChannelData(0), offset = Math.round(start * 48000);
      if (part.sampleRate !== 48000 || part.numberOfChannels !== 1 || actual.length !== Math.round((end - start) * 48000) || offset + actual.length > reference.length) throw new Error('Invalid window PCM');
      for (let i=0;i<actual.length;i++) { const difference = actual[i]-reference[offset+i]; max=Math.max(max,Math.abs(difference)); rms += difference*difference; }
      errors.push({decoder,start,length:part.length,max,rms:Math.sqrt(rms/part.length)});
    }
    }
    globalThis.AudioDecoder = nativeDecoder;
    await context.close(); return errors;
  })()`);
  console.log('Window decode comparison', chunkDecode);
  assert.ok(chunkDecode.every(p => Number.isFinite(p.max) && Number.isFinite(p.rms) && p.max < .001), 'window decode must match independent full PCM');
  await evaluate(`(() => {
    window.nativeAudioDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = async () => { throw new Error('short-MP4 decode intentionally disabled'); };
    window.packetDecoderTimes = [];
    window.packetWorkerTerminations = 0;
    globalThis.AudioDecoder = new Proxy(AudioDecoder, {construct() { throw new Error('packet decoding must run in the worker'); }});
    globalThis.Worker = new Proxy(Worker, {construct(target,args) {
      const worker = new target(...args), post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
      const pending = new Map();
      worker.postMessage = (...args) => {
        const record = {start:performance.now(),end:null}; window.packetDecoderTimes.push(record); pending.set(args[0].id,record);
        return post(...args);
      };
      worker.addEventListener('message',e=>{const record=pending.get(e.data.id);if(record){record.end=performance.now();pending.delete(e.data.id);}});
      worker.terminate = () => { window.packetWorkerTerminations++; return terminate(); };
      return worker;
    }});
  })()`);
  assert.equal(await evaluate(`document.querySelectorAll('polygon').length`), 32);
  assert.equal(await evaluate(`document.querySelectorAll('polygon')[0].getAttribute('points').length > 100`), true);
  for (const [width, height] of [[320, 640], [360, 740], [740, 360], [1280, 800]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${width} overflow ${await evaluate('JSON.stringify({inner:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,sections:Array.from(document.querySelectorAll("section")).map(e=>[e.className,e.clientWidth,e.scrollWidth,getComputedStyle(e).overflowX])})')}: ${await evaluate("JSON.stringify(Array.from(document.querySelectorAll('*')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width,e.getBoundingClientRect().right]))")}`);
  }
  // CDP mouse input is a trusted user gesture; autoplay policy stays enabled.
  await evaluate(`(async () => {
    const { AudioEngine } = await import('/src/audio/engine.ts');
    const play = AudioEngine.prototype.play;
    window.transportPlayCalls = 0;
    AudioEngine.prototype.play = function(...args) { window.transportPlayCalls++; window.transportPlay = play.apply(this,args); return window.transportPlay; };
    window.transportSourceStarts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.transportSourceStarts++; return start.apply(this,args); };
  })()`);
  await deferMedia();
  await clickPlayback('Воспроизвести');
  await waitForPendingPlayback(0);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .2`));
  await deferMedia();
  await evaluate(`(() => {
    const slider = document.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '4');
    slider.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitForPendingPlayback(4);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > 4.1`));
  console.log('PASS transport loading: delayed first Play and seek resume expose Pause while busy; one requested playback starts after loading.');
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
  await poll(() => evaluate('window.packetWorkerTerminations > 0'));
  await poll(() => evaluate(`document.body.textContent.includes('Аудио недоступно')`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Пауза"]') === null`), true);
  assert.ok(requests.filter(r => r.url.includes('/media/') || r.url.includes('/peaks')).every(r => !r.cookie));
  const rendered = await evaluate(`(async () => {
    const {AudioEngine} = await import('/src/audio/engine.ts');
    const results = [], defaults = {volume:100,solo:false,muted:false};
    for (const [one,two] of [[{},{}],[{solo:true},{}],[{muted:true},{}],[{volume:50},{}]]) {
      const context = new OfflineAudioContext(1, 48000, 48000);
      // Offline contexts have no resume-before-render API; only that gesture adapter is replaced.
      context.resume = async () => {};
      const engine = new AudioEngine(context, 1);
      for (const [id,value] of [['one',.25],['two',.125]]) {
        const buffer = context.createBuffer(1, 48000, 48000);
        buffer.getChannelData(0).fill(value);
        engine.streams.set(id, {duration:1, async load() { return buffer; }});
      }
      await engine.play({one:{...defaults,...one},two:{...defaults,...two}});
      const output = await context.startRendering(); const data = output.getChannelData(0);
      engine.pause();
      results.push({before:data[4799],first:data[4800],middle:data[10000]});
    }
    return results;
  })()`);
  assert.deepEqual(rendered, [.375,.25,.125,.25].map(value => ({before:0,first:value,middle:value})), 'streamed voices, Solo, Mute and gain affect actual PCM');
  // PCM assertions are independent of the cursor and highlight DOM.
  const loopPCM = await evaluate(`(async () => {
    const {AudioEngine} = await import('/src/audio/engine.ts');
    const context = new OfflineAudioContext(1, 96000, 48000);
    context.resume = async () => {};
    const engine = new AudioEngine(context, 8);
    let loads = 0;
    engine.streams.set('one', {duration:8, async load(start,end) {
      loads++;
      const buffer = context.createBuffer(1, Math.round((end-start)*48000), 48000);
      const pcm = buffer.getChannelData(0);
      for (let i=0;i<pcm.length;i++) pcm[i] = start+i/48000 < 1.125 ? .25 : -.25;
      return buffer;
    }});
    await engine.setLoop({start:.75,end:1.5});
    await engine.play({one:{volume:100,solo:false,muted:false}});
    // Drain the initial scheduling horizon before starting accelerated offline rendering.
    await new Promise(resolve=>setTimeout(resolve,50));
    const output = (await context.startRendering()).getChannelData(0);
    engine.pause();
    let max = 0;
    for (let i=4800;i<output.length;i++) {
      const expected = (i-4800)%36000 < 18000 ? .25 : -.25;
      max = Math.max(max, Math.abs(output[i]-expected));
    }
    const clicks = [];
    for (const enabled of [false,true]) {
      const ctx = new OfflineAudioContext(1, 24000, 48000); ctx.resume = async () => {};
      const player = new AudioEngine(ctx, 1);
      player.buffers.set('silent', ctx.createBuffer(1,48000,48000));
      player.setMetronome(enabled,120,3,8);
      await player.play({silent:{volume:100,solo:false,muted:false}});
      const data = (await ctx.startRendering()).getChannelData(0);
      player.pause();
      clicks.push({before:Math.max(...data.slice(0,1920)), peak:Math.max(...data.slice(1920,3360))});
    }
    return {max, loads, clicks};
  })()`);
  assert.equal(loopPCM.max, 0, 'actual PCM repeats both halves without silence, overlap or sound outside the range');
  assert.equal(loopPCM.loads, 1, 'short loop reuses one decoded window');
  assert.equal(loopPCM.clicks[0].peak, 0, 'disabled metronome is silent');
  assert.equal(loopPCM.clicks[1].before, 0, 'metronome waits for the audio epoch');
  assert.ok(loopPCM.clicks[1].peak > .1, 'enabled metronome produces real audio');

  async function setLoopField(name, value) {
    await evaluate(`(() => { const input=document.querySelector('[name="${name}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  await evaluate(`Array.from(document.querySelectorAll('summary')).find(e => e.textContent === 'Ввести номера').click()`);
  await setLoopField('loopStart', 2); await setLoopField('loopEnd', 3);
  await clickPlayback('Повтор фрагмента');
  await poll(() => evaluate(`document.querySelector('[aria-label="Повтор фрагмента"]').getAttribute('aria-pressed')==='true'`));
  const highlight = await evaluate(`(() => {const el=document.querySelector('[class*="loopRegion"]'),parent=el.parentElement;return {left:parseFloat(getComputedStyle(el).left)/parent.clientWidth,width:el.clientWidth/parent.clientWidth};})()`);
  assert.ok(Math.abs(highlight.left-.09375)<.002 && Math.abs(highlight.width-.1875)<.004, 'highlight uses 120 BPM 3/8 and actual 8-second duration');
  for (const [width,height] of [[320,640],[360,740],[740,360],[1280,800]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800});
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[name="loopStart"],[name="loopEnd"]')).every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44&&r.right<=innerWidth;})`),true);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:true});
  const touch = await evaluate(`(() => { const r=document.querySelector('[name="loopStart"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch]});
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await evaluate('document.activeElement.name'),'loopStart');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
  assert.equal(await evaluate(`document.querySelector('[name="loopStart"]').value`),'3');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await send('Input.insertText',{text:'12'});
  assert.equal(await evaluate(`document.querySelector('[name="loopStart"]').value`),'12');
  await poll(() => evaluate(`document.querySelector('[aria-label="Повтор фрагмента"]').disabled`));
  assert.equal(await evaluate(`document.querySelector('[class*="loopRegion"]')===null`),true);
  await setLoopField('loopStart', 2);
  await clickPlayback('Метроном');
  await clickPlayback('Воспроизвести');
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]')!==null`));
  const positions=[];
  for(let i=0;i<12;i++) {await sleep(150);positions.push(await evaluate(`Number(document.querySelector('input[type=range]').value)`));}
  assert.ok(positions.every(p=>p>=.75&&p<2.25));
  assert.ok(positions.some((p,i)=>i>0&&p<positions[i-1]),'cursor crosses loop boundary');
  // Gate the real decoder after entry: Pause must cancel the new range's pending start.
  await evaluate(`(async () => {
    const {MP4Reader} = await import('/src/audio/mp4.ts');
    const decode = MP4Reader.prototype.decode;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.deferredDecodes = 0;
    window.finishedDecodes = 0;
    window.releaseDecode = () => { MP4Reader.prototype.decode = decode; release(); };
    MP4Reader.prototype.decode = async function(...args) {
      window.deferredDecodes++;
      await gate;
      try { return await decode.apply(this, args); }
      finally { window.finishedDecodes++; }
    };
  })()`);
  await setLoopField('loopEnd', 4); await setLoopField('loopStart', 4);
  await poll(() => evaluate(`window.deferredDecodes > 0 && document.querySelector('[aria-label="Пауза"]')?.getAttribute('aria-busy') === 'true'`));
  const startsBeforeCancel = await evaluate('window.transportSourceStarts');
  await clickPlayback('Пауза');
  await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]')?.disabled === false`));
  const cancelledPosition = await evaluate(`Number(document.querySelector('input[type=range]').value)`);
  await evaluate('window.releaseDecode()');
  await poll(() => evaluate('window.finishedDecodes === window.deferredDecodes'));
  await evaluate('window.transportPlay');
  await sleep(250);
  assert.equal(await evaluate('window.transportSourceStarts'), startsBeforeCancel, 'late range decode must not start any audio after Pause');
  assert.equal(await evaluate(`Number(document.querySelector('input[type=range]').value)`), cancelledPosition, 'cancelled cursor stays paused');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').getAttribute('aria-busy')`), 'false');
  console.log('PASS pending live loop change: enabled Pause cancels delayed decode without late sound or cursor movement.');
  await clickPlayback('Воспроизвести');
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]')!==null && Number(document.querySelector('input[type=range]').value)>=2.25`));
  await clickPlayback('Пауза');
  await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]')!==null`));
  await clickPlayback('Вернуться к началу');
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value)===2.25`));
  await clickPlayback('Воспроизвести');
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]')!==null`));
  await clickPlayback('Пауза'); await clickPlayback('Метроном'); await clickPlayback('Повтор фрагмента');
  assert.equal(await evaluate(`document.querySelector('[role=alert]')===null`),true);
  await send('Page.captureScreenshot',{format:'png'}).then(async result=>writeFile('/tmp/choral-issue12-360.png',Buffer.from(result.data,'base64')));
  console.log('PASS loop/metronome: actual PCM wrap and audible click; touch-size inputs, keyboard, validation, exact highlight, live range change, restart/resume; 320/360/landscape/desktop.');
  await evaluate(`history.pushState(null,'','?song=meter-32-fixture');window.dispatchEvent(new PopStateEvent('popstate'));`);
  await poll(()=>evaluate(`document.querySelector('h1') && document.body.textContent.includes('300 BPM')`));
  await clickPlayback('Метроном');
  for (const [width,height] of [[320,640],[360,740],[740,360]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'32 beat indicators wrap inside the page');
  }
  await evaluate(`(() => {
    window.windowStarts = []; window.activePCM = 0; window.peakPCM = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      window.windowStarts.push({at:args[0], duration:this.buffer.duration, length:this.buffer.length});
      const bytes=this.buffer.length*4;window.activePCM+=bytes;window.peakPCM=Math.max(window.peakPCM,window.activePCM);
      this.addEventListener('ended',()=>{window.activePCM-=bytes;},{once:true});
      return start.apply(this,args);
    };
    history.pushState(null, '', '?song=long-fixture'); window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  await poll(() => evaluate(`document.querySelectorAll('small[role=status]').length === 32 && Array.from(document.querySelectorAll('small[role=status]')).every(e=>e.textContent.startsWith('Готово'))`));
  for (const [width,height] of [[320,640],[360,740],[740,360],[1280,800]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800});
    await evaluate('new Promise(r=>requestAnimationFrame(r))');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'long song page overflow');
  }
  // React StrictMode actually replays updater functions in this runtime.
  for (let i = 0; i < 32; i++) await evaluate(`document.querySelector('[aria-label="Solo: Voice ${i}"]').click()`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[aria-label^="Solo:"]')).every(e=>e.getAttribute('aria-pressed')==='false')`), true);
  await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').click()`);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .3`));
  const continuousSeconds = Number(process.env.CHORAL_AUDIO_SECONDS ?? 12.5);
  for (let elapsed=0; elapsed<continuousSeconds;) {
    const step = Math.min(30,continuousSeconds-elapsed); await sleep(step*1000); elapsed+=step;
    const playing = await evaluate(`document.querySelector('[aria-label="Пауза"]') !== null`);
    if (!playing) console.log('Continuous playback failure state:', await evaluate(`JSON.stringify({
      errors:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent),
      position:document.querySelector('input[type=range]').value, starts:window.windowStarts.length,closed:window.closedAudioContexts,
      decoders:window.packetDecoderTimes.slice(-96).map(t=>t.end===null?{pending:performance.now()-t.start}:{ms:t.end-t.start})
    })`));
    assert.equal(playing,true,'continuous playback must not underrun');
    console.log(`Continuous 32-track playback: ${elapsed}s, peak scheduled PCM ${await evaluate('window.peakPCM')} bytes`);
  }
  assert.ok(await evaluate('window.peakPCM < 90*1024*1024'), 'bounded PCM independent of recording length');
  const starts = await evaluate('window.windowStarts');
  assert.ok(starts.length >= 128, '32 tracks scheduled across at least four windows');
  for (let i=0; i<starts.length; i+=32) {
    assert.equal(starts.slice(i,i+32).length,32);
    assert.ok(starts.slice(i,i+32).every(s=>s.at===starts[i].at && s.duration<=4));
    if(i) assert.ok(Math.abs(starts[i].at-starts[i-32].at-4)<1e-8, 'no cumulative timing error');
  }
  for (const offset of [600.123,1196,3.5,1198]) {
    await evaluate(`document.querySelector('[aria-label="Пауза"]').click()`);
    await evaluate(`(() => { const s=document.querySelector('input[type=range]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'${offset}');s.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await poll(() => evaluate(`Math.abs(Number(document.querySelector('input[type=range]').value)-${offset})<.02`));
    await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').click()`);
    await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > ${offset+.1}`));
  }
  await evaluate(`document.querySelector('[aria-label="Пауза"]').click()`);
  const longRequests = requests.filter(r=>r.url.startsWith('/api/v1/long/'));
  assert.equal(new Set(longRequests.map(r=>r.url)).size,32);
  assert.ok(longRequests.every(r=>!r.cookie), 'public streaming requests omit an existing cookie');
  assert.ok(longRequests.every(r=>r.range), 'no full recording download');
  const largestRange = Math.max(...longRequests.map(r=> {const [,a,b]=/bytes=(\d+)-(\d+)/.exec(r.range);return Number(b)-Number(a)+1;}));
  assert.ok(largestRange < 1024*1024, 'bounded requests for 20 minute tracks');
  await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]') !== null`));
  await evaluate(`document.querySelector('[aria-label="Solo: Voice 0"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Solo: Voice 0"]').getAttribute('aria-pressed')`), 'true');
  changedTrack = true;
  await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').click()`);
  await poll(() => evaluate(`document.body.textContent.includes('Аудиофайл изменился')`));
  await poll(() => evaluate(`document.querySelector('[aria-label="Solo: Voice 0"]').getAttribute('aria-pressed') === 'false'`));
  await poll(() => evaluate(`document.querySelector('[aria-label="Пауза"]') !== null`));
  assert.equal(await evaluate(`document.querySelector('[role="alert"]') === null`), true, 'one failed stream must not stop healthy output');
  await evaluate(`document.querySelector('[aria-label="Пауза"]').click()`);
  await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]') !== null`));
  await evaluate(`(() => {
    const slider = document.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0');
    slider.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) === 0`));
  await clickPlayback('Воспроизвести');
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .3`));
  revokeMedia = true; // Fail the next background windows, after real audio has started.
  await poll(() => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('Воспроизведение остановлено')`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Пауза"]') === null`),true);
  await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]')?.disabled === false`));
  const failedPosition = await evaluate(`Number(document.querySelector('input[type=range]').value)`);
  const failedStarts = await evaluate('window.windowStarts.length');
  assert.ok(failedPosition > 0 && failedPosition < 12, 'stop near the buffered audio, not the end of the song');
  await sleep(300);
  assert.equal(await evaluate(`Number(document.querySelector('input[type=range]').value)`), failedPosition);
  assert.equal(await evaluate('window.windowStarts.length'), failedStarts, 'no new audio scheduled after losing every stream');
  console.log('PASS background failures: one failed stream leaves others playing; losing all remaining streams stops sound and cursor, reports an error and restores Play.');
  console.log(`PASS long media: 32 real 20-minute AAC tracks, bounded Range windows, ${continuousSeconds} seconds continuous clock scheduling, repeated seeks/resume including end of recording; StrictMode all-solo reset. Largest Range: ${largestRange}`);
  console.log('PASS Chrome: real AAC-LC decode/play, sample-exact OfflineAudioContext mix, 32 channels with individual 404, peaks, gesture, clock cursor/pause, Solo, 320/360/landscape/desktop overflow.');
  // Device construction failure must finish loading and allow an explicit retry.
  revokeMedia = false; changedTrack = false;
  await evaluate(`(() => {
    window.nativeAudioContext = AudioContext;
    window.audioConstructionAttempts = 0;
    window.failAudioConstruction = true;
    globalThis.AudioContext = new Proxy(AudioContext, {construct(target,args,newTarget) {
      window.audioConstructionAttempts++;
      if (window.failAudioConstruction) throw new Error('synthetic device unavailable');
      return Reflect.construct(target,args,newTarget);
    }});
    history.pushState(null, '', '?song=device-retry-fixture'); window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  await poll(() => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('не смог открыть аудиоустройство')`));
  await poll(() => evaluate(`document.querySelector('[aria-label="Повторить подключение аудио"]')?.disabled === false`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Повторить подключение аудио"]').getAttribute('aria-busy')`), 'false');
  assert.equal(await evaluate(`document.body.textContent.includes('Загрузка аудио…')`), false);
  assert.equal(await evaluate(`document.querySelectorAll('small[role=status]').length`), 1);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('small[role=status]')).every(e=>e.textContent==='Аудиоустройство недоступно')`), true);
  const firstAttempts = await evaluate('window.audioConstructionAttempts');
  await clickPlayback('Повторить подключение аудио');
  await poll(() => evaluate(`window.audioConstructionAttempts > ${firstAttempts} && document.querySelector('[aria-label="Повторить подключение аудио"]')?.disabled === false`));
  const failedAttempts = await evaluate('window.audioConstructionAttempts');
  await sleep(200);
  assert.equal(await evaluate('window.audioConstructionAttempts'), failedAttempts, 'persistent failure must not auto-retry or keep loading');
  await evaluate(`(() => {
    window.failAudioConstruction = false;
    const fetch = window.fetch;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.deferredPeakRequests = 0;
    window.releasePeakRequests = () => { window.fetch = fetch; release(); };
    window.fetch = async (...args) => {
      if (args[0] === '/api/v1/peaks') { window.deferredPeakRequests++; await gate; }
      return fetch(...args);
    };
  })()`);
  const beforeRecoveryStarts = await evaluate('window.transportSourceStarts');
  await clickPlayback('Повторить подключение аудио');
  await poll(() => evaluate(`window.deferredPeakRequests > 0 && document.querySelector('small[role=status]')?.textContent.startsWith('Готово') && document.querySelector('[aria-label="Воспроизвести"]')?.disabled === false`));
  assert.equal(await evaluate(`document.querySelector('[role="alert"]') === null`), true);
  assert.equal(await evaluate('window.transportSourceStarts'), beforeRecoveryStarts, 'retry prepares audio without autoplay');
  await clickPlayback('Воспроизвести');
  await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .2`));
  await clickPlayback('Пауза');
  await evaluate('window.releasePeakRequests()');
  await evaluate('globalThis.AudioContext = window.nativeAudioContext');
  console.log('PASS device initialization: throwing AudioContext ends busy states, repeated failure leaves Retry available, recovery reloads real media without autoplay; explicit Play works while the last peaks response is pending.');
  // Exercise the diagnostic UI with a deliberately shortened real decode result.
  // This models the failure shape; it is not a physical Safari compatibility test.
  revokeMedia = false; changedTrack = false;
  await evaluate(`(() => {
    globalThis.AudioDecoder = undefined;
    const decode = window.nativeAudioDecode;
    AudioContext.prototype.decodeAudioData = async function(...args) {
      const pcm = await decode.apply(this, args);
      const shortened = this.createBuffer(pcm.numberOfChannels, pcm.length - 4096, pcm.sampleRate);
      shortened.copyToChannel(pcm.getChannelData(0).subarray(0, shortened.length), 0);
      return shortened;
    };
    history.pushState(null, '', '?song=decoder-diagnostic'); window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  await poll(() => evaluate(`Array.from(document.querySelectorAll('small[role=status]')).filter(e=>e.textContent.startsWith('Готово')).length === 31 && !document.querySelector('[aria-label="Воспроизвести"]').disabled`));
  await evaluate(`document.querySelector('[aria-label="Воспроизвести"]').click()`);
  try {
    await poll(() => evaluate(`(() => {
      const details = Array.from(document.querySelectorAll('details')).find(e=>e.querySelector('summary')?.textContent==='Диагностика воспроизведения');
      return details && JSON.parse(details.querySelector('pre').textContent).length === 31;
    })()`));
  } catch (error) {
    console.log('Decoder diagnostic failure state:', await evaluate('document.body.innerText'));
    throw error;
  }
  const diagnostic = await evaluate(`(() => {
    const details = Array.from(document.querySelectorAll('details')).find(e=>e.querySelector('summary')?.textContent==='Диагностика воспроизведения');
    details.open = true; return JSON.parse(details.querySelector('pre').textContent);
  })()`);
  assert.equal(diagnostic.length, 31);
  assert.equal(diagnostic[0].code, 'AAC_SHORT_PCM');
  assert.equal(diagnostic[0].readerVersion, 2);
  assert.equal(diagnostic[0].decoder, 'decodeAudioData');
  assert.equal(diagnostic[0].decodedRate, 48000);
  assert.ok(diagnostic[0].decodedSamples < diagnostic[0].offset + diagnostic[0].requiredSamples);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  console.log('PASS dev-only decoder diagnostics: actual rate/length/offset reported after an intentionally shortened decode.');
  if (process.env.CHORAL_STORYBOOK_URL) {
    await send('Page.addScriptToEvaluateOnNewDocument', {source: `
      window.storyResults = [];
      const timer = setInterval(() => {
        const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
        if (!channel) return;
        clearInterval(timer);
        for (const event of ['storyFinished','storyErrored','storyThrewException','playFunctionThrewException']) {
          channel.on(event, result => window.storyResults.push({event,result}));
        }
      }, 1);
    `});
    for (const story of ['default','single-bar','full-song-loop','short-song','sixteen-bars']) {
      await send('Page.navigate', {url: process.env.CHORAL_STORYBOOK_URL + '/iframe.html?id=layouts-rehearsal-player--' + story + '&viewMode=story'});
      await poll(() => evaluate(`location.search.includes('id=layouts-rehearsal-player--${story}&') && window.storyResults?.length>0`));
      const results = await evaluate('window.storyResults');
      assert.ok(results.some(r=>r.event==='storyFinished' && r.result.storyId==='layouts-rehearsal-player--'+story), JSON.stringify(results));
      assert.ok(results.every(r=>r.event==='storyFinished' && r.result.status==='success'), JSON.stringify(results));
      console.log('PASS Storybook play:',story);
    }
  }

} finally { ws?.close(); for (const child of children) child.kill('SIGTERM'); server.closeAllConnections(); server.close(); await sleep(300); await rm(dir, { recursive: true, force: true }); }
