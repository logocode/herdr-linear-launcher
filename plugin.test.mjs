import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchName, fetchIssue, issueIdentifier, issuePrompt, shellQuote } from './plugin.mjs';

const script = fileURLToPath(new URL('./plugin.mjs', import.meta.url));
const issue = {
  identifier: 'ENG-1234', title: 'Fix domain validation',
  url: 'https://linear.app/example/issue/ENG-1234/fix-domain-validation',
  description: 'Reject an invalid domain.\nKeep valid domains working.',
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-linear-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo with spaces');
  const config = join(root, 'config');
  mkdirSync(repo);
  mkdirSync(config);
  execFileSync('git', ['init', '-q', '-b', 'develop', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'Test']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', repo]);
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD']);
  const log = join(root, 'herdr.jsonl');
  const binary = join(root, 'herdr');
  writeFileSync(binary, `#!${process.execPath}\nimport('node:fs').then(fs => {
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
    if (${Boolean(options.startFailure)} && args[0] === 'agent' && args[1] === 'start') { console.error('Agent did not become ready'); process.exit(1); }
    if (args[0] === 'plugin' && args[1] === 'config-dir') console.log(${JSON.stringify(config)});
    else if (args[0] === 'worktree' && args[1] === 'create') console.log(JSON.stringify({ result: { workspace: { workspace_id: 'w2' }, root_pane: { pane_id: 'w2:p1' }, worktree: { path: ${JSON.stringify(repo)} } } }));
    else console.log('{}');
  });\n`);
  chmodSync(binary, 0o755);
  const preload = join(root, 'fetch.mjs');
  writeFileSync(preload, `if (process.env.HERDR_TEST_TTY) {
    process.stdin.isTTY = true;
    process.stdin.setRawMode = () => {};
    process.stdout.columns = 68;
  }
  globalThis.fetch = async (url, options) => {
    if (url !== 'https://api.linear.app/graphql') throw new Error('Unexpected network request');
    return new Response(JSON.stringify(${JSON.stringify(options.payload || { data: { issue: options.issue || issue } })}), {status: ${options.status || 200}});
  };\n`);
  const env = { ...process.env, HERDR_BIN_PATH: binary, HERDR_PLUGIN_CONTEXT_JSON: '{}', LINEAR_API_KEY: 'fixture', ...options.env };
  return {
    root, repo, config,
    run(args, overrides = {}, input) {
      return spawnSync(process.execPath, ['--import', preload, script, ...args], { cwd: repo, env: { ...env, ...overrides }, input, encoding: 'utf8', timeout: 10000 });
    },
    calls() { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []; },
  };
}

test('accepts Linear links and identifiers, rejects unrelated or malformed input', () => {
  assert.equal(issueIdentifier(issue.url + '?comment=abc#thread'), 'ENG-1234');
  assert.equal(issueIdentifier(' eng-1234 '), 'ENG-1234');
  for (const input of ['https://linear.app.evil.test/x/issue/ENG-1234/x', 'http://linear.app/x/issue/ENG-1234/x', 'https://user:pass@linear.app/x/issue/ENG-1234/x', 'https://linear.app/x/project/ENG-1234', 'ENG-0', 'ENG-1234; touch x']) {
    assert.throws(() => issueIdentifier(input));
  }
});

test('branch names retain issue identity and use a bounded title slug', () => {
  assert.equal(branchName({ ...issue, title: 'Fix Café: a/b $(touch x)' }), 'linear/eng-1234-fix-cafe-a-b-touch-x');
  assert.equal(branchName({ ...issue, title: '你好' }), 'linear/eng-1234-issue');
  assert.ok(branchName({ ...issue, title: 'x'.repeat(1000) }).length < 110);
});

test('fetches every comment page, sorts comments, and sends read-only queries', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(options.headers.Authorization, 'fixture');
    assert.ok(body.query.startsWith('query '));
    const first = body.variables.after === null;
    return new Response(JSON.stringify({ data: { issue: { ...issue, comments: {
      nodes: [{ id: first ? 'new' : 'old', body: first ? 'Newer' : 'Older', createdAt: first ? '2026-09-14' : '2026-09-13' }],
      pageInfo: { hasNextPage: first, endCursor: first ? 'cursor-1' : null },
    } } } }));
  });
  const result = await fetchIssue(issue.url, 'fixture');
  assert.deepEqual(calls.map((call) => call.variables), [{ id: 'ENG-1234', after: null }, { id: 'ENG-1234', after: 'cursor-1' }]);
  assert.deepEqual(result.comments.map((comment) => comment.id), ['old', 'new']);
});

