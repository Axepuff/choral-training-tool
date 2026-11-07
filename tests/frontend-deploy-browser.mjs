import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic release fixture on an isolated Go service. Keep one tab open across
// publish/rollback and force old asset requests to reach the server, not cache.
const [fixturePath] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const profile = await mkdtemp(join(tmpdir(), 'choral-frontend-browser-'));
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let ws, sequence = 0, launchError;
chrome.on('error', error => { launchError = error; });
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error('Browser smoke timeout');
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.ok(!result.exceptionDetails, 'Browser evaluation failed');
  return result.result.value;
}
try {
  let port;
  await poll(async () => {
    if (launchError) throw launchError;
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return !!port; }
    catch { return false; }
  });
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  };
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: fixture.origin + '/listen/deep' });
  await poll(() => evaluate('window.release === "one"'));
  const oldAsset = await evaluate('document.querySelector("script").getAttribute("src")');
  execFileSync('python3', [fixture.helper, 'publish', fixture.archive,
    '--root', fixture.root, '--sha256', fixture.sha256,
    '--approved-commit', fixture.commit, '--backend-api', 'choral-api-v1']);
  assert.equal(await evaluate('window.release'), 'one', 'Open tab unexpectedly reloaded');
  assert.match(await evaluate(`fetch(${JSON.stringify(oldAsset)}, {cache:'reload'}).then(r => { if(!r.ok) throw Error('old asset missing'); return r.text(); })`), /one/);
  assert.equal(await evaluate('fetch("/api/v1/auth/me").then(r => r.status)'), 401);
  assert.match(await evaluate('fetch("/",{cache:"reload"}).then(r=>r.text())'), new RegExp(fixture.newAsset));
  execFileSync('python3', [fixture.helper, 'rollback', '--root', fixture.root,
    '--to', fixture.previous, '--backend-api', 'choral-api-v1']);
  assert.equal(await evaluate('window.release'), 'one');
  assert.equal(await evaluate(`fetch(${JSON.stringify('/' + fixture.newAsset)}).then(r=>r.status)`), 200);
  await send('Page.reload', { ignoreCache: true });
  await poll(() => evaluate('window.release === "one"'));
  console.log('PASS: one real Chrome tab across publish/rollback, old/new assets without cache, deep link, API, reload');
} finally {
  ws?.close();
  for (const item of pending.values()) clearTimeout(item.timer);
  chrome.kill();
  await new Promise(resolve => { chrome.once('exit', resolve); if (chrome.exitCode !== null) resolve(); });
  // Chrome helper processes can finish profile writes after the main process exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
