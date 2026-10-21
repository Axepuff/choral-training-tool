import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  repository, queue, selectTask, closesIssue, validateReview, assertChecks,
  assertSubscriptionEnvironment, childEnvironment, protectedPath,
} from './policy.mjs';
import { processTask } from './engine.mjs';
import { Runner } from './runner.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const approval = () => ({ head_sha: head, base_sha: base, verdict: 'approve', acceptance_criteria_met: true, summary: 'Все критерии проверены.', findings: [] });
const finding = { severity: 'P1', file: 'backend/auth.go', line: 12, description: 'Нет проверки владельца.' };
const rejection = () => ({ ...approval(), verdict: 'changes_requested', acceptance_criteria_met: false, findings: [finding] });
const issues = () => queue.map(t => ({ number: t.issue, state: 'open', title: `Issue ${t.issue}`, body: 'Acceptance criteria' }));
const pull = (issue = 2) => ({ number: 18, state: 'open', body: `Closes #${issue}`, draft: false, base: { ref: 'main' }, head: { ref: 'issue-2-contracts', sha: head, repo: { full_name: repository } } });

test('очередь начинает с существующего PR #18 и исключает epic, NEXT и production', () => {
  const task = selectTask(issues(), [pull()]);
  assert.equal(task.issue.number, 2);
  assert.equal(task.pr.number, 18);
  for (const id of [1, 13, 16]) assert.ok(!queue.some(t => t.issue === id));
});

test('следующая задача требует и completed Issue, и merged PR в main', () => {
  const list = issues();
  list[0] = { ...list[0], state: 'closed', state_reason: 'completed' };
  assert.throws(() => selectTask(list, []), /без подтверждённого merge/);
  assert.equal(selectTask(list, [{ ...pull(), state: 'closed', merged_at: '2026-10-20' }]).issue.number, 3);
  list[0].state_reason = 'not_planned';
  assert.throws(() => selectTask(list, [{ ...pull(), merged_at: '2026-10-20' }]), /без подтверждённого merge/);
});

test('ссылка Closes #20 не закрывает #2; неоднозначные, draft и fork PR блокируются', () => {
  assert.equal(closesIssue({ body: 'Closes #20' }, 2), false);
  assert.equal(closesIssue({ body: `Fixes https://github.com/${repository}/issues/2` }, 2), true);
  assert.throws(() => selectTask(issues(), [pull(), { ...pull(), number: 19 }]), /Несколько/);
  assert.throws(() => selectTask(issues(), [{ ...pull(), draft: true }]), /draft/);
  const fork = pull(); fork.head.repo.full_name = 'someone/fork';
  assert.throws(() => selectTask(issues(), [fork]), /fork/);
});

