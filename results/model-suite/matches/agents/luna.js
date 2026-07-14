'use strict';

const fs = require('fs');
const fields = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const board = Array(64).fill(null);
const ranks = fields[0].split('/');
for (let r = 0; r < 8; r++) {
  let f = 0;
  const br = 7 - r;
  for (const c of ranks[r]) {
    if (c >= '1' && c <= '8') f += +c;
    else board[br * 8 + f++] = c;
  }
}
const turn = fields[1] === 'b' ? 1 : 0;
const rights = fields[2] || '-';
const ep = fields[3] && fields[3] !== '-'
  ? (fields[3].charCodeAt(0) - 97) + (fields[3].charCodeAt(1) - 49) * 8 : -1;

const knight = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const king = [[1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const bishop = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const rook = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const white = p => p && p === p.toUpperCase();
const mine = (p, side) => p && (white(p) ? 0 : 1) === side;

function attacked(bb, sq, by) {
  const f = sq & 7, r = sq >> 3;
  const pawn = by ? 'p' : 'P';
  const pr = r + (by ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f && bb[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && bb[pr * 8 + f + 1] === pawn) return true;
  }
  const horse = by ? 'n' : 'N';
  for (const d of knight) {
    const x = f + d[0], y = r + d[1];
    if (inside(x, y) && bb[y * 8 + x] === horse) return true;
  }
  const monarch = by ? 'k' : 'K';
  for (const d of king) {
    const x = f + d[0], y = r + d[1];
    if (inside(x, y) && bb[y * 8 + x] === monarch) return true;
  }
  for (const d of rook) {
    let x = f + d[0], y = r + d[1];
    while (inside(x, y)) {
      const p = bb[y * 8 + x];
      if (p) {
        if (mine(p, by) && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true;
        break;
      }
      x += d[0]; y += d[1];
    }
  }
  for (const d of bishop) {
    let x = f + d[0], y = r + d[1];
    while (inside(x, y)) {
      const p = bb[y * 8 + x];
      if (p) {
        if (mine(p, by) && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true;
        break;
      }
      x += d[0]; y += d[1];
    }
  }
  return false;
}

function inCheck(bb, side) {
  const k = side ? 'k' : 'K';
  const sq = bb.indexOf(k);
  return sq < 0 || attacked(bb, sq, 1 - side);
}

function moves() {
  const out = [];
  const add = (from, to, promo, passant, castle) => {
    const target = board[to];
    if (!target || !mine(target, turn)) {
      if (!target || target.toLowerCase() !== 'k') out.push({ from, to, promo, passant, castle });
    }
  };
  const promote = turn ? ['q', 'r', 'b', 'n'] : ['Q', 'R', 'B', 'N'];
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!mine(p, turn)) continue;
    const f = from & 7, r = from >> 3, kind = p.toLowerCase();
    if (kind === 'p') {
      const dir = turn ? -1 : 1, start = turn ? 6 : 1, last = turn ? 0 : 7;
      const oneR = r + dir;
      if (inside(f, oneR)) {
        const one = oneR * 8 + f;
        if (!board[one]) {
          if (oneR === last) for (const q of promote) add(from, one, q, false, false);
          else {
            add(from, one, null, false, false);
            const two = (r + 2 * dir) * 8 + f;
            if (r === start && !board[two]) add(from, two, null, false, false);
          }
        }
        for (const df of [-1, 1]) {
          const x = f + df;
          if (!inside(x, oneR)) continue;
          const to = oneR * 8 + x, target = board[to];
          if ((target && !mine(target, turn) && target.toLowerCase() !== 'k') || to === ep) {
            if (oneR === last) for (const q of promote) add(from, to, q, to === ep, false);
            else add(from, to, null, to === ep, false);
          }
        }
      }
    } else if (kind === 'n' || kind === 'k') {
      const ds = kind === 'n' ? knight : king;
      for (const d of ds) {
        const x = f + d[0], y = r + d[1];
        if (inside(x, y)) add(from, y * 8 + x, null, false, false);
      }
      if (kind === 'k' && ((turn === 0 && r === 0 && f === 4) || (turn === 1 && r === 7 && f === 4))) {
        const base = turn ? 56 : 0, enemy = 1 - turn;
        const canShort = rights.includes(turn ? 'k' : 'K');
        const canLong = rights.includes(turn ? 'q' : 'Q');
        if (canShort && board[base + 5] == null && board[base + 6] == null &&
            board[base + 7] === (turn ? 'r' : 'R') &&
            !attacked(board, base + 4, enemy) && !attacked(board, base + 5, enemy) && !attacked(board, base + 6, enemy))
          out.push({ from, to: base + 6, promo: null, passant: false, castle: true });
        if (canLong && board[base + 1] == null && board[base + 2] == null && board[base + 3] == null &&
            board[base] === (turn ? 'r' : 'R') &&
            !attacked(board, base + 4, enemy) && !attacked(board, base + 3, enemy) && !attacked(board, base + 2, enemy))
          out.push({ from, to: base + 2, promo: null, passant: false, castle: true });
      }
    } else {
      const ds = kind === 'b' ? bishop : kind === 'r' ? rook : bishop.concat(rook);
      for (const d of ds) {
        let x = f + d[0], y = r + d[1];
        while (inside(x, y)) {
          const to = y * 8 + x;
          if (board[to]) {
            add(from, to, null, false, false);
            break;
          }
          add(from, to, null, false, false);
          x += d[0]; y += d[1];
        }
      }
    }
  }
  return out;
}

function without(s, chars) {
  for (const c of chars) s = s.replace(c, '');
  return s || '-';
}

function apply(m) {
  const bb = board.slice(), p = bb[m.from], captured = bb[m.to];
  bb[m.from] = null;
  if (m.passant) bb[m.to + (turn ? 8 : -8)] = null;
  bb[m.to] = m.promo || p;
  if (m.castle) {
    const row = turn ? 56 : 0;
    if (m.to > m.from) { bb[row + 5] = bb[row + 7]; bb[row + 7] = null; }
    else { bb[row + 3] = bb[row]; bb[row] = null; }
  }
  let cr = rights;
  if (p === 'K') cr = without(cr, 'KQ');
  if (p === 'k') cr = without(cr, 'kq');
  if (p === 'R' && m.from === 0) cr = without(cr, 'Q');
  if (p === 'R' && m.from === 7) cr = without(cr, 'K');
  if (p === 'r' && m.from === 56) cr = without(cr, 'q');
  if (p === 'r' && m.from === 63) cr = without(cr, 'k');
  if (captured === 'R' && m.to === 0) cr = without(cr, 'Q');
  if (captured === 'R' && m.to === 7) cr = without(cr, 'K');
  if (captured === 'r' && m.to === 56) cr = without(cr, 'q');
  if (captured === 'r' && m.to === 63) cr = without(cr, 'k');
  return bb;
}

const legal = moves().filter(m => !inCheck(apply(m), turn));
const chosen = legal[0];
function square(n) { return String.fromCharCode(97 + (n & 7)) + (1 + (n >> 3)); }
if (chosen) process.stdout.write(square(chosen.from) + square(chosen.to) + (chosen.promo ? chosen.promo.toLowerCase() : ''));
