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

test('install adds Bash to the matcher of an old readfirst hook and changes nothing else', () => {
  const root = repoWith(OLD);
  assert.equal(installHook(root), 'matcher');
  assert.equal(read(root), OLD.replace('"Edit|Write|MultiEdit"', '"Edit|Write|MultiEdit|Bash"'), 'only the matcher, in the file\'s own layout');
  const pre = JSON.parse(read(root)).hooks.PreToolUse;
  assert.equal(pre[1].hooks[0].command, 'npx --yes readfirst hook --gate', 'the command is the user\'s: --gate stays');
  assert.equal(installHook(root), false, 'a second install writes nothing');
  assert.equal(read(root), OLD.replace('"Edit|Write|MultiEdit"', '"Edit|Write|MultiEdit|Bash"'));
});

test('a hook without --gate keeps having none; a matcher that already covers Bash is left alone', () => {
  const plain = repoWith(`${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] }] } }, null, 2)}\n`);
  assert.equal(installHook(plain), 'matcher');
  assert.deepEqual(JSON.parse(read(plain)).hooks.PreToolUse, [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: 'npx --yes readfirst hook' }] }]);
  for (const matcher of ['Edit|Write|MultiEdit|Bash', '*', '', '.*', 'Bash|Edit']) {
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
  assert.equal(pre[1].matcher, 'Edit|Write|MultiEdit|Bash');
});

test('hook --install says what it did to an old hook', () => {
  const root = repoWith(OLD);
  let out = '';
  assert.equal(main(['--root', root, 'hook', '--install'], { out: (s) => { out += s; }, err: () => {} }), 0);
  assert.match(out, /added Bash to the readfirst hook's matcher in \.claude\/settings\.json[^\n]*its command was left as it was/u);
});
