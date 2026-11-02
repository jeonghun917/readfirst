// The map file: groups of files with what to check and what to watch out for, plus project rules.
// Paths are repository paths with forward slashes. A pattern is a path, a folder ending in "/**", or a "*" glob
// within one path segment ("src/*.js", "*.md"). Every tracked file belongs to exactly one group or to "ignore".

export const MAP_FORMAT = 'readfirst/map@1';
export const MAP_PATH = '.readfirst/map.json';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 2000) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

export function patternToRegExp(pattern) {
  // Within one segment: `*` is any run of characters, `?` one character; everything else is literal.
  const segment = (s) => s.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*').replace(/\?/gu, '[^/]');
  if (pattern.endsWith('/**')) return new RegExp(`^${segment(pattern.slice(0, -3))}/`, 'u');
  if (pattern === '**') return /^/u;
  const body = pattern.split('**/').map(segment).join('(?:.*/)?');
  return new RegExp(`^${body}$`, 'u');
}

export const matcher = (patterns) => {
  const res = patterns.map(patternToRegExp);
  return (path) => res.some((r) => r.test(path));
};

const strings = (v, where, p, max = 500) => {
  if (!Array.isArray(v) || !v.every((s) => text(s, max))) p.push(`${where}: a list of non-empty strings`);
  return Array.isArray(v) ? v.filter((s) => text(s, max)) : [];
};

const only = (v, keys, where, p) => {
  for (const k of Object.keys(v)) if (!keys.includes(k)) p.push(`${where}.${k}: unknown field`);
};

const checkList = (v, where, p) => {
  if (v === undefined) return;
  if (!Array.isArray(v)) { p.push(`${where}: a list`); return; }
  v.forEach((c, i) => {
    if (!isRecord(c) || !text(c.run, 500)) { p.push(`${where}[${i}]: { run, why? }`); return; }
    only(c, ['run', 'why'], `${where}[${i}]`, p);
    if (c.why !== undefined && !text(c.why)) p.push(`${where}[${i}].why: text`);
  });
};

