import fs from 'node:fs';

// Squares are numbered a1=0 through h8=63. Upper-case pieces are White.
const fen = fs.readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
let rank = 7;
for (const row of fields[0].split('/')) {
  let file = 0;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') file += Number(ch);
    else board[rank * 8 + file++] = ch;
  }
  rank--;
}

const state = {
  b: board,
  turn: fields[1],
  castle: fields[2] === '-' ? '' : fields[2],
  ep: fields[3] === '-' ? -1 : square(fields[3]),
  half: Number(fields[4] || 0),
  full: Number(fields[5] || 1),
};

function square(s) {
  return s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
}

function name(s) {
  return String.fromCharCode(97 + (s & 7)) + String(1 + (s >> 3));
}

function white(p) {
  return p !== null && p === p.toUpperCase();
}

function sameSide(p, side) {
  return p !== null && white(p) === (side === 'w');
}

function attacked(st, sq, by) {
  const b = st.b;
  const f = sq & 7;
  if (by === 'w') {
    if (f < 7 && sq >= 7 && b[sq - 7] === 'P') return true;
    if (f > 0 && sq >= 9 && b[sq - 9] === 'P') return true;
  } else {
    if (f > 0 && sq <= 56 && b[sq + 7] === 'p') return true;
    if (f < 7 && sq <= 54 && b[sq + 9] === 'p') return true;
  }

  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    const nf = f + df, nr = (sq >> 3) + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && b[nr * 8 + nf] === knight) return true;
  }

  const bishop = by === 'w' ? 'B' : 'b';
  const rook = by === 'w' ? 'R' : 'r';
  const queen = by === 'w' ? 'Q' : 'q';
  for (const [df, dr, diagonal] of [[1, 1, true], [-1, 1, true], [1, -1, true], [-1, -1, true], [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false]]) {
    let nf = f + df, nr = (sq >> 3) + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p !== null) {
        if (p === queen || (diagonal ? p === bishop : p === rook)) return true;
        break;
      }
      nf += df;
      nr += dr;
    }
  }

  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (df === 0 && dr === 0) continue;
    const nf = f + df, nr = (sq >> 3) + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && b[nr * 8 + nf] === king) return true;
  }
  return false;
}

function inCheck(st, side = st.turn) {
  const king = side === 'w' ? 'K' : 'k';
  const sq = st.b.indexOf(king);
  return sq >= 0 && attacked(st, sq, side === 'w' ? 'b' : 'w');
}

function addPawnMove(moves, from, to, finalRank, special = '') {
  if ((to >> 3) === finalRank) {
    for (const p of ['q', 'r', 'b', 'n']) moves.push({ f: from, t: to, p, s: special });
  } else moves.push({ f: from, t: to, p: '', s: special });
}

function pseudo(st, capturesOnly = false) {
  const b = st.b, side = st.turn, moves = [];
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!sameSide(piece, side)) continue;
    const type = piece.toLowerCase(), f = from & 7, r = from >> 3;

    if (type === 'p') {
      const dir = side === 'w' ? 8 : -8;
      const start = side === 'w' ? 1 : 6;
      const finalRank = side === 'w' ? 7 : 0;
      const one = from + dir;
      if (one >= 0 && one < 64 && b[one] === null && (!capturesOnly || (one >> 3) === finalRank)) {
        addPawnMove(moves, from, one, finalRank);
        const two = from + 2 * dir;
        if (!capturesOnly && r === start && b[two] === null) moves.push({ f: from, t: two, p: '', s: 'd' });
      }
      for (const df of [-1, 1]) {
        const nf = f + df, to = one + df;
        if (nf < 0 || nf > 7 || to < 0 || to >= 64) continue;
        if (b[to] !== null && !sameSide(b[to], side)) addPawnMove(moves, from, to, finalRank);
        else if (to === st.ep) addPawnMove(moves, from, to, finalRank, 'e');
      }
      continue;
    }

    if (type === 'n') {
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (!sameSide(b[to], side) && (!capturesOnly || b[to] !== null)) moves.push({ f: from, t: to, p: '', s: '' });
      }
      continue;
    }

    if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = type === 'b' ? [[1, 1], [-1, 1], [1, -1], [-1, -1]]
        : type === 'r' ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
          : [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (b[to] !== null) {
            if (!sameSide(b[to], side)) moves.push({ f: from, t: to, p: '', s: '' });
            break;
          }
          if (!capturesOnly) moves.push({ f: from, t: to, p: '', s: '' });
          nf += df;
          nr += dr;
        }
      }
      continue;
    }

    if (type === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (!sameSide(b[to], side) && (!capturesOnly || b[to] !== null)) moves.push({ f: from, t: to, p: '', s: '' });
      }
      if (!capturesOnly) {
        const enemy = side === 'w' ? 'b' : 'w';
        if (side === 'w' && from === 4 && piece === 'K' && !attacked(st, 4, enemy)) {
          if (st.castle.includes('K') && b[7] === 'R' && b[5] === null && b[6] === null && !attacked(st, 5, enemy) && !attacked(st, 6, enemy)) moves.push({ f: 4, t: 6, p: '', s: 'c' });
          if (st.castle.includes('Q') && b[0] === 'R' && b[1] === null && b[2] === null && b[3] === null && !attacked(st, 3, enemy) && !attacked(st, 2, enemy)) moves.push({ f: 4, t: 2, p: '', s: 'c' });
        } else if (side === 'b' && from === 60 && piece === 'k' && !attacked(st, 60, enemy)) {
          if (st.castle.includes('k') && b[63] === 'r' && b[61] === null && b[62] === null && !attacked(st, 61, enemy) && !attacked(st, 62, enemy)) moves.push({ f: 60, t: 62, p: '', s: 'c' });
          if (st.castle.includes('q') && b[56] === 'r' && b[57] === null && b[58] === null && b[59] === null && !attacked(st, 59, enemy) && !attacked(st, 58, enemy)) moves.push({ f: 60, t: 58, p: '', s: 'c' });
        }
      }
    }
  }
  return moves;
}

