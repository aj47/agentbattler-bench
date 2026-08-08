#!/usr/bin/env node
import { main } from '../src/reference-ledger.mjs';

await main(process.argv.slice(2));
