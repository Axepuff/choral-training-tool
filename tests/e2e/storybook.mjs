import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { serveDirectory } from './serve.mjs';

// Run the built stories in real Chrome; Storybook itself executes each play.
// No screenshots, cookies, request dumps or browser profiles are retained.
const root = resolve('storybook-static');
const server = await serveDirectory(root);
const origin = server.origin;
const profile = await mkdtemp(join(tmpdir(), 'choral-stories-'));
let chrome, ws, sequence = 0;
const pending = new Map();
const loadedDocuments = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error(`Timeout: ${label}`);
}
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  assert.ok(!result.exceptionDetails, 'Browser evaluation failed');
  return result.result.value;
}
try {
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
  const stories = Object.values(index.entries).filter(entry => entry.type === 'story');
  assert.ok(stories.length > 0, 'Empty Storybook index');
  chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError;
  chrome.on('error', error => { launchError = error; });
  let port;
  await poll(async () => {
    if (launchError) throw launchError;
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return !!port; } catch { return false; }
  }, 'Chrome startup');
  let completed = 0;
  for (const story of stories) {
    // Match normal browser-test isolation: one fresh page per case. Reusing the
    // preview document can carry an unfinished Storybook render into the next play.
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    loadedDocuments.clear();
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = message => {
      const data = JSON.parse(message.data), entry = pending.get(data.id);
      if (data.method === 'Page.lifecycleEvent' && data.params.name === 'load') loadedDocuments.add(data.params.loaderId);
      if (data.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
      if (entry) { clearTimeout(entry.timer); pending.delete(data.id); if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result); }
    };
    await send('Page.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    await send('Page.bringToFront');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.storyResults = [];
      let channel;
      Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
        configurable: true,
        get: () => channel,
        set: next => {
          channel = next;
          for (const event of ['storyFinished','storyErrored','storyThrewException','playFunctionThrewException']) {
            next.on(event, result => window.storyResults.push({event, id: result?.storyId, status: result?.status}));
          }
        }
      });
    ` });
    const navigation = await send('Page.navigate', { url: `${origin}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story` });
    assert.ok(!navigation.errorText, `Navigation failed: ${story.id}`);
    await poll(() => loadedDocuments.has(navigation.loaderId), `Document load: ${story.id}`);
    await poll(() => evaluate(`new URLSearchParams(location.search).get('id') === ${JSON.stringify(story.id)} && window.storyResults?.some(r => r.id === ${JSON.stringify(story.id)} || r.event !== 'storyFinished')`), story.id);
    const results = await evaluate('window.storyResults');
    assert.ok(results.every(r => r.event === 'storyFinished' && r.status === 'success'), `Story failed: ${story.id}; ${JSON.stringify(results)}`);
    assert.ok(results.some(r => r.id === story.id && r.status === 'success'), `Story incomplete: ${story.id}`);
    completed++;
    console.log(`PASS ${story.id}`);
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    ws.close();
  }
  assert.equal(completed, stories.length);
  console.log(`Storybook: ${completed}/${stories.length} stories finished successfully (including their play functions).`);
} finally {
  ws?.close();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(2000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
