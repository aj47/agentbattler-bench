import {
  appendCommand,
  auditCommand,
  batchCommand,
  compactCommand,
  exportCommand,
  getCommand,
  importCommand,
  queryCommand,
  recoverCommand,
  replayCommand,
} from './commands.mjs';

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!command) throw new Error('a command is required');
  const flags = {};
  const positionals = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (!key || value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${token}`);
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate --${key}`);
    flags[key] = value;
    index += 2;
  }
  return { command, flags, positionals };
}

function exactFlags(flags, required) {
  const expected = new Set(required);
  for (const name of required) {
    if (!Object.hasOwn(flags, name) || flags[name] === '') throw new Error(`missing --${name}`);
  }
  for (const name of Object.keys(flags)) {
    if (!expected.has(name)) throw new Error(`unexpected --${name}`);
  }
}

function positionalCount(positionals, expected) {
  if (positionals.length !== expected) throw new Error(`expected ${expected} positional argument${expected === 1 ? '' : 's'}`);
}

async function dispatch(argv) {
  const { command, flags, positionals } = parseArgs(argv);
  if (command === 'append') {
    exactFlags(flags, ['id', 'kind', 'payload']);
    positionalCount(positionals, 0);
    return appendCommand(flags);
  }
  if (command === 'get') {
    exactFlags(flags, ['id']);
    positionalCount(positionals, 0);
    return getCommand(flags);
  }
  if (command === 'query') {
    if (Object.hasOwn(flags, 'cursor')) exactFlags(flags, ['kind', 'cursor', 'limit']);
    else if (Object.hasOwn(flags, 'after-sequence')) exactFlags(flags, ['kind', 'after-sequence', 'limit']);
    else exactFlags(flags, ['kind', 'limit']);
    positionalCount(positionals, 0);
    return queryCommand(flags);
  }
  if (command === 'append-batch') {
    exactFlags(flags, ['file', 'idempotency-key']);
    positionalCount(positionals, 0);
    return batchCommand({ file: flags.file, key: flags['idempotency-key'] });
  }
  if (command === 'export') {
    exactFlags(flags, []);
    positionalCount(positionals, 1);
    return exportCommand(positionals[0]);
  }
  if (command === 'import') {
    exactFlags(flags, []);
    positionalCount(positionals, 1);
    return importCommand(positionals[0]);
  }
  if (command === 'compact') {
    exactFlags(flags, ['keep']);
    positionalCount(positionals, 0);
    return compactCommand(flags);
  }
  if (command === 'recover') {
    exactFlags(flags, []);
    positionalCount(positionals, 0);
    return recoverCommand();
  }
  if (command === 'replay') {
    exactFlags(flags, []);
    positionalCount(positionals, 0);
    return replayCommand();
  }
  if (command === 'audit') {
    exactFlags(flags, []);
    positionalCount(positionals, 0);
    return auditCommand();
  }
  throw new Error(`unknown command: ${command}`);
}

export async function main(argv) {
  try {
    const value = await dispatch(argv);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message).slice(0, 300) })}\n`);
    process.exitCode = 1;
  }
}
