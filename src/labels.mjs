// Labels for the map view, written by a coding agent and kept on one machine. They hold the map's text in another
// language ("text") and plain notes for people new to the code ("plain"). They are personal, not team knowledge: they
// live in .readfirst/local/, which is added to .git/info/exclude (this clone only) so they never reach the repository.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { MAP_PATH } from './map.mjs';

export const LOCAL_DIR = '.readfirst/local';
export const LABELS_DIR = `${LOCAL_DIR}/labels`;
export const LABELS_FORMAT = 'readfirst/labels@1';

// Adds .readfirst/local/ to this clone's .git/info/exclude. Returns true when it added the line.
export function keepLocal(root) {
  let at;
  try {
    at = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return false; }
  if (!isAbsolute(at)) at = join(root, at);
  const line = `/${LOCAL_DIR}/`;
  const now = existsSync(at) ? readFileSync(at, 'utf8') : '';
  if (now.split('\n').some((l) => l.trim() === line)) return false;
  mkdirSync(join(at, '..'), { recursive: true });
  appendFileSync(at, `${now && !now.endsWith('\n') ? '\n' : ''}# readfirst: personal labels and views, this clone only\n${line}\n`);
  return true;
}

// Every labels file under .readfirst/local/labels, by language. A file that is not valid JSON is skipped with a note.
export function readLabels(root, warn = () => {}) {
  const dir = join(root, LABELS_DIR);
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const l = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const lang = typeof l.lang === 'string' && l.lang ? l.lang : f.replace(/\.json$/u, '');
      out[lang] = { text: l.text ?? {}, ...(l.plain ? { plain: { groups: l.plain.groups ?? {}, files: l.plain.files ?? {}, text: l.plain.text ?? {} } } : {}) };
    } catch (e) { warn(`skipped ${LABELS_DIR}/${f}: ${e.message}\n`); }
  }
  return out;
}

// The strings of the map a labels file covers: group titles, risks, rules and every "why".
export function mapStrings(map) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim()) out.add(s); };
  for (const g of map.groups) {
    add(g.title);
    for (const c of g.checks ?? []) add(c.why);
    for (const r of g.risks ?? []) add(r.text);
  }
  for (const r of map.rules ?? []) {
    add(r.rule); add(r.why);
    for (const c of r.checks ?? []) add(c.why);
  }
  return [...out];
}

const NAMES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', de: 'German', fr: 'French', pt: 'Portuguese' };

export function labelsBrief(map, lang) {
  const name = NAMES[lang] ?? lang;
  const translate = lang !== 'en';
  const strings = mapStrings(map);
  return `You are writing ${LABELS_DIR}/${lang}.json: ${name} labels for the readfirst map view (\`npx readfirst view\`).
The file is for the person who asked for it and stays on this machine. First run \`npx readfirst view\` once: it adds
${LOCAL_DIR}/ to this clone's .git/info/exclude, so nothing in it can be committed. Do not commit the labels and do not
change ${MAP_PATH}.

Format:
{
  "format": "${LABELS_FORMAT}",
  "lang": "${lang}",${translate ? `
  "text": { "<string from the map, exactly>": "<the same in ${name}>" },` : ''}
  "plain": {
    "groups": { "<group id>": { "name": "<short name>", "about": "<what this part does>" } },
    "files": { "<path>": "<what this file does>" },
    "text": { "<string from the map, exactly>": "<plain ${name}>" }
  }
}
${translate ? `
"text" is the technical mode: a faithful ${name} translation of every string listed below. Keep code identifiers, file
paths, commands, option names and API names exactly as written, and keep technical terms (use the standard ${name} term,
or the original word where ${name} developers use it). Do not simplify or leave anything out.
` : ''}
"plain" is the plain mode, for someone who can read code but does not know this codebase or its jargon:
- Plain, factual sentences in ${name}. Say what the code does and what breaks if the rule or risk is ignored.
- Keep identifiers, paths and commands as written. Explain a technical term in a few words the first time it matters.
- No metaphors, analogies, jokes, nicknames, emoji or marketing tone. Group "name" is a short descriptive noun phrase
  (like "${lang === 'ko' ? '핵심 라이브러리' : 'Core library'}"), not a picture.
- Only facts from the map or the code. If you are unsure, leave the entry out.
- "groups": every group. "files": only the 5 to 15 files people change most or that carry a risk or rule.
- "text": every string listed below.

Groups: ${map.groups.map((g) => g.id).join(', ')}.

Strings from the map (${strings.length}):
${strings.map((s) => `- ${JSON.stringify(s)}`).join('\n')}

When done, check the file is valid JSON and run \`npx readfirst view\` to see it.
`;
}
