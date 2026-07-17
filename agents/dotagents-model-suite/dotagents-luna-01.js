import fs from 'node:fs';

const fields = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const board = Array(64).fill(null);
const rows = (fields[0] || '').split('/');
for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const c of rows[row] || '') {
    if (c >= '1' && c <= '8') file += +c;
    else board[(7 - row) * 8 + file++] = c;
  }
}
const white = fields[1] !== 'b';
const rights = fields[2] || '-';
const epText = fields[3] || '-';
const ep = epText !== '-' ? epText.charCodeAt(0) - 97 + (+epText[1] - 1) * 8 : -1;
const knight = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const king = [[1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const diagonal = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const straight = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
const square = (x, y) => inside(x, y) ? y * 8 + x : -1;
const isWhite = p => !!p && p === p.toUpperCase();
const enemy = (p, side) => !!p && isWhite(p) !== side;

function attacked(b, target, byWhite) {
  const x = target & 7, y = target >> 3;
  const pawnY = y + (byWhite ? -1 : 1);
  for (const dx of [-1, 1]) {
    const p = square(x + dx, pawnY);
    if (p >= 0 && b[p] === (byWhite ? 'P' : 'p')) return true;
  }
  for (const [dx, dy] of knight) {
    const p = square(x + dx, y + dy);
    if (p >= 0 && b[p] === (byWhite ? 'N' : 'n')) return true;
  }
  for (const [dx, dy] of king) {
    const p = square(x + dx, y + dy);
    if (p >= 0 && b[p] === (byWhite ? 'K' : 'k')) return true;
  }
  for (const [dx, dy] of diagonal) {
    let xx = x + dx, yy = y + dy;
    while (inside(xx, yy)) {
      const p = b[square(xx, yy)];
      if (p) {
        if (isWhite(p) === byWhite && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true;
        break;
      }
      xx += dx; yy += dy;
    }
  }
  for (const [dx, dy] of straight) {
    let xx = x + dx, yy = y + dy;
    while (inside(xx, yy)) {
      const p = b[square(xx, yy)];
      if (p) {
        if (isWhite(p) === byWhite && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true;
        break;
      }
      xx += dx; yy += dy;
    }
  }
  return false;
}

function inCheck(b, side) {
  const k = side ? 'K' : 'k';
  const kingSquare = b.indexOf(k);
  return kingSquare < 0 || attacked(b, kingSquare, !side);
}

function add(moves, from, to, extra = {}) {
  if (to >= 0) moves.push({ from, to, ...extra });
}
function pawnMoves(b, moves, from, side) {
  const x = from & 7, y = from >> 3, dy = side ? 1 : -1;
  const one = square(x, y + dy);
  const promote = side ? y === 6 : y === 1;
  const put = (to, extra = {}) => {
    if (promote) for (const p of ['q', 'r', 'b', 'n']) add(moves, from, to, { ...extra, promotion: p });
    else add(moves, from, to, extra);
  };
  if (one >= 0 && !b[one]) {
    put(one);
    const two = square(x, y + 2 * dy);
    if ((side ? y === 1 : y === 6) && !b[two]) add(moves, from, two);
  }
  for (const dx of [-1, 1]) {
    const to = square(x + dx, y + dy);
    if (to < 0) continue;
    if (enemy(b[to], side)) {
      if (b[to].toLowerCase() !== 'k') put(to);
    } else if (to === ep) {
      const captured = b[to + (side ? -8 : 8)];
      if (captured === (side ? 'p' : 'P')) add(moves, from, to, { ep: true });
    }
  }
}

function pseudo(b, side) {
  const moves = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || isWhite(p) !== side) continue;
    const type = p.toLowerCase(), x = from & 7, y = from >> 3;
    if (type === 'p') {
      pawnMoves(b, moves, from, side);
    } else if (type === 'n' || type === 'k') {
      const steps = type === 'n' ? knight : king;
      for (const [dx, dy] of steps) {
        const to = square(x + dx, y + dy);
        if (to >= 0 && (!b[to] || (enemy(b[to], side) && b[to].toLowerCase() !== 'k')))
          add(moves, from, to);
      }
      if (type === 'k') {
        const rank = side ? 0 : 7, home = square(4, rank);
        if (from === home && !inCheck(b, side)) {
          const kingSide = side ? 'K' : 'k';
          const queenSide = side ? 'Q' : 'q';
          if (rights.includes(kingSide) && b[square(7, rank)] === (side ? 'R' : 'r') &&
              !b[square(5, rank)] && !b[square(6, rank)] &&
              !attacked(b, square(5, rank), !side) && !attacked(b, square(6, rank), !side))
            add(moves, from, square(6, rank), { castle: true });
          if (rights.includes(queenSide) && b[square(0, rank)] === (side ? 'R' : 'r') &&
              !b[square(1, rank)] && !b[square(2, rank)] && !b[square(3, rank)] &&
              !attacked(b, square(3, rank), !side) && !attacked(b, square(2, rank), !side))
            add(moves, from, square(2, rank), { castle: true });
        }
      }
    } else {
      const dirs = type === 'b' ? diagonal : type === 'r' ? straight : diagonal.concat(straight);
      for (const [dx, dy] of dirs) {
        let xx = x + dx, yy = y + dy;
        while (inside(xx, yy)) {
          const to = square(xx, yy);
          if (!b[to]) add(moves, from, to);
          else {
            if (enemy(b[to], side) && b[to].toLowerCase() !== 'k') add(moves, from, to);
            break;
          }
          xx += dx; yy += dy;
        }
      }
    }
  }
  return moves;
}

function play(b, m, side) {
  const n = b.slice(), p = n[m.from];
  n[m.from] = null;
  if (m.ep) n[m.to + (side ? -8 : 8)] = null;
  if (m.castle) {
    const rank = side ? 0 : 7;
    const rookFrom = m.to > m.from ? square(7, rank) : square(0, rank);
    const rookTo = m.to > m.from ? square(5, rank) : square(3, rank);
    n[rookTo] = n[rookFrom]; n[rookFrom] = null;
  }
  n[m.to] = m.promotion ? (side ? m.promotion.toUpperCase() : m.promotion) : p;
  return n;
}
function coord(s) { return String.fromCharCode(97 + (s & 7)) + (1 + (s >> 3)); }

const legal = pseudo(board, white).filter(m => !inCheck(play(board, m, white), white));
if (legal[0]) {
  const m = legal[0];
  process.stdout.write(coord(m.from) + coord(m.to) + (m.promotion || ''));
}
