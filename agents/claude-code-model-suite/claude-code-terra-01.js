import fs from 'node:fs';

const fen = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const board = [];
for (const row of rows) {
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') {
      for (let i = 0; i < Number(ch); i++) board.push('.');
    } else board.push(ch);
  }
}

const white = fen[1] === 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-'
  ? (8 - Number(fen[3][1])) * 8 + fen[3].charCodeAt(0) - 97
  : -1;

function mine(p, w) {
  return p !== '.' && (w ? p >= 'A' && p <= 'Z' : p >= 'a' && p <= 'z');
}
function foe(p, w) {
  return p !== '.' && !mine(p, w);
}
function attacked(b, sq, byWhite) {
  const r = sq >> 3, c = sq & 7;
  const pawnRow = r + (byWhite ? 1 : -1);
  const pawn = byWhite ? 'P' : 'p';
  if (pawnRow >= 0 && pawnRow < 8) {
    if (c > 0 && b[pawnRow * 8 + c - 1] === pawn) return true;
    if (c < 7 && b[pawnRow * 8 + c + 1] === pawn) return true;
  }

  const knight = byWhite ? 'N' : 'n';
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === knight) return true;
  }

  const king = byWhite ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === king) return true;
  }

  const rookers = byWhite ? 'RQ' : 'rq';
  const bishops = byWhite ? 'BQ' : 'bq';
  for (const [dr, dc, kinds] of [
    [-1,0,rookers],[1,0,rookers],[0,-1,rookers],[0,1,rookers],
    [-1,-1,bishops],[-1,1,bishops],[1,-1,bishops],[1,1,bishops]
  ]) {
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
      const p = b[rr * 8 + cc];
      if (p !== '.') {
        if (kinds.includes(p)) return true;
        break;
      }
      rr += dr;
      cc += dc;
    }
  }
  return false;
}

function apply(b, m, w) {
  const n = b.slice();
  const [from, to, promotion, enPassant, castle] = m;
  const piece = n[from];
  n[to] = promotion ? (w ? promotion.toUpperCase() : promotion) : piece;
  n[from] = '.';
  if (enPassant) n[to + (w ? 8 : -8)] = '.';
  if (castle) {
    if (to === 62) { n[61] = n[63]; n[63] = '.'; }
    else if (to === 58) { n[59] = n[56]; n[56] = '.'; }
    else if (to === 6) { n[5] = n[7]; n[7] = '.'; }
    else if (to === 2) { n[3] = n[0]; n[0] = '.'; }
  }
  return n;
}

function pseudoMoves(b, w) {
  const moves = [];
  const add = (a, z, p = null, e = false, c = false) => moves.push([a, z, p, e, c]);

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!mine(piece, w)) continue;
    const lower = piece.toLowerCase();
    const r = from >> 3, c = from & 7;

    if (lower === 'p') {
      const d = w ? -1 : 1;
      const start = w ? 6 : 1;
      const promo = w ? 0 : 7;
      const rr = r + d;
      const pawnAdd = (to) => {
        if (rr === promo) for (const q of ['q', 'r', 'b', 'n']) add(from, to, q);
        else add(from, to);
      };
      if (rr >= 0 && rr < 8) {
        const one = rr * 8 + c;
        if (b[one] === '.') {
          pawnAdd(one);
          const two = (r + 2 * d) * 8 + c;
          if (r === start && b[two] === '.') add(from, two);
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc > 7) continue;
          const to = rr * 8 + cc;
          if (foe(b[to], w) && b[to].toLowerCase() !== 'k') pawnAdd(to);
          if (to === ep && b[to] === '.' && b[to + (w ? 8 : -8)] === (w ? 'p' : 'P')) {
            add(from, to, null, true);
          }
        }
      }
    } else if (lower === 'n') {
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const to = rr * 8 + cc;
        if (!mine(b[to], w) && b[to].toLowerCase() !== 'k') add(from, to);
      }
    } else if (lower === 'b' || lower === 'r' || lower === 'q') {
      const dirs = [];
      if (lower === 'b' || lower === 'q') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      if (lower === 'r' || lower === 'q') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const to = rr * 8 + cc;
          if (mine(b[to], w)) break;
          if (b[to].toLowerCase() !== 'k') add(from, to);
          if (b[to] !== '.') break;
          rr += dr;
          cc += dc;
        }
      }
    } else if (lower === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const to = rr * 8 + cc;
        if (!mine(b[to], w) && b[to].toLowerCase() !== 'k') add(from, to);
      }
      if (w && from === 60 && piece === 'K' && !attacked(b, 60, false)) {
        if (rights.includes('K') && b[61] === '.' && b[62] === '.' && b[63] === 'R' &&
            !attacked(b, 61, false) && !attacked(b, 62, false)) add(60, 62, null, false, true);
        if (rights.includes('Q') && b[59] === '.' && b[58] === '.' && b[57] === '.' && b[56] === 'R' &&
            !attacked(b, 59, false) && !attacked(b, 58, false)) add(60, 58, null, false, true);
      }
      if (!w && from === 4 && piece === 'k' && !attacked(b, 4, true)) {
        if (rights.includes('k') && b[5] === '.' && b[6] === '.' && b[7] === 'r' &&
            !attacked(b, 5, true) && !attacked(b, 6, true)) add(4, 6, null, false, true);
        if (rights.includes('q') && b[3] === '.' && b[2] === '.' && b[1] === '.' && b[0] === 'r' &&
            !attacked(b, 3, true) && !attacked(b, 2, true)) add(4, 2, null, false, true);
      }
    }
  }
  return moves;
}

function algebraic(i) {
  return String.fromCharCode(97 + (i & 7)) + String(8 - (i >> 3));
}

const legal = pseudoMoves(board, white).filter(m => {
  const next = apply(board, m, white);
  const king = next.indexOf(white ? 'K' : 'k');
  return king >= 0 && !attacked(next, king, !white);
});

if (legal.length) {
  const m = legal[0];
  process.stdout.write(algebraic(m[0]) + algebraic(m[1]) + (m[2] || ''));
}