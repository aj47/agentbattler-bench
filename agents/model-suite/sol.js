import { readFileSync } from 'node:fs';

// Complete legal move generation plus an iterative-deepening alpha-beta player.
// Squares are numbered a1=0 through h8=63.
const input = readFileSync(0, 'utf8').trim();

function parseFen(fen) {
  const p = fen.split(/\s+/), b = Array(64).fill(null), ranks = p[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const c of ranks[7 - r]) {
      if (c >= '1' && c <= '8') f += Number(c);
      else b[r * 8 + f++] = c;
    }
  }
  return { b, turn: p[1], castle: p[2] === '-' ? '' : p[2], ep: p[3] === '-' ? -1 : square(p[3]), half: Number(p[4] || 0), full: Number(p[5] || 1) };
}

function square(s) { return s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49); }
function name(s) { return String.fromCharCode(97 + (s & 7)) + String(1 + (s >> 3)); }
function white(p) { return p && p === p.toUpperCase(); }
function sidePiece(p, side) { return !!p && white(p) === (side === 'w'); }
function type(p) { return p ? p.toLowerCase() : ''; }
function uci(m) { return name(m.from) + name(m.to) + (m.prom || ''); }

const knightSteps = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const kingSteps = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]];
const bishopDirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const rookDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function attacked(s, target, by) {
  const b = s.b, tf = target & 7, tr = target >> 3, pawn = by === 'w' ? 'P' : 'p';
  const pawnRank = tr + (by === 'w' ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    if (tf > 0 && b[pawnRank * 8 + tf - 1] === pawn) return true;
    if (tf < 7 && b[pawnRank * 8 + tf + 1] === pawn) return true;
  }
  const n = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of knightSteps) {
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === n) return true;
  }
  const k = by === 'w' ? 'K' : 'k';
  for (const [df, dr] of kingSteps) {
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === k) return true;
  }
  for (const [df, dr] of bishopDirs) {
    for (let f = tf + df, r = tr + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
      const p = b[r * 8 + f];
      if (p) { if (sidePiece(p, by) && (type(p) === 'b' || type(p) === 'q')) return true; break; }
    }
  }
  for (const [df, dr] of rookDirs) {
    for (let f = tf + df, r = tr + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
      const p = b[r * 8 + f];
      if (p) { if (sidePiece(p, by) && (type(p) === 'r' || type(p) === 'q')) return true; break; }
    }
  }
  return false;
}

function kingSquare(s, side) { return s.b.indexOf(side === 'w' ? 'K' : 'k'); }
function inCheck(s, side = s.turn) {
  const k = kingSquare(s, side);
  return k >= 0 && attacked(s, k, side === 'w' ? 'b' : 'w');
}

function addPawnMove(out, from, to, captured, special = '') {
  const rank = to >> 3;
  if (rank === 0 || rank === 7) for (const prom of ['q', 'r', 'b', 'n']) out.push({ from, to, prom, captured, special });
  else out.push({ from, to, captured, special });
}

function pseudoMoves(s) {
  const out = [], b = s.b, us = s.turn, them = us === 'w' ? 'b' : 'w';
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!sidePiece(p, us)) continue;
    const f = from & 7, r = from >> 3, t = type(p);
    if (t === 'p') {
      const dr = us === 'w' ? 1 : -1, start = us === 'w' ? 1 : 6, one = from + dr * 8;
      if (one >= 0 && one < 64 && !b[one]) {
        addPawnMove(out, from, one, null);
        const two = from + dr * 16;
        if (r === start && !b[two]) out.push({ from, to: two, captured: null, special: 'double' });
      }
      for (const df of [-1, 1]) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (b[to] && sidePiece(b[to], them)) addPawnMove(out, from, to, b[to]);
        else if (to === s.ep) addPawnMove(out, from, to, us === 'w' ? 'p' : 'P', 'ep');
      }
    } else if (t === 'n' || t === 'k') {
      const steps = t === 'n' ? knightSteps : kingSteps;
      for (const [df, dr] of steps) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, q = b[to];
        if (!q || sidePiece(q, them)) out.push({ from, to, captured: q });
      }
      if (t === 'k' && !inCheck(s, us)) {
        if (us === 'w' && from === 4) {
          if (s.castle.includes('K') && b[7] === 'R' && !b[5] && !b[6] && !attacked(s, 5, them) && !attacked(s, 6, them)) out.push({ from: 4, to: 6, captured: null, special: 'castle' });
          if (s.castle.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] && !attacked(s, 3, them) && !attacked(s, 2, them)) out.push({ from: 4, to: 2, captured: null, special: 'castle' });
        } else if (us === 'b' && from === 60) {
          if (s.castle.includes('k') && b[63] === 'r' && !b[61] && !b[62] && !attacked(s, 61, them) && !attacked(s, 62, them)) out.push({ from: 60, to: 62, captured: null, special: 'castle' });
          if (s.castle.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] && !attacked(s, 59, them) && !attacked(s, 58, them)) out.push({ from: 60, to: 58, captured: null, special: 'castle' });
        }
      }
    } else {
      const dirs = t === 'b' ? bishopDirs : t === 'r' ? rookDirs : bishopDirs.concat(rookDirs);
      for (const [df, dr] of dirs) {
        for (let nf = f + df, nr = r + dr; nf >= 0 && nf < 8 && nr >= 0 && nr < 8; nf += df, nr += dr) {
          const to = nr * 8 + nf, q = b[to];
          if (!q) out.push({ from, to, captured: null });
          else { if (sidePiece(q, them)) out.push({ from, to, captured: q }); break; }
        }
      }
    }
  }
  return out;
}

