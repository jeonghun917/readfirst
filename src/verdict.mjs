// The verdict at the top of the PR comment and of `readfirst diff` (step 3 of "Nothing hidden, nothing unchecked",
// 2026-11-09): what to do, what is blocked, what was not checked and which other repositories, in the reader's language,
// before the items themselves. It is templated from the read list, never written by a model. It counts and names; it
// never stands in for an item: everything it counts is shown below it, in full or folded, whole.
//
// The language is an Action input (`language`) or `diff --lang`, else the one language of this clone's personal labels
// (`prompt --labels ko`). Only the verdict's own words are translated: the map's rules and risks stay as the map says
// them. A language with no strings here is said in the verdict, in English, never dropped without a word.

export const VERDICT_LANGS = ['en', 'ko'];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const code = (s) => `\`${s}\``;

// The template's words by language. Every language has every key (test/verdict.test.mjs).
export const VERDICT_TEXT = {
  en: {
    blocked: (n) => `**Blocked**: ${plural(n, 'thing')} to fix before this is done.`,
    todo: (n) => `**${n} to do**, nothing blocked.`,
    nothing: '**Nothing to do** from the map, nothing blocked.',
    blockedHead: 'Blocked',
    todoHead: 'To do',
    notCheckedHead: 'Not checked',
    othersHead: 'Other repositories',
    problems: (n) => `the map no longer matches the code (${plural(n, 'problem')}, listed below): run \`npx readfirst check\` and fix the map in this change`,
    leftBehind: (t) => `${t.for.map(code).join(', ')} changed but none of ${t.also.map(code).join(' or ')} did: change it too (verify fails until then) — ${t.why}`,
    together: (t) => `${t.also.map(code).join(' or ')} changed too, as the map asks — ${t.why}`,
    replaced: (d) => `group **${d.group}** is being replaced${d.use ? `: use ${code(d.use)} instead` : ''}; do not add to it — ${d.why}`,
    rules: (ids) => `confirm ${ids.length === 1 ? 'this rule still holds' : 'these rules still hold'}, the change touches what ${ids.length === 1 ? 'it is' : 'they are'} about: ${ids.map((i) => `**${i}**`).join(', ')} (in full below)`,
    risks: (n) => `read the ${plural(n, 'risk')} the change touches (in full below)`,
    unjudged: (n) => `read the ${plural(n, 'rule or risk', 'rules and risks')} readfirst could not match against the change (in full below)`,
    notRunPr: 'readfirst ran none of these checks (the Action runs no repository commands): tick each once it has run',
    notRunDiff: 'diff runs none of these checks: `npx readfirst verify` runs them',
    noSymbol: (n) => `${plural(n, 'rule or risk', 'rules and risks')} ${n === 1 ? 'names' : 'name'} no symbol or line readfirst can match against the change: shown for their files, unjudged`,
    groupWide: (n) => `${plural(n, 'more group risk')} could not be judged either (folded below, whole)`,
    drifted: (n) => `${plural(n, 'rule or risk', 'rules and risks')} ${n === 1 ? 'points' : 'point'} at a line outside what ${n === 1 ? 'it names' : 'they name'}: it may have moved with the code, so the line may judge the wrong code (\`readfirst check\` lists them, \`readfirst fix\` moves what git traces)`,
    notCovered: (paths) => `${plural(paths.length, 'changed file')} the map does not place: ${paths.map(code).join(', ')}`,
    unseen: (paths) => `${plural(paths.length, 'file')} readfirst cannot fully read (computed imports or a language it does not read), so an empty list for ${paths.length === 1 ? 'it' : 'them'} may mean unknown: ${paths.map(code).join(', ')}`,
    history: (n) => `whether ${n === 1 ? '1 file' : `${n} files`} broke before is unknown: the history was not fetched`,
    noList: 'no read list was made, because the map has problems: the rules, risks and checks of these files were not looked up',
    other: (d) => `**${d.repo}**${d.paths.length ? ` (${d.paths.map(code).join(', ')})` : ''} depends on this — ${d.why}`,
    othersUnseen: 'readfirst cannot see other repositories from here: check them before calling this done',
    noLang: (lang) => `(no "${lang}" text in readfirst yet: shown in English)`,
  },
  ko: {
    blocked: (n) => `**막힘**: 끝내기 전에 고칠 것 ${n}개.`,
    todo: (n) => `**할 일 ${n}개**, 막힌 것 없음.`,
    nothing: '**지도에 따른 할 일 없음**, 막힌 것 없음.',
    blockedHead: '막힌 것',
    todoHead: '할 일',
    notCheckedHead: '확인되지 않은 것',
    othersHead: '다른 저장소',
    problems: (n) => `지도가 코드와 맞지 않습니다(문제 ${n}개, 아래에 있음): \`npx readfirst check\`를 실행하고 이 변경에서 지도를 고치세요`,
    leftBehind: (t) => `${t.for.map(code).join(', ')}는 바뀌었는데 ${t.also.map(code).join(' 또는 ')}는 바뀌지 않았습니다: 함께 고치세요(그 전까지 verify가 실패합니다) — ${t.why}`,
    together: (t) => `지도대로 ${t.also.map(code).join(' 또는 ')}도 함께 바뀌었습니다 — ${t.why}`,
    replaced: (d) => `**${d.group}** 그룹은 교체 중입니다${d.use ? `: 대신 ${code(d.use)}를 쓰세요` : ''}. 여기에 더하지 마세요 — ${d.why}`,
    rules: (ids) => `이 변경이 건드린 규칙이 여전히 지켜지는지 확인하세요: ${ids.map((i) => `**${i}**`).join(', ')} (아래에 전문)`,
    risks: (n) => `이 변경이 건드린 위험 ${n}개를 읽으세요(아래에 전문)`,
    unjudged: (n) => `readfirst가 변경과 맞춰 보지 못한 규칙·위험 ${n}개를 읽으세요(아래에 전문)`,
    notRunPr: 'readfirst는 이 검사들을 하나도 실행하지 않았습니다(Action은 저장소 명령을 실행하지 않습니다): 실행한 것마다 체크하세요',
    notRunDiff: 'diff는 이 검사들을 실행하지 않습니다: `npx readfirst verify`가 실행합니다',
    noSymbol: (n) => `규칙·위험 ${n}개는 변경과 맞춰 볼 심볼이나 줄을 적지 않아, 판정 없이 파일 기준으로 보입니다`,
    groupWide: (n) => `그룹 위험 ${n}개도 판정하지 못했습니다(아래에 접혀 있음, 전문)`,
    drifted: (n) => `규칙·위험 ${n}개는 증거 줄이 자기가 말하는 코드 밖을 가리킵니다: 코드가 옮겨 갔을 수 있어 그 줄로 한 판정이 틀릴 수 있습니다(\`readfirst check\`가 나열하고, \`readfirst fix\`가 git으로 추적되는 것은 옮깁니다)`,
    notCovered: (paths) => `지도가 자리를 정하지 않은 바뀐 파일 ${paths.length}개: ${paths.map(code).join(', ')}`,
    unseen: (paths) => `readfirst가 다 읽지 못하는 파일 ${paths.length}개(계산된 import 또는 읽지 않는 언어), 그래서 빈 목록은 "모름"일 수 있습니다: ${paths.map(code).join(', ')}`,
    history: (n) => `파일 ${n}개는 히스토리를 가져오지 않아 전에 깨진 적이 있는지 모릅니다`,
    noList: '지도에 문제가 있어 읽을 목록을 만들지 않았습니다: 이 파일들의 규칙, 위험, 검사를 찾아보지 않았습니다',
    other: (d) => `**${d.repo}**${d.paths.length ? ` (${d.paths.map(code).join(', ')})` : ''}가 이것에 기댑니다 — ${d.why}`,
    othersUnseen: 'readfirst는 여기서 다른 저장소를 볼 수 없습니다: 끝났다고 하기 전에 확인하세요',
    noLang: (lang) => `(readfirst에 "${lang}" 문구가 아직 없어 영어로 보입니다)`,
  },
};

