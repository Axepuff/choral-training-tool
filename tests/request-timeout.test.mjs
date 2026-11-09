import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/network/requestTimeout.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { withRequestTimeout } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('deadline covers response body and releases timer/listener on success and failure', async t => {
  const timers = new Map();
  let next = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    assert.equal(milliseconds, 60000);
    timers.set(++next, callback);
    return next;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  for (const fail of [false, true]) {
    const parent = new AbortController();
    const remove = t.mock.method(parent.signal, 'removeEventListener');
    let signal;
    const pending = withRequestTimeout(60000, parent.signal, async current => {
      signal = current;
      // Headers have arrived but consuming the body is still pending.
      await Promise.resolve();
      if (fail) await new Promise((_, reject) => current.addEventListener('abort', () => reject(new Error('aborted'))));
      return 'body';
    });
    await Promise.resolve();
    if (fail) {
      assert.equal(timers.size, 1);
      [...timers.values()][0]();
      await assert.rejects(pending, /aborted/);
    } else assert.equal(await pending, 'body');
    assert.equal(timers.size, 0);
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(parent.signal.aborted, false);
    parent.abort();
    assert.equal(signal.aborted, true);
  }
});

test('caller cancellation works before and during an operation', async () => {
  for (const alreadyAborted of [false, true]) {
    const parent = new AbortController();
    if (alreadyAborted) parent.abort();
    const pending = withRequestTimeout(60000, parent.signal, signal => new Promise((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      else signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    parent.abort();
    await assert.rejects(pending, /aborted/);
  }
});


test('early response validation failure aborts an unread body', async () => {
  let signal;
  await assert.rejects(withRequestTimeout(60000, undefined, async current => {
    signal = current;
    await Promise.resolve(); // fetch resolved with headers, body still streaming
    throw new Error('Invalid Content-Range');
  }), /Invalid Content-Range/);
  assert.equal(signal.aborted, true);
});
