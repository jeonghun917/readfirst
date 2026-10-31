#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`readfirst: ${e.message}\n`); process.exitCode = 2; }
