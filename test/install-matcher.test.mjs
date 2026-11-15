// `readfirst hook --install` and a readfirst hook installed before it read Bash commands. Until this test, install
// found the hook already there (matcher Edit|Write|MultiEdit) and left it so: the hook never saw a file a Bash command
// wrote, nor a `readfirst read` or `find` run in Bash. Now Bash is added to that entry's matcher; its command (with or
// without --gate), the other entries and the rest of the file stay as they were, and a second install writes nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installHook, main } from '../src/cli.mjs';

function repoWith(settingsText) {
  const root = mkdtempSync(join(tmpdir(), 'readfirst-install-matcher-'));
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), settingsText);
  return root;
}
const read = (root) => readFileSync(join(root, '.claude/settings.json'), 'utf8');

// A settings file written by hand: four spaces, keys in its own order, a user's own hook on Bash, another tool's hook,
// the readfirst hook with --gate on the narrow matcher, and the Stop hook.
const OLD = `{
    "permissions": { "allow": ["Bash(ls)"] },
    "hooks": {
        "PreToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./my-guard.sh" }] },
            { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "npx --yes readfirst hook --gate", "timeout": 15 }] },
            { "matcher": "Write", "hooks": [{ "type": "command", "command": "prettier --check" }] }
        ],
        "Stop": [{ "hooks": [{ "type": "command", "command": "npx --yes readfirst hook --stop", "timeout": 1800 }] }]
    }
}
`;

test('install adds Bash and NotebookEdit to the matcher of an old readfirst hook and changes nothing else', () => {
  const root = repoWith(OLD);
  const widened = OLD.replace('"Edit|Write|MultiEdit"', '"Edit|Write|MultiEdit|NotebookEdit|Bash"');
  assert.equal(installHook(root), 'matcher');
  assert.equal(read(root), widened, 'only the matcher, in the file\'s own layout');
  const pre = JSON.parse(read(root)).hooks.PreToolUse;
  assert.equal(pre[1].hooks[0].command, 'npx --yes readfirst hook --gate', 'the command is the user\'s: --gate stays');
  assert.equal(installHook(root), false, 'a second install writes nothing');
  assert.equal(read(root), widened);
});

test('a hook without --gate keeps having none; a matcher that already covers Bash and NotebookEdit is left alone', () => {
  const plain = repoWith(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] }] } }, null, 2)}\n`);
  assert.equal(installHook(plain), 'matcher');
  assert.deepEqual(JSON.parse(read(plain)).hooks.PreToolUse, [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] }]);
  for (const matcher of ['Edit|Write|MultiEdit|NotebookEdit|Bash', '*', '', '.*', 'Bash|NotebookEdit|Edit|Write|MultiEdit']) {
    const text = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'npx readfirst hook' }] }] } })}\n`;
    const root = repoWith(text);
    assert.equal(installHook(root), false, JSON.stringify(matcher));
    assert.equal(read(root), text, `${JSON.stringify(matcher)}: untouched`);
  }
});

test('when the old matcher is written twice in the file, it is written out as JSON with the same contents', () => {
  const twice = { hooks: { PreToolUse: [
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'prettier --check' }] },
    { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] },
  ] } };
  const root = repoWith(JSON.stringify(twice));
  assert.equal(installHook(root), 'matcher');
  const pre = JSON.parse(read(root)).hooks.PreToolUse;
  assert.deepEqual(pre[0], twice.hooks.PreToolUse[0], 'the other entry with the same matcher is not widened');
  assert.equal(pre[1].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
});

// Review of 3ff928a: install knew its hook only as `readfirst hook`, so a hook run from a checkout
// (`node "$CLAUDE_PROJECT_DIR/bin/readfirst.mjs" hook --gate`, as this repository's own) was not seen and a second
// PreToolUse entry was added: the hook ran twice on every call. And an old matcher without MultiEdit stayed without it.
test('install knows its hook however it is run, and adds no second entry', () => {
  const LOCAL = 'node "$CLAUDE_PROJECT_DIR/bin/readfirst.mjs" hook --gate';
  const current = repoWith(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: LOCAL, timeout: 15 }] }], Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/bin/readfirst.mjs" hook --stop' }] }] } }, null, 2)}\n`);
  const before = read(current);
  assert.equal(installHook(current, { verify: true }), false, 'the hook and the Stop hook are there');
  assert.equal(read(current), before);
  const old = repoWith(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: LOCAL }] }] } })}\n`);
  assert.equal(installHook(old), 'matcher');
  const pre = JSON.parse(read(old)).hooks.PreToolUse;
  assert.equal(pre.length, 1, 'no second entry');
  assert.equal(pre[0].hooks[0].command, LOCAL, 'its command is left as it was');
});

test('an old matcher without MultiEdit gets it too', () => {
  const root = repoWith(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] }] } })}\n`);
  assert.equal(installHook(root), 'matcher');
  assert.deepEqual(JSON.parse(read(root)).hooks.PreToolUse[0].matcher.split('|').sort(), ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
});

