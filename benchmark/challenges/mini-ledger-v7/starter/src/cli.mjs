import { parseArgs, requireFlags, requirePositionals } from './args.mjs';
import { append } from './commands/append.mjs';
import { appendBatch } from './commands/batch.mjs';
import { audit, replay } from './commands/audit.mjs';
import { get, query } from './commands/read.mjs';
import { recover } from './commands/recover.mjs';
import { compact, exportLedger, importLedger } from './commands/transfer.mjs';

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function main(argv) {
  try {
    const { command, flags, positionals } = parseArgs(argv);
    let result;
    if (command === 'append') {
      requireFlags(flags, ['id', 'kind', 'payload']);
      requirePositionals(positionals, 0);
      result = await append(flags);
    } else if (command === 'get') {
      requireFlags(flags, ['id']);
      requirePositionals(positionals, 0);
      result = await get(flags);
    } else if (command === 'query') {
      if (Object.hasOwn(flags, 'cursor')) requireFlags(flags, ['kind', 'cursor', 'limit']);
      else if (Object.hasOwn(flags, 'after-sequence')) requireFlags(flags, ['kind', 'after-sequence', 'limit']);
      else requireFlags(flags, ['kind', 'limit']);
      requirePositionals(positionals, 0);
      result = await query(flags);
    } else if (command === 'append-batch') {
      requireFlags(flags, ['file', 'idempotency-key']);
      requirePositionals(positionals, 0);
      result = await appendBatch(flags);
    } else if (command === 'export') {
      requireFlags(flags, []);
      requirePositionals(positionals, 1);
      result = await exportLedger(positionals[0]);
    } else if (command === 'import') {
      requireFlags(flags, []);
      requirePositionals(positionals, 1);
      result = await importLedger(positionals[0]);
    } else if (command === 'compact') {
      requireFlags(flags, ['keep']);
      requirePositionals(positionals, 0);
      result = await compact(flags);
    } else if (command === 'recover') {
      requireFlags(flags, []);
      requirePositionals(positionals, 0);
      result = await recover();
    } else if (command === 'replay') {
      requireFlags(flags, []);
      requirePositionals(positionals, 0);
      result = await replay();
    } else if (command === 'audit') {
      requireFlags(flags, []);
      requirePositionals(positionals, 0);
      result = await audit();
    } else {
      throw new Error(`unknown command: ${command}`);
    }
    emit(result);
  } catch (error) {
    emit({ ok: false, error: String(error.message).slice(0, 300) });
    process.exitCode = 1;
  }
}
