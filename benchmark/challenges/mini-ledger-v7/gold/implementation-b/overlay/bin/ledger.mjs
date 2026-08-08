#!/usr/bin/env node
import { main } from '../src/reference-b/cli.mjs';

await main(process.argv.slice(2));