function makeMove(s, m) {
  const b = s.b.slice(), us = s.turn, p = b[m.from], captured = b[m.to];
  b[m.from] = null;
  b[m.to] = m.prom ? (us === 'w' ? m.prom.toUpperCase() : m.prom) : p;
  if (m.special === 'ep') b[m.to + (us === 'w' ? -8 : 8)] = null;
  if (m.special === 'castle') {
    if (m.to === 6) { b[5] = b[7]; b[7] = null; }
    else if (m.to === 2) { b[3] = b[0]; b[0] = null; }
    else if (m.to === 62) { b[61] = b[63]; b[63] = null; }
    else { b[59] = b[56]; b[56] = null; }
  }
  let castle = s.castle;
  if (p === 'K') castle = castle.replace(/[KQ]/g, '');
  if (p === 'k') castle = castle.replace(/[kq]/g, '');
  const rightsAt = { 0: 'Q', 7: 'K', 56: 'q', 63: 'k' };
  if (rightsAt[m.from]) castle = castle.replace(rightsAt[m.from], '');
  if (rightsAt[m.to] && captured) castle = castle.replace(rightsAt[m.to], '');
  return { b, turn: us === 'w' ? 'b' : 'w', castle, ep: m.special === 'double' ? (m.from + m.to) >> 1 : -1, half: type(p) === 'p' || m.captured ? 0 : s.half + 1, full: s.full + (us === 'b' ? 1 : 0) };
}

function legalMoves(s) {
  const us = s.turn;
  return pseudoMoves(s).filter(m => !inCheck(makeMove(s, m), us));
}

const value = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let score = 0, wb = 0, bb = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq];
    if (!p) continue;
    const sign = white(p) ? 1 : -1, t = type(p), f = sq & 7, r = sq >> 3;
    const center = 7 - Math.abs(2 * f - 7) - Math.abs(2 * r - 7);
    let bonus = 0;
    if (t === 'p') bonus = (white(p) ? r : 7 - r) * 7 + Math.max(0, center) * 2;
    else if (t === 'n') bonus = center * 4;
    else if (t === 'b') { bonus = center * 2; if (white(p)) wb++; else bb++; }
    else if (t === 'r') bonus = (white(p) ? r : 7 - r) * 2;
    else if (t === 'q') bonus = center;
    else { const home = white(p) ? r : 7 - r; bonus = s.full < 18 ? -center * 2 - home * 4 : center * 3; }
    score += sign * (value[t] + bonus);
  }
  if (wb >= 2) score += 25;
  if (bb >= 2) score -= 25;
  return s.turn === 'w' ? score : -score;
}

const MATE = 100000, INF = 1000000, timeout = {};
let deadline = 0, nodes = 0;
const table = new Map();
function key(s) { return s.b.map(x => x || '.').join('') + s.turn + s.castle + s.ep; }
function moveScore(m, preferred) {
  if (preferred && uci(m) === preferred) return 100000;
  let n = m.prom ? value[m.prom] + 800 : 0;
  if (m.captured) n += 10 * value[type(m.captured)] - value[type(m.piece || '')] / 10;
  if (m.special === 'castle') n += 40;
  return n;
}
function ordered(s, moves, preferred) {
  for (const m of moves) m.piece = s.b[m.from];
  return moves.sort((a, b) => moveScore(b, preferred) - moveScore(a, preferred));
}
function timeCheck() { if ((++nodes & 1023) === 0 && Date.now() >= deadline) throw timeout; }

function quiesce(s, alpha, beta, ply, qdepth = 0) {
  timeCheck();
  const check = inCheck(s), stand = evaluate(s);
  if (!check) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qdepth >= 7) return alpha;
  } else if (qdepth >= 9) return stand;
  let moves = legalMoves(s);
  if (check && moves.length === 0) return -MATE + ply;
  if (!check) moves = moves.filter(m => m.captured || m.prom);
  ordered(s, moves, null);
  for (const m of moves) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, ply + 1, qdepth + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(s, depth, alpha, beta, ply) {
  timeCheck();
  if (depth <= 0) return quiesce(s, alpha, beta, ply);
  const originalAlpha = alpha, k = key(s), old = table.get(k);
  if (old && old.depth >= depth) {
    if (old.flag === 0) return old.score;
    if (old.flag < 0 && old.score <= alpha) return old.score;
    if (old.flag > 0 && old.score >= beta) return old.score;
  }
  const moves = ordered(s, legalMoves(s), old?.best);
  if (!moves.length) return inCheck(s) ? -MATE + ply : 0;
  let best = -INF, bestMove = null;
  for (const m of moves) {
    const score = -search(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) { best = score; bestMove = m; }
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  const flag = best <= originalAlpha ? -1 : best >= beta ? 1 : 0;
  table.set(k, { depth, score: best, flag, best: bestMove && uci(bestMove) });
  return best;
}

function choose(s) {
  let moves = legalMoves(s);
  if (!moves.length) return null;
  let bestMove = moves[0];
  deadline = Date.now() + 850;
  for (let depth = 1; depth <= 7; depth++) {
    try {
      const prior = table.get(key(s))?.best;
      moves = ordered(s, legalMoves(s), prior);
      let iterationBest = moves[0], best = -INF, alpha = -INF;
      for (const m of moves) {
        const score = -search(makeMove(s, m), depth - 1, -INF, -alpha, 1);
        if (score > best) { best = score; iterationBest = m; }
        if (score > alpha) alpha = score;
      }
      bestMove = iterationBest;
      table.set(key(s), { depth, score: best, flag: 0, best: uci(bestMove) });
      if (Math.abs(best) > MATE - 100) break;
    } catch (e) {
      if (e !== timeout) throw e;
      break;
    }
  }
  return bestMove;
}

const selected = choose(parseFen(input));
if (selected) process.stdout.write(uci(selected) + '\n');
