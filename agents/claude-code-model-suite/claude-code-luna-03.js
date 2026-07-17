import { stdin, stdout } from 'node:process';

let input = '';
for await (const chunk of stdin) input += chunk;
const fields = input.trim().split(/\s+/);
const rows = (fields[0] || '').split('/');
const board = Array(64).fill(null);

for (let i = 0; i < 8; i++) {
  let file = 0;
  for (const ch of (rows[i] || '')) {
    if (ch >= '1' && ch <= '8') file += +ch;
    else if (file < 8) board[(7 - i) * 8 + file++] = ch;
  }
}

const turn = fields[1] === 'b' ? 1 : 0;
let rights = 0;
for (const ch of (fields[2] || '-')) {
  rights |= ({ K: 1, Q: 2, k: 4, q: 8 }[ch] || 0);
}
const ep = fields[3] && fields[3] !== '-' ? sq(fields[3]) : -1;

const isWhite = p => p && p >= 'A' && p <= 'Z';
const color = p => isWhite(p) ? 0 : 1;
const file = s => s & 7;
const rank = s => s >> 3;

function sq(s) {
  return s && s.length >= 2
    ? s.charCodeAt(0) - 97 + (s.charCodeAt(1) - 49) * 8
    : -1;
}

function inside(f, r) {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

function enemy(p, c) {
  return p && color(p) !== c;
}

function attacked(b, target, by) {
  const f = file(target), r = rank(target);
  const pawn = by ? 'p' : 'P';
  const pr = r + (by ? 1 : -1);

  if (inside(f - 1, pr) && b[pr * 8 + f - 1] === pawn) return true;
  if (inside(f + 1, pr) && b[pr * 8 + f + 1] === pawn) return true;

  const knight = by ? 'n' : 'N';
  for (const [df, dr] of [
    [1, 2], [2, 1], [-1, 2], [-2, 1],
    [1, -2], [2, -1], [-1, -2], [-2, -1]
  ]) {
    if (inside(f + df, r + dr) &&
        b[(r + dr) * 8 + f + df] === knight) return true;
  }

  const king = by ? 'k' : 'K';
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if ((df || dr) && inside(f + df, r + dr) &&
          b[(r + dr) * 8 + f + df] === king) return true;
    }
  }

  for (const [df, dr, chars] of [
    [1, 0, 'rq'], [-1, 0, 'rq'], [0, 1, 'rq'], [0, -1, 'rq'],
    [1, 1, 'bq'], [1, -1, 'bq'], [-1, 1, 'bq'], [-1, -1, 'bq']
  ]) {
    let x = f + df, y = r + dr;
    while (inside(x, y)) {
      const p = b[y * 8 + x];
      if (p) {
        if (color(p) === by && chars.includes(p.toLowerCase())) return true;
        break;
      }
      x += df;
      y += dr;
    }
  }
  return false;
}

function make(b, m) {
  const n = b.slice();
  const p = n[m.from];

  n[m.from] = null;
  if (m.ep) n[m.to + (turn ? 8 : -8)] = null;
  n[m.to] = m.promo || p;

  if (m.castle) {
    if (m.to === 6) {
      n[5] = n[7];
      n[7] = null;
    } else if (m.to === 2) {
      n[3] = n[0];
      n[0] = null;
    } else if (m.to === 62) {
      n[61] = n[63];
      n[63] = null;
    } else if (m.to === 58) {
      n[59] = n[56];
      n[56] = null;
    }
  }
  return n;
}

function legal(b, m) {
  const n = make(b, m);
  let king = -1;
  for (let i = 0; i < 64; i++) {
    if (n[i] === (turn ? 'k' : 'K')) {
      king = i;
      break;
    }
  }
  return king >= 0 && !attacked(n, king, turn ^ 1);
}

function add(out, from, to, extra = {}) {
  const p = board[from];
  const tr = rank(to);

  if (p.toLowerCase() === 'p' && (tr === 0 || tr === 7)) {
    for (const x of (turn ? ['q', 'r', 'b', 'n'] : ['Q', 'R', 'B', 'N'])) {
      out.push({ from, to, promo: x, ...extra });
    }
  } else {
    out.push({ from, to, ...extra });
  }
}

function generate() {
  const out = [];

  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!p || color(p) !== turn) continue;

    const f = file(from), r = rank(from), lo = p.toLowerCase();

    if (lo === 'p') {
      const d = turn ? -1 : 1;
      const one = r + d;

      if (inside(f, one) && !board[one * 8 + f]) {
        add(out, from, one * 8 + f);
        const start = turn ? 6 : 1;
        const two = r + 2 * d;
        if (r === start && !board[two * 8 + f]) {
          add(out, from, two * 8 + f);
        }
      }

      for (const df of [-1, 1]) {
        const x = f + df;
        if (!inside(x, one)) continue;
        const to = one * 8 + x;
        if (enemy(board[to], turn)) add(out, from, to);
        else if (to === ep) add(out, from, to, { ep: true });
      }
    } else if (lo === 'n') {
      for (const [df, dr] of [
        [1, 2], [2, 1], [-1, 2], [-2, 1],
        [1, -2], [2, -1], [-1, -2], [-2, -1]
      ]) {
        const x = f + df, y = r + dr;
        if (inside(x, y) &&
            (!board[y * 8 + x] || enemy(board[y * 8 + x], turn))) {
          add(out, from, y * 8 + x);
        }
      }
    } else if (lo === 'k') {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          const x = f + df, y = r + dr;
          if ((df || dr) && inside(x, y) &&
              (!board[y * 8 + x] || enemy(board[y * 8 + x], turn))) {
            add(out, from, y * 8 + x);
          }
        }
      }

      const home = turn ? 60 : 4;
      const kingSide = turn ? 4 : 1;
      const queenSide = turn ? 8 : 2;

      if (from === home && !attacked(board, from, turn ^ 1)) {
        if ((rights & kingSide) &&
            !board[home + 1] &&
            !board[home + 2] &&
            board[home + 3] === (turn ? 'r' : 'R') &&
            !attacked(board, home + 1, turn ^ 1)) {
          add(out, from, home + 2, { castle: true });
        }

        if ((rights & queenSide) &&
            !board[home - 1] &&
            !board[home - 2] &&
            !board[home - 3] &&
            board[home - 4] === (turn ? 'r' : 'R') &&
            !attacked(board, home - 1, turn ^ 1)) {
          add(out, from, home - 2, { castle: true });
        }
      }
    } else {
      const dirs = lo === 'b'
        ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
        : lo === 'r'
          ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
          : [[1, 1], [1, -1], [-1, 1], [-1, -1],
             [1, 0], [-1, 0], [0, 1], [0, -1]];

      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (inside(x, y)) {
          const to = y * 8 + x;
          if (!board[to]) {
            add(out, from, to);
          } else {
            if (enemy(board[to], turn)) add(out, from, to);
            break;
          }
          x += df;
          y += dr;
        }
      }
    }
  }

  return out.filter(m => legal(board, m));
}

const moves = generate();
const m = moves[0];

if (m) {
  stdout.write(
    String.fromCharCode(97 + file(m.from)) +
    String.fromCharCode(49 + rank(m.from)) +
    String.fromCharCode(97 + file(m.to)) +
    String.fromCharCode(49 + rank(m.to)) +
    (m.promo ? m.promo.toLowerCase() : '')
  );
}