// `readfirst scan`: the published bug shapes (src/shapes.mjs) over every tracked code file, read as if each line were
// new. No model and no network; it reads the checkout and writes nothing.
import { assignedFromQueryset, candidates, PATTERNS, QS_HINT } from './shapes.mjs';

const CODE = /\.(?:py|[cm]?[jt]sx?)$/u;
const MAX_FILE_BYTES = 400_000;
// Generated or vendored code is never read; tests, fixtures and migrations only for the shapes about test code.
const NEVER = /(?:^|\/)(?:node_modules|vendor|dist|build)\/|\.min\.js$/u;
const NOT_APP = /(?:^|\/)(?:tests?|__tests__|testing|fixtures|migrations)\/|test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[jt]sx?$/u;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|testing)\/|\.(?:test|spec)\.[jt]sx?$/u;

// Findings in one file's text: [{ pattern, file, line, why, code }].
export function scanText(path, text) {
  const notApp = NOT_APP.test(path);
  if (!CODE.test(path) || NEVER.test(path) || text.length > MAX_FILE_BYTES) return [];
  if (notApp && (!TEST_FILE.test(path) || /\.py$/u.test(path))) return [];
  const lines = text.split('\n');
  const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
  const out = [];
  for (const c of candidates({ filename: path, patch })) {
    if (notApp && !c.pattern.tests) continue;
    if (c.pattern.notIn && (c.pattern.notIn.path.test(path) || c.pattern.notIn.text.test(text))) continue;
    if (c.pattern.queryset && !QS_HINT.test(c.recv) && !assignedFromQueryset(c.recv.match(/^[A-Za-z_][\w.]*/u)[0], text)) continue;
    out.push({ pattern: c.pattern.id, file: path, line: c.line, why: c.pattern.why(c.method), code: lines[c.line - 1].trim() });
  }
  return out;
}

export function scan(files, read) {
  const findings = [];
  let scanned = 0;
  for (const f of files) {
    if (!CODE.test(f) || NEVER.test(f)) continue;
    const text = read(f);
    if (text == null) continue;
    const found = scanText(f, text);
    if (CODE.test(f)) scanned++;
    findings.push(...found);
  }
  return { format: 'readfirst/scan@1', files: scanned, shapes: PATTERNS.map((p) => p.id), findings };
}

export function scanTextReport(r) {
  const lines = [];
  if (!r.findings.length) lines.push(`No line in ${r.files} code files matches the ${r.shapes.length} shapes this scan knows.`);
  else {
    lines.push(`# ${r.findings.length} line${r.findings.length === 1 ? '' : 's'} to look at (${r.files} code files scanned)`, '');
    for (const f of r.findings) lines.push(`- \`${f.file}:${f.line}\` ${f.code.length > 100 ? `${f.code.slice(0, 99)}…` : f.code}`, `  ${f.why}`);
  }
  lines.push('', `Shapes: ${r.shapes.join(', ')}. Each was a real bug in a public repository first; a match is a place to look, not a verdict.`,
    'The hosted version checks more shapes (security ones included) on every pull request: https://readfirst-cloud.vercel.app');
  return `${lines.join('\n')}\n`;
}
