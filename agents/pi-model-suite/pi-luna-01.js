/* A small, self-contained chess player.  Squares are numbered a1=0 through h8=63. */
import process from 'node:process';
const V = { p:100, n:320, b:330, r:500, q:900, k:20000 };
const files = "abcdefgh";
const dirsB = [[1,1],[1,-1],[-1,1],[-1,-1]];
const dirsR = [[1,0],[-1,0],[0,1],[0,-1]];
const dirsK = [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
const dirsN = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];

function colour(p) { return p === p.toUpperCase() ? 'w' : 'b'; }
function enemy(p, c) { return p !== '.' && colour(p) !== c; }
function own(p, c) { return p !== '.' && colour(p) === c; }
function sq(x, y) { return y * 8 + x; }
function inside(x, y) { return x >= 0 && x < 8 && y >= 0 && y < 8; }
function pawnChar(c) { return c === 'w' ? 'P' : 'p'; }
function makeMove(from, to, promotion, kind) {
  return { from, to, promotion: promotion || '', kind: kind || '' };
}

function parseFen(text) {
  const f = text.trim().split(/\s+/);
  const b = Array(64).fill('.');
  const rows = (f[0] || '').split('/');
  for (let row = 0; row < 8; row++) {
    let x = 0;
    for (const ch of (rows[row] || '')) {
      if (ch >= '1' && ch <= '8') x += +ch;
      else if (x < 8) b[sq(x++, 7 - row)] = ch;
    }
  }
  let rights = 0;
  for (const ch of f[2] || '') rights |= ch === 'K' ? 1 : ch === 'Q' ? 2 : ch === 'k' ? 4 : ch === 'q' ? 8 : 0;
  let ep = -1;
  if (f[3] && f[3] !== '-') ep = files.indexOf(f[3][0]) + 8 * (+f[3][1] - 1);
  return { b, side: f[1] === 'b' ? 'b' : 'w', rights, ep, half: +(f[4] || 0) || 0 };
}

/* Whether a square is attacked by side c.  This deliberately does not care
   whether the attacking piece is pinned: that is the definition needed for
   king moves and castling. */
function attacked(b, target, c) {
  const tx = target & 7, ty = target >> 3;
  const py = ty + (c === 'w' ? -1 : 1);
  for (const dx of [-1, 1]) if (inside(tx + dx, py) && b[sq(tx + dx, py)] === pawnChar(c)) return true;
  for (const [dx, dy] of dirsN) if (inside(tx + dx, ty + dy) && b[sq(tx + dx, ty + dy)] === (c === 'w' ? 'N' : 'n')) return true;
  for (const [dx, dy] of dirsK) if (inside(tx + dx, ty + dy) && b[sq(tx + dx, ty + dy)] === (c === 'w' ? 'K' : 'k')) return true;
  for (const [dx, dy] of dirsB) {
    let x = tx + dx, y = ty + dy;
    while (inside(x, y)) {
      const p = b[sq(x, y)];
      if (p !== '.') { if (p === (c === 'w' ? 'B' : 'b') || p === (c === 'w' ? 'Q' : 'q')) return true; break; }
      x += dx; y += dy;
    }
  }
  for (const [dx, dy] of dirsR) {
    let x = tx + dx, y = ty + dy;
    while (inside(x, y)) {
      const p = b[sq(x, y)];
      if (p !== '.') { if (p === (c === 'w' ? 'R' : 'r') || p === (c === 'w' ? 'Q' : 'q')) return true; break; }
      x += dx; y += dy;
    }
  }
  return false;
}

function inCheck(s, c) {
  const king = c === 'w' ? 'K' : 'k';
  const k = s.b.indexOf(king);
  return k < 0 || attacked(s.b, k, c === 'w' ? 'b' : 'w');
}

