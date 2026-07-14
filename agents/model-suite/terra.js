// A small, dependency-free legal-move chess agent. Board squares are a1=0..h8=63.
const fs = require('fs');

const v = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const other = c => c === 'w' ? 'b' : 'w';
const mine = (p, c) => p !== '.' && (c === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());

function square(s) { return (s.charCodeAt(0) - 97) + 8 * (s.charCodeAt(1) - 49); }
function name(s) { return String.fromCharCode(97 + (s & 7)) + (1 + (s >> 3)); }

function parse(text) {
  const x = text.trim().split(/\s+/), b = Array(64).fill('.');
  const rows = x[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') f += +ch;
      else b[(7 - r) * 8 + f++] = ch;
    }
  }
  return { b, side: x[1], rights: x[2] || '-', ep: x[3] && x[3] !== '-' ? square(x[3]) : -1 };
}

// Is square s attacked by the given colour on this board?
function attacked(b, s, by) {
  const f = s & 7, r = s >> 3;
  const pawn = by === 'w' ? 'P' : 'p';
  if (by === 'w') {
    if (r > 0 && f > 0 && b[s - 9] === pawn) return true;
    if (r > 0 && f < 7 && b[s - 7] === pawn) return true;
  } else {
    if (r < 7 && f > 0 && b[s + 7] === pawn) return true;
    if (r < 7 && f < 7 && b[s + 9] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const nf = f + df, nr = r + dr;
    if (inside(nf, nr) && b[nr * 8 + nf] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if ((df || dr) && inside(f + df, r + dr) && b[(r + dr) * 8 + f + df] === king) return true;
  }
  const bishop = by === 'w' ? 'B' : 'b', rook = by === 'w' ? 'R' : 'r', queen = by === 'w' ? 'Q' : 'q';
  for (const [df, dr, a] of [[1,1,0],[1,-1,0],[-1,1,0],[-1,-1,0],[1,0,1],[-1,0,1],[0,1,1],[0,-1,1]]) {
    let nf = f + df, nr = r + dr;
    while (inside(nf, nr)) {
      const p = b[nr * 8 + nf];
      if (p !== '.') { if (p === queen || p === (a ? rook : bishop)) return true; break; }
      nf += df; nr += dr;
    }
  }
  return false;
}

function check(b, side) {
  const k = side === 'w' ? 'K' : 'k', at = b.indexOf(k);
  return at < 0 || attacked(b, at, other(side));
}

function apply(pos, m) {
  const b = pos.b.slice(), piece = b[m.f];
  b[m.f] = '.';
  if (m.ep) b[m.t + (pos.side === 'w' ? -8 : 8)] = '.';
  if (m.castle) {
    const from = m.t > m.f ? m.f + 3 : m.f - 4;
    const to = m.t > m.f ? m.f + 1 : m.f - 1;
    b[to] = b[from]; b[from] = '.';
  }
  b[m.t] = m.prom ? (pos.side === 'w' ? m.prom.toUpperCase() : m.prom) : piece;
  return b;
}

function pseudo(pos) {
  const { b, side, rights, ep } = pos, out = [];
  const add = (f, t, extra = {}) => {
    const dst = b[t];
    if (!mine(dst, side) && dst.toLowerCase() !== 'k') out.push({ f, t, ...extra });
  };
  for (let f = 0; f < 64; f++) {
    const p = b[f]; if (!mine(p, side)) continue;
    const type = p.toLowerCase(), file = f & 7, rank = f >> 3;
    if (type === 'p') {
      const d = side === 'w' ? 8 : -8, start = side === 'w' ? 1 : 6, last = side === 'w' ? 7 : 0;
      const putPawn = t => {
        if ((t >> 3) === last) for (const prom of ['q','r','b','n']) add(f, t, { prom });
        else add(f, t);
      };
      const one = f + d;
      if (one >= 0 && one < 64 && b[one] === '.') {
        putPawn(one);
        const two = f + 2 * d;
        if (rank === start && b[two] === '.') add(f, two);
      }
      for (const df of [-1, 1]) {
        const nf = file + df, t = f + d + df;
        if (nf < 0 || nf > 7 || t < 0 || t > 63) continue;
        if (b[t] !== '.' && !mine(b[t], side)) putPawn(t);
        else if (t === ep) add(f, t, { ep: true });
      }
    } else if (type === 'n' || type === 'k') {
      const steps = type === 'n' ? [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]] : [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
      for (const [df, dr] of steps) if (inside(file + df, rank + dr)) add(f, (rank + dr) * 8 + file + df);
      if (type === 'k' && !check(b, side)) {
        const enemy = other(side), base = side === 'w' ? 0 : 56;
        const ks = side === 'w' ? 'K' : 'k', qs = side === 'w' ? 'Q' : 'q', rook = side === 'w' ? 'R' : 'r';
        if (f === base + 4 && rights.includes(ks) && b[base+5] === '.' && b[base+6] === '.' && b[base+7] === rook && !attacked(b, base+5, enemy) && !attacked(b, base+6, enemy)) add(f, base+6, { castle: true });
        if (f === base + 4 && rights.includes(qs) && b[base+1] === '.' && b[base+2] === '.' && b[base+3] === '.' && b[base] === rook && !attacked(b, base+3, enemy) && !attacked(b, base+2, enemy)) add(f, base+2, { castle: true });
      }
    } else {
      const dirs = type === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : type === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let nf = file + df, nr = rank + dr;
        while (inside(nf, nr)) {
          const t = nr * 8 + nf;
          if (b[t] === '.') add(f, t);
          else { if (!mine(b[t], side)) add(f, t); break; }
          nf += df; nr += dr;
        }
      }
    }
  }
  return out;
}

function legal(pos) { return pseudo(pos).filter(m => !check(apply(pos, m), pos.side)); }
function moveText(m) { return name(m.f) + name(m.t) + (m.prom || ''); }

const pos = parse(fs.readFileSync(0, 'utf8'));
const moves = legal(pos);
// Prefer forcing material gains, but legality (not playing strength) is the goal here.
moves.sort((a, b) => {
  const score = m => (m.prom ? 100 + v[m.prom] : 0) + (m.ep ? 1 : (v[pos.b[m.t].toLowerCase()] || 0));
  return score(b) - score(a) || moveText(a).localeCompare(moveText(b));
});
process.stdout.write(moves.length ? moveText(moves[0]) + '\n' : '0000\n');
