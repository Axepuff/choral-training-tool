import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const dir = await mkdtemp(join(tmpdir(), 'choral-auth-test-'));
for (const file of ['api/client', 'api/public', 'auth/session', 'navigation/routes']) {
  const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from '(\.\.?\/[^']+)'/g, "from '$1.mjs'");
  await mkdir(join(dir, file.split('/')[0]), { recursive: true });
  await writeFile(join(dir, `${file}.mjs`), output);
}
const { ApiClient, ApiError, api } = await import(`${dir}/api/client.mjs`);
const auth = await import(`${dir}/auth/session.mjs`);
const { readRoute, safeReturn } = await import(`${dir}/navigation/routes.mjs`);
const { readPublic } = await import(`${dir}/api/public.mjs`);
const originalFetch = globalThis.fetch;
const session = { user: { id: 'fictional-id', email: 'teacher@example.test', role: 'teacher', blocked: false, mustChangePassword: false }, csrfToken: 'fictional-csrf', expiresAt: '2099-01-01T00:00:00Z' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (code, status) => json({ error: { code, message: code, requestId: 'test-request' } }, status);

test('API/session/navigation behavior', async (t) => {
  try {
    await t.test('initial network failure offers recovery without a session', async () => {
      globalThis.fetch = async () => { throw new Error('offline'); };
      await auth.restoreSession();
      assert.equal(auth.getAuth().status, 'error');
      assert.equal(auth.getAuth().session, null);
    });
    await t.test('credentials and CSRF are centralized; public scope omits both', async () => {
      const client = new ApiClient(); client.csrfToken = 'fictional-csrf';
      const calls = [];
      globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return new Response(null, { status: 204 }); };
      await client.request('/songs', { method: 'POST', body: '{}' });
      await client.request('/public/shares/test', {}, 'public');
      assert.equal(calls[0].url, '/api/v1/songs');
      assert.equal(calls[0].credentials, 'same-origin');
      assert.equal(calls[0].headers.get('X-CSRF-Token'), 'fictional-csrf');
      assert.equal(calls[1].credentials, 'omit');
      assert.equal(calls[1].headers.get('X-CSRF-Token'), null);
      await assert.rejects(client.request('//external.test'), /Invalid API path/);
    });
    await t.test('login/reload use only server identity; 401 clears role and token', async () => {
      globalThis.fetch = async () => json(session);
      await auth.login({ email: 'teacher@example.test', password: 'fictional password' });
      assert.equal(auth.getAuth().session.user.role, 'teacher');
      await auth.restoreSession();
      assert.equal(auth.getAuth().session.user.id, session.user.id);
      globalThis.fetch = async () => problem('unauthorized', 401);
      await assert.rejects(api.request('/songs'), ApiError);
      assert.equal(auth.getAuth().session, null);
      assert.equal(api.csrfToken, null);
    });
    await t.test('network error, invalid/blocked login and malformed success never authenticate', async () => {
      for (const respond of [() => { throw new Error('offline'); }, () => problem('invalid_credentials', 401), () => json({}), () => json({ ...session, user: { ...session.user, role: 'guest' } }), () => json({ ...session, user: { ...session.user, blocked: true } })]) {
        auth.clearSession(); globalThis.fetch = async () => respond();
        await assert.rejects(auth.login({ email: 'test@example.test', password: 'fictional password' }));
        assert.equal(auth.getAuth().session, null);
      }
      globalThis.fetch = async () => { throw new Error('offline'); };
      await auth.restoreSession();
      assert.equal(auth.getAuth().status, 'ready');
    });
    await t.test('logout waits for revocation, failed logout can retry', async () => {
      globalThis.fetch = async () => json(session);
      await auth.login({ email: 'teacher@example.test', password: 'fictional password' });
      globalThis.fetch = async () => { throw new Error('offline'); };
      await assert.rejects(auth.logout());
      assert.ok(auth.getAuth().session);
      globalThis.fetch = async () => new Response(null, { status: 204 });
      await auth.logout(); assert.equal(auth.getAuth().session, null);
    });
    await t.test('stale me cannot undo logout or overwrite a newer login', async () => {
      let resolve;
      globalThis.fetch = () => new Promise((done) => { resolve = done; });
      const pending = auth.restoreSession();
      auth.clearSession(); resolve(json(session)); await pending;
      assert.equal(auth.getAuth().session, null);
    });
    await t.test('focus checks preserve anonymous state and cannot interrupt login', async () => {
      auth.clearSession();
      let finishMe;
      let finishLogin;
      const calls = [];
      globalThis.fetch = (url) => {
        calls.push(url);
        return new Promise((resolve) => { if (url.endsWith('/me')) finishMe = resolve; else finishLogin = resolve; });
      };
      const check = auth.restoreSession();
      assert.equal(auth.getAuth().status, 'checking');
      const signingIn = auth.login({ email: session.user.email, password: 'fictional password' });
      await auth.restoreSession();
      // A pre-login me 401 is also stale, even when its initial CSRF was null.
      finishMe(problem('unauthorized', 401));
      await check;
      await auth.restoreSession();
      assert.equal(calls.length, 2);
      finishLogin(json(session));
      await signingIn;
      assert.equal(auth.getAuth().session.user.id, session.user.id);
      globalThis.fetch = async () => { throw new Error('offline'); };
      auth.clearSession();
      await auth.restoreSession();
      assert.equal(auth.getAuth().status, 'ready');
    });
    await t.test('late me 401 cannot clear a successful login or its CSRF', async () => {
      auth.clearSession();
      let finishMe;
      globalThis.fetch = (url) => url.endsWith('/me')
        ? new Promise((resolve) => { finishMe = resolve; }) : Promise.resolve(json(session));
      const check = auth.restoreSession();
      await auth.login({ email: session.user.email, password: 'fictional password' });
      finishMe(problem('unauthorized', 401));
      await check;
      assert.equal(auth.getAuth().session.user.id, session.user.id);
      assert.equal(api.csrfToken, session.csrfToken);
    });
    await t.test('a late unauthorized response cannot invalidate a newer session', async () => {
      let resolve;
      api.csrfToken = 'old-fictional-csrf';
      globalThis.fetch = () => new Promise((done) => { resolve = done; });
      const pending = api.request('/songs');
      api.csrfToken = 'new-fictional-csrf';
      resolve(problem('unauthorized', 401));
      await assert.rejects(pending);
      assert.equal(api.csrfToken, 'new-fictional-csrf');
    });
    await t.test('CSRF failure refreshes session but never replays the write', async () => {
      const calls = [];
      globalThis.fetch = async (url) => { calls.push(url); return url.endsWith('/me') ? json(session) : problem('csrf_failed', 403); };
      await assert.rejects(api.request('/songs', { method: 'POST', body: '{}' }), (e) => e.problem.code === 'csrf_failed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(calls, ['/api/v1/songs', '/api/v1/auth/me']);
      assert.equal(auth.getAuth().session.csrfToken, session.csrfToken);
    });
    await t.test('CSRF rejection during logout refreshes after the auth operation', async () => {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        return url.endsWith('/me') ? json(session) : problem('csrf_failed', 403);
      };
      await assert.rejects(auth.logout(), (e) => e.problem.code === 'csrf_failed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(calls, ['/api/v1/auth/logout', '/api/v1/auth/me']);
      assert.equal(auth.getAuth().status, 'ready');
      assert.equal(auth.getAuth().session.csrfToken, session.csrfToken);
    });
    await t.test('public routes ignore forged role/page; redirect is an internal allowlist', () => {
      assert.equal(readRoute('?list=public-token&page=create-song&role=admin').kind, 'public-list');
      assert.equal(readRoute('?song=public-token&role=admin').kind, 'public-song');
      for (const value of ['https://external.test', '//external.test', '?page=sign-in&returnTo=https://external.test', '?page=library&role=admin&password=secret', '?list=public-token']) {
        assert.equal(safeReturn(value), '?page=library');
      }
      assert.equal(safeReturn('?page=create-song'), '?page=create-song');
    });
    await t.test('public lists read all snapshot pages; no fallback on failure', async () => {
      const calls = [];
      globalThis.fetch = async (url, options) => { calls.push([url, options.credentials]); return json({ kind: 'list', songs: [{ id: String(calls.length) }], nextCursor: calls.length === 1 ? 'next' : null }); };
      const songs = await readPublic('test-token', new AbortController().signal);
      assert.deepEqual(songs.map((s) => s.id), ['1', '2']);
      assert.deepEqual(calls.map((c) => c[1]), ['omit', 'omit']);
      assert.match(calls[1][0], /cursor=next/);
      globalThis.fetch = async () => problem('not_found', 404);
      await assert.rejects(readPublic('revoked', new AbortController().signal));
    });
    await t.test('hanging public requests time out with caller signal and can retry; caller cancellation still works', async () => {
      const timeout = AbortSignal.timeout;
      try {
        // Shorten the production deadline without changing client configuration.
        AbortSignal.timeout = (ms) => { assert.equal(ms, 30_000); return timeout(20); };
        globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        const controller = new AbortController();
        const keepAlive = setTimeout(() => {}, 1000);
        try {
          await assert.rejects(readPublic('hanging', controller.signal), (e) => e instanceof ApiError && e.problem.code === 'network_error');
          assert.equal(controller.signal.aborted, false);
          const canceled = readPublic('canceled', controller.signal);
          controller.abort();
          await assert.rejects(canceled, ApiError);
        } finally { clearTimeout(keepAlive); }
        globalThis.fetch = async () => json({ kind: 'list', songs: [{ id: 'retry' }], nextCursor: null });
        assert.deepEqual(await readPublic('hanging', new AbortController().signal), [{ id: 'retry' }]);
      } finally { AbortSignal.timeout = timeout; }
    });
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});
