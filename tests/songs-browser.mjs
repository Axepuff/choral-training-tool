import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'choral-browser-'));
const processes = [];
const origin = process.env.CHORAL_TEST_WEB ?? 'http://127.0.0.1:5179';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'ignore'] });
  processes.push(p); return p;
}
async function poll(check, message, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch { /* wait until ready */ } await delay(100); }
  throw new Error(message);
}
let ws;
let next = 0;
let acceptDialog = false;
let dialogs = 0;
let failOneJob = false;
let failedJobs = 0;
const pending = new Map();
const loadedDocuments = new Set();
const uploadKeys = [];
function send(method, params = {}) {
  const id = ++next;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed');
  return result.result.value;
}
async function navigate(query) {
  const navigation = await send('Page.navigate', { url: `${origin}/${query}` });
  assert.ok(!navigation.errorText, 'Browser navigation failed');
  await poll(() => loadedDocuments.has(navigation.loaderId), 'Document did not load');
  await poll(() => evaluate('document.readyState === "complete" && !!document.getElementById("root")?.textContent'), 'App did not render');
}
const bodyIncludes = (text) => evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`);
async function expectText(text) { await poll(() => bodyIncludes(text), `Missing expected UI: ${text}`); }
async function submit(email, password) {
  await evaluate(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [name, value] of Object.entries(${JSON.stringify({ email, password })})) {
      const input = document.querySelector('input[name="' + name + '"]'); set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('form').requestSubmit();
  })()`);
}
async function click(text) {
  await poll(() => evaluate(`!!Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)} && !b.disabled)`), `Button unavailable: ${text}`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`);
}

async function input(name, value, textarea = false) {
 await evaluate(`(() => { const el = document.querySelector('[name="${name}"]'); Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
}
async function api(path, method = 'GET', body, headers = {}) {
 return evaluate(`(async () => { const me = await (await fetch('/api/v1/auth/me')).json(); const response = await fetch('/api/v1' + ${JSON.stringify(path)}, {method:${JSON.stringify(method)}, headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken,...${JSON.stringify(headers)}}, ${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`} }); return {status:response.status, body:response.status===204?null:await response.json()}; })()`);
}
async function save() { await poll(() => evaluate(`document.querySelector('fieldset')?.disabled === false`), 'Editor busy before save'); await evaluate(`(async () => { document.querySelector('form').requestSubmit(); await new Promise(requestAnimationFrame); })()`); }
async function selectFile(path, index = 0) {
 await poll(() => evaluate(`document.querySelector('fieldset')?.disabled === false`), 'Editor busy before file selection');
 // A real browser File with deterministic fixture bytes. CDP's filesystem
 // chooser can omit change for long Unicode paths in this Linux environment.
 const bytes = (await readFile(path)).toString('base64');
 const name = path.split('/').at(-1);
 await evaluate(`(async () => {
   const input = document.querySelector('[name="tracks[${index}].file"]');
   const transfer = new DataTransfer();
   transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}), char => char.charCodeAt(0))], ${JSON.stringify(name)}, {type:'audio/wav'}));
   input.files = transfer.files;
   input.dispatchEvent(new Event('change', {bubbles:true}));
   await new Promise(requestAnimationFrame);
 })()`);
 await expectText(name);
}

try {
 await poll(async () => (await fetch(origin)).ok,'Go frontend did not start');
 start(process.env.CHROME_BIN ?? '/usr/bin/google-chrome',['--headless','--disable-features=BackForwardCache','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${dir}`,'about:blank']);
 let port; await poll(async () => { port=(await readFile(join(dir,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port; },'Chrome did not start');
 const targets=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=message=>{const data=JSON.parse(message.data);if(data.method==='Page.lifecycleEvent' && data.params.name==='load') loadedDocuments.add(data.params.loaderId);if(data.method==='Network.requestWillBeSent' && data.params.request.url.endsWith('/uploads')){uploadKeys.push(data.params.request.headers['Idempotency-Key']);}if(data.method==='Fetch.requestPaused'){
   if(failOneJob && data.params.request.url.includes('/jobs/')){failOneJob=false;failedJobs++;void send('Fetch.failRequest',{requestId:data.params.requestId,errorReason:'ConnectionReset'});}
   else if(data.params.request.url.includes('/jobs/')) void send('Fetch.continueRequest',{requestId:data.params.requestId});
   else void send('Fetch.failRequest',{requestId:data.params.requestId,errorReason:'ConnectionReset'});
  }if(data.method==='Page.javascriptDialogOpening'){dialogs++;void send('Page.handleJavaScriptDialog',{accept:data.params.type==='beforeunload' || acceptDialog});}const entry=pending.get(data.id);if(entry){pending.delete(data.id);if(data.error)entry.reject(new Error(data.error.message));else entry.resolve(data.result);}};
 await send('Page.enable');await send('Page.setLifecycleEventsEnabled',{enabled:true});await send('Runtime.enable');await send('Network.enable');
 await navigate('?page=create-song');await expectText('Вход');
 await submit('teacher@example.test','fictional password 123');await expectText('Новая песня');
 await input('title','Реальная песня');await input('notes','Заметка 🌼',true);
 await evaluate(`(() => {const s=document.querySelector('[name=trackCount]');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 // Real PCM WAV input created outside Git; actual probe and worker process it.
 const wav=Buffer.alloc(44+48000*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<48000;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*8000),44+i*2);
 const file=join(dir,'synthetic.wav');await writeFile(file,wav);
 // Draft metadata commits before any selected audio is uploaded.
 // Lose the response AFTER the real server commits the draft, then edit the form.
 await selectFile(file);
 await send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/songs',requestStage:'Response'}]});
 await save();await expectText('Нет соединения с сервером');
 await send('Fetch.disable');
 const uncertain=await api('/songs');assert.equal(uncertain.body.items.length,1);
 assert.equal(uncertain.body.items[0].title,'Реальная песня');
 await input('title','Восстановленная песня');await input('notes','Изменено после потери ответа',true);
 await input('tracks[0].name','Новая партия');assert.equal(await bodyIncludes('synthetic.wav'),true);
 await save();await expectText('Изменения сохранены на сервере.');await expectText('Аудио готово.');
 const recovered=(await api('/songs/'+uncertain.body.items[0].id)).body;
 assert.equal(recovered.title,'Восстановленная песня');assert.equal(recovered.notes,'Изменено после потери ответа');
 assert.equal(recovered.tracks[0].sourceName,'synthetic.wav');assert.equal(recovered.tracks[0].name,'Новая партия');assert.equal(recovered.ready,true);
 assert.equal(await bodyIncludes('Нет соединения с сервером'),false);
 await input('title','Реальная песня');await input('notes','Заметка 🌼',true);
 await save();await expectText('Изменения сохранены на сервере.');
 const listing=await api('/songs');assert.equal(listing.status,200);assert.equal(listing.body.items.length,1);
 const id=listing.body.items[0].id;assert.equal(id,uncertain.body.items[0].id,'Recovery must reuse the committed draft');
 await navigate(await evaluate('location.search'));await expectText('Редактировать песню');assert.equal(await evaluate('location.search'),'?page=edit-song&id='+id);
 assert.equal(await evaluate(`document.querySelector('[name=notes]').value`),'Заметка 🌼');await expectText('synthetic.wav');
 assert.equal(await evaluate(`!!document.querySelector('form button') && [...document.querySelectorAll('button')].filter(b=>b.textContent==='Слушать песню' || b.textContent==='Опубликовать сохранённую песню').every(b=>!!b.closest('form'))`),true);
 await selectFile(file);await expectText('synthetic.wav');await save();await expectText('Изменения сохранены на сервере.');await expectText('Аудио готово.');
 let song=(await api('/songs/'+id)).body;assert.equal(song.ready,true);let media=song.tracks[0].mediaUrl;
 assert.equal((await api('/songs/'+id)).body.notes,'Заметка 🌼');
 // Confirmed probe_timeout must allow saving the SAME selected File again.
 await writeFile(process.env.CHORAL_TEST_PROBE_MARKER, 'armed');
 await selectFile(file);await save();await expectText('Проверка превысила 15 секунд');
 assert.equal((await api('/songs/'+id)).body.tracks[0].mediaUrl,media);
 assert.equal(await bodyIncludes('Изменения сохранены на сервере.'),false);
 const timeoutKey=uploadKeys.at(-1);assert.ok(timeoutKey);
 await save();await expectText('Изменения сохранены на сервере.');await expectText('Аудио готово.');
 assert.notEqual(uploadKeys.at(-1),timeoutKey,'Final probe rejection must get a new idempotency key');
 media=(await api('/songs/'+id)).body.tracks[0].mediaUrl;
 // A transport failure has an unknown outcome: retry keeps the same key.
 await send('Fetch.enable',{patterns:[{urlPattern:'*/uploads',requestStage:'Request'}]});
 await selectFile(file);await save();await expectText('Загрузка не подтверждена');
 const networkKey=uploadKeys.at(-1);assert.ok(networkKey);
 await send('Fetch.disable');
 await save();await expectText('Изменения сохранены на сервере.');
 assert.equal(uploadKeys.at(-1),networkKey,'Unknown network outcome must retain the idempotency key');
 media=(await api('/songs/'+id)).body.tracks[0].mediaUrl;
 // Accepted upload, one failed status request, then real background recovery.
 failOneJob=true;await send('Fetch.enable',{patterns:[{urlPattern:'*/api/v1/jobs/*',requestStage:'Request'}]});
 await selectFile(file);await save();await expectText('Нет соединения с сервером');
 await poll(()=>evaluate(`!document.querySelector('fieldset').disabled && [...document.querySelectorAll('form [role=status]')].some(e=>e.textContent==='Готово')`),'Background job did not replace the stale row error');
 assert.equal(failedJobs,1);await send('Fetch.disable');
 media=(await api('/songs/'+id)).body.tracks[0].mediaUrl;
 // Reload after background recovery to use the committed editor/file inputs.
 await navigate('?page=edit-song&id='+id);await expectText('Редактировать песню');await expectText('synthetic.wav');
 // Replace with invalid bytes: old media survives, no success UI.
 const replacement=join(dir,'Длинное-имя-'.repeat(9)+'.wav');await writeFile(replacement,wav);await selectFile(replacement);await save();await expectText('Изменения сохранены на сервере.');
 await poll(async () => (await api('/songs/'+id)).body.tracks[0].sourceName === 'Длинное-имя-'.repeat(9)+'.wav', 'Replacement did not finish');
 media=(await api('/songs/'+id)).body.tracks[0].mediaUrl;
 assert.equal((await api('/songs/'+id)).body.tracks[0].sourceName,'Длинное-имя-'.repeat(9)+'.wav');
 const bad=join(dir,'invalid.wav');await writeFile(bad,'not audio');await selectFile(bad);await save();await expectText('Файл повреждён');
 assert.equal((await api('/songs/'+id)).body.tracks[0].sourceName,'Длинное-имя-'.repeat(9)+'.wav');
 assert.equal(await bodyIncludes('Изменения сохранены на сервере.'),false);
 assert.equal((await api('/songs/'+id)).body.tracks[0].mediaUrl,media);
 await selectFile(file);await save();await expectText('Изменения сохранены на сервере.');
 // Concurrent edit causes conflict and preserves typed text; explicit retry succeeds.
 await input('title','Мои изменения');song=(await api('/songs/'+id)).body;
 const update={title:'Чужая версия',bpm:song.bpm,beatsPerBar:song.beatsPerBar,beatUnit:song.beatUnit,notes:song.notes,publication:song.publication,tracks:song.tracks.map(t=>({id:t.id,name:t.name,position:t.position,gain:t.gain}))};
 assert.equal((await api('/songs/'+id,'PUT',update,{'If-Match':`"${song.version}"`})).status,200);
 await save();await expectText('Песня изменена на сервере');assert.equal(await evaluate(`document.querySelector('[name=title]').value`),'Мои изменения');
 await save();await expectText('Изменения сохранены на сервере.');
 await input('notes','Офлайн заметка',true);
 await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await save();await expectText('Нет соединения с сервером');
 await evaluate(`window.dispatchEvent(new Event('focus'))`);await expectText('Изменения остаются в форме.');
 assert.equal(await evaluate(`document.querySelector('[name=notes]').value`),'Офлайн заметка');
 await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await evaluate(`window.dispatchEvent(new Event('focus'))`);await poll(()=>evaluate(`!document.body.textContent.includes('Повторить проверку сессии')`),'Session did not recover');await save();await expectText('Изменения сохранены на сервере.');
 // Publication conflict refreshes concurrency metadata without dropping form edits/files.
 await input('title','Несохранённое поле публикации');await selectFile(file);
 song=(await api('/songs/'+id)).body;
 assert.equal((await api('/songs/'+id,'PUT',{...update,title:song.title,notes:song.notes},{'If-Match':`"${song.version}"`})).status,200);
 await click('Опубликовать сохранённую песню');await expectText('Песня изменена на сервере');
 assert.equal(await bodyIncludes('Публикация обновлена.'),false);
 assert.equal(await evaluate(`document.querySelector('[name=title]').value`),'Несохранённое поле публикации');
 assert.equal(await bodyIncludes('synthetic.wav'),true);
 await click('Опубликовать сохранённую песню');await expectText('Публикация обновлена.');
 assert.equal(await evaluate(`document.querySelector('[name=title]').value`),'Несохранённое поле публикации');
 assert.equal((await api('/songs/'+id)).body.publication,'published');
 assert.equal((await api('/songs/'+id)).body.title,'Мои изменения');
 // Explicit reload discards the still-unsaved form before continuing the guest flow.
 acceptDialog=true;await navigate(await evaluate('location.search'));await expectText('Редактировать песню');acceptDialog=false;dialogs=0;
 const extra=await api('/songs','POST',{title:'Аа первая',bpm:84,beatsPerBar:4,beatUnit:4,notes:'',publication:'draft',tracks:[{name:'Альт',position:0,gain:1}]},{'Idempotency-Key':crypto.randomUUID()});assert.equal(extra.status,201);
 await navigate('?page=library');await expectText('Аа первая');
 await evaluate(`(() => {const s=document.querySelector('[name=songSort]');s.value='title';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await poll(()=>evaluate(`document.querySelector('ul[aria-label="Песни"] li h2')?.textContent === 'Аа первая'`),'API title sort failed');
 await input('songSearch' ,'несуществующая');await expectText('Песня не найдена');
 await input('songSearch','Мои изменения');await expectText('Мои изменения');
 await evaluate(`document.querySelector('[aria-label="Скопировать ссылку: Мои изменения"]').click()`);await expectText('Публичные ссылки');
 await click('Создать новую ссылку');await poll(()=>evaluate(`!!document.querySelector('section[aria-label="Публичные ссылки"] a')`),'No public URL');
 const publicUrl=await evaluate(`document.querySelector('section[aria-label="Публичные ссылки"] a').href`);assert.ok(/\?song=/.test(publicUrl), 'Public song URL missing');
 await send('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});await send('Page.bringToFront');await click('Копировать');assert.ok(await evaluate('navigator.clipboard.readText()') === publicUrl, 'Clipboard must contain the generated URL');
 await click('Заменить ссылку');await poll(()=>evaluate(`!!document.querySelector('section[aria-label="Публичные ссылки"] a') && document.querySelector('section[aria-label="Публичные ссылки"] a').href !== ${JSON.stringify(publicUrl)}`),'Rotation failed');
 const rotated=await evaluate(`document.querySelector('section[aria-label="Публичные ссылки"] a').href`);
 assert.equal((await evaluate(`(async()=> (await fetch('/api/v1/public/shares/'+new URL(${JSON.stringify(publicUrl)}).searchParams.get('song'))).status)()`)),404);
 await click('Отозвать ссылку');await expectText('Ссылка отозвана');assert.equal(await evaluate(`!!document.querySelector('section[aria-label="Публичные ссылки"] a')`),false);
 assert.equal((await evaluate(`(async()=> (await fetch('/api/v1/public/shares/'+new URL(${JSON.stringify(rotated)}).searchParams.get('song'))).status)()`)),404);
 await click('Создать новую ссылку');await poll(()=>evaluate(`!!document.querySelector('section[aria-label="Публичные ссылки"] a')`),'No replacement URL');
 const guest=await evaluate(`document.querySelector('section[aria-label="Публичные ссылки"] a').search`);
 await click('Закрыть');await evaluate(`document.querySelector('[aria-label="Ссылка на список"]').click()`);await expectText('Публичные ссылки');await click('Создать новую ссылку');await poll(()=>evaluate(`!!document.querySelector('section[aria-label="Публичные ссылки"] a')`),'No list URL');
 const guestList=await evaluate(`document.querySelector('section[aria-label="Публичные ссылки"] a').search`);
 await click('Закрыть');await click('Выйти');await expectText('Вход');
 await navigate(guest);await expectText('Офлайн заметка');assert.equal(await bodyIncludes('Вход'),false);
 // The public grant cannot authorize writes or extend to another song/track ID.
 const token = new URLSearchParams(guest).get('song');
 const publicRoot = '/api/v1/public/shares/' + token;
 for (const [path, expected] of [[publicRoot, 405], ['/api/v1/songs/' + id + '?token=' + token, 401]]) {
   const status = await evaluate(`(async () => (await fetch(${JSON.stringify(path)}, {method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status)()`);
   assert.equal(status, expected, 'Anonymous public token must not authorize writes');
 }
 assert.equal(await evaluate(`(async () => (await fetch(${JSON.stringify(publicRoot + '/songs/' + extra.body.id + '/tracks/' + recovered.tracks[0].id + '/media')})).status)()`),404);
 // Decode and play the actual worker output through the guest UI and media API.
 await poll(() => evaluate(`document.querySelector('[aria-label="Воспроизвести"]')?.disabled === false`), 'Real public audio not ready');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(e => e.textContent === 'Настроить').click()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(e => e.textContent === 'Ввести номера').click()`);
 await input('loopStart', '1');await input('loopEnd', '1');
 await evaluate(`document.querySelector('[aria-label="Повтор фрагмента"]').click()`);
 const point = await evaluate(`(() => { const r=document.querySelector('[aria-label="Воспроизвести"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
 await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) > .1`), 'Public playback clock did not advance');
 await evaluate(`(async () => {document.querySelector('[aria-label="Пауза"]').click();await new Promise(requestAnimationFrame);})()`);
 await poll(() => evaluate(`!!document.querySelector('[aria-label="Воспроизвести"]')`), 'Pause did not complete');
 const paused = await evaluate(`Number(document.querySelector('input[type=range]').value)`);
 await delay(200);
 assert.equal(await evaluate(`Number(document.querySelector('input[type=range]').value)`),paused,'Paused cursor must remain stable');
 await evaluate(`(() => {const el=document.querySelector('input[type=range]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.5');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await poll(() => evaluate(`Number(document.querySelector('input[type=range]').value) === .5`),'Seek failed');
 await navigate(guestList);await expectText('Мои изменения');assert.equal(await evaluate(`!!document.querySelector('[aria-label="Создать песню"]')`),false);
 // Admin can edit all; another teacher can read published but cannot write.
 await navigate('?page=library');await expectText('Вход');await submit('admin@example.test','fictional password 123');await expectText('Администратор');await expectText('Мои изменения');
 assert.equal(await evaluate(`!!document.querySelector('[aria-label="Редактировать: Мои изменения"]')`),true);
 await click('Выйти');await expectText('Вход');await submit('outsider@example.test','fictional password 123');await expectText('Преподаватель');await expectText('Мои изменения');
 assert.equal(await evaluate(`!!document.querySelector('[aria-label="Редактировать: Мои изменения"]')`),false);
 song=(await api('/songs/'+id)).body;
 assert.equal((await api('/songs/'+id,'PUT',update,{'If-Match':`"${song.version}"`})).status,403);
 await navigate('?page=edit-song&id='+id+'&role=admin');await expectText('Мои изменения');assert.equal(await evaluate('!!document.querySelector("form")'),false);
 await navigate('?page=library');await expectText('Преподаватель');
 await click('Выйти');await expectText('Вход');await submit('teacher@example.test','fictional password 123');await expectText('Преподаватель');
 // Unicode scalar validation permits 1000 astral characters and rejects 1001.
 await navigate('?page=edit-song&id='+id);await expectText('Редактировать песню');await input('notes','🌼'.repeat(1001),true);await save();await expectText('заметки: до 1000');await input('notes','🌼'.repeat(1000),true);await save();await expectText('Изменения сохранены на сервере.');
 await selectFile(replacement);await expectText('Длинное-имя-'.repeat(9)+'.wav');
 for(const [width,height] of [[320,640],[360,800],[800,360],[1280,900]]){await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<900});assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,`Overflow ${width}`);assert.equal(await evaluate(`[...document.querySelectorAll('form button, form input:not([hidden]), form select, form textarea')].every(e=>(e.tagName==='BUTTON' || e.id && e.name) && e.getBoundingClientRect().height>=44)`),true);}
 await input('title','Несохранённое название');await click('Отмена');assert.equal(dialogs,1);assert.equal(await evaluate(`document.querySelector('[name=title]').value`),'Несохранённое название');
 acceptDialog=true;await click('Отмена');await expectText('Мои изменения');assert.equal((await api('/songs/'+id)).body.title,'Мои изменения');
 // Partial multi-file success keeps server identity/name when local selection is removed.
 await navigate('?page=create-song');await expectText('Новая песня');await input('title','Частичное сохранение');
 for(const count of [2,4]) {
   await evaluate(`(() => {const s=document.querySelector('[name=trackCount]');s.value='${count}';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await selectFile(file,count-2);await selectFile(bad,count-1);await save();await expectText('Файл повреждён');
   const partialId=await evaluate(`new URLSearchParams(location.search).get('id')`);
   const partial=(await api('/songs/'+partialId)).body;
   assert.equal(partial.tracks[count-2].sourceName,'synthetic.wav');
   await evaluate(`document.querySelector('[aria-label="Убрать файл трека ${count-1}"]').click()`);
   assert.equal(await evaluate(`document.querySelector('[name="tracks[${count-2}].name"]').closest('div').textContent.includes('synthetic.wav')`),true,'Saved source name must survive removing the local File after partial success');
   assert.equal(await evaluate(`document.querySelector('[name="tracks[${count-2}].name"]').closest('div').textContent.includes('Файл не выбран')`),false);
   await evaluate(`document.querySelector('[aria-label="Убрать файл трека ${count}"]').click()`);
   await save();await expectText('Изменения сохранены на сервере.');
 }
 console.log('Real Go/SQLite/FFmpeg + Chrome: background job recovery, partial multi-file saves for new and appended tracks, lost creation response/edit/replay without duplicate or File loss, draft, upload/ready, probe timeout/retry, network key retention, failed replacement, persistence, conflict/retry, offline, publication conflict/retry, search, share rotation/revocation, anonymous song/list, admin, Unicode and responsive checks passed.');
} finally {
 if(ws)ws.close();for(const p of processes.reverse()){p.kill('SIGTERM');await Promise.race([new Promise(resolve=>p.once('exit',resolve)),delay(2000)]);if(p.exitCode===null)p.kill('SIGKILL');}await rm(dir,{recursive:true,force:true,maxRetries:5});
}
