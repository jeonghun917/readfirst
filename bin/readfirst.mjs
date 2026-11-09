#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// Output piped into `head` closes early: stop quietly instead of printing a stack trace for the broken pipe.
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0); throw e; });
try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`readfirst: ${e.message}\n`); process.exitCode = 2; }
