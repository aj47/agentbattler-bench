import { readFileSync } from 'node:fs';

// Read exactly one FEN from stdin
const raw = readFileSync(0, 'utf8');
const fen = raw.trim().split(/\s+/).slice(0, 6).join(' ');

// ---------- FEN parsing ----------
function parseFEN(fen) {
  const parts = fen.split(' ');
  const boardPart = parts[0] || '';
  const turn = parts[1] || 'w';
  const castling = parts[2] || '-';
  const ep = parts[3] || '-';
  const board = new Array(64).fill(null);
  let idx = 0;
  for (const ch of boardPart) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') {
      idx += parseInt(ch, 10);
    } else {
      board[idx] = ch;
      idx++;
    }
  }
  return { board, turn, castling, ep };
}

const state = parseFEN(fen);

// ---------- helpers ----------
function isWhite(p) { return p && p === p.toUpperCase(); }
function color(p) { return p ? (isWhite(p) ? 'w' : 'b') : null; }
function type(p) { return p ? p.toLowerCase() : null; }
function onBoard(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }
function sq(r, f) { return r * 8 + f; }
function toUci(from, to, promo) {
  const f1 = String.fromCharCode(97 + (from % 8));
  const r1 = 8 - Math.floor(from / 8);
  const f2 = String.fromCharCode(97 + (to % 8));
  const r2 = 8 - Math.floor(to / 8);
  return f1 + r1 + f2 + r2 + (promo || '');
}

const KNIGHT_MOVES = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const KING_DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const BISHOP_DIRS = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ROOK_DIRS = [[-1,0],[1,0],[0,-1],[0,1]];

// ---------- move generation (pseudo-legal) ----------
function genMoves(st) {
  const moves = [];
  const { board, turn, castling, ep } = st;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || color(p) !== turn) continue;
    const r = Math.floor(i / 8), f = i % 8;
    const t = type(p);
    if (t === 'p') {
      const dir = turn === 'w' ? -1 : 1;
      const startRank = turn === 'w' ? 6 : 1;
      const promoRank = turn === 'w' ? 0 : 7;
      const nr = r + dir;
      if (onBoard(nr, f) && !board[sq(nr, f)]) {
        if (nr === promoRank) {
          for (const pr of ['q','r','b','n']) moves.push({ from: i, to: sq(nr, f), promo: pr });
        } else {
          moves.push({ from: i, to: sq(nr, f) });
        }
        if (r === startRank && !board[sq(r + 2 * dir, f)]) {
          moves.push({ from: i, to: sq(r + 2 * dir, f) });
        }
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (!onBoard(nr, nf)) continue;
        const target = board[sq(nr, nf)];
        if (target && color(target) !== turn) {
          if (nr === promoRank) {
            for (const pr of ['q','r','b','n']) moves.push({ from: i, to: sq(nr, nf), promo: pr });
          } else {
            moves.push({ from: i, to: sq(nr, nf) });
          }
        }
        if (ep && ep !== '-') {
          const epFile = ep.charCodeAt(0) - 97;
          const epR = 8 - parseInt(ep[1], 10);
          if (nr === epR && nf === epFile) {
            moves.push({ from: i, to: sq(nr, nf), ep: true });
          }
        }
      }
    } else if (t === 'n') {
      for (const [dr, df] of KNIGHT_MOVES) {
        const nr = r + dr, nf = f + df;
        if (onBoard(nr, nf)) {
          const target = board[sq(nr, nf)];
          if (!target || color(target) !== turn) moves.push({ from: i, to: sq(nr, nf) });
        }
      }
    } else if (t === 'b' || t === 'r' || t === 'q') {
      const dirs = t === 'b' ? BISHOP_DIRS : (t === 'r' ? ROOK_DIRS : KING_DIRS);
      for (const [dr, df] of dirs) {
        let nr = r + dr, nf = f + df;
        while (onBoard(nr, nf)) {
          const target = board[sq(nr, nf)];
          if (!target) {
            moves.push({ from: i, to: sq(nr, nf) });
          } else {
            if (color(target) !== turn) moves.push({ from: i, to: sq(nr, nf) });
            break;
          }
          nr += dr; nf += df;
        }
      }
    } else if (t === 'k') {
      for (const [dr, df] of KING_DIRS) {
        const nr = r + dr, nf = f + df;
        if (onBoard(nr, nf)) {
          const target = board[sq(nr, nf)];
          if (!target || color(target) !== turn) moves.push({ from: i, to: sq(nr, nf) });
        }
      }
      const rank = turn === 'w' ? 7 : 0;
      if (r === rank && f === 4) {
        if (turn === 'w') {
          if (castling.includes('K') && !board[61] && !board[62] && board[63] === 'R')
            moves.push({ from: i, to: 62, castle: 'K' });
          if (castling.includes('Q') && !board[59] && !board[58] && !board[57] && board[56] === 'R')
            moves.push({ from: i, to: 58, castle: 'Q' });
        } else {
          if (castling.includes('k') && !board[5] && !board[6] && board[7] === 'r')
            moves.push({ from: i, to: 6, castle: 'k' });
          if (castling.includes('q') && !board[3] && !board[2] && !board[1] && board[0] === 'r')
            moves.push({ from: i, to: 2, castle: 'q' });
        }
      }
    }
  }
  return moves;
}

