import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashWrites, codeTargets } from '../src/bash-writes.mjs';

test('bashWrites: where a command writes, not every file it names', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w(`sed -i 's/a/b/' src/x.mjs`), ['/r/src/x.mjs']);
  assert.deepEqual(w('perl -pi -e "s/a/b/" lib/y.pl'), ['/r/lib/y.pl']);
  assert.deepEqual(w('cat src/a.js > /tmp/out.txt && npm test'), ['/tmp/out.txt']);
  assert.deepEqual(w('cd /r/sub && echo hi >> notes.md'), ['/r/sub/notes.md']);
  assert.deepEqual(w("python3 - <<'E'\np='src/map.mjs'; s=open(p).read()\nopen(p,'w').write(s)\nE"), ['/r/src/map.mjs']);
  assert.deepEqual(w("python3 - <<'E'\nprint(open('src/map.mjs').read())\nE"), [], 'a script that only reads');
  assert.deepEqual(w("cat > test/x.test.mjs <<'E'\nimport fs from 'node:fs'; fs.writeFileSync('a.json', '')\nE"), ['/r/test/x.test.mjs'], 'a here-document fed to cat is data');
  assert.deepEqual(w('cp vendor/a.js lib/a.js'), ['/r/lib/a.js']);
  assert.deepEqual(w('echo x | tee -a log/a.txt b.txt'), ['/r/log/a.txt', '/r/b.txt']);
  assert.deepEqual(w('git checkout -- src/a.js'), ['/r/src/a.js']);
  assert.deepEqual(w('grep -n foo src/a.js 2>/dev/null | head'), []);
  assert.deepEqual(w('node --test test/a.test.mjs 2>&1 | tail -3'), []);
  assert.deepEqual(w('ls > $OUT'), [], 'a variable is not a path we can name');
});

// readfirst's own sessions, 2026-11-08: a script that wrote one file flagged every path-like word in it.
test('bashWrites: a script counts the targets of its write calls, not the words it names', () => {
  const w = (c) => bashWrites(c, '/r');
  const py = (body, head = 'python3 -') => w(`${head} <<'E'\n${body}\nE`);
  assert.deepEqual(py("p='HANDOFF.md'; s=open(p).read()\ns=s.replace('0.015', 'src/money.js /u.test')\nopen(p,'w').write(s)"), ['/r/HANDOFF.md'], 'numbers, regex and test data are not files');
  assert.deepEqual(py("import sys\np=sys.argv[1]; s=open(p).read()\nopen(p,'w').write(s)", 'python3 - src/cli.mjs'), ['/r/src/cli.mjs'], 'sys.argv: the script argument');
  assert.deepEqual(py("def rep(p, a, b):\n  s=open(p).read(); open(p,'w').write(s.replace(a, b))\nrep('docs/guide.md', 'x.md', 'y.md')"), ['/r/docs/guide.md'], 'a parameter, from the call');
  assert.deepEqual(py("for p in ['src/a.mjs', 'src/b.mjs']:\n  open(p,'w').write('')"), ['/r/src/a.mjs', '/r/src/b.mjs'], 'a for-loop over literals');
  assert.deepEqual(w(`node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('.readfirst/map.json','utf8')); m.groups.find((g)=>g.id==='x').risks.push({files:['lib/a.mjs']});\nfs.writeFileSync('.readfirst/map.json', JSON.stringify(m))" && git diff`), ['/r/.readfirst/map.json'], 'node -e: one segment through its ; and newline');
  assert.deepEqual(w(`node -e "console.log([1,2].map((a)=>a>1))"`), [], 'an arrow in quoted code is not a redirect');
  assert.deepEqual(w('echo hi >> "my notes.md"'), ['/r/my notes.md'], 'a quoted redirect target');
  assert.deepEqual(w(`python3 -c "open('out.txt','w').write('x')"`), ['/r/out.txt']);
  assert.deepEqual(w(`node bin/x.mjs read a.mjs; cat > t.mjs <<'E'\nfs.writeFileSync('a.json', '')\nE`), ['/r/t.mjs'], 'the here-document goes to cat, not to the node before the ;');
});

test('codeTargets: glob loops expand, unresolved writes fall back to named files that exist', () => {
  const glob = (p) => (p === 'docs/*.md' ? ['docs/a.md', 'docs/b.md'] : []);
  assert.deepEqual(codeTargets("import glob\nfor p in glob.glob('docs/*.md'):\n  open(p,'w').write('')", { glob }), ['docs/a.md', 'docs/b.md']);
  const exists = (p) => p === 'src/real.mjs';
  assert.deepEqual(codeTargets("open(f'{d}/x.mjs','w')\n# see src/real.mjs and 0.015", { exists }), ['src/real.mjs']);
});

test('bashWrites: a file the script names and does not write stays out, even when it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  mkdirSync(join(dir, 'src'));
  for (const f of ['HANDOFF.md', 'src/read.mjs']) writeFileSync(join(dir, f), '');
  const got = bashWrites(`python3 - <<'E'\np='HANDOFF.md'; s=open(p).read() + open('src/read.mjs').read()\nopen(p,'w').write(s)\nE`, dir);
  assert.deepEqual(got, [join(dir, 'HANDOFF.md')]);
  // A target built at run time cannot be named: the files it names that exist stand in for it.
  assert.deepEqual(bashWrites(`python3 - <<'E'\np=root + 'src/read.mjs'\nopen(p,'w').write('')\nE`, dir), [join(dir, 'src/read.mjs')]);
});

