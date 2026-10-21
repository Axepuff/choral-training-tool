// Explicit integration check: requires Codex CLI, but never calls a model.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Runner } from './runner.mjs';

const cli = process.env.CHORAL_TEST_CODEX_BIN || 'codex';
const missingProvider = 'choral_queue_offline_config_probe';

async function invocation(t, review) {
  const dir = await mkdtemp(join(tmpdir(), 'choral-codex-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'codex-home');
  await mkdir(home);
  const runner = new Runner(dir, {
    env: { ...process.env, CODEX_HOME: home }, log: () => {},
  });
  runner.dir = dir;
  // Capture the actual production invocation without executing its OpenAI provider.
  const command = runner.command.bind(runner);
  let args;
  runner.command = async (_, actualArgs) => {
    args = actualArgs;
    await writeFile(args[args.indexOf('--output-last-message') + 1], '{}');
  };
  await runner.codex('Configuration parser test only.', { review });
  // The last config override wins. An unknown provider fails before auth/inference.
  args.splice(args.length - 1, 0, '-c', `model_provider="${missingProvider}"`);
  return { args, command };
}

test('regression control: enabled=false without a transport reproduces invalid transport', async t => {
  const { args, command } = await invocation(t, false);
  const url = args.findIndex(a => a.startsWith('mcp_servers.choral_storybook.url='));
  assert.ok(url > 0, 'Production invocation must include a complete transport.');
  args.splice(url - 1, 2);
  const result = await command(cli, args, { input: 'Parser check.', allowFailure: true, timeout: 15_000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid transport/);
  assert.match(result.stderr, /mcp_servers\.choral_storybook/);
});

for (const review of [false, true]) {
  test(`real Codex parses the ${review ? 'review' : 'implementation'} invocation with disabled Storybook MCP`, async t => {
    const { args, command } = await invocation(t, review);
    const result = await command(cli, args, { input: 'Parser check.', allowFailure: true, timeout: 15_000 });
    assert.equal(result.code, 1); // Expected refusal: the probe provider does not exist.
    assert.match(result.stderr, new RegExp(`Model provider .${missingProvider}. not found`));
    assert.doesNotMatch(result.stderr, /invalid transport|Error loading config/);
  });
}

test('real Codex recognizes the HTTP transport and keeps Storybook MCP disabled', async t => {
  const { args, command } = await invocation(t, false);
  const overrides = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && args[i + 1].startsWith('mcp_servers.choral_storybook.')) {
      overrides.push(args[i], args[++i]);
    }
  }
  const result = await command(cli, ['mcp', 'list', '--json', ...overrides], { timeout: 15_000 });
  const servers = JSON.parse(result.output);
  const storybook = servers.find(server => server.name === 'choral_storybook');
  assert.ok(storybook);
  assert.equal(storybook.enabled, false);
  assert.equal(storybook.transport.type, 'streamable_http');
  assert.equal(storybook.transport.url, 'http://127.0.0.1:6006/mcp');
});
