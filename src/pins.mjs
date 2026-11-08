// Which readfirst a repository runs in CI, from its own files: the Action (`uses: jeonghun917/readfirst@v0.13.0`), an
// npx call with a version (`npx readfirst@0.17.0`), or package.json. The oldest pinned version wins; a major tag (@v0),
// `latest` or no pin at all is the newest release. `check` fails when the map uses a field that version rejects: the
// newer local CLI passes, and CI fails on the push (readfirst-cloud, 2026-11-07, on v0.13.0 with models and flows).
const VERSION = /(\d+)\.(\d+)\.(\d+)/u;

export const parseVersion = (v) => { const m = String(v ?? '').match(VERSION); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
// Whether `have` is `want` or newer; no version (nothing pinned) is the newest.
export const atLeast = (have, want) => {
  const a = parseVersion(have);
  const b = parseVersion(want);
  if (!a) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

export const pinFiles = (paths) => paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(p) || p === 'package.json');

// texts: Map(path -> text) of pinFiles. Returns { version, at } of the oldest pin, or null when nothing is pinned.
export function pinnedReadfirst(texts) {
  const found = [];
  for (const [path, text] of texts) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) {
      for (const m of String(text ?? '').matchAll(/uses:\s*['"]?jeonghun917\/readfirst@v?(\d+\.\d+\.\d+)\b/gu)) found.push({ version: m[1], at: path });
      for (const m of String(text ?? '').matchAll(/\bnpx\s+(?:--yes\s+|-y\s+)?readfirst@(\d+\.\d+\.\d+)\b/gu)) found.push({ version: m[1], at: path });
    } else if (path === 'package.json') {
      try {
        const p = JSON.parse(text);
        const v = p.devDependencies?.readfirst ?? p.dependencies?.readfirst;
        if (typeof v === 'string' && VERSION.test(v)) found.push({ version: v.match(VERSION)[0], at: path });
      } catch { /* not JSON: nothing pinned here */ }
    }
  }
  return found.sort((a, b) => (atLeast(a.version, b.version) ? 1 : -1))[0] ?? null;
}

// The first release whose `check` accepts each map field.
export const FIELD_SINCE = [
  ['hotspots', '0.10.0', (m) => m.hotspots !== undefined],
  ['groups[].deprecated', '0.12.0', (m) => (m.groups ?? []).some((g) => g?.deprecated !== undefined)],
  ['requires', '0.15.0', (m) => m.requires !== undefined],
  ['dependents', '0.15.0', (m) => m.dependents !== undefined],
  ['flows', '0.18.0', (m) => m.flows !== undefined],
  ['vocabulary', '0.18.0', (m) => m.vocabulary !== undefined],
  ['rules[].flow', '0.20.0', (m) => (m.rules ?? []).some((r) => r?.flow !== undefined)],
  ['models', '0.22.0', (m) => m.models !== undefined],
  ['more than 500 flows', '0.25.0', (m) => Array.isArray(m.flows) && m.flows.length > 500],
];

// Fields the map uses that the pinned readfirst rejects, as problem lines for `check`.
export function pinProblems(map, pin) {
  if (!pin) return [];
  return FIELD_SINCE.filter(([, since, uses]) => uses(map) && !atLeast(pin.version, since))
    .map(([field, since]) => `${field} needs readfirst ${since} or newer, and ${pin.at} pins ${pin.version}: CI will reject the map. Raise the pin, or leave the field out`);
}