// Review of #218 (ledger, 2026-11-14): install knew its hook by one pattern of spellings. A PreToolUse entry holding
// only `readfirst hook --stop` counted as the hook, so none was added; a version or an option before `hook`, or a
// Windows path, was not seen and a second entry was added; `readfirst hook-x` counted; and a matcher that is no valid
// pattern was widened into another invalid one. A command is now read by its words: the readfirst program, then its
// first word that is not an option, which must be `hook`.
const settingsWith = (pre) => `${JSON.stringify({ hooks: { PreToolUse: pre } }, null, 2)}\n`;
const entry = (command, matcher = 'Edit|Write|MultiEdit|NotebookEdit|Bash') => ({ matcher, hooks: [{ type: 'command', command }] });

test('a PreToolUse entry that only runs the Stop hook is not the hook: install adds it', () => {
  const root = repoWith(settingsWith([entry('npx --yes readfirst hook --stop')]));
  assert.equal(installHook(root), true);
  const pre = JSON.parse(read(root)).hooks.PreToolUse;
  assert.equal(pre.length, 2);
  assert.ok(pre.some((m) => m.hooks.some((h) => h.command === 'npx --yes readfirst hook')), 'the PreToolUse hook is there now');
});

test('the hook is known by its words however readfirst is named or optioned, and only `hook` is the hook', () => {
  for (const command of ['npx readfirst@^1.2 hook', 'readfirst@1.2.3-beta+x hook --gate', 'node C:\\x\\readfirst.mjs hook', 'npx readfirst --no-color hook', 'pnpm dlx readfirst hook', 'bunx readfirst hook']) {
    const root = repoWith(settingsWith([entry(command)]));
    assert.equal(installHook(root), false, command);
  }
  const other = repoWith(settingsWith([entry('npx readfirst hook-x')]));
  assert.equal(installHook(other), true, 'hook-x is another command');
  assert.equal(JSON.parse(read(other)).hooks.PreToolUse.length, 2);
});

// Review of 299934b: the words were read only right after the first launcher, so a hook the old pattern found was no
// longer seen and a second entry was added: run by a shell's -c, by npm exec or bun x, or by npx with -p <package>.
// Every hook form the old pattern found is listed here; a launcher's option that takes a value skips that value, and a
// -c string (sh, bash, npx --call) is read as a command of its own.
const OLD_FORMS = [
  'sh -c "npx readfirst hook"', "bash -c 'npx --yes readfirst hook --gate'", 'bash -lc "npx readfirst hook"', '/bin/sh -c "readfirst hook"',
  'npx -c "readfirst hook"', 'npx -p readfirst readfirst hook', 'npx --package readfirst readfirst hook', 'npx --yes -p readfirst@1 readfirst hook',
  'npx --package=readfirst readfirst hook', 'npm exec -- readfirst hook', 'npm exec readfirst hook', 'npm exec --yes -- readfirst hook',
  'npm x readfirst hook', 'bun x readfirst hook', 'yarn dlx readfirst hook', 'pnpm exec readfirst hook', 'pnpm --silent dlx readfirst hook',
  'env FOO=1 npx readfirst hook', 'cd x && npx readfirst hook', 'npx readfirst hook; echo done', 'node -r ./trace.cjs bin/readfirst.mjs hook',
  '/usr/bin/env node bin/readfirst.mjs hook', 'nice npx readfirst hook', 'npx -y readfirst@latest hook',
];
test('every hook form the old pattern found is still the hook: install adds no second entry', () => {
  for (const command of OLD_FORMS) {
    const root = repoWith(settingsWith([entry(command)]));
    assert.equal(installHook(root), false, command);
  }
  for (const command of ['sh -c "npx readfirst hook --stop"', 'npm exec -- readfirst hook --stop']) {
    const text = `${JSON.stringify({ hooks: { PreToolUse: [entry('npx readfirst hook')], Stop: [{ hooks: [{ type: 'command', command }] }] } }, null, 2)}\n`;
    const root = repoWith(text);
    assert.equal(installHook(root, { verify: true }), false, command);
    assert.equal(read(root), text);
  }
  for (const command of ['echo readfirst hook', 'sh -c "echo readfirst hook"', 'npx -p readfirst hook']) {
    const root = repoWith(settingsWith([entry(command)]));
    assert.equal(installHook(root), true, `${command}: not the hook`);
  }
});

test('a readfirst hook whose matcher is no valid pattern is left alone, and install says it cannot widen it', () => {
  const text = settingsWith([entry('npx --yes readfirst hook', 'Edit|Write(')]);
  const root = repoWith(text);
  assert.throws(() => installHook(root), /matcher `Edit\|Write\(` is not a valid pattern/u);
  assert.equal(read(root), text, 'nothing was written');
});

test('hook --install says what it did to an old hook', () => {
  const root = repoWith(OLD);
  let out = '';
  assert.equal(main(['--root', root, 'hook', '--install'], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.match(out, /added what the readfirst hook's matcher in \.claude\/settings\.json did not cover of the tools it reads \(Edit, Write, MultiEdit, NotebookEdit, Bash\)[^\n]*its command was left as it was/u);
});
