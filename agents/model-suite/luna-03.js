import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8').trim();
const fields = input.split(/\s+/);
const board = Array(64).fill(null);
const ranks = (fields[0] || '').split('/');
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const ch of (ranks[r] || '')) {
    if (ch >= '1' && ch <= '8') f += +ch;
    else if (f < 8) board[r * 8 + f++] = ch;
  }
}
const state = {
  b: board,
  turn: fields[1] === 'b' ? 'b' : 'w',
  castling: fields[2] === '-' ? '' : (fields[2] || ''),
  ep: fields[3] && fields[3] !== '-' ? fromUci(fields[3]) : -1
};

function fromUci(s) {
  return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97;
}

function uci(s) {
  return String.fromCharCode(97 + (s % 8)) + (8 - (s >> 3));
}

function mine(p, side) {
  return p && (side === 'w' ? p < 'a' : p >= 'a');
}

function enemy(p, side) {
  return p && !mine(p, side);
}

function attacked(s, x, by) {
  const b = s.b, f = x & 7, r = x >> 3;
  const pawn = by === 'w' ? 'P' : 'p';
  const pr = r + (by === 'w' ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && b[nr * 8 + nf] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && b[nr * 8 + nf] === king) return true;
  }
  const lines = [
    [1, 0, 'R', 'Q'], [-1, 0, 'R', 'Q'], [0, 1, 'R', 'Q'], [0, -1, 'R', 'Q'],
    [1, 1, 'B', 'Q'], [1, -1, 'B', 'Q'], [-1, 1, 'B', 'Q'], [-1, -1, 'B', 'Q']
  ];
  for (const [df, dr, a, q] of lines) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        if (p === (by === 'w' ? a : a.toLowerCase()) || p === (by === 'w' ? q : q.toLowerCase())) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  return false;
}

function inCheck(s, side) {
  const k = side === 'w' ? 'K' : 'k';
  const x = s.b.indexOf(k);
  return x < 0 || attacked(s, x, side === 'w' ? 'b' : 'w');
}

function addPawnMove(out, from, to, side, extra = {}) {
  const rank = to >> 3;
  if (rank === (side === 'w' ? 0 : 7)) {
    for (const p of 'qrbn') out.push({ from, to, p, ...extra });
  } else out.push({ from, to, p: '', ...extra });
}

function pseudo(s) {
  const out = [], side = s.turn, b = s.b;
  const dir = side === 'w' ? -1 : 1;
  const start = side === 'w' ? 6 : 1;
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!mine(piece, side)) continue;
    const f = from & 7, r = from >> 3, type = piece.toUpperCase();
    if (type === 'P') {
      const nr = r + dir;
      if (nr >= 0 && nr < 8) {
        const one = nr * 8 + f;
        if (!b[one]) {
          addPawnMove(out, from, one, side);
          const two = (r + 2 * dir) * 8 + f;
          if (r === start && !b[two]) out.push({ from, to: two, p: '' });
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf, target = b[to];
          if ((enemy(target, side) && target.toUpperCase() !== 'K') || to === s.ep) {
            if (to === s.ep) {
              const cap = to - dir * 8;
              if (target || b[cap] !== (side === 'w' ? 'p' : 'P')) continue;
            }
            addPawnMove(out, from, to, side, to === s.ep ? { ep: true } : {});
          }
        }
      }
      continue;
    }
    let deltas = [];
    if (type === 'N') deltas = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    else if (type === 'K') deltas = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]];
    else if (type === 'B') deltas = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    else if (type === 'R') deltas = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    else if (type === 'Q') deltas = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [df, dr] of deltas) {
      let nf = f + df, nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        const to = nr * 8 + nf, target = b[to];
        if (mine(target, side)) break;
        if (!target || target.toUpperCase() !== 'K') out.push({ from, to, p: '' });
        if (target || type === 'N' || type === 'K') break;
        nf += df; nr += dr;
      }
    }
    if (type === 'K' && (from === (side === 'w' ? 60 : 4)) && !inCheck(s, side)) {
      const row = side === 'w' ? 7 : 0, enemySide = side === 'w' ? 'b' : 'w';
      const rights = side === 'w' ? [['K', 63, 62, 61], ['Q', 56, 58, 59]] : [['k', 7, 6, 5], ['q', 0, 2, 3]];
      for (const [right, rook, to, transit] of rights) {
        const between = right.toLowerCase() === 'k' ? [transit, to] : [transit, to, row * 8 + 1];
        if (s.castling.includes(right) && b[rook] === (side === 'w' ? 'R' : 'r') && between.every(x => !b[x]) && !attacked(s, transit, enemySide)) {
          out.push({ from, to, p: '', castle: true });
        }
      }
    }
  }
  return out;
}

function removeRight(c, x) {
  return c.replace(x, '');
}

function updateRights(c, piece, from, captured, to) {
  if (piece === 'K') c = removeRight(removeRight(c, 'K'), 'Q');
  if (piece === 'k') c = removeRight(removeRight(c, 'k'), 'q');
  const rookSquares = { 56: 'Q', 63: 'K', 0: 'q', 7: 'k' };
  if (piece.toUpperCase() === 'R' && rookSquares[from]) c = removeRight(c, rookSquares[from]);
  if (captured && captured.toUpperCase() === 'R' && rookSquares[to]) c = removeRight(c, rookSquares[to]);
  return c;
}

function make(s, m) {
  const b = s.b.slice(), piece = b[m.from], captured = b[m.to];
  b[m.from] = null;
  let placed = piece;
  if (m.p) placed = s.turn === 'w' ? m.p.toUpperCase() : m.p;
  b[m.to] = placed;
  if (m.to === s.ep && piece.toUpperCase() === 'P' && !captured) {
    b[m.to + (s.turn === 'w' ? 8 : -8)] = null;
  }
  if (m.castle) {
    const row = s.turn === 'w' ? 7 : 0;
    const kingSide = (m.to & 7) === 6;
    const rf = row * 8 + (kingSide ? 7 : 0), rt = row * 8 + (kingSide ? 5 : 3);
    b[rt] = b[rf]; b[rf] = null;
  }
  let ep = -1;
  if (piece.toUpperCase() === 'P' && Math.abs(m.to - m.from) === 16) ep = (m.to + m.from) >> 1;
  return { b, turn: s.turn === 'w' ? 'b' : 'w', castling: updateRights(s.castling, piece, m.from, captured, m.to), ep };
}

const legal = pseudo(state).filter(m => !inCheck(make(state, m), state.turn));
if (legal.length) {
  const m = legal.find(x => x.castle) || legal.find(x => x.ep) || legal.find(x => x.p && x.p !== '') || legal[0];
  process.stdout.write(uci(m.from) + uci(m.to) + (m.p || ''));
}