// The rows of a judged read list, by what the verdict says of them (src/trigger.mjs sets `trigger`). A row never judged
// (no `trigger`) counts as not matched: nothing says the change missed it.
export function sortRows(list) {
  const rows = [...(list?.rules ?? []).map((r) => ({ kind: 'rule', row: r })), ...(list?.risks ?? []).map((r) => ({ kind: 'risk', row: r }))];
  const touched = rows.filter(({ row }) => row.trigger?.triggered && row.trigger.by?.length);
  const off = rows.filter(({ row }) => row.trigger?.triggered === false);
  const unmatched = rows.filter((x) => !touched.includes(x) && !off.includes(x));
  // A group-wide risk (no `files` of its own that name a changed file) is folded in the PR comment, as before.
  const open = unmatched.filter(({ kind, row }) => kind === 'rule' || row.named);
  const groupWide = unmatched.filter((x) => !open.includes(x));
  return { touched, off, open, groupWide };
}

// The language the verdict is written in, and the note when the one asked for has no strings here.
export function verdictLang(asked) {
  const lang = String(asked ?? '').trim().toLowerCase().split(/[-_]/u)[0];
  if (!lang || lang === 'en') return { lang: 'en', note: null };
  return VERDICT_LANGS.includes(lang) ? { lang, note: null } : { lang: 'en', note: VERDICT_TEXT.en.noLang(asked) };
}