test('rejects GraphQL errors even when HTTP succeeds', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { issue }, errors: [{ message: 'Not authorized' }] })));
  await assert.rejects(fetchIssue('ENG-1234', 'fixture'), /Not authorized/);
});

test('rejects incomplete data and stalled pagination', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { issue: { ...issue, comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } } })));
  await assert.rejects(fetchIssue('ENG-1234', 'fixture'), /pagination did not advance/);
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { issue: null } }));
  await assert.rejects(fetchIssue('ENG-1234', 'fixture'), /not found/);
});

test('prompt contains issue details and comment context without terminal controls', () => {
  const prompt = issuePrompt({ ...issue, comments: [{ id: 'c2', parent: { id: 'c1' }, user: { displayName: 'Reviewer' }, body: 'Keep this case.\x1b\x03', createdAt: '2026-09-14' }] });
  for (const value of [issue.identifier, issue.title, issue.url, issue.description, 'Reviewer', 'Keep this case.', 'reply to c1']) assert.ok(prompt.includes(value));
  assert.ok(!/[\x1b\x03]/.test(prompt));
  assert.match(prompt, /setup may run concurrently/);
  assert.match(prompt, /herdr-setup-status/);
});

test('shell quoting delivers the exact initial prompt without executing issue text', (t) => {
  const f = fixture(t);
  const marker = join(f.root, 'must-not-exist');
  const output = join(f.root, 'argv.json');
  const prompt = `Handle O'Reilly\n$(touch ${marker}) \`touch ${marker}\` "; touch ${marker}; #`;
  const capture = join(f.root, 'capture.mjs');
  writeFileSync(capture, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  const command = [process.execPath, capture, '-C', f.repo, prompt].map(shellQuote).join(' ');
  execFileSync('/bin/sh', ['-c', command]);
  assert.deepEqual(JSON.parse(readFileSync(output)), ['-C', f.repo, prompt]);
  assert.equal(existsSync(marker), false);
});

test('launch creates a background worktree and immediately starts Codex with the prompt', (t) => {
  const f = fixture(t, { issue: { ...issue, title: 'Fix "domain" validation' } });
  const result = f.run(['launch', issue.url]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const create = calls.find((args) => args[0] === 'worktree' && args[1] === 'create');
  assert.deepEqual(create, ['worktree', 'create', '--cwd', f.repo, '--branch', 'linear/eng-1234-fix-domain-validation', '--base', 'origin/develop', '--label', 'Fix "domain" validation', '--no-focus']);
  assert.deepEqual(calls.at(-1), ['pane', 'run', 'w2:p1', `cd ${shellQuote(f.repo)} && ${['codex', '-C', f.repo, '-c', `projects={${JSON.stringify(f.repo)}={trust_level="trusted"}}`, issuePrompt({ ...issue, title: 'Fix "domain" validation', comments: [] })].map(shellQuote).join(' ')}`]);
  assert.equal(calls.some((args) => args.includes('--focus') || args.includes('focus')), false);
});

test('Claude receives the same initial prompt in the new worktree', (t) => {
  const f = fixture(t);
  const result = f.run(['launch', issue.url, 'claude']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().at(-1), ['pane', 'run', 'w2:p1', `cd ${shellQuote(f.repo)} && ${['claude', issuePrompt({ ...issue, comments: [] })].map(shellQuote).join(' ')}`]);
});

test('unsupported agents are rejected before creating a worktree', (t) => {
  const f = fixture(t);
  const result = f.run(['launch', issue.url, 'other']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose codex or claude/);
  assert.equal(f.calls().length, 0);
});

test('fetch failure prevents a stale worktree and agent launch', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.repo, 'remote', 'set-url', 'origin', join(f.root, 'missing-repo')]);
  const result = f.run(['launch', issue.url]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git fetch failed/);
  assert.equal(f.calls().length, 0);
});