// ---------- attack detection ----------
function isAttacked(board, r, f, byColor) {
  const pdir = byColor === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const pr = r + pdir, pf = f + df;
    if (onBoard(pr, pf)) {
      const p = board[sq(pr, pf)];
      if (p && color(p) === byColor && type(p) === 'p') return true;
    }
  }
  for (const [dr, df] of KNIGHT_MOVES) {
    const nr = r + dr, nf = f + df;
    if (onBoard(nr, nf)) {
      const p = board[sq(nr, nf)];
      if (p && color(p) === byColor && type(p) === 'n') return true;
    }
  }
  for (const [dr, df] of KING_DIRS) {
    const nr = r + dr, nf = f + df;
    if (onBoard(nr, nf)) {
      const p = board[sq(nr, nf)];
      if (p && color(p) === byColor && type(p) === 'k') return true;
    }
  }
  for (const [dr, df] of BISHOP_DIRS) {
    let nr = r + dr, nf = f + df;
    while (onBoard(nr, nf)) {
      const p = board[sq(nr, nf)];
      if (p) {
        if (color(p) === byColor && (type(p) === 'b' || type(p) === 'q')) return true;
        break;
      }
      nr += dr; nf += df;
    }
  }
  for (const [dr, df] of ROOK_DIRS) {
    let nr = r + dr, nf = f + df;
    while (onBoard(nr, nf)) {
      const p = board[sq(nr, nf)];
      if (p) {
        if (color(p) === byColor && (type(p) === 'r' || type(p) === 'q')) return true;
        break;
      }
      nr += dr; nf += df;
    }
  }
  return false;
}

function findKing(board, c) {
  const k = c === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (board[i] === k) return i;
  return -1;
}

// ---------- apply move ----------
function applyMove(st, move) {
  const board = st.board.slice();
  const { from, to, promo, ep, castle } = move;
  const piece = board[from];
  const turn = st.turn;
  board[from] = null;
  if (ep) board[sq(Math.floor(from / 8), to % 8)] = null;
  board[to] = promo ? (color(piece) === 'w' ? promo.toUpperCase() : promo.toLowerCase()) : piece;
  if (castle === 'K') { board[63] = null; board[61] = 'R'; }
  else if (castle === 'Q') { board[56] = null; board[59] = 'R'; }
  else if (castle === 'k') { board[7] = null; board[5] = 'r'; }
  else if (castle === 'q') { board[0] = null; board[3] = 'r'; }
  let newEp = '-';
  if (type(piece) === 'p' && Math.abs(Math.floor(to / 8) - Math.floor(from / 8)) === 2) {
    const epR = (Math.floor(from / 8) + Math.floor(to / 8)) / 2;
    newEp = String.fromCharCode(97 + (from % 8)) + (8 - epR);
  }
  let cr = st.castling;
  if (cr && cr !== '-') {
    let r = cr;
    const rem = (c) => { r = r.split(c).join(''); };
    if (type(piece) === 'k') {
      if (turn === 'w') { rem('K'); rem('Q'); } else { rem('k'); rem('q'); }
    }
    if (type(piece) === 'r') {
      if (from === 56) rem('Q'); else if (from === 63) rem('K');
      else if (from === 0) rem('q'); else if (from === 7) rem('k');
    }
    if (to === 56) rem('Q'); if (to === 63) rem('K');
    if (to === 0) rem('q'); if (to === 7) rem('k');
    cr = r || '-';
  }
  return { board, turn: turn === 'w' ? 'b' : 'w', castling: cr, ep: newEp };
}

