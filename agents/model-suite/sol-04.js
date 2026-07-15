import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const FILES = 'abcdefgh';
const VALUE = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
const MATE = 100000;
const TIMEOUT = {};
let nodes = 0;
let deadline = 0;

const color = p => !p ? '' : p === p.toUpperCase() ? 'w' : 'b';
const other = c => c === 'w' ? 'b' : 'w';
const squareName = s => FILES[s & 7] + String((s >> 3) + 1);

function parseFen(fen) {
  const fields = fen.trim().split(/\s+/);
  const board = Array(64).fill('');
  const rows = fields[0].split('/');
  for (let i = 0; i < 8; i++) {
    let file = 0;
    for (const ch of rows[i]) {
      if (ch >= '1' && ch <= '8') file += Number(ch);
      else board[(7 - i) * 8 + file++] = ch;
    }
  }
  let ep = -1;
  if (fields[3] && fields[3] !== '-') {
    ep = FILES.indexOf(fields[3][0]) + (Number(fields[3][1]) - 1) * 8;
  }
  return {
    board,
    turn: fields[1],
    castling: fields[2] === '-' ? '' : fields[2],
    ep
  };
}

function attacked(s, target, by) {
  const b = s.board;
  const tf = target & 7;
  if (by === 'w') {
    if (tf < 7 && target >= 7 && b[target - 7] === 'P') return true;
    if (tf > 0 && target >= 9 && b[target - 9] === 'P') return true;
  } else {
    if (tf > 0 && target <= 56 && b[target + 7] === 'p') return true;
    if (tf < 7 && target <= 54 && b[target + 9] === 'p') return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  const tr = target >> 3;
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === knight) return true;
  }
  for (const [df, dr, kinds] of [
    [1, 0, 'rq'], [-1, 0, 'rq'], [0, 1, 'rq'], [0, -1, 'rq'],
    [1, 1, 'bq'], [1, -1, 'bq'], [-1, 1, 'bq'], [-1, -1, 'bq']
  ]) {
    let f = tf + df, r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p) {
        if (color(p) === by && kinds.includes(p.toLowerCase())) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === king) return true;
  }
  return false;
}

function inCheck(s, side) {
  const king = side === 'w' ? 'K' : 'k';
  const sq = s.board.indexOf(king);
  return sq < 0 || attacked(s, sq, other(side));
}

function pseudoMoves(s) {
  const b = s.board, side = s.turn, moves = [];
  const add = (from, to, extra = {}) => moves.push({
    from, to, capture: extra.capture || '', promotion: extra.promotion || '',
    ep: Boolean(extra.ep), castle: extra.castle || ''
  });
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || color(p) !== side) continue;
    const kind = p.toLowerCase(), f = from & 7, r = from >> 3;
    if (kind === 'p') {
      const dir = side === 'w' ? 8 : -8;
      const start = side === 'w' ? 1 : 6;
      const promotionRank = side === 'w' ? 7 : 0;
      const one = from + dir;
      if (one >= 0 && one < 64 && !b[one]) {
        if ((one >> 3) === promotionRank) {
          for (const q of ['q', 'r', 'b', 'n']) add(from, one, { promotion: q });
        } else {
          add(from, one);
          const two = from + 2 * dir;
          if (r === start && !b[two]) add(from, two);
        }
      }
      for (const df of [-1, 1]) {
        if (f + df < 0 || f + df > 7) continue;
        const to = from + dir + df;
        if (to < 0 || to >= 64) continue;
        const victim = b[to];
        if (victim && color(victim) !== side && victim.toLowerCase() !== 'k') {
          if ((to >> 3) === promotionRank) {
            for (const q of ['q', 'r', 'b', 'n']) add(from, to, { capture: victim, promotion: q });
          } else add(from, to, { capture: victim });
        } else if (to === s.ep && !victim) {
          const captured = b[to - dir];
          if (captured === (side === 'w' ? 'p' : 'P')) add(from, to, { capture: captured, ep: true });
        }
      }
    } else if (kind === 'n') {
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, victim = b[to];
        if (!victim) add(from, to);
        else if (color(victim) !== side && victim.toLowerCase() !== 'k') add(from, to, { capture: victim });
      }
    } else if (kind === 'b' || kind === 'r' || kind === 'q') {
      const dirs = [];
      if (kind !== 'b') dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      if (kind !== 'r') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf, victim = b[to];
          if (!victim) add(from, to);
          else {
            if (color(victim) !== side && victim.toLowerCase() !== 'k') add(from, to, { capture: victim });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
    } else if (kind === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, victim = b[to];
        if (!victim) add(from, to);
        else if (color(victim) !== side && victim.toLowerCase() !== 'k') add(from, to, { capture: victim });
      }
      const foe = other(side);
      if (side === 'w' && from === 4 && p === 'K') {
        if (s.castling.includes('K') && b[7] === 'R' && !b[5] && !b[6] &&
            !attacked(s, 4, foe) && !attacked(s, 5, foe) && !attacked(s, 6, foe)) add(4, 6, { castle: 'K' });
        if (s.castling.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] &&
            !attacked(s, 4, foe) && !attacked(s, 3, foe) && !attacked(s, 2, foe)) add(4, 2, { castle: 'Q' });
      } else if (side === 'b' && from === 60 && p === 'k') {
        if (s.castling.includes('k') && b[63] === 'r' && !b[61] && !b[62] &&
            !attacked(s, 60, foe) && !attacked(s, 61, foe) && !attacked(s, 62, foe)) add(60, 62, { castle: 'k' });
        if (s.castling.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] &&
            !attacked(s, 60, foe) && !attacked(s, 59, foe) && !attacked(s, 58, foe)) add(60, 58, { castle: 'q' });
      }
    }
  }
  return moves;
}