// Problems with the map against the list of tracked files. An empty list means the map is good.
export function mapProblems(map, files, { placement = true } = {}) {
  const p = [];
  if (!isRecord(map)) return ['map: a JSON object'];
  only(map, ['format', 'groups', 'rules', 'ignore'], 'map', p);
  if (map.format !== MAP_FORMAT) p.push(`format: "${MAP_FORMAT}"`);
  if (!Array.isArray(map.groups) || !map.groups.length) return [...p, 'groups: at least one group'];
  const ids = new Set();
  map.groups.forEach((g, i) => {
    const at = `groups[${i}]`;
    if (!isRecord(g)) { p.push(`${at}: an object`); return; }
    only(g, ['id', 'title', 'files', 'checks', 'risks'], at, p);
    if (typeof g.id !== 'string' || !ID.test(g.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
    else if (ids.has(g.id)) p.push(`${at}.id: ${g.id} is used twice`);
    ids.add(g.id);
    if (!text(g.title, 200)) p.push(`${at}.title: text`);
    if (!strings(g.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
    checkList(g.checks, `${at}.checks`, p);
    if (g.risks !== undefined) {
      if (!Array.isArray(g.risks)) p.push(`${at}.risks: a list`);
      else g.risks.forEach((r, j) => {
        if (!isRecord(r) || !text(r.text)) { p.push(`${at}.risks[${j}]: { text, files? }`); return; }
        only(r, ['text', 'files'], `${at}.risks[${j}]`, p);
        if (r.files !== undefined) strings(r.files, `${at}.risks[${j}].files`, p);
      });
    }
  });
  if (map.rules !== undefined) {
    if (!Array.isArray(map.rules)) p.push('rules: a list');
    else {
      const ruleIds = new Set();
      map.rules.forEach((r, i) => {
        const at = `rules[${i}]`;
        if (!isRecord(r)) { p.push(`${at}: an object`); return; }
        only(r, ['id', 'rule', 'why', 'files', 'checks'], at, p);
        if (typeof r.id !== 'string' || !ID.test(r.id)) p.push(`${at}.id: lowercase letters, digits and "-"`);
        else if (ruleIds.has(r.id)) p.push(`${at}.id: ${r.id} is used twice`);
        ruleIds.add(r.id);
        if (!text(r.rule)) p.push(`${at}.rule: text`);
        if (r.why !== undefined && !text(r.why)) p.push(`${at}.why: text`);
        if (!strings(r.files, `${at}.files`, p).length) p.push(`${at}.files: at least one path or pattern`);
        checkList(r.checks, `${at}.checks`, p);
        for (const f of Array.isArray(r.files) ? r.files.filter((x) => typeof x === 'string') : [])
          if (!files.some(matcher([f]))) p.push(`${at}.files: ${f} matches no tracked file`);
      });
    }
  }
  if (map.ignore !== undefined) strings(map.ignore, 'ignore', p);
  if (p.length || !placement) return p;

  // Placement: each tracked file in exactly one group or ignored; each group pattern matches something.
  const ignored = matcher(map.ignore ?? []);
  const groupMatch = map.groups.map((g) => [g.id, matcher(g.files)]);
  const unplaced = [];
  for (const f of files) {
    if (f === MAP_PATH) continue;
    const owners = groupMatch.filter(([, m]) => m(f)).map(([id]) => id);
    if (owners.length > 1) p.push(`${f}: in more than one group (${owners.join(', ')})`);
    else if (!owners.length && !ignored(f)) unplaced.push(f);
  }
  if (unplaced.length) p.push(`${unplaced.length} file(s) in no group and not ignored: ${unplaced.slice(0, 10).join(', ')}${unplaced.length > 10 ? ', ...' : ''}`);
  for (const g of map.groups) for (const pat of g.files)
    if (!files.some(matcher([pat]))) p.push(`groups.${g.id}.files: ${pat} matches no tracked file`);
  return p;
}

export function assertMap(map, files) {
  const p = mapProblems(map, files);
  if (p.length) throw new Error(`${MAP_PATH} has problems:\n- ${p.join('\n- ')}`);
  return map;
}

export const groupOf = (map, path) => map.groups.find((g) => matcher(g.files)(path)) ?? null;

// A first map from the file tree alone: one group per top folder (one per sub-folder under src/, lib/ and app/),
// tests together. Folders of only media or fonts get a group of their own too: code usually loads them, so the risks of
// that code belong there; "ignore" is left for a person to fill with what nothing depends on. Titles and risks are left
// for a person or an agent to write.
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|m4a|flac|mp4|webm|mov|woff2?|ttf|otf|eot|glb|gltf|fbx|blend|zip|pdf)$/iu;
export function draftMap(files, read = () => null) {
  const nested = new Set(['src', 'lib', 'app', 'packages', 'apps']);
  const keyOf = (path) => {
    const parts = path.split('/');
    if (parts.length === 1) return { key: 'root', pattern: null };
    if (/^(?:tests?|__tests__|spec|e2e)$/u.test(parts[0])) return { key: 'tests', pattern: `${parts[0]}/**` };
    if (nested.has(parts[0]) && parts.length > 2) return { key: `${parts[0]}-${parts[1]}`, pattern: `${parts[0]}/${parts[1]}/**` };
    return { key: parts[0], pattern: `${parts[0]}/**` };
  };
  const groups = new Map();
  const ignore = new Set();
  const byFolder = new Map();
  const projectChecks = draftChecks(files, read);
  for (const f of files) {
    if (f === MAP_PATH) continue;
    const { key, pattern } = keyOf(f);
    const slot = byFolder.get(key) ?? { pattern, files: [] };
    slot.files.push(f);
    byFolder.set(key, slot);
  }
  for (const [key, slot] of byFolder) {
    const media = Boolean(slot.pattern) && slot.files.every((f) => MEDIA.test(f));
    const id = key.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64) || 'group';
    const patterns = slot.pattern ? [slot.pattern] : slot.files;
    const prev = groups.get(id);
    const title = media
      ? `TODO: what loads the media files in ${slot.pattern} (binary, not read)`
      : `TODO: what ${slot.pattern ?? 'the top-level files'} ${slot.pattern ? 'is' : 'are'} for`;
    groups.set(id, { id, title, files: prev ? [...prev.files, ...patterns] : patterns, checks: media ? [] : projectChecks, risks: [] });
  }
  // A nested pattern ("src/a/**") and the parent's loose files ("src/x.js") must not overlap; loose files under a nested root
  // become their own group.
  for (const root of nested) {
    const loose = files.filter((f) => f.startsWith(`${root}/`) && f.split('/').length === 2);
    if (!loose.length) continue;
    const covered = groups.get(root);
    const hasNested = [...byFolder.values()].some((slot) => slot.pattern?.startsWith(`${root}/`) && slot.pattern !== `${root}/**`);
    if (covered && hasNested) covered.files = covered.files.filter((p) => p !== `${root}/**`).concat(loose);
  }
  // A folder that is a workspace package of its own (packages/db/package.json) gets that package's checks, run through the
  // package manager's workspace filter, so verify runs the package's tests instead of the whole repository's. Its title
  // comes from the package's description when it has one.
  for (const g of groups.values()) {
    const dir = g.files.length === 1 && /^(.+)\/\*\*$/u.exec(g.files[0])?.[1];
    if (!dir || !files.includes(`${dir}/package.json`)) continue;
    let pkg;
    try { pkg = JSON.parse(read(`${dir}/package.json`) ?? ''); } catch { continue; }
    const checks = workspaceChecks(files, dir, pkg);
    if (checks.length) g.checks = checks;
    const about = typeof pkg?.description === 'string' ? pkg.description.trim().replace(/\s+/gu, ' ') : '';
    if (about && g.title.startsWith('TODO:')) g.title = `${typeof pkg.name === 'string' ? `${pkg.name}: ` : ''}${about}`.slice(0, 200);
  }
  return { format: MAP_FORMAT, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), rules: [], ignore: [...ignore].sort() };
}

const packageManager = (has) => (has.has('pnpm-lock.yaml') ? 'pnpm' : has.has('yarn.lock') ? 'yarn' : has.has('bun.lockb') || has.has('bun.lock') ? 'bun' : 'npm');
const PLACEHOLDER = /no test specified/u;
// The scripts worth running as checks, in order, with what each covers.
const scriptChecks = (scripts, run) => [
  ...(typeof scripts.test === 'string' && !PLACEHOLDER.test(scripts.test) ? [{ run: run('test'), why: 'the test suite' }] : []),
  ...['typecheck', 'type-check', 'check-types', 'lint'].filter((n) => typeof scripts[n] === 'string').map((n) => ({ run: run(n), why: n === 'lint' ? 'lint rules' : 'types' })),
];

// One workspace package's own scripts, scoped to it: pnpm --filter, yarn workspace, bun --filter or npm -w.
export function workspaceChecks(files, dir, pkg) {
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const name = typeof pkg?.name === 'string' && pkg.name ? pkg.name : null;
  const pm = packageManager(new Set(files));
  const run = (script) => {
    if (pm === 'pnpm') return `pnpm --filter ${name ?? `./${dir}`} ${script === 'test' ? 'test' : `run ${script}`}`;
    if (pm === 'yarn' && name) return `yarn workspace ${name} ${script === 'test' ? 'test' : `run ${script}`}`;
    if (pm === 'bun' && name) return `bun --filter ${name} run ${script}`;
    return script === 'test' ? `npm test -w ${dir}` : `npm run ${script} -w ${dir}`;
  };
  return scriptChecks(scripts, run).map((c) => ({ ...c, why: `${c.why} of ${name ?? dir}` }));
}

// Repairs the two ways a good map goes stale as code moves, without guessing at meaning:
// - a tracked file in no group joins the group of its nearest neighbour (same folder, else the closest parent folder);
//   a new folder whose files are all unplaced joins as "<folder>/**", a lone new file by its path;
// - a pattern that no longer matches any file is dropped (from a group, a risk or a rule), unless it is the last one.
// What it cannot decide (a file with no placed neighbour, a group or rule left with no files) stays for a person.
// Returns the fixed map, the changes as sentences, and the problems still left.
export function fixMap(map, files) {
  const out = structuredClone(map);
  const changes = [];
  const live = (pat) => files.some(matcher([pat]));
  for (const g of out.groups) {
    const keep = g.files.filter(live);
    for (const pat of g.files.filter((p) => !live(p))) {
      if (keep.length) changes.push(`groups.${g.id}: dropped ${pat} (matches no file)`);
    }
    if (keep.length) g.files = keep;
    for (const r of g.risks ?? []) if (Array.isArray(r.files)) {
      const k = r.files.filter(live);
      for (const pat of r.files.filter((p) => !live(p))) changes.push(`groups.${g.id} risk "${r.text.slice(0, 40)}": dropped ${pat}`);
      if (k.length) r.files = k; else delete r.files;
    }
  }
  for (const r of out.rules ?? []) {
    const keep = r.files.filter(live);
    for (const pat of r.files.filter((p) => !live(p))) if (keep.length) changes.push(`rules.${r.id}: dropped ${pat} (matches no file)`);
    if (keep.length) r.files = keep;
  }

  const ignored = matcher(out.ignore ?? []);
  const owner = (f) => out.groups.find((g) => matcher(g.files)(f));
  const unplaced = files.filter((f) => f !== MAP_PATH && !ignored(f) && !owner(f));
  const dir = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  const placedIn = (d) => files.filter((f) => f !== MAP_PATH && dir(f) === d && owner(f));
  const doneDirs = new Set();
  for (const f of unplaced) {
    if (owner(f)) continue; // placed by a folder pattern added earlier in this loop
    // The nearest folder, going up, that holds a placed file decides the group.
    let d = dir(f);
    let neighbours = placedIn(d);
    while (!neighbours.length && d) { d = dir(d); neighbours = placedIn(d); }
    if (!neighbours.length) continue;
    const counts = new Map();
    for (const n of neighbours) { const g = owner(n); counts.set(g, (counts.get(g) ?? 0) + 1); }
    const group = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    // A whole new folder (nothing in it or under it placed or ignored) joins as one pattern.
    const own = dir(f);
    const under = files.filter((x) => x.startsWith(`${own}/`));
    const fresh = own && own !== d && !doneDirs.has(own) && under.every((x) => unplaced.includes(x));
    const pat = fresh ? `${own}/**` : f;
    if (fresh) doneDirs.add(own);
    group.files.push(pat);
    changes.push(`groups.${group.id}: added ${pat}`);
  }
  return { map: out, changes, problems: mapProblems(out, files) };
}

// A map that is only behind the code (new files that have a neighbour's group, patterns for deleted files) is settled
// the way `fix` would settle it, without writing anything; only what fix cannot decide stays a problem. Read lists,
// check and the Action use the settled map, so adding a file to an existing folder never fails a pull request.
// A new top-level folder is the one placement fix guesses at (it joins the root files' group), so it stays a problem:
// someone should give it a group.
export function settleMap(map, files) {
  const problems = mapProblems(map, files);
  if (!problems.length) return { map, problems: [], settled: [] };
  let fixed;
  try { fixed = fixMap(map, files); } catch { return { map, problems, settled: [] }; }
  const owned = matcher(map.groups.flatMap((g) => g.files));
  const newTop = fixed.changes.map((c) => c.match(/^groups\.[^:]+: added ((\w[^/]*)\/.*)$/u)).filter((m) => m && !files.some((f) => f.startsWith(`${m[2]}/`) && owned(f)));
  const left = [...fixed.problems, ...newTop.map((m) => `new top-level folder ${m[2]}/ is in no group: give it one (\`readfirst fix\` would put ${m[1]} with the root files)`)];
  return { map: left.length ? map : fixed.map, problems: left.length ? problems.filter((p) => !/in no group|matches no/u.test(p)).concat(left) : [], settled: left.length ? fixed.changes.filter((c) => !newTop.some((m) => c.endsWith(`added ${m[1]}`))) : fixed.changes };
}

// The project's own check commands, found in its build files, so a first map already says what to run. Repository-wide
// on purpose: narrowing a check to the group it covers is left to a person or an agent.
export function draftChecks(files, read = () => null) {
  const has = new Set(files);
  const out = [];
  const add = (run, why) => { if (!out.some((c) => c.run === run)) out.push({ run, why }); };
  if (has.has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read('package.json') ?? '{}').scripts ?? {}; } catch { scripts = {}; }
    const pm = packageManager(has);
    const run = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name === 'test' && pm !== 'bun' ? 'test' : `run ${name}`}`);
    for (const c of scriptChecks(scripts, run)) add(c.run, c.why);
  }
  const makefile = has.has('Makefile') ? read('Makefile') ?? '' : '';
  if (/^test:/mu.test(makefile)) add('make test', 'the test suite (Makefile)');
  if (has.has('go.mod')) add('go test ./...', 'the Go tests');
  if (has.has('Cargo.toml')) add('cargo test', 'the Rust tests');
  const py = has.has('pyproject.toml') || has.has('setup.py') || has.has('pytest.ini');
  if (py && files.some((f) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/u.test(f))) add('pytest', 'the Python tests');
  if (files.some((f) => /\.(?:sln|csproj|fsproj)$/u.test(f))) add('dotnet test', 'the .NET tests');
  if (has.has('mix.exs')) add('mix test', 'the Elixir tests');
  if (has.has('gradlew') || has.has('build.gradle') || has.has('build.gradle.kts')) add(has.has('gradlew') ? './gradlew test' : 'gradle test', 'the JVM tests (Gradle)');
  else if (has.has('pom.xml')) add(has.has('mvnw') ? './mvnw test' : 'mvn test', 'the JVM tests (Maven)');
  if (has.has('Gemfile')) {
    if (files.some((f) => /(?:^|\/)spec\/.*_spec\.rb$/u.test(f))) add('bundle exec rspec', 'the Ruby specs');
    else if (files.some((f) => /(?:^|\/)test\/.*_test\.rb$/u.test(f))) add(has.has('bin/rails') ? 'bin/rails test' : 'bundle exec rake test', 'the Ruby tests');
  }
  if (has.has('composer.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read('composer.json') ?? '{}').scripts ?? {}; } catch { scripts = {}; }
    if (scripts.test) add('composer test', 'the PHP tests');
    else if (has.has('phpunit.xml') || has.has('phpunit.xml.dist')) add('vendor/bin/phpunit', 'the PHP tests');
  }
  return out;
}