// The verdict as Markdown lines. list: a judged read list, or null when none was made (map problems). where: 'pr' (the
// Action) or 'diff'. problems: the map's problems (they block). broke: the targets with their brokeBefore, when the
// caller renders that section itself (the Action). checklist: the checks as task-list boxes.
export function verdictLines(list, { lang: asked = 'en', where = 'pr', problems = [], broke = null, checklist = false } = {}) {
  const { lang, note } = verdictLang(asked);
  const t = VERDICT_TEXT[lang];
  const blocked = [];
  const todo = [];
  const notChecked = [];
  const others = [];
  if (problems.length) blocked.push(t.problems(problems.length));
  if (!list) {
    if (problems.length) notChecked.push(t.noList);
  } else {
    for (const tg of list.together ?? []) (tg.changed ? todo : blocked).push(tg.changed ? `${checklist ? '[x] ' : ''}${t.together(tg)}` : t.leftBehind(tg));
    for (const d of list.deprecated ?? []) todo.push(t.replaced(d));
    for (const c of list.checks ?? []) todo.push(`${checklist ? '[ ] ' : ''}${code(c.run)} — ${c.why}${(list.targets ?? []).length > 1 && c.for?.length ? ` _(${c.for.join(', ')})_` : ''}`);
    const { touched, open, groupWide } = sortRows(list);
    const rules = touched.filter((x) => x.kind === 'rule').map((x) => x.row.id);
    const risks = touched.filter((x) => x.kind === 'risk').length;
    if (rules.length) todo.push(t.rules(rules));
    if (risks) todo.push(t.risks(risks));
    if (open.length) todo.push(t.unjudged(open.length));
    if ((list.checks ?? []).length) notChecked.push(where === 'diff' ? t.notRunDiff : t.notRunPr);
    if (open.length) notChecked.push(t.noSymbol(open.length));
    if (groupWide.length) notChecked.push(t.groupWide(groupWide.length));
    const drifted = [...(list.rules ?? []), ...(list.risks ?? [])].filter((r) => r.trigger?.drifted?.length).length;
    if (drifted) notChecked.push(t.drifted(drifted));
    const notCovered = (list.notCovered ?? []).map((n) => n.path);
    if (notCovered.length) notChecked.push(t.notCovered(notCovered));
    const unseen = [...new Set((list.unseen ?? []).map((n) => n.path))];
    if (unseen.length) notChecked.push(t.unseen(unseen));
    const fetched = (broke ?? list.targets ?? []).filter((x) => x.brokeBefore?.notFetched).length;
    if (fetched) notChecked.push(t.history(fetched));
    for (const d of list.dependents ?? []) others.push(t.other(d));
    if (others.length) others.push(t.othersUnseen);
  }
  const head = blocked.length ? t.blocked(blocked.length) : todo.length ? t.todo(todo.length) : t.nothing;
  const lines = [`${head}${note ? ` ${note}` : ''}`, ''];
  const part = (title, rows) => { if (rows.length) lines.push(`**${title}**`, '', ...rows.map((r) => `- ${r}`), ''); };
  part(t.blockedHead, blocked);
  part(t.todoHead, todo);
  part(t.notCheckedHead, notChecked);
  part(t.othersHead, others);
  return lines;
}
