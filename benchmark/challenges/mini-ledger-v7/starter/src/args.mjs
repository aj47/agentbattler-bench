export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!command) throw new Error('a command is required');
  const flags = {};
  const positionals = [];
  for (let index = 0; index < tokens.length;) {
    const name = tokens[index];
    if (!name.startsWith('--')) {
      positionals.push(name);
      index += 1;
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`invalid argument near ${name}`);
    const key = name.slice(2);
    if (Object.hasOwn(flags, key)) throw new Error(`duplicate --${key}`);
    flags[key] = value;
    index += 2;
  }
  return { command, flags, positionals };
}

export function requireFlags(flags, names) {
  const expected = new Set(names);
  for (const name of names) {
    if (!Object.hasOwn(flags, name) || flags[name] === '') throw new Error(`missing --${name}`);
  }
  for (const name of Object.keys(flags)) {
    if (!expected.has(name)) throw new Error(`unexpected --${name}`);
  }
}

export function requirePositionals(positionals, count) {
  if (positionals.length !== count) throw new Error(`expected ${count} positional argument${count === 1 ? '' : 's'}`);
}