test('auth не допускает API-ключ или custom endpoint и не выводит значения', () => {
  assert.doesNotThrow(() => assertSubscriptionEnvironment({ PATH: '/bin' }));
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    assert.throws(() => assertSubscriptionEnvironment({ [name]: 'sensitive-value' }), error => {
      assert.ok(error.message.includes(name)); assert.ok(!error.message.includes('sensitive-value')); return true;
    });
  }
  assert.deepEqual(childEnvironment({ PATH: '/bin', CODEX_HOME: '/normal', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', DB_PASSWORD: 'secret' }), { PATH: '/bin', CODEX_HOME: '/normal' });
});

test('ревью должно соответствовать HEAD и base, содержать непротиворечивое одобрение', () => {
  assert.equal(validateReview(approval(), head, base), true);
  assert.equal(validateReview(rejection(), head, base), false);
  for (const invalid of [null, {}, { ...approval(), head_sha: base }, { ...approval(), base_sha: head },
    { ...approval(), findings: [finding] }, { ...approval(), acceptance_criteria_met: false },
    { ...approval(), findings: [{ ...finding, line: 0 }] }, { ...approval(), extra: true }]) {
    assert.throws(() => validateReview(invalid, head, base), /ревью/);
  }
});

test('GitHub statuses и check-runs: pending, failure и unknown блокируют merge', () => {
  assert.doesNotThrow(() => assertChecks([]));
  assert.doesNotThrow(() => assertChecks([{ context: 'ci', state: 'success' }, { status: 'completed', conclusion: 'success' }]));
  for (const bad of [{ context: 'ci', state: 'failure' }, { context: 'ci', state: 'pending' }, { status: 'in_progress' }, { status: 'completed', conclusion: 'failure' }, {}]) {
    assert.throws(() => assertChecks([bad]));
  }
});

test('очередь не может менять свой контроллер, правила и secrets, но может добавить CI для #3', () => {
  for (const path of ['scripts/agent-queue/runner.mjs', '.codex/config.toml', '.agents/rules.md', 'AGENTS.md', '.env', 'backend/.env.prod', 'auth.json']) assert.equal(protectedPath(path), true, path);
  for (const path of ['.github/workflows/ci.yml', 'backend/.env.example', 'backend/main.go', 'src/main.tsx']) assert.equal(protectedPath(path), false, path);
});

function fakeIO({ reports = [approval()], checkFailures = 0, stale = false, blocked = false } = {}) {
  const events = [], saved = [], feedback = [];
  const state = { fixRounds: 0, implemented: true };
  return { state, events, saved, feedback,
    prepare: async () => events.push('prepare'), guard: async () => events.push('guard'),
    implement: async (_, details) => { events.push('implement'); feedback.push(details); },
    commit: async () => events.push('commit'),
    save: async s => saved.push(structuredClone(s)),
    revision: async () => ({ head, base }),
    check: async () => {
      events.push('check');
      if (checkFailures-- > 0) throw Object.assign(new Error('meaningful test failed'), { checkFailure: true });
      return ['tests'];
    },
    assertStable: async () => { if (stale) throw new Error('SHA changed'); },
    publish: async () => events.push('publish'),
    review: async () => { events.push('review'); return reports.length > 1 ? reports.shift() : reports[0]; },
    recordReview: async () => events.push('record'),
    remoteChecks: async () => { if (blocked) throw new Error('human changes requested'); events.push('remoteChecks'); },
    merge: async () => events.push('merge'),
  };
}

test('существующий PR проходит проверки и отдельное ревью без повторной реализации', async () => {
  const io = fakeIO();
  await processTask(io, {}, io.state);
  assert.equal(io.events.includes('implement'), false);
  assert.ok(io.events.indexOf('check') < io.events.indexOf('review'));
  assert.ok(io.events.indexOf('review') < io.events.indexOf('merge'));
  assert.equal(io.events.at(-1), 'merge');
});

test('новая Issue: реализация → PR → отклонённое ревью → исправление → новое ревью → merge', async () => {
  const io = fakeIO({ reports: [rejection(), approval()] });
  io.state.implemented = false;
  await processTask(io, {}, io.state);
  assert.equal(io.events.filter(e => e === 'implement').length, 2);
  assert.equal(io.events.filter(e => e === 'check').length, 2);
  assert.equal(io.events.filter(e => e === 'review').length, 2);
  assert.equal(io.state.fixRounds, 1);
  assert.equal(io.feedback[1].findings[0].file, finding.file);
  assert.equal(io.events.at(-1), 'merge');
});

test('ошибка проверки исправляется до ревью и merge', async () => {
  const io = fakeIO({ checkFailures: 1 });
  await processTask(io, {}, io.state);
  assert.equal(io.events.filter(e => e === 'check').length, 2);
  assert.equal(io.events.filter(e => e === 'review').length, 1);
  assert.ok(io.feedback[0].checks_failed.includes('test failed'));
});

test('после трёх исправлений очередь останавливается и сохраняет счётчик для resume', async () => {
  const io = fakeIO({ reports: [rejection()] });
  await assert.rejects(processTask(io, {}, io.state), /Три попытки/);
  assert.equal(io.events.filter(e => e === 'implement').length, 3);
  assert.equal(io.events.includes('merge'), false);
  assert.equal(io.saved.at(-1).fixRounds, 3);
  const resumed = fakeIO({ reports: [rejection()] });
  resumed.state.fixRounds = 3;
  await assert.rejects(processTask(resumed, {}, resumed.state), /Три попытки/);
  assert.equal(resumed.events.includes('implement'), false);
});

test('невалидное ревью, новый SHA, человеческое отклонение и исчерпанная квота не приводят к merge', async () => {
  for (const options of [{ reports: [{}] }, { stale: true }, { blocked: true }]) {
    const io = fakeIO(options);
    await assert.rejects(processTask(io, {}, io.state));
    assert.equal(io.events.includes('merge'), false);
  }
  const limited = fakeIO();
  limited.state.implemented = false;
  limited.implement = async () => { throw new Error('Usage limit reached'); };
  await assert.rejects(processTask(limited, {}, limited.state), /Usage limit/);
  assert.equal(limited.events.includes('publish'), false);
  assert.equal(limited.events.includes('merge'), false);
});

test('изменение PR после полученного approval отменяет merge без попытки исправить чужой SHA', async () => {
  const io = fakeIO(); let probes = 0;
  io.assertStable = async () => { if (++probes === 2) throw new Error('remote HEAD changed after review'); };
  await assert.rejects(processTask(io, {}, io.state), /after review/);
  assert.equal(io.events.includes('review'), true);
  assert.equal(io.events.includes('merge'), false);
  assert.equal(io.events.includes('implement'), false);
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'choral-queue-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = new Runner(dir, { log: () => {} });
  await runner.command('git', ['init', '-b', 'main']);
  await runner.git('config', 'user.email', 'queue-test@example.invalid');
  await runner.git('config', 'user.name', 'Queue test');
  await writeFile(join(dir, 'example.txt'), 'base\n');
  await runner.git('add', '--all');
  await runner.git('commit', '-m', 'base');
  await runner.init();
  return runner;
}

test('реальный Git: изменённое рабочее дерево блокирует начало, файлы сохраняются', async t => {
  const runner = await fixture(t);
  await runner.clean();
  await writeFile(join(runner.root, 'example.txt'), 'user change\n');
  await assert.rejects(runner.clean(), /Рабочее дерево изменено/);
  assert.equal(await readFile(join(runner.root, 'example.txt'), 'utf8'), 'user change\n');
});

test('реальный lock исключает второй процесс; живой lock нельзя снять', async t => {
  const runner = await fixture(t);
  await runner.lock();
  await assert.rejects(runner.lock(), /Другая очередь/);
  await assert.rejects(runner.unlock(), /ещё работает/);
  await rm(runner.lockFile);
  await runner.lock();
});

test('state сохраняется атомарно и читается для продолжения', async t => {
  const runner = await fixture(t);
  const state = { repository, issue: 2, fixRounds: 2, branch: 'issue-2-queue', pr: 18, implemented: true };
  await runner.save(state);
  assert.deepEqual(await runner.readState(), state);
});

test('подпроцесс получает фильтрованное окружение; ошибки auth не раскрывают stdout/stderr', async t => {
  const runner = await fixture(t);
  runner.cleanEnv = { ...runner.cleanEnv, CHORAL_TEST_VALUE: 'available' };
  const result = await runner.command(process.execPath, ['-e', 'process.stdout.write(process.env.CHORAL_TEST_VALUE)']);
  assert.equal(result.output, 'available');
  await assert.rejects(runner.command(process.execPath, ['-e', 'console.error("sensitive-value");process.exit(1)']), error => !error.message.includes('sensitive-value'));
});

test('таймаут и abort прерывают подпроцесс', async t => {
  const runner = await fixture(t);
  await assert.rejects(runner.command(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 30 }));
  const abort = new AbortController();
  runner.signal = abort.signal;
  const pending = runner.command(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)']);
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending);
});

test('реальный Git guard отклоняет изменение своего контроллера, включая переименование', async t => {
  const runner = await fixture(t);
  await writeFile(join(runner.root, 'AGENTS.md'), 'rules\n');
  await runner.git('add', '--all'); await runner.git('commit', '-m', 'base rules');
  runner.base = await runner.git('rev-parse', 'HEAD'); runner.state = { branch: 'main' };
  await runner.git('mv', 'AGENTS.md', 'removed-rules.md');
  await runner.git('commit', '-m', 'rename protected file');
  await assert.rejects(runner.guard(), /защищённые файлы/);
});

test('реальный CLI-адаптер запускает fake Codex с ChatGPT policy, отдельными sandbox и JSON review', async t => {
  const runner = await fixture(t);
  const bin = join(runner.root, 'fake-bin'); await mkdir(bin);
  const executable = join(bin, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const review = args.includes('--output-schema');
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(output, JSON.stringify(review ? ${JSON.stringify(approval())} : {done: true}));
console.log(JSON.stringify({ args, promptLength: prompt.length, tokenPresent: Boolean(process.env.GH_TOKEN) }));
`);
  await chmod(executable, 0o755);
  runner.cleanEnv.PATH = `${bin}:${runner.cleanEnv.PATH}`;
  await runner.codex('implement fixture');
  const report = JSON.parse(await runner.codex('review fixture', { review: true }));
  assert.equal(validateReview(report, head, base), true);
  const { readdir } = await import('node:fs/promises');
  const logs = (await readdir(runner.dir)).filter(p => p.endsWith('.log'));
  assert.equal(logs.length, 2);
  for (const file of logs) {
    const entry = JSON.parse(await readFile(join(runner.dir, file), 'utf8'));
    assert.ok(entry.args.includes('forced_login_method="chatgpt"'));
    assert.ok(entry.args.includes('model_provider="openai"'));
    assert.ok(entry.args.includes('--ignore-user-config'));
    assert.ok(!entry.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(entry.tokenPresent, false);
    assert.ok(entry.promptLength > 0);
    assert.ok(entry.args.includes(file.includes('review') ? 'read-only' : 'workspace-write'));
  }
});

test('preflight отвергает API login до GitHub и не вызывает inference', async t => {
  const runner = await fixture(t);
  runner.env = { PATH: process.env.PATH };
  const calls = [];
  runner.command = async (bin, args) => { calls.push([bin, ...args]); return { output: 'Logged in using an API key', stderr: '' }; };
  runner.api = async () => { throw new Error('GitHub must not be called'); };
  await assert.rejects(runner.preflight(), /Нужен codex login/);
  assert.deepEqual(calls, [['codex', 'login', 'status']]);
});

test('после merge зависимость не считается принятой, пока Issue не закрылась', async t => {
  const runner = await fixture(t);
  runner.api = async () => ({ number: 2, state: 'closed', state_reason: 'completed' });
  await runner.waitCompletion({ issue: 2 }, { ...pull(), merged_at: '2026-10-20' });
  const abort = new AbortController(); abort.abort(); runner.signal = abort.signal;
  runner.api = async () => ({ number: 2, state: 'open' });
  await assert.rejects(runner.waitCompletion({ issue: 2 }, { ...pull(), merged_at: '2026-10-20' }));
});

test('реальный Git: подхват PR, включение свежего main и resume сохраняют изменения обеих сторон', async t => {
  const runner = await fixture(t);
  const origin = join(runner.dir, 'origin.git');
  await runner.command('git', ['init', '--bare', origin]);
  await runner.git('remote', 'add', 'origin', origin);
  await runner.git('push', 'origin', 'HEAD:refs/heads/main');
  await runner.git('switch', '-c', 'existing-contract-pr');
  await writeFile(join(runner.root, 'contract.md'), 'contract\n');
  await runner.git('add', '--all'); await runner.git('commit', '-m', 'contract');
  const candidate = await runner.git('rev-parse', 'HEAD');
  await runner.git('push', 'origin', 'HEAD:refs/heads/existing-contract-pr');
  await runner.git('switch', 'main');
  await runner.git('branch', '-D', 'existing-contract-pr');
  await writeFile(join(runner.root, 'new-main.md'), 'fresh main\n');
  await runner.git('add', '--all'); await runner.git('commit', '-m', 'main advanced');
  await runner.git('push', 'origin', 'HEAD:refs/heads/main');
  runner.api = async () => ({ ...pull(), head: { ...pull().head, sha: candidate } });
  const state = { repository, issue: 2, branch: 'existing-contract-pr', pr: 18, fixRounds: 0, prepared: false, implemented: false };
  const task = { issue: issues()[0], pr: pull() };
  await runner.prepare(task, state);
  await runner.guard();
  assert.equal(state.implemented, true);
  assert.equal(await readFile(join(runner.root, 'contract.md'), 'utf8'), 'contract\n');
  assert.equal(await readFile(join(runner.root, 'new-main.md'), 'utf8'), 'fresh main\n');
  const mergedHead = await runner.git('rev-parse', 'HEAD');
  await runner.prepare(task, await runner.readState());
  assert.equal(await runner.git('rev-parse', 'HEAD'), mergedHead);
});

test('PR, созданный перед аварийным завершением, обнаруживается без повторного create', async t => {
  const runner = await fixture(t);
  runner.state = { branch: 'issue-2-contracts' };
  runner.guard = async () => {};
  const pushes = [];
  runner.git = async (...args) => { pushes.push(args); return ''; };
  runner.pages = async () => [{ ...pull(), head: { ...pull().head, ref: 'issue-2-contracts' } }];
  runner.api = async () => { throw new Error('duplicate PR creation'); };
  const state = { branch: 'issue-2-contracts', pr: null };
  await runner.publish({ issue: issues()[0] }, state, ['tests']);
  assert.equal(state.pr, 18);
  assert.deepEqual(pushes, [['push', 'origin', 'HEAD:refs/heads/issue-2-contracts']]);
  await assert.rejects(runner.publish({ issue: issues()[0] }, { branch: 'main' }, []), /Прямой push/);
});