// 2026-11-08: `cd /home/user/readfirst-cloud && python3 - <<E` writing .github/workflows/ci.yml showed readfirst's notes.
test('bashWrites: a here-document writes where the cds before it moved to', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w("cd /other && python3 - <<'E'\np='ci.yml'; open(p,'w').write('')\nE"), ['/other/ci.yml']);
  assert.deepEqual(w("cd sub && cat > a.md <<'E'\nx\nE\ncd /b && python3 - <<'F'\nopen('c.md','w')\nF").sort(), ['/b/c.md', '/r/sub/a.md'], 'each here-document after its own cd');
  assert.deepEqual(w("python3 - <<'E'\nimport os; os.system('cd /elsewhere')\nopen('x.md','w')\nE"), ['/r/x.md'], 'a cd inside a body is code, not a move');
});

// 2026-11-08: `D=/tmp/x && cd $D && cat > a.test.js <<E` showed `$D/a.test.js` under the session's folder.
test('bashWrites: after a cd to a variable, relative paths are not named; absolute ones still are', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w("cd $D && cat > a.test.js <<'E'\nx\nE"), []);
  assert.deepEqual(w('cd "$(dirname x)" && echo hi > b.md && echo hi > /abs/c.md'), ['/abs/c.md']);
  assert.deepEqual(w('cd $D && cd /known && echo x > d.md'), ['/known/d.md'], 'an absolute cd after it is known again');
  assert.deepEqual(w("cd ~/proj && echo x > e.md")[0].endsWith('/proj/e.md'), true);
});

// 2026-11-09: `cd readfirst-cloud && (cd ../readfirst && git archive ...) | tar ... && echo x > package.json` showed the
// readfirst map's notes for readfirst-cloud's package.json: the cd inside ( ) carried on past its `)`. The `)` also stuck
// to the last word (`sed -i ... f.txt)` named `f.txt)`), and a redirect after the `)` was put inside the subshell's folder.
test('bashWrites: a cd inside ( ) ends at its ), and what follows the ) is the outer shell\'s', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w('cd /a && (cd /b && git archive HEAD src) | tar -x -C v && echo x > package.json'), ['/a/package.json']);
  assert.deepEqual(w('cd /a && (cd /b && true) && echo x > f'), ['/a/f']);
  assert.deepEqual(w('(cd /b && sed -i s/a/b/ f.txt)'), ['/b/f.txt'], 'the ) is not part of the file name');
  assert.deepEqual(w('(cd /b && make) > log'), ['/r/log'], 'the subshell\'s output goes where the outer shell is');
  assert.deepEqual(w('( (cd /b && true) ; echo z > i ) ; echo w > j'), ['/r/i', '/r/j'], 'nested');
  assert.deepEqual(w('(cd /b && python3 - <<E\nopen("o.txt", "w").write("")\nE\n) && echo > after.txt'), ['/b/o.txt', '/r/after.txt'], 'a here-document inside');
  assert.deepEqual(w('cd /a && (cd /b && cat > x.txt <<E\nhi\nE\n) && python3 - <<E\nopen("y.txt", "w").write("")\nE').sort(), ['/a/y.txt', '/b/x.txt'], 'the here-document after the ) starts in the outer folder');
  // Look-alikes: a { } group runs in this shell, so its cd stays; parentheses that open and close in one command, and a
  // case pattern's ), change nothing.
  assert.deepEqual(w('{ cd /b && true; } && echo x > f'), ['/b/f'], 'a group is not a subshell');
  assert.deepEqual(w('x=$(cd /b; pwd) && echo q > k'), ['/r/k'], 'a cd inside $( ) ends there too');
  assert.deepEqual(w('(( x > 0 )) && echo a > g'), ['/r/g']);
  assert.deepEqual(w('case $x in a) true ;; esac; echo y > h'), ['/r/h']);
  assert.deepEqual(w('(cd /b && npm test)'), [], 'a subshell that only runs tests writes nothing');
});

// 2026-11-10: `sed -i ... $(grep -rln x src test docs)` was split inside the $( ), and src, test and `docs)` were named
// as the files sed writes; the hook put readfirst's notes on paths like `0\.29\.2` and `docs)`.
test('a $( ) or backtick argument is one word, and what it expands to is not named', () => {
  const w = (c) => bashWrites(c, '/r');
  assert.deepEqual(w('sed -i "s/a/b/g" $(grep -rln "x" src test docs)'), [], 'the files come from grep: not known here');
  assert.deepEqual(w('sed -i "s/a/b/g" $(git ls-files src) README.md'), ['/r/README.md'], 'a literal file beside it still counts');
  assert.deepEqual(w('sed -i s/a/b/ `ls src` x.txt'), ['/r/x.txt'], 'backticks the same way');
  assert.deepEqual(w('sed -i "s/a/b/" $(find . -name "*.md" -newer (x)) y.txt'), ['/r/y.txt'], 'one level of brackets inside');
  assert.deepEqual(w('echo "$(cat a b)" > out.txt'), ['/r/out.txt'], 'a redirect after it is still a write');
});
