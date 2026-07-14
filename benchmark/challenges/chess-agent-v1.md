Create exactly one file named `agent.js` in the current directory.

The file is a self-contained JavaScript chess agent with this contract:

- It must be at most 50 KiB of valid UTF-8.
- It must use only built-in Node.js APIs and require no package installation.
- It reads exactly one standard FEN chess position from standard input.
- It writes exactly one legal move in UCI notation to standard output, optionally followed by one newline, and nothing else.
- It must handle either side to move and all standard move rules needed to return a legal move, including check evasion, castling, en passant, and promotion.
- It must not use the network, MCP, skills, subagents, external files, or persistent state.

You may use shell commands inside this empty workspace to create and test `agent.js`. Do not create any other files. Finish only when `agent.js` is syntactically valid and you have locally exercised representative FEN positions.