// ---------- legal move filtering ----------
function legalMoves(st) {
  const pseudo = genMoves(st);
  const legal = [];
  const myColor = st.turn;
  const opp = myColor === 'w' ? 'b' : 'w';
  for (const m of pseudo) {
    if (m.castle) {
      const rank = myColor === 'w' ? 7 : 0;
      if (isAttacked(st.board, rank, 4, opp)) continue;
      if (m.castle === 'K' || m.castle === 'k') {
        if (isAttacked(st.board, rank, 5, opp)) continue;
        if (isAttacked(st.board, rank, 6, opp)) continue;
      } else {
        if (isAttacked(st.board, rank, 3, opp)) continue;
        if (isAttacked(st.board, rank, 2, opp)) continue;
      }
    }
    const ns = applyMove(st, m);
    const ki = findKing(ns.board, myColor);
    if (ki < 0) { legal.push(m); continue; }
    if (!isAttacked(ns.board, Math.floor(ki / 8), ki % 8, opp)) legal.push(m);
  }
  return legal;
}

// ---------- evaluation ----------
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const PST_P = [
  0,0,0,0,0,0,0,0,
  5,10,10,-20,-20,10,10,5,
  5,-5,-10,0,0,-10,-5,5,
  0,0,0,20,20,0,0,0,
  5,5,10,25,25,10,5,5,
  10,10,20,30,30,20,10,10,
  50,50,50,50,50,50,50,50,
  0,0,0,0,0,0,0,0
];
const PST_N = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,0,5,5,0,-20,-40,
  -30,5,10,15,15,10,5,-30,
  -30,0,15,20,20,15,0,-30,
  -30,5,15,20,20,15,5,-30,
  -30,0,10,15,15,10,0,-30,
  -40,-20,0,0,0,0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50
];

function evaluate(st) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = st.board[i];
    if (!p) continue;
    const c = color(p);
    const t = type(p);
    const sign = c === st.turn ? 1 : -1;
    score += sign * VAL[t];
    const idx = c === 'w' ? i : 63 - i;
    if (t === 'p') score += sign * PST_P[idx];
    else if (t === 'n') score += sign * PST_N[idx];
  }
  return score;
}

// ---------- search (negamax + alpha-beta) ----------
function search(st, depth, alpha, beta) {
  const moves = legalMoves(st);
  if (moves.length === 0) {
    const ki = findKing(st.board, st.turn);
    const opp = st.turn === 'w' ? 'b' : 'w';
    if (ki >= 0 && isAttacked(st.board, Math.floor(ki / 8), ki % 8, opp))
      return -1000000 - depth;
    return 0;
  }
  if (depth <= 0) return evaluate(st);
  let best = -Infinity;
  // simple ordering: captures first
  moves.sort((a, b) => {
    const ca = st.board[a.to] ? 1 : 0;
    const cb = st.board[b.to] ? 1 : 0;
    return cb - ca;
  });
  for (const m of moves) {
    const ns = applyMove(st, m);
    const val = -search(ns, depth - 1, -beta, -alpha);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickMove(st) {
  const moves = legalMoves(st);
  if (moves.length === 0) return null;
  let best = -Infinity, bestMove = moves[0];
  for (const m of moves) {
    const ns = applyMove(st, m);
    let val = -search(ns, 2, -Infinity, Infinity);
    val += (st.board[m.to] ? 0.1 : 0) + (m.promo ? 0.2 : 0);
    if (val > best) { best = val; bestMove = m; }
  }
  return bestMove;
}

const move = pickMove(state);
if (move) {
  process.stdout.write(toUci(move.from, move.to, move.promo) + '\n');
}
