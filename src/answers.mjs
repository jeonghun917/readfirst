// Answers to the gate's notes (`readfirst answer '<json>'`, plan of 2026-11-13). Under `hook --gate` each rule and risk
// a change touches, or that readfirst cannot judge against it, is asked: whoever makes the change answers what they do
// about it and why, and the call goes through only when every item asked has an answer. Until this, a refused call
// went through when made again, whether its notes were read or not (ledger gate-resend-passes-without-reading).
//
// The answer is a literal argument of one command, read from the command line as the shell hands it over
// (commandWords in src/bash-writes.mjs): `$(cat a.json)`, a variable from outside the command, a here-document or a
// pipe is no answer, for the reason a hidden read is no read. The hook keeps an answer only when its call is let
// through, and it counts from the next call on.
//
// The hook state keeps, per session (src/cli.mjs, appended as [key, time] lines):
// - `ask:<JSON [item, by]>`: the gate asked the item, which the change touched by those names (none: not judged);
// - `answer:<JSON [item, kind, covered, symbols, because]>`: an answer given, holding for the names in `covered` (those
//   the item was asked for when it was given).
import { commandWords } from './bash-writes.mjs';

export const ANSWER_KINDS = ['keeps', 'not-this', 'done', 'unsure'];
const KIND_LINE = 'keeps (the change keeps what it asks; say how), not-this (it is about something else; `symbols`: what the change touches), done (the change does what it asks), unsure';

// The answers in one JSON text, checked for their shape alone: { answers, problems }. Any problem and nothing of the
// text is kept (the hook records nothing from a bad answer).
export function parseAnswer(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch (e) { return { answers: [], problems: [`not JSON (${String(e?.message ?? e).split('\n')[0]})`] }; }
  const list = Array.isArray(data) ? data : [data];
  const problems = [];
  const answers = [];
  if (!list.length) problems.push('no answer in it: give a list of { "item", "answer", "because" }');
  list.forEach((a, i) => {
    const at = `answer ${i + 1}`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { problems.push(`${at} is not an object`); return; }
    const item = typeof a.item === 'string' ? a.item.trim() : '';
    const where = item ? `\`${item}\`` : at;
    if (!item) problems.push(`${at} has no "item" (the id the notes give, e.g. risk:cli:1a2b3c4d)`);
    if (!ANSWER_KINDS.includes(a.answer)) problems.push(`${where}: "answer" is ${JSON.stringify(a.answer ?? null)}; give one of ${KIND_LINE}`);
    const because = typeof a.because === 'string' ? a.because.trim() : '';
    if (!because) problems.push(`${where} has no "because" (one sentence: why)`);
    const symbols = a.symbols === undefined ? [] : a.symbols;
    if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string' || !s.trim())) problems.push(`${where}: "symbols" must be a list of names`);
    else if (a.answer === 'not-this' && !symbols.length) problems.push(`${where}: a not-this answer names in "symbols" what the change touches`);
    answers.push({ item, answer: a.answer, because, symbols: Array.isArray(symbols) ? symbols.map((s) => String(s).trim()) : [] });
  });
  return { answers: problems.length ? [] : answers, problems };
}

// The word that names readfirst: readfirst, readfirst@<version>, or a path to it (bin/readfirst.mjs, …/bin/readfirst).
const READFIRST = /^(?:\S*\/)?readfirst(?:@[\w.-]+)?(?:\.mjs)?$/u;
// Each `readfirst answer` a Bash command runs, as the shell hands its words over: [{ text }] for one read, [{ why }]
// for one that gives no readable answer. A command inside a function body is not run where it is written and is left
// out. The words are read without the hook's environment, so only a value the command itself sets is known.
export function answerRuns(command, cwd) {
  const out = [];
  if (!/\banswer\b/u.test(String(command ?? ''))) return out;
  for (const c of commandWords(command, cwd)) {
    if (c.body) continue;
    const w = c.words;
    let i = 0;
    if (w[i]?.text === 'npx') { i++; while (/^(?:-y|--yes)$/u.test(w[i]?.text ?? '')) i++; } else if (w[i]?.text === 'node') i++;
    if (!READFIRST.test(w[i]?.text ?? '') || w[i + 1]?.text !== 'answer') continue;
    const arg = w[i + 2];
    if (c.pipe) out.push({ why: 'it is in a pipeline: give the JSON as its one quoted argument, not on standard input' });
    else if (!arg) out.push({ why: 'it has no argument (a here-document or standard input is not read): give the JSON as its one quoted argument' });
    else if (!arg.known) out.push({ why: 'its argument is not written out in the command ($( ), a file, or a variable the command does not set): give the JSON itself, in single quotes' });
    else if (w.length > i + 3) out.push({ why: `it has ${w.length - i - 2} arguments: give the whole JSON as one quoted argument` });
    else out.push({ text: arg.text });
  }
  return out;
}

