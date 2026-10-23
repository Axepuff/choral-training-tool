import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  repository, queue, selectTask, closesIssue, validateReview, assertChecks,
  assertSubscriptionEnvironment, childEnvironment, protectedPath, defaultMaxFixRounds,
} from './policy.mjs';
import { processTask } from './engine.mjs';
import { Runner, parseOptions } from './runner.mjs';

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
  for (const id of [1, 13, 16, 32, 35]) assert.ok(!queue.some(t => t.issue === id));
});

test('CLI: default ten rounds and an explicit total limit work for run/status/dry-run', () => {
  assert.equal(defaultMaxFixRounds, 10);
  for (const mode of ['--run', '--once', '--status', '--dry-run', '--unlock']) {
    assert.deepEqual(parseOptions([mode]), { mode, maxFixRounds: 10 });
    assert.deepEqual(parseOptions([mode, '--max-fix-rounds', '15']), { mode, maxFixRounds: 15 });
    assert.deepEqual(parseOptions(['--max-fix-rounds=3', mode]), { mode, maxFixRounds: 3 });
  }
  assert.equal(parseOptions([]).mode, '--help');
  assert.equal(parseOptions(['--help']).mode, '--help');
});

test('CLI rejects invalid limits and conflicting modes before any work', () => {
  for (const limit of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e2', '', '9007199254740992']) {
    assert.throws(() => parseOptions(['--run', `--max-fix-rounds=${limit}`]));
  }
  for (const args of [['--run', '--once'], ['--run', '--unknown'], ['--run', 'extra'],
    ['--run', '--max-fix-rounds'], ['--max-fix-rounds=10'],
    ['--run', '--max-fix-rounds=10', '--max-fix-rounds=15']]) assert.throws(() => parseOptions(args));
  for (const maxFixRounds of [0, -1, 1.5, NaN, Infinity, '10']) assert.throws(() => new Runner('/tmp', { maxFixRounds }));
});

function playerStage() {
  const list = issues(), prs = [];
  const accept = number => {
    Object.assign(list.find(i => i.number === number), { state: 'closed', state_reason: 'completed' });
    prs.push({ ...pull(number), number: 100 + number, state: 'closed', merged_at: '2026-10-22' });
  };
  for (const task of queue.slice(0, queue.findIndex(t => t.issue === 11))) accept(task.issue);
  return { list, prs, accept };
}

test('после player очередь выполняет редактор #31 и только после его merge выбирает #12', () => {
  const { list, prs, accept } = playerStage();
  assert.equal(selectTask(list, prs).issue.number, 11);
  accept(11);
  const editorPR = { ...pull(31), number: 131 };
  assert.equal(selectTask(list, [...prs, editorPR]).issue.number, 31);
  assert.equal(selectTask(list, [...prs, editorPR]).pr.number, editorPR.number);
  accept(31);
  assert.equal(selectTask(list, prs).issue.number, 12);
});

