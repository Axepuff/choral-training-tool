import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'choral-browser-'));
const processes = [];
const storiesOnly = process.env.CHORAL_STORIES_ONLY === 'true';
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
const pending = new Map();
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
  await evaluate('window.__leavingDocument = true');
  await send('Page.navigate', { url: `http://127.0.0.1:5179/${query}` });
  await poll(() => evaluate('!window.__leavingDocument && document.readyState === "complete" && !!document.getElementById("root")?.textContent'), 'Page did not load');
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
// Hold a real me response to check the form both during and after revalidation.
async function checkFormOnFocus(selector) {
  await evaluate(`(() => {
    window.__formInput = document.querySelector(${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(window.__formInput, 'fictional draft value');
    window.__formInput.dispatchEvent(new Event('input', { bubbles: true }));
    const original = window.fetch;
    window.__meStarted = false; window.__meFinished = false;
    window.fetch = async (...args) => {
      if (!String(args[0]).endsWith('/auth/me')) return original(...args);
      window.__meStarted = true;
      await new Promise(resolve => { window.__releaseMe = resolve; });
      try { return await original(...args); }
      finally { window.fetch = original; window.__meFinished = true; }
    };
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
  await poll(() => evaluate('window.__meStarted'), 'Focus did not check me');
  const preserved = `document.querySelector(${JSON.stringify(selector)}) === window.__formInput && window.__formInput.value === 'fictional draft value'`;
  assert.equal(await evaluate(preserved), true, 'Focus unmounted form during me');
  await evaluate('window.__releaseMe()');
  await poll(() => evaluate('window.__meFinished'), 'Focus me did not finish');
  await delay(100);
  assert.equal(await evaluate(preserved), true, 'Focus erased form after me');
}

async function checkResponsiveText(selector, text) {
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`), text);
  for (const [width, height] of [[320, 640], [360, 800], [800, 360], [1280, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Page overflow at ${width}: ${selector}`);
    assert.equal(await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const range = document.createRange(); range.selectNodeContents(element);
      return [...range.getClientRects()].every(rect => rect.left >= 0 && rect.right <= innerWidth)
        && element.scrollWidth <= element.clientWidth;
    })()`), true, `Text overflow at ${width}: ${selector}`);
  }
}

