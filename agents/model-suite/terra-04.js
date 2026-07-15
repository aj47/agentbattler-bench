import fs from 'node:fs';

const fen = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const board = [];
for (const row of rows) for (const ch of row) {
  if (ch >= '1' && ch <= '8') for (let i = 0; i < +ch; i++) board.push('.');
  else board.push(ch);
}
const initial = {
  b: board, side: fen[1], castle: fen[2] === '-' ? '' : fen[2],
  ep: fen[3] === '-' ? -1 : (8 - +fen[3][1]) * 8 + fen[3].charCodeAt(0) - 97
};
const xy = n => [n & 7, n >> 3];
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
const mine = (p, s) => p !== '.' && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const enemy = (p, s) => p !== '.' && !mine(p, s) && p.toLowerCase() !== 'k';

function attacked(b, sq, side) {
  const [x, y] = xy(sq), pawn = side === 'w' ? 'P' : 'p';
  const py = y + (side === 'w' ? 1 : -1);
  for (const px of [x - 1, x + 1]) if (inside(px, py) && b[py * 8 + px] === pawn) return true;
  const knight = side === 'w' ? 'N' : 'n';
  for (const [dx, dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]])
    if (inside(x + dx, y + dy) && b[(y + dy) * 8 + x + dx] === knight) return true;
  const king = side === 'w' ? 'K' : 'k';
  for (const [dx, dy] of [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]])
    if (inside(x + dx, y + dy) && b[(y + dy) * 8 + x + dx] === king) return true;
  for (const [dx, dy, kinds] of [[1,0,'rq'],[-1,0,'rq'],[0,1,'rq'],[0,-1,'rq'],[1,1,'bq'],[1,-1,'bq'],[-1,1,'bq'],[-1,-1,'bq']]) {
    let a = x + dx, z = y + dy;
    while (inside(a, z)) {
      const p = b[z * 8 + a];
      if (p !== '.') { if (mine(p, side) && kinds.includes(p.toLowerCase())) return true; break; }
      a += dx; z += dy;
    }
  }
  return false;
}

function moves(st) {
  const {b, side, castle, ep} = st, out = [];
  const put = (f, t, promo = '', e = false, c = false) => { if (!mine(b[t], side) && b[t].toLowerCase() !== 'k') out.push([f, t, promo, e, c]); };
  for (let f = 0; f < 64; f++) {
    const p = b[f]; if (!mine(p, side)) continue;
    const q = p.toLowerCase(), [x, y] = xy(f);
    if (q === 'p') {
      const d = side === 'w' ? -1 : 1, start = side === 'w' ? 6 : 1, last = side === 'w' ? 0 : 7, ny = y + d;
      const pawnPut = t => { if ((t >> 3) === last) for (const z of 'qrbn') put(f, t, z); else put(f, t); };
      if (inside(x, ny) && b[ny * 8 + x] === '.') {
        pawnPut(ny * 8 + x);
        if (y === start && b[(y + 2 * d) * 8 + x] === '.') put(f, (y + 2 * d) * 8 + x);
      }
      for (const nx of [x - 1, x + 1]) if (inside(nx, ny)) {
        const t = ny * 8 + nx;
        if (enemy(b[t], side)) pawnPut(t);
        else if (t === ep) put(f, t, '', true);
      }
    } else if (q === 'n' || q === 'k') {
      const ds = q === 'n' ? [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]] : [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
      for (const [dx, dy] of ds) if (inside(x + dx, y + dy)) put(f, (y + dy) * 8 + x + dx);
      if (q === 'k') {
        const foe = side === 'w' ? 'b' : 'w', home = side === 'w' ? 60 : 4;
        if (f === home && !attacked(b, home, foe)) {
          if (side === 'w' && castle.includes('K') && b[61] === '.' && b[62] === '.' && b[63] === 'R' && !attacked(b,61,foe) && !attacked(b,62,foe)) put(f,62,'',false,true);
          if (side === 'w' && castle.includes('Q') && b[59] === '.' && b[58] === '.' && b[57] === '.' && b[56] === 'R' && !attacked(b,59,foe) && !attacked(b,58,foe)) put(f,58,'',false,true);
          if (side === 'b' && castle.includes('k') && b[5] === '.' && b[6] === '.' && b[7] === 'r' && !attacked(b,5,foe) && !attacked(b,6,foe)) put(f,6,'',false,true);
          if (side === 'b' && castle.includes('q') && b[3] === '.' && b[2] === '.' && b[1] === '.' && b[0] === 'r' && !attacked(b,3,foe) && !attacked(b,2,foe)) put(f,2,'',false,true);
        }
      }
    } else {
      const ds = q === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : q === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dx, dy] of ds) for (let a = x + dx, z = y + dy; inside(a, z); a += dx, z += dy) {
        const t = z * 8 + a;
        if (b[t] === '.') put(f, t); else { if (enemy(b[t], side)) put(f, t); break; }
      }
    }
  }
  return out;
}

function play(st, m) {
  const [f, t, promo, ep, castle] = m, b = st.b.slice(), p = b[f];
  b[f] = '.'; b[t] = promo ? (st.side === 'w' ? promo.toUpperCase() : promo) : p;
  if (ep) b[t + (st.side === 'w' ? 8 : -8)] = '.';
  if (castle) {
    const r = t === 62 ? [63,61] : t === 58 ? [56,59] : t === 6 ? [7,5] : [0,3];
    b[r[1]] = b[r[0]]; b[r[0]] = '.';
  }
  let c = st.castle;
  if (p === 'K') c = c.replace(/[KQ]/g, ''); if (p === 'k') c = c.replace(/[kq]/g, '');
  if (f === 63 || t === 63) c = c.replace('K',''); if (f === 56 || t === 56) c = c.replace('Q','');
  if (f === 7 || t === 7) c = c.replace('k',''); if (f === 0 || t === 0) c = c.replace('q','');
  return {b, side: st.side === 'w' ? 'b' : 'w', castle: c, ep: p.toLowerCase() === 'p' && Math.abs(f - t) === 16 ? (f + t) / 2 : -1};
}

const legal = moves(initial).filter(m => {
  const next = play(initial, m), king = initial.side === 'w' ? 'K' : 'k';
  return !attacked(next.b, next.b.indexOf(king), next.side);
});
const name = n => String.fromCharCode(97 + (n & 7)) + (8 - (n >> 3));
const m = legal[0];
process.stdout.write(name(m[0]) + name(m[1]) + m[2]);
