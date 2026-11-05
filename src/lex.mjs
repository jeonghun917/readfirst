// Where the long string and comment blocks are in a run of source lines: Python triple-quoted strings, JavaScript block
// comments. One pass over the lines, character by character, carrying the state from line to line, so a quote or a
// comment marker inside a string or a comment is never taken for one that opens or closes a block (`SEP = "'''"`,
// `const glob = "src/*.ts"`, `# don't use '''`). No dependencies; the work is linear in the text.
//
// Returns one entry per line: startsIn (the line begins inside a block), endsIn (it ends inside one) and touches (some
// part of it is in a block, for Python a triple-quoted string that opens and closes on the line counts).

export function blockLines(lines, py) {
  const out = [];
  // Python: q is the open string's delimiter (' " ''' """). JavaScript: q is ' " ` or 'block' for /* */ and 're' for a
  // regular expression literal; tpl holds the brace depth of each open ${ } inside template literals.
  let q = null;
  const tpl = [];
  let last = ''; // JavaScript: the last significant character outside strings and comments, to tell / from a regex
  const isBlock = () => (py ? q === "'''" || q === '"""' : q === 'block');
  for (const text of lines) {
    const startsIn = isBlock();
    let touches = startsIn;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (py) {
        if (q) {
          if (c === '\\') { i++; continue; }
          if (q.length === 3 ? text.startsWith(q, i) : c === q) { if (q.length === 3) { i += 2; touches = true; } q = null; }
          continue;
        }
        if (c === '#') break;
        if (c === '"' || c === "'") {
          const triple = text.startsWith(c.repeat(3), i);
          q = triple ? c.repeat(3) : c;
          if (triple) { i += 2; touches = true; }
        }
        continue;
      }
      if (q === 'block') { if (c === '*' && text[i + 1] === '/') { q = null; i++; last = ''; } continue; }
      if (q === 're') {
        if (c === '\\') i++;
        else if (c === '[') { const end = text.indexOf(']', i + 1); i = end < 0 ? text.length : end; }
        else if (c === '/') { q = null; last = 'x'; }
        continue;
      }
      if (q === '`') {
        if (c === '\\') i++;
        else if (c === '`') { q = null; last = 'x'; }
        else if (c === '$' && text[i + 1] === '{') { tpl.push(0); q = null; i++; last = '{'; }
        continue;
      }
      if (q) { if (c === '\\') i++; else if (c === q) { q = null; last = 'x'; } continue; }
      if (c === '/' && text[i + 1] === '/') break;
      if (c === '/' && text[i + 1] === '*') { q = 'block'; touches = true; i++; continue; }
      if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/u.test(last))) { q = 're'; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (tpl.length) {
        if (c === '{') tpl[tpl.length - 1]++;
        else if (c === '}') { if (tpl[tpl.length - 1] === 0) { tpl.pop(); q = '`'; continue; } tpl[tpl.length - 1]--; }
      }
      if (!/\s/u.test(c)) last = /[A-Za-z0-9_$)\]]/u.test(c) ? 'x' : c;
    }
    // A plain string or a regular expression ends with its line; a triple-quoted string, a block comment and a
    // template literal go on.
    if (py ? q === "'" || q === '"' : q === "'" || q === '"' || q === 're') q = null;
    const endsIn = isBlock();
    out.push({ startsIn, endsIn, touches: touches || endsIn });
  }
  return out;
}