const parseKey = (key, tag) => { try { return JSON.parse(key.slice(tag.length)); } catch { return null; } };
// What the session was asked: item -> the names the change touched it by, over every time it was asked.
export function askedItems(seen) {
  const asked = new Map();
  for (const k of Object.keys(seen)) {
    if (!k.startsWith('ask:')) continue;
    const v = parseKey(k, 'ask:');
    if (!Array.isArray(v) || typeof v[0] !== 'string') continue;
    if (!asked.has(v[0])) asked.set(v[0], new Set());
    for (const s of Array.isArray(v[1]) ? v[1] : []) asked.get(v[0]).add(String(s));
  }
  return asked;
}
// The answers of a session: [{ item, answer, covered, symbols, because, at }].
export function givenAnswers(seen) {
  const out = [];
  for (const [k, at] of Object.entries(seen)) {
    if (!k.startsWith('answer:')) continue;
    const v = parseKey(k, 'answer:');
    if (!Array.isArray(v) || typeof v[0] !== 'string') continue;
    out.push({ item: v[0], answer: v[1], covered: Array.isArray(v[2]) ? v[2] : [], symbols: Array.isArray(v[3]) ? v[3] : [], because: String(v[4] ?? ''), at });
  }
  return out;
}

// Whether the session's answers hold for an item the change touches by `by` (plan 2.5): an answer holds while the names
// are among those the item was touched by when it was answered, so a change that touches a new name of the item asks
// again; an item readfirst cannot judge (no names) is answered once for the session.
export function answered(answers, item, by) {
  const mine = answers.filter((a) => a.item === item);
  if (!mine.length) return false;
  const covered = new Set(mine.flatMap((a) => a.covered));
  return by.every((s) => covered.has(s));
}

// The answers a Bash command gives, checked against the session: { keys, problems, count }. `keys`: the state keys to
// add when the call is let through. Nothing is kept from a command with a problem in any of its answers.
// - each item must be one the gate asked in this session;
// - a not-this answer's symbols must be among the names the change touched the item by (it cannot claim a whole file);
// - once unsure answers are more than half of the items asked in the session, an answer with an unsure is refused
//   (counted across answers, so splitting them does not help).
export function answersIn(command, cwd, seen) {
  const runs = answerRuns(command, cwd);
  if (!runs.length) return null;
  const problems = [];
  const answers = [];
  for (const r of runs) {
    if (r.why) { problems.push(`\`readfirst answer\` is not read: ${r.why}`); continue; }
    const p = parseAnswer(r.text);
    problems.push(...p.problems);
    answers.push(...p.answers);
  }
  const asked = askedItems(seen);
  const before = givenAnswers(seen);
  for (const a of answers) {
    const by = asked.get(a.item);
    if (!by) { problems.push(`\`${a.item}\` was not asked in this session: answer the ids the refusal gave`); continue; }
    if (a.answer === 'not-this' && by.size) {
      const wider = a.symbols.filter((s) => !by.has(s));
      if (wider.length) problems.push(`\`${a.item}\`: not-this names ${wider.map((s) => `\`${s}\``).join(', ')}, which the change did not touch it by (it touched ${[...by].map((s) => `\`${s}\``).join(', ')}): name only those`);
    }
  }
  const unsureBefore = before.filter((a) => a.answer === 'unsure').length;
  if (answers.some((a) => a.answer === 'unsure') && unsureBefore * 2 > asked.size) {
    problems.push(`${unsureBefore} answers in this session were unsure, more than half of the ${asked.size} items asked: an unsure answer is no answer now; answer keeps, not-this or done`);
  }
  if (problems.length) return { keys: {}, problems, count: 0 };
  const keys = {};
  for (const a of answers) keys[`answer:${JSON.stringify([a.item, a.answer, [...asked.get(a.item)].sort(), a.symbols, a.because])}`] = true;
  return { keys, problems, count: answers.length };
}

// The items whose last answer is unsure, with no later answer of another kind (plan 2.6): the Stop hook names them.
export function openUnsure(seen) {
  const last = new Map();
  for (const a of givenAnswers(seen)) {
    const was = last.get(a.item);
    // An answer of another kind given in the same call clears it.
    if (!was || a.at > was.at || (a.at === was.at && a.answer !== 'unsure')) last.set(a.item, a);
  }
  return [...last.values()].filter((a) => a.answer === 'unsure').sort((a, b) => a.item.localeCompare(b.item));
}

// How to answer, for the gate's refusal.
export const ANSWER_HOW = `npx readfirst answer '[{"item":"<id>","answer":"keeps|not-this|done|unsure","because":"<one sentence>","symbols":["<name>"]}]'`;
export const ANSWER_KINDS_LINE = KIND_LINE;