test('authentication failures cannot create a worktree or start an agent', (t) => {
  const f = fixture(t, { status: 401 });
  const result = f.run(['launch', issue.url]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 401/);
  assert.equal(f.calls().length, 0);
});

test('a repeated issue link reopens its existing worktree even after a title change', (t) => {
  const f = fixture(t);
  const checkout = join(f.root, 'existing');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-q', '-b', 'linear/eng-1234-old-title', checkout]);
  const result = f.run(['launch', issue.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [['worktree', 'open', '--cwd', f.repo, '--path', checkout, '--no-focus']]);
  assert.match(result.stdout, /without restarting its agent/);
});

test('an existing issue branch without a checkout is not reused automatically', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.repo, 'branch', 'linear/eng-1234-old-title']);
  const result = f.run(['launch', issue.url]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already has a local branch/);
  assert.equal(f.calls().length, 0);
});

test('setup callback does not start a second agent for a Linear worktree', (t) => {
  const f = fixture(t);
  const result = f.run(['start-agent'], { HERDR_PANE_ID: 'w2:p1', HERDR_WORKTREE: f.repo, HERDR_BRANCH: 'linear/eng-1234-fix-domain-validation' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), []);
});

test('ordinary worktrees keep their unprompted Codex startup', (t) => {
  const f = fixture(t, { status: 401, env: { LINEAR_API_KEY: '' } });
  const result = f.run(['start-agent'], { HERDR_PANE_ID: 'w2:p1', HERDR_WORKTREE: f.repo, HERDR_BRANCH: 'my-feature' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [['pane', 'run', 'w2:p1', ['codex', '-C', f.repo, '-c', `projects={${JSON.stringify(f.repo)}={trust_level="trusted"}}`].map(shellQuote).join(' ')]]);
});

test('Linear setup callback no longer needs to fetch the issue', (t) => {
  const f = fixture(t, { status: 403 });
  const result = f.run(['start-agent'], { HERDR_PANE_ID: 'w2:p1', HERDR_WORKTREE: f.repo, HERDR_BRANCH: 'linear/eng-1234-test' });
  assert.equal(result.status, 0);
  assert.equal(f.calls().length, 0);
});

test('plan prompt asks for approval before implementation and includes user context', () => {
  const prompt = issuePrompt({ ...issue, comments: [] }, 'plan', 'Focus on the API.\nKeep the UI unchanged.');
  assert.match(prompt, /^Plan the Linear issue/);
  assert.match(prompt, /Do not implement changes until the user approves/);
  assert.doesNotMatch(prompt, /Start inspecting and editing|run appropriate verification/);
  assert.match(prompt, /## Additional context from the user\nFocus on the API.\nKeep the UI unchanged\.$/);
  assert.doesNotMatch(issuePrompt({ ...issue, comments: [] }, 'normal', '  '), /Additional context/);
});

test('Codex plan mode starts immediately and submits the complete prompt only after readiness', (t) => {
  const f = fixture(t);
  const context = "Use O'Reilly's case.\n$(touch must-not-run)";
  const result = f.run(['launch', issue.url, 'codex', 'plan', context]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.slice(-2), [
    ['agent', 'start', 'linear-eng-1234', '--kind', 'codex', '--pane', 'w2:p1', '--timeout', '30000', '--', '-C', f.repo, '-c', `projects={${JSON.stringify(f.repo)}={trust_level="trusted"}}`],
    ['agent', 'prompt', 'w2:p1', `/plan ${issuePrompt({ ...issue, comments: [] }, 'plan', context)}`],
  ]);
  assert.equal(calls.at(-3)[1], 'create');
  assert.equal(calls.some((args) => args.includes('--focus')), false);
});

test('failed Codex readiness never sends the issue text to a shell', (t) => {
  const f = fixture(t, { startFailure: true });
  const result = f.run(['launch', issue.url, 'codex', 'plan', 'Extra context']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Agent did not become ready/);
  assert.equal(f.calls().at(-1)[1], 'start');
  assert.equal(f.calls().some((args) => args[1] === 'prompt'), false);
});

test('Claude plan mode uses its native permission mode with user context', (t) => {
  const f = fixture(t);
  const context = 'Keep the existing API.\nCheck both clients.';
  const result = f.run(['launch', issue.url, 'claude', 'plan', context]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().at(-1), ['pane', 'run', 'w2:p1', `cd ${shellQuote(f.repo)} && ${['claude', '--permission-mode', 'plan', issuePrompt({ ...issue, comments: [] }, 'plan', context)].map(shellQuote).join(' ')}`]);
});

test('both agents receive additional context in normal mode without enabling plan mode', (t) => {
  for (const agent of ['codex', 'claude']) {
    const f = fixture(t);
    const context = "Keep O'Reilly's example.\nCheck the API.";
    const result = f.run(['launch', issue.url, agent, 'normal', context]);
    assert.equal(result.status, 0, result.stderr);
    const command = f.calls().at(-1)[3];
    assert.ok(command.includes(shellQuote(issuePrompt({ ...issue, comments: [] }, 'normal', context))));
    assert.ok(!command.includes('--permission-mode'));
    assert.ok(!command.includes('/plan '));
  }
});

test('invalid modes are rejected before accessing Linear or creating a worktree', (t) => {
  const f = fixture(t);
  const result = f.run(['launch', issue.url, 'codex', 'other']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose normal or plan/);
  assert.deepEqual(f.calls(), []);
});

test('modal defaults to Codex normal mode and accepts an empty context', (t) => {
  const f = fixture(t);
  const result = f.run(['form'], { HERDR_TEST_TTY: '1' }, 'ENG-1234\x13');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Additional context \(optional\)/);
  assert.equal(f.calls().at(-1)[1], 'run');
  assert.ok(f.calls().at(-1)[3].includes("'codex'"));
  assert.ok(!f.calls().at(-1)[3].includes('Additional context from the user'));
});

test('modal selects agent and plan mode and preserves pasted multiline context', (t) => {
  const f = fixture(t);
  const context = "Keep O'Reilly's API.\n\nCheck $(touch must-not-run) and café.";
  const input = `ENG-1234\t\x1b[C\t \t\x1b[200~${context}\x1b[201~\t\r`;
  const result = f.run(['form'], { HERDR_TEST_TTY: '1' }, input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().at(-1), ['pane', 'run', 'w2:p1', `cd ${shellQuote(f.repo)} && ${['claude', '--permission-mode', 'plan', issuePrompt({ ...issue, comments: [] }, 'plan', context)].map(shellQuote).join(' ')}`]);
});

test('modal retains fields when navigating backward and supports editing context', (t) => {
  const f = fixture(t);
  const input = 'ENG-1234\t\t\tFirst\rSecnd\x1b[D\x1b[Do\x1b[F\x1b[Z\x1b[C\t\x13';
  const result = f.run(['form'], { HERDR_TEST_TTY: '1' }, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().at(-1)[1], 'prompt');
  assert.ok(f.calls().at(-1)[3].endsWith('First\nSecond'));
});

test('Escape closes the modal from every field without launching', (t) => {
  for (let field = 0; field < 5; field++) {
    const f = fixture(t);
    const result = f.run(['form'], { HERDR_TEST_TTY: '1' }, 'ENG-1234' + '\t'.repeat(field) + '\x1b');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), []);
  }
});

test('modal validates the issue before launch and can recover without losing context', (t) => {
  const f = fixture(t);
  const result = f.run(['form'], { HERDR_TEST_TTY: '1' }, 'bad\t\t\tKeep this\x13\x15ENG-1234\x13');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Paste a Linear issue URL/);
  assert.ok(f.calls().at(-1)[3].includes('Keep this'));
});