function addPawnMoves(s, moves, from, c) {
  const b = s.b, x = from & 7, y = from >> 3, d = c === 'w' ? 1 : -1;
  const last = c === 'w' ? 7 : 0;
  const oneY = y + d;
  if (inside(x, oneY) && b[sq(x, oneY)] === '.') {
    const to = sq(x, oneY);
    if (oneY === last) for (const p of 'qrbn') moves.push(makeMove(from, to, c === 'w' ? p.toUpperCase() : p));
    else moves.push(makeMove(from, to));
    const start = c === 'w' ? 1 : 6;
    const two = sq(x, y + 2 * d);
    if (y === start && b[two] === '.') moves.push(makeMove(from, two));
  }
  for (const dx of [-1, 1]) {
    const nx = x + dx;
    if (!inside(nx, oneY)) continue;
    const to = sq(nx, oneY), p = b[to];
    const epPawn = c === 'w' ? to - 8 : to + 8;
    if (enemy(p, c) || (to === s.ep && p === '.' && b[epPawn] === pawnChar(c === 'w' ? 'b' : 'w'))) {
      if (oneY === last) for (const q of 'qrbn') moves.push(makeMove(from, to, c === 'w' ? q.toUpperCase() : q, to === s.ep && p === '.' ? 'ep' : ''));
      else moves.push(makeMove(from, to, '', to === s.ep && p === '.' ? 'ep' : ''));
    }
  }
}

function pseudo(s) {
  const b = s.b, c = s.side, out = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!own(p, c)) continue;
    const type = p.toLowerCase(), x = from & 7, y = from >> 3;
    if (type === 'p') { addPawnMoves(s, out, from, c); continue; }
    if (type === 'n') {
      for (const [dx, dy] of dirsN) if (inside(x + dx, y + dy)) {
        const to = sq(x + dx, y + dy); if (!own(b[to], c)) out.push(makeMove(from, to));
      }
      continue;
    }
    if (type === 'b' || type === 'r' || type === 'q') {
      const ds = type === 'b' ? dirsB : type === 'r' ? dirsR : dirsB.concat(dirsR);
      for (const [dx, dy] of ds) {
        let nx = x + dx, ny = y + dy;
        while (inside(nx, ny)) {
          const to = sq(nx, ny);
          if (b[to] === '.') out.push(makeMove(from, to));
          else { if (enemy(b[to], c)) out.push(makeMove(from, to)); break; }
          nx += dx; ny += dy;
        }
      }
      continue;
    }
    if (type === 'k') {
      for (const [dx, dy] of dirsK) if (inside(x + dx, y + dy)) {
        const to = sq(x + dx, y + dy); if (!own(b[to], c)) out.push(makeMove(from, to));
      }
      const home = c === 'w' ? 4 : 60, enemySide = c === 'w' ? 'b' : 'w';
      if (from === home && !inCheck(s, c)) {
        const castleBoard = b.slice();
        castleBoard[home] = '.';
        const kingRight = c === 'w' ? 1 : 4, queenRight = c === 'w' ? 2 : 8;
        const rook = c === 'w' ? 'R' : 'r';
        if ((s.rights & kingRight) && b[home + 3] === rook && b[home + 1] === '.' && b[home + 2] === '.' &&
            !attacked(castleBoard, home + 1, enemySide) && !attacked(castleBoard, home + 2, enemySide)) out.push(makeMove(from, home + 2, '', 'castle'));
        if ((s.rights & queenRight) && b[home - 4] === rook && b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.' &&
            !attacked(castleBoard, home - 1, enemySide) && !attacked(castleBoard, home - 2, enemySide)) out.push(makeMove(from, home - 2, '', 'castle'));
      }
    }
  }
  return out;
}