function play(st, m) {
  const b = st.b.slice();
  const piece = b[m.f], side = st.turn;
  const captured = b[m.t];
  b[m.t] = piece;
  b[m.f] = null;
  if (m.s === 'e') b[m.t + (side === 'w' ? -8 : 8)] = null;
  if (m.s === 'c') {
    if (m.t === 6) { b[5] = b[7]; b[7] = null; }
    if (m.t === 2) { b[3] = b[0]; b[0] = null; }
    if (m.t === 62) { b[61] = b[63]; b[63] = null; }
    if (m.t === 58) { b[59] = b[56]; b[56] = null; }
  }
  if (m.p) b[m.t] = side === 'w' ? m.p.toUpperCase() : m.p;

  let castle = st.castle;
  if (piece === 'K') castle = castle.replace(/[KQ]/g, '');
  if (piece === 'k') castle = castle.replace(/[kq]/g, '');
  if (m.f === 0 || m.t === 0) castle = castle.replace('Q', '');
  if (m.f === 7 || m.t === 7) castle = castle.replace('K', '');
  if (m.f === 56 || m.t === 56) castle = castle.replace('q', '');
  if (m.f === 63 || m.t === 63) castle = castle.replace('k', '');
  const pawnMove = piece.toLowerCase() === 'p';
  return {
    b,
    turn: side === 'w' ? 'b' : 'w',
    castle,
    ep: m.s === 'd' ? (m.f + m.t) >> 1 : -1,
    half: pawnMove || captured !== null || m.s === 'e' ? 0 : st.half + 1,
    full: st.full + (side === 'b' ? 1 : 0),
  };
}

function legal(st, capturesOnly = false) {
  const side = st.turn;
  return pseudo(st, capturesOnly).filter(m => !inCheck(play(st, m), side));
}

const value = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };

function evaluate(st) {
  let score = 0, whiteBishops = 0, blackBishops = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = st.b[sq];
    if (p === null) continue;
    const side = white(p) ? 1 : -1, type = p.toLowerCase();
    const f = sq & 7, r = white(p) ? sq >> 3 : 7 - (sq >> 3);
    const center = 7 - Math.abs(2 * f - 7) - Math.abs(2 * r - 7);
    let positional = 0;
    if (type === 'p') positional = 5 * r + (f > 1 && f < 6 ? 3 : 0);
    else if (type === 'n') positional = 4 * center;
    else if (type === 'b') { positional = 2 * center; if (side > 0) whiteBishops++; else blackBishops++; }
    else if (type === 'r') positional = 2 * r;
    else if (type === 'q') positional = center;
    else if (type === 'k') positional = -2 * center;
    score += side * (value[type] + positional);
  }
  if (whiteBishops >= 2) score += 25;
  if (blackBishops >= 2) score -= 25;
  return (st.turn === 'w' ? 1 : -1) * score;
}

function movePriority(st, m) {
  const mover = st.b[m.f].toLowerCase();
  let victim = st.b[m.t];
  if (m.s === 'e') victim = st.turn === 'w' ? 'p' : 'P';
  let score = victim ? 10 * value[victim.toLowerCase()] - value[mover] : 0;
  if (m.p) score += value[m.p] + 700;
  if (m.s === 'c') score += 60;
  return score;
}

function ordered(st, moves) {
  return moves.sort((a, b) => movePriority(st, b) - movePriority(st, a));
}

const deadline = Date.now() + 900;
let nodes = 0;
function timeCheck() {
  if ((++nodes & 2047) === 0 && Date.now() > deadline) throw new Error('time');
}

function quiesce(st, alpha, beta, ply) {
  timeCheck();
  const checked = inCheck(st);
  if (!checked) {
    const stand = evaluate(st);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  if (ply >= 8) return checked ? evaluate(st) : alpha;
  const moves = ordered(st, legal(st, !checked));
  if (checked && moves.length === 0) return -30000 + ply;
  for (const m of moves) {
    const score = -quiesce(play(st, m), -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(st, depth, alpha, beta, ply) {
  timeCheck();
  if (depth === 0) return quiesce(st, alpha, beta, ply);
  const moves = ordered(st, legal(st));
  if (moves.length === 0) return inCheck(st) ? -30000 + ply : 0;
  let best = -31000;
  for (const m of moves) {
    const score = -search(play(st, m), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

const rootMoves = ordered(state, legal(state));
if (rootMoves.length > 0) {
  let chosen = rootMoves[0];
  // Completed iterations replace the choice; an interrupted iteration is discarded.
  for (let depth = 1; depth <= 5; depth++) {
    try {
      let iterationBest = rootMoves[0], bestScore = -31000, alpha = -31000;
      for (const m of rootMoves) {
        const score = -search(play(state, m), depth - 1, -31000, -alpha, 1);
        if (score > bestScore) { bestScore = score; iterationBest = m; }
        if (score > alpha) alpha = score;
      }
      chosen = iterationBest;
      // Put the principal variation first in the next iteration.
      rootMoves.splice(rootMoves.indexOf(chosen), 1);
      rootMoves.unshift(chosen);
      if (Math.abs(bestScore) > 29000) break;
    } catch {
      break;
    }
  }
  process.stdout.write(name(chosen.f) + name(chosen.t) + chosen.p);
}