async function click(text) {
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === ${JSON.stringify(text)}).click()`);
}

try {
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5179', '--strictPort'], { CHORAL_API_PROXY: process.env.CHORAL_TEST_API, VITE_APP_DEMO: 'false' });
  await poll(async () => (await fetch('http://127.0.0.1:5179')).ok, 'Vite did not start');
  start(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank']);
  let port;
  await poll(async () => { port = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return !!port; }, 'Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
    const entry = pending.get(data.id);
    if (entry) { pending.delete(data.id); if (data.error) entry.reject(new Error(data.error.message)); else entry.resolve(data.result); }
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  if (!storiesOnly) {
  await navigate('?page=create-song&role=admin');
  await expectText('Вход');
  await checkFormOnFocus('[name=email]');
  await submit('teacher@example.test', 'incorrect fictional password');
  await expectText('Неверный email или пароль');
  // Delay the real login response, then simulate returning from another tab.
  await evaluate(`(() => {
    const original = window.fetch;
    window.__loginHeld = false; window.__focusMeCalls = 0;
    window.fetch = async (...args) => {
      if (String(args[0]).endsWith('/auth/me')) window.__focusMeCalls++;
      const response = await original(...args);
      if (String(args[0]).endsWith('/auth/login')) {
        window.__loginHeld = true;
        await new Promise(resolve => { window.__releaseLogin = resolve; });
      }
      return response;
    };
    window.__restoreFetch = () => { window.fetch = original; };
  })()`);
  await submit('teacher@example.test', 'fictional password 123');
  await poll(() => evaluate('window.__loginHeld'), 'Login response was not held');
  await evaluate(`window.__loginForm = document.querySelector('form'); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'));`);
  await delay(100);
  assert.equal(await evaluate("document.querySelector('form') === window.__loginForm"), true);
  assert.equal(await evaluate('window.__focusMeCalls'), 0, 'Focus competed with login');
  await evaluate('window.__releaseLogin(); window.__restoreFetch();');

  await expectText('Новая песня');
  await checkFormOnFocus('[name=title]');
  assert.equal(await evaluate('location.search'), '?page=create-song');
  await navigate('?page=library&role=admin');
  await expectText('Преподаватель');
  assert.equal(await bodyIncludes('Администратор'), false);
  assert.equal(await bodyIncludes('Тихий вечер'), false);
  for (const [width, height] of [[320, 640], [360, 800], [800, 360], [1280, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Overflow at ${width}`);
  }
  assert.equal(await evaluate('localStorage.length + sessionStorage.length'), 0);
  // Network logout failure must keep the server session and offer a real retry.
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await click('Выйти'); await expectText('Нет соединения с сервером');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Выйти'); await expectText('Вход');
  await navigate('?page=library'); await expectText('Вход');
  // Login network error has no success message and no mock data.
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await submit('teacher@example.test', 'fictional password 123'); await expectText('Не удалось войти');
  assert.equal(await bodyIncludes('Вход выполнен.'), false);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await submit('teacher@example.test', 'fictional password 123'); await expectText('Преподаватель');
  // A blocked user loses the session on me; login does not disclose blocking.
  assert.equal((await fetch(`${process.env.CHORAL_TEST_API}/__test/block`, { method: 'POST' })).status, 204);
  await navigate('?page=library'); await expectText('Вход');
  await submit('teacher@example.test', 'fictional password 123'); await expectText('Неверный email или пароль');
  // A public link bypasses login even with forged editor query parameters.
  await navigate('?list=invalid-public-link&page=create-song&role=admin');
  await expectText('Не удалось открыть ссылку'); assert.equal(await bodyIncludes('Вход'), false);
  await navigate('?song=invalid-public-link&role=admin');
  await expectText('Не удалось открыть ссылку'); assert.equal(await bodyIncludes('Создать песню'), false);
  // Simulate a stalled transport, keeping PublicRoute's own cancellation signal.
  const stalled = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = () => timeout(100);
    const original = window.fetch;
    window.fetch = (url, options) => String(url).includes('/public/shares/')
      ? new Promise((resolve, reject) => {
          options.signal.throwIfAborted();
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        })
      : original(url, options);
  ` });
  await navigate('?list=' + ('B'.repeat(42) + 'A'));
  await expectText('Не удалось открыть ссылку');
  await expectText('Обновите страницу для повтора');
  assert.equal(await bodyIncludes('Загрузка песни…'), false);
  assert.equal(await bodyIncludes('Тестовая песня'), false);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stalled.identifier });
  await send('Page.reload');
  await expectText('Тестовая песня');
  await navigate('?list=' + ('B'.repeat(42) + 'A') + '&page=create-song&role=admin');
  await expectText('Тестовая песня');
  assert.equal(await bodyIncludes('Создать песню'), false);
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="Ссылка на список"]')`), false);
  await evaluate(`document.querySelector('a[aria-label="Открыть: Тестовая песня"]').click()`);
  await expectText('Тестовая заметка'); await expectText('Сопрано');
  await navigate('?song=' + 'A'.repeat(43) + '&role=admin');
  await expectText('Тестовая заметка');
  assert.equal(await bodyIncludes('Создать песню'), false);
  assert.equal((await fetch(`${process.env.CHORAL_TEST_API}/__test/long-metadata`, { method: 'POST' })).status, 204);
  for (const query of ['?song=' + 'A'.repeat(43), '?list=' + ('B'.repeat(42) + 'A')]) {
    await navigate(query); await expectText('Я'.repeat(160));
    await checkResponsiveText(query.startsWith('?song') ? 'main h1' : 'main h2', 'Я'.repeat(160));
    if (query.startsWith('?list')) {
      await evaluate(`document.querySelector('main h2').closest('a').click()`);
      await expectText('Ж'.repeat(1000));
      await checkResponsiveText('main h1', 'Я'.repeat(160));
    }
    await checkResponsiveText('main li', 'Щ'.repeat(80));
    await checkResponsiveText('main p:nth-of-type(2)', 'Ж'.repeat(1000));
  }
  // Bootstrap is a real gated session, not an editor until password replacement.
  await navigate('?page=sign-in&returnTo=https://external.test'); await expectText('Вход');
  await submit(('a'.repeat(64) + '@' + 'b'.repeat(63) + '.test'), 'fictional password 123'); await expectText('Смена пароля');
  assert.equal(await bodyIncludes('Создать песню'), false);
  await checkFormOnFocus('[name=newPassword]');
  await evaluate(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(document.querySelector('[name=currentPassword]'), 'fictional password 123');
    set.call(document.querySelector('[name=newPassword]'), 'replacement password 456');
    document.querySelector('form').requestSubmit();
  })()`);
  await expectText('Вход');
  await submit(('a'.repeat(64) + '@' + 'b'.repeat(63) + '.test'), 'replacement password 456'); await expectText('Администратор');
  assert.equal(await evaluate('location.search'), '?page=library');
  await checkResponsiveText('header + p', 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.test · Администратор');
  await navigate('?list=' + ('B'.repeat(42) + 'A') + '&role=admin&page=create-song');
  await expectText('Я'.repeat(160));
  assert.equal(await bodyIncludes('Создать песню'), false);
  assert.equal(await bodyIncludes('Администратор'), false);
  await navigate('?page=library'); await expectText('Администратор');
  await click('Выйти'); await expectText('Вход');
  }
  // Wait for Storybook's own storyFinished event, including each play function.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    let channel;
    Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
      configurable: true,
      get: () => channel,
      set: (next) => {
        channel = next;
        next.on('storyFinished', (result) => { window.__storyResult = result; });
      },
    });
  ` });
  const index = await (await fetch('http://127.0.0.1:5179/storybook-static/index.json')).json();
  const stories = Object.values(index.entries).filter((s) => s.type === 'story' && /pages-(sign-in|song-library|create-song)--/.test(s.id));
  assert.equal(stories.length, 30);
  for (const story of stories) {
    await send('Page.navigate', { url: `http://127.0.0.1:5179/storybook-static/iframe.html?id=${story.id}&viewMode=story` });
    await poll(() => evaluate(`window.__storyResult?.storyId === ${JSON.stringify(story.id)}`), `Story did not finish: ${story.id}`, 30_000);
    assert.equal(await evaluate('window.__storyResult.status'), 'success', story.id);
  }
  await send('Page.navigate', { url: 'http://127.0.0.1:5179/storybook-static/app/?page=sign-in' });
  await poll(() => evaluate('document.title === "Демонстрация · Хор" && !!document.querySelector("form")'), 'Pages demo did not load');
  await submit('fictional@example.test', 'fictional password 123');
  await expectText('Это макет: данные не отправлены');
  console.log(`Storybook browser: ${stories.length} affected stories including play functions passed.`);
  if (!storiesOnly) console.log('Real Go API + browser: login, reload, role, redirect, logout/revocation, network failures, blocked user, password gate, guest routes, storage and responsive smoke passed.');
} finally {
  if (ws) ws.close();
  for (const p of processes.reverse()) { p.kill('SIGTERM'); await Promise.race([new Promise((resolve) => p.once('exit', resolve)), delay(2000)]); if (p.exitCode === null) p.kill('SIGKILL'); }
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