function apply(s, m) {
  const b = s.b.slice(), p = b[m.from], c = s.side;
  b[m.from] = '.';
  if (m.kind === 'ep') b[m.to + (c === 'w' ? -8 : 8)] = '.';
  b[m.to] = m.promotion || p;
  if (m.kind === 'castle') {
    if (m.to > m.from) { b[m.from + 3] = '.'; b[m.from + 1] = c === 'w' ? 'R' : 'r'; }
    else { b[m.from - 4] = '.'; b[m.from - 1] = c === 'w' ? 'R' : 'r'; }
  }
  let rights = s.rights;
  if (p === 'K') rights &= ~3; else if (p === 'k') rights &= ~12;
  if (m.from === 0 || m.to === 0) rights &= ~2;
  if (m.from === 7 || m.to === 7) rights &= ~1;
  if (m.from === 56 || m.to === 56) rights &= ~8;
  if (m.from === 63 || m.to === 63) rights &= ~4;
  let ep = -1;
  if (p.toLowerCase() === 'p' && Math.abs(m.to - m.from) === 16) ep = (m.to + m.from) >> 1;
  return { b, side: c === 'w' ? 'b' : 'w', rights, ep, half: s.half + 1 };
}

function legalMoves(s) {
  const out = [];
  for (const m of pseudo(s)) { const n = apply(s, m); if (!inCheck(n, s.side)) out.push(m); }
  return out;
}

const pst = {
  p: [0,0,0,0,0,0,0,0, 5,10,10,-20,-20,10,10,5, 5,-5,-10,0,0,-10,-5,5, 0,0,0,20,20,0,0,0, 5,5,10,25,25,10,5,5, 10,10,20,30,30,20,10,10, 50,50,50,50,50,50,50,50, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,5,5,0,-20,-40, -30,5,10,15,15,10,5,-30, -30,0,15,20,20,15,0,-30, -30,5,15,20,20,15,5,-30, -30,0,10,15,15,10,0,-30, -40,-20,0,0,0,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,5,5,0,0,0, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 5,10,10,10,10,10,10,5, 0,0,0,0,0,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,5,0,0,0,0,-10, -10,5,5,5,5,5,0,-10, 0,0,5,5,5,5,0,-5, -5,0,5,5,5,5,0,-5, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20]
};
function evaluate(s) {
  let score = 0;
  for (let i = 0; i < 64; i++) if (s.b[i] !== '.') {
    const p = s.b[i], t = p.toLowerCase(), y = i >> 3, j = p === p.toUpperCase() ? i : (7 - y) * 8 + (i & 7);
    score += (p === p.toUpperCase() ? 1 : -1) * (V[t] + (pst[t] ? pst[t][j] : 0));
  }
  return s.side === 'w' ? score : -score;
}
function moveValue(s, m) {
  const victim = s.b[m.to];
  let v = victim === '.' ? 0 : V[victim.toLowerCase()] - V[s.b[m.from].toLowerCase()] / 20;
  if (m.kind === 'ep') v += V.p;
  if (m.promotion) v += V[m.promotion.toLowerCase()] - V.p;
  if (m.kind === 'castle') v += 30;
  return v;
}
function search(s, depth, alpha, beta, ply) {
  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s, s.side) ? -100000 + ply : 0;
  if (depth <= 0) return evaluate(s);
  moves.sort((a, b) => moveValue(s, b) - moveValue(s, a));
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(apply(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
function uci(m) {
  const at = n => files[n & 7] + String((n >> 3) + 1);
  return at(m.from) + at(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
}
function choose(s) {
  const moves = legalMoves(s);
  if (!moves.length) return '';
  moves.sort((a, b) => moveValue(s, b) - moveValue(s, a));
  let best = moves[0], bestScore = -Infinity;
  /* Three plies is enough to avoid most hanging-piece moves while keeping the
     program responsive even on positions with many promotions or checks. */
  for (const m of moves) {
    const score = -search(apply(s, m), 2, -Infinity, Infinity, 1);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return uci(best);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const fen = input.trim();
  const move = choose(parseFen(fen));
  process.stdout.write(move + (move ? '\n' : ''));
});