function makeMove(s, m) {
  const board = s.board.slice();
  const piece = board[m.from], side = s.turn;
  board[m.from] = '';
  if (m.ep) board[m.to + (side === 'w' ? -8 : 8)] = '';
  board[m.to] = m.promotion ? (side === 'w' ? m.promotion.toUpperCase() : m.promotion) : piece;
  if (m.castle) {
    const rookFrom = m.to > m.from ? m.from + 3 : m.from - 4;
    const rookTo = m.to > m.from ? m.from + 1 : m.from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = '';
  }
  let castling = s.castling;
  if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (piece === 'k') castling = castling.replace(/[kq]/g, '');
  if (m.from === 0 || m.to === 0) castling = castling.replace('Q', '');
  if (m.from === 7 || m.to === 7) castling = castling.replace('K', '');
  if (m.from === 56 || m.to === 56) castling = castling.replace('q', '');
  if (m.from === 63 || m.to === 63) castling = castling.replace('k', '');
  const ep = piece.toLowerCase() === 'p' && Math.abs(m.to - m.from) === 16 ? (m.to + m.from) >> 1 : -1;
  return { board, turn: other(side), castling, ep };
}

function legalMoves(s) {
  const side = s.turn;
  return pseudoMoves(s).filter(m => !inCheck(makeMove(s, m), side));
}

function moveText(m) {
  return squareName(m.from) + squareName(m.to) + m.promotion;
}

function evaluation(s) {
  let score = 0, whiteBishops = 0, blackBishops = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.board[sq];
    if (!p) continue;
    const side = color(p), sign = side === 'w' ? 1 : -1;
    const kind = p.toLowerCase(), f = sq & 7, r = sq >> 3;
    let bonus = 0;
    const center = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 3.5));
    if (kind === 'p') bonus = (side === 'w' ? r : 7 - r) * 8 - Math.abs(f - 3.5) * 2;
    else if (kind === 'n') bonus = center * 9;
    else if (kind === 'b') { bonus = center * 4; if (side === 'w') whiteBishops++; else blackBishops++; }
    else if (kind === 'r') bonus = (side === 'w' ? r : 7 - r) * 2;
    else if (kind === 'q') bonus = center;
    else if (kind === 'k') {
      const home = side === 'w' ? r : 7 - r;
      bonus = home < 2 ? (Math.abs(f - 3.5) - 1.5) * 5 : -center * 3;
    }
    score += sign * (VALUE[kind] + bonus);
  }
  if (whiteBishops >= 2) score += 28;
  if (blackBishops >= 2) score -= 28;
  return (s.turn === 'w' ? 1 : -1) * score;
}

function orderScore(m, preferred = '') {
  let score = moveText(m) === preferred ? 1000000 : 0;
  if (m.capture) score += 10000 + 10 * VALUE[m.capture.toLowerCase()] - VALUE[m.promotion ? 'p' : 'p'];
  if (m.promotion) score += 8000 + VALUE[m.promotion];
  if (m.castle) score += 200;
  const f = m.to & 7, r = m.to >> 3;
  score += 7 - Math.abs(f - 3.5) - Math.abs(r - 3.5);
  return score;
}

function ordered(moves, preferred = '') {
  return moves.sort((a, b) => orderScore(b, preferred) - orderScore(a, preferred));
}

function timeCheck() {
  if ((++nodes & 1023) === 0 && performance.now() >= deadline) throw TIMEOUT;
}

function quiesce(s, alpha, beta, ply, qdepth) {
  timeCheck();
  const checked = inCheck(s, s.turn);
  let moves = legalMoves(s);
  if (!moves.length) return checked ? -MATE + ply : 0;
  if (qdepth >= 6) return evaluation(s);
  if (!checked) {
    const stand = evaluation(s);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    moves = moves.filter(m => m.capture || m.promotion);
    if (!moves.length) return alpha;
  }
  for (const m of ordered(moves)) {
    const score = -quiesce(makeMove(s, m), -beta, -alpha, ply + 1, qdepth + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(s, depth, alpha, beta, ply) {
  timeCheck();
  if (depth <= 0) return quiesce(s, alpha, beta, ply, 0);
  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s, s.turn) ? -MATE + ply : 0;
  for (const m of ordered(moves)) {
    const score = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function rootSearch(s, depth, preferred) {
  let alpha = -MATE, best = null;
  const moves = ordered(legalMoves(s), preferred);
  for (const m of moves) {
    const score = -negamax(makeMove(s, m), depth - 1, -MATE, -alpha, 1);
    if (best === null || score > alpha) {
      alpha = score;
      best = m;
    }
  }
  return best;
}

const state = parseFen(readFileSync(0, 'utf8'));
const initial = legalMoves(state);
if (initial.length) {
  let best = ordered(initial)[0];
  deadline = performance.now() + 700;
  for (let depth = 1; depth <= 7; depth++) {
    try {
      const found = rootSearch(state, depth, moveText(best));
      if (found) best = found;
      if (performance.now() >= deadline) break;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
  process.stdout.write(moveText(best));
}