test('закрытие редактора без merged PR или недоступная Issue не позволяет перескочить к #12', () => {
  const { list, prs, accept } = playerStage();
  accept(11);
  Object.assign(list.find(i => i.number === 31), { state: 'closed', state_reason: 'completed' });
  assert.throws(() => selectTask(list, prs), /#31.*без подтверждённого merge/);
  assert.throws(() => selectTask(list.filter(i => i.number !== 31), prs), /#31 недоступна/);
});

test('обновлённый план принимает сохранённую задачу #11 с тремя использованными исправлениями', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'choral-queue-resume-'));
  try {
    const runner = new Runner(dir);
    runner.stateFile = join(dir, 'state.json');
    const state = { repository, issue: 11, branch: 'issue-11-queue', fixRounds: 3, implemented: true, prepared: true, pr: 30 };
    await writeFile(runner.stateFile, JSON.stringify(state));
    assert.deepEqual(await runner.readState(), state);
    const { list, prs } = playerStage();
    assert.equal(selectTask(list, [...prs, { ...pull(11), number: 30 }]).issue.number, state.issue);
  } finally { await rm(dir, { recursive: true, force: true }); }
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

function fakeIO({ reports = [approval()], checkFailures = 0, stale = false, blocked = false, maxFixRounds = defaultMaxFixRounds } = {}) {
  const events = [], saved = [], feedback = [];
  const state = { fixRounds: 0, implemented: true };
  return { state, events, saved, feedback, maxFixRounds,
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

test('готовое ручное исправление проходит новое ревью и merge даже при исчерпанном лимите', async () => {
  for (const used of [3, 12]) {
    const io = fakeIO({ maxFixRounds: 3 });
    io.state.fixRounds = used;
    await processTask(io, {}, io.state);
    assert.equal(io.events.includes('implement'), false);
    assert.equal(io.events.at(-1), 'merge');
    assert.equal(io.state.fixRounds, used);
  }
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

test('default budget stops after ten fixes and preserves the count on resume', async () => {
  const io = fakeIO({ reports: [rejection()] });
  await assert.rejects(processTask(io, {}, io.state), /исчерпан \(10\/10\).*--max-fix-rounds/);
  assert.equal(io.events.filter(e => e === 'implement').length, 10);
  assert.equal(io.events.includes('merge'), false);
  assert.equal(io.saved.at(-1).fixRounds, 10);
  const resumed = fakeIO({ reports: [rejection()] });
  resumed.state.fixRounds = 10;
  await assert.rejects(processTask(resumed, {}, resumed.state), /исчерпан \(10\/10\)/);
  assert.equal(resumed.events.includes('implement'), false);
});

test('saved 3/3 gains seven fixes with the new default, without resetting state or skipping reviews', async () => {
  const io = fakeIO({ reports: [...Array.from({ length: 7 }, rejection), approval()] });
  io.state.fixRounds = 3;
  await processTask(io, {}, io.state);
  assert.equal(io.state.fixRounds, 10);
  assert.equal(io.events.filter(e => e === 'implement').length, 7);
  assert.equal(io.events.filter(e => e === 'check').length, 8);
  assert.equal(io.events.filter(e => e === 'review').length, 8);
  assert.equal(io.events.at(-1), 'merge');
  assert.deepEqual(io.saved.filter((state, index, all) => index === 0 || state.fixRounds !== all[index - 1].fixRounds).map(s => s.fixRounds), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test('raising the configured limit resumes an exhausted budget; lowering it never resets the count', async () => {
  const first = fakeIO({ maxFixRounds: 4, reports: [rejection()] });
  first.state.fixRounds = 3;
  await assert.rejects(processTask(first, {}, first.state), /исчерпан \(4\/4\)/);
  assert.equal(first.events.filter(e => e === 'implement').length, 1);
  const resumed = fakeIO({ maxFixRounds: 6, reports: [rejection(), rejection(), approval()] });
  Object.assign(resumed.state, first.saved.at(-1));
  await processTask(resumed, {}, resumed.state);
  assert.equal(resumed.state.fixRounds, 6);
  assert.equal(resumed.events.filter(e => e === 'implement').length, 2);
  assert.equal(resumed.events.at(-1), 'merge');
  const lowered = fakeIO({ maxFixRounds: 3, reports: [rejection()] });
  Object.assign(lowered.state, resumed.state);
  await assert.rejects(processTask(lowered, {}, lowered.state), /исчерпан \(6\/3\)/);
  assert.equal(lowered.state.fixRounds, 6);
  assert.equal(lowered.events.includes('implement'), false);
  assert.equal(lowered.events.includes('merge'), false);
});

test('interrupted fixes spend a round before execution and resume under the remaining budget', async () => {
  const io = fakeIO({ maxFixRounds: 5, reports: [rejection()] });
  io.state.fixRounds = 3;
  io.implement = async () => { throw new Error('Usage limit reached'); };
  await assert.rejects(processTask(io, {}, io.state), /Usage limit/);
  assert.equal(io.saved.at(-1).fixRounds, 4);
  assert.equal(io.events.includes('merge'), false);
  const resumed = fakeIO({ maxFixRounds: 5, reports: [rejection(), approval()] });
  Object.assign(resumed.state, io.saved.at(-1));
  await processTask(resumed, {}, resumed.state);
  assert.equal(resumed.state.fixRounds, 5);
  assert.equal(resumed.events.filter(e => e === 'implement').length, 1);
  assert.equal(resumed.events.at(-1), 'merge');
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

test('persisted counts above three remain valid even when the current budget is lower', async t => {
  const runner = await fixture(t);
  runner.maxFixRounds = 3;
  const state = { repository, issue: 11, branch: 'issue-11-queue', pr: 30, fixRounds: 7, implemented: true, prepared: true };
  await runner.save(state);
  assert.deepEqual(await runner.readState(), state);
  for (const invalid of [-1, 1.5, null, '7', Number.MAX_SAFE_INTEGER + 1]) {
    await runner.save({ ...state, fixRounds: invalid });
    await assert.rejects(runner.readState(), /повреждено/);
  }
});

test('real CLI status reports configured/default remaining rounds without changing saved work', async t => {
  const runner = await fixture(t);
  const state = { repository, issue: 11, branch: 'issue-11-queue', pr: 30, fixRounds: 7, implemented: true, prepared: true };
  await runner.save(state);
  const script = fileURLToPath(new URL('./runner.mjs', import.meta.url));
  for (const [args, limit, remaining] of [[[], 10, 3], [['--max-fix-rounds=15'], 15, 8], [['--max-fix-rounds', '3'], 3, 0]]) {
    const result = JSON.parse((await runner.command(process.execPath, [script, '--status', ...args])).output);
    assert.deepEqual(result.state, state);
    assert.equal(result.maxFixRounds, limit);
    assert.equal(result.remainingFixRounds, remaining);
    assert.equal(result.lock, null);
    assert.deepEqual(await runner.readState(), state);
  }
  const invalid = await runner.command(process.execPath, [script, '--run', '--max-fix-rounds=0'], { allowFailure: true });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /--max-fix-rounds/);
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

async function capacityFixture(t, { failures = 2, stderr, stdout = '', writeSuccess = true } = {}) {
  const runner = await fixture(t);
  const bin = join(runner.dir, 'fake-bin'); await mkdir(bin);
  const executable = join(bin, 'codex');
  const capacity = 'ERROR: Selected model is at capacity. Please try a different model.';
  await writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const countFile = ${JSON.stringify(join(runner.dir, 'attempts.json'))};
const calls = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : [];
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
calls.push({ args, prompt, staleOutput: fs.existsSync(output) });
fs.writeFileSync(countFile, JSON.stringify(calls));
if (calls.length <= ${failures}) {
  fs.writeFileSync('example.txt', 'partial implementation\\n');
  fs.writeFileSync(output, 'stale failed response');
  process.stdout.write(${JSON.stringify(stdout)});
  process.stderr.write(${JSON.stringify(stderr ?? `${capacity}\n${capacity}\n`)});
  process.exit(1);
}
if (${writeSuccess}) fs.writeFileSync(output, args.includes('--output-schema') ? ${JSON.stringify(JSON.stringify(approval()))} : 'finished');
`);
  await chmod(executable, 0o755);
  runner.cleanEnv.PATH = `${bin}:${runner.cleanEnv.PATH}`;
  const waits = [];
  runner.wait = async ms => { waits.push(ms); };
  const calls = async () => JSON.parse(await readFile(join(runner.dir, 'attempts.json'), 'utf8'));
  return { runner, waits, calls, capacity };
}

test('capacity: повторы сохраняют настройки, частичный код и счётчик исправлений', async t => {
  const { runner, waits, calls } = await capacityFixture(t);
  runner.state = { fixRounds: 2 };
  assert.equal(await runner.codex('Complete Issue #8.'), 'finished');
  assert.deepEqual(waits, [15_000, 30_000]);
  const attempts = await calls(); assert.equal(attempts.length, 3);
  for (const attempt of attempts) {
    assert.deepEqual(attempt.args, attempts[0].args);
    assert.equal(attempt.staleOutput, false);
  }
  assert.ok(attempts[1].prompt.includes('сохраняя уже сделанную работу'));
  assert.equal(await readFile(join(runner.root, 'example.txt'), 'utf8'), 'partial implementation\n');
  assert.equal(runner.state.fixRounds, 2);
});

test('capacity: максимум три повтора, затем остановка с понятной причиной', async t => {
  const { runner, waits, calls } = await capacityFixture(t, { failures: 10 });
  await assert.rejects(runner.codex('Complete Issue #8.'), /перегруженной после трёх повторов/);
  assert.equal((await calls()).length, 4);
  assert.deepEqual(waits, [15_000, 30_000, 60_000]);
});

test('capacity: ревью повторяется только для чтения и возвращает свежий JSON', async t => {
  const { runner, waits, calls } = await capacityFixture(t, { failures: 1 });
  const report = JSON.parse(await runner.codex('Review Issue #8.', { review: true }));
  assert.equal(validateReview(report, head, base), true);
  const attempts = await calls(); assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].args, attempts[1].args);
  assert.ok(attempts[1].args.includes('read-only'));
  assert.equal(attempts[0].prompt, attempts[1].prompt);
  assert.deepEqual(waits, [15_000]);
});

test('capacity: квота, auth, неизвестная ошибка и сообщение только в stdout не повторяются', async t => {
  const capacity = 'ERROR: Selected model is at capacity. Please try a different model.';
  for (const options of [
    { stderr: "ERROR: You've hit your usage limit.\n" },
    { stderr: 'ERROR: 401 Unauthorized: fake-sensitive-value\n' },
    { stderr: 'Error: unknown failure\n' },
    { stderr: `${capacity}\nERROR: 401 Unauthorized\n` },
    { stderr: 'Error: unknown failure\n', stdout: capacity },
  ]) {
    const { runner, waits, calls } = await capacityFixture(t, options);
    await assert.rejects(runner.codex('Complete Issue #8.'), error => {
      assert.notEqual(error.code, 'CODEX_MODEL_CAPACITY');
      assert.ok(!error.message.includes('fake-sensitive-value'));
      return true;
    });
    assert.equal((await calls()).length, 1);
    assert.deepEqual(waits, []);
  }
});

test('capacity: Ctrl+C во время задержки прекращает повторы и сохраняет код', async t => {
  const { runner, calls } = await capacityFixture(t);
  const controller = new AbortController(); runner.signal = controller.signal;
  runner.wait = async (_, __, { signal }) => { controller.abort(); signal.throwIfAborted(); };
  await assert.rejects(runner.codex('Complete Issue #8.'), { name: 'AbortError' });
  assert.equal((await calls()).length, 1);
  assert.equal(await readFile(join(runner.root, 'example.txt'), 'utf8'), 'partial implementation\n');
});

test('capacity: успешный exit без нового ответа не использует оставшийся ответ неудачной попытки', async t => {
  const { runner, calls } = await capacityFixture(t, { failures: 1, writeSuccess: false });
  await assert.rejects(runner.codex('Complete Issue #8.'), { code: 'ENOENT' });
  assert.equal((await calls()).length, 2);
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

test('manual check pauses without fixes or merge, including repeated runs at the budget limit', async () => {
  const report = { ...approval(), verdict: 'manual_check_required',
    acceptance_criteria_met: false, summary: 'На телефоне: Play, ожидается звук; запишите результат.' };
  const io = fakeIO({ reports: [report], maxFixRounds: 3 });
  io.state.fixRounds = 3;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(processTask(io, {}, io.state), /Нужна ручная проверка.*\nНа телефоне:/);
    assert.equal(io.state.fixRounds, 3);
    assert.equal(io.events.includes('implement'), false);
    assert.equal(io.events.includes('merge'), false);
    assert.equal(io.events.at(-1), 'record');
  }
  io.review = async () => approval();
  await processTask(io, {}, io.state);
  assert.equal(io.events.at(-1), 'merge');
  assert.equal(io.state.fixRounds, 3);
});

test('fixable defects are repaired before a manual-only pause', async () => {
  const io = fakeIO({ reports: [rejection(), { ...approval(),
    verdict: 'manual_check_required', acceptance_criteria_met: false }] });
  await assert.rejects(processTask(io, {}, io.state), /Нужна ручная проверка/);
  assert.equal(io.state.fixRounds, 1);
  assert.equal(io.events.filter(e => e === 'implement').length, 1);
  assert.equal(io.events.includes('merge'), false);
});

test('manual verdict cannot hide code findings, pass acceptance, or bypass SHA validation', () => {
  const report = { ...approval(), verdict: 'manual_check_required', acceptance_criteria_met: false };
  assert.equal(validateReview(report, head, base), false);
  for (const invalid of [{ ...report, findings: [finding] },
    { ...report, acceptance_criteria_met: true }, { ...report, head_sha: base }]) {
    assert.throws(() => validateReview(invalid, head, base), /ревью/);
  }
});
