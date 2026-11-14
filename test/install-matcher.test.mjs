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

test('hook --install says what it did to an old hook', () => {
  const root = repoWith(OLD);
  let out = '';
  assert.equal(main(['--root', root, 'hook', '--install'], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.match(out, /added what the readfirst hook's matcher in \.claude\/settings\.json did not cover of the tools it reads \(Edit, Write, MultiEdit, NotebookEdit, Bash\)[^\n]*its command was left as it was/u);
});
