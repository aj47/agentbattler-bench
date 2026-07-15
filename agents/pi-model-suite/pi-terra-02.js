import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const board = Array(64).fill('.');
for (let r = 0; r < 8; r++) {
  let x = 0;
  for (const ch of rows[r]) {
    if (ch >= '1' && ch <= '8') x += +ch;
    else board[(7 - r) * 8 + x++] = ch;
  }
}
const at = s => s === '-' || !s ? -1 : (s.charCodeAt(0) - 97) + 8 * (+s[1] - 1);
const other = c => c === 'w' ? 'b' : 'w';
const col = p => p === p.toUpperCase() ? 'w' : 'b';
const xy = i => [i & 7, i >> 3];

function attacked(b, target, by) {
  const [tx, ty] = xy(target);
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p === '.' || col(p) !== by) continue;
    const q = p.toLowerCase(), [x, y] = xy(i), dx = tx - x, dy = ty - y;
    if (q === 'p' && Math.abs(dx) === 1 && dy === (by === 'w' ? 1 : -1)) return true;
    if (q === 'n' && ((Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1))) return true;
    if (q === 'k' && Math.max(Math.abs(dx), Math.abs(dy)) === 1) return true;
    const diagonal = Math.abs(dx) === Math.abs(dy) && dx !== 0;
    const straight = (dx === 0) !== (dy === 0);
    if ((q === 'b' && diagonal) || (q === 'r' && straight) || (q === 'q' && (diagonal || straight))) {
      const sx = Math.sign(dx), sy = Math.sign(dy);
      let a = x + sx, z = y + sy, clear = true;
      while (a !== tx || z !== ty) {
        if (b[z * 8 + a] !== '.') { clear = false; break; }
        a += sx; z += sy;
      }
      if (clear) return true;
    }
  }
  return false;
}

function stepSafe(b, from, to, c) {
  const n = b.slice(); n[to] = n[from]; n[from] = '.';
  return !attacked(n, to, other(c));
}
function addPawn(a, f, t, c, ep) {
  if ((t >> 3) === 0 || (t >> 3) === 7)
    for (const p of 'QRBN') a.push([f, t, p]);
  else a.push([f, t, '', t === ep]);
}
function pseudo(s) {
  const { b, turn: c, cr, ep } = s, a = [], enemy = other(c);
  for (let f = 0; f < 64; f++) {
    const p = b[f];
    if (p === '.' || col(p) !== c) continue;
    const q = p.toLowerCase(), [x, y] = xy(f);
    if (q === 'p') {
      const d = c === 'w' ? 8 : -8, home = c === 'w' ? 1 : 6, t = f + d;
      if (t >= 0 && t < 64 && b[t] === '.') {
        addPawn(a, f, t, c, -1);
        const t2 = f + 2 * d;
        if (y === home && b[t2] === '.') a.push([f, t2, '']);
      }
      for (const dx of [-1, 1]) {
        const nx = x + dx, u = t + dx;
        if (nx >= 0 && nx < 8 && u >= 0 && u < 64 && (b[u] !== '.' && col(b[u]) === enemy || u === ep)) addPawn(a, f, u, c, ep);
      }
    } else if (q === 'n') {
      for (const [dx, dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const X = x + dx, Y = y + dy, t = Y * 8 + X;
        if (X >= 0 && X < 8 && Y >= 0 && Y < 8 && (b[t] === '.' || col(b[t]) === enemy)) a.push([f, t, '']);
      }
    } else if (q === 'b' || q === 'r' || q === 'q') {
      const ds = q === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : q === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of ds) for (let X = x + dx, Y = y + dy; X >= 0 && X < 8 && Y >= 0 && Y < 8; X += dx, Y += dy) {
        const t = Y * 8 + X;
        if (b[t] === '.') a.push([f, t, '']);
        else { if (col(b[t]) === enemy) a.push([f, t, '']); break; }
      }
    } else if (q === 'k') {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) {
        const X = x + dx, Y = y + dy, t = Y * 8 + X;
        if (X >= 0 && X < 8 && Y >= 0 && Y < 8 && (b[t] === '.' || col(b[t]) === enemy)) a.push([f, t, '']);
      }
      const base = c === 'w' ? 4 : 60, rookK = c === 'w' ? 7 : 63, rookQ = c === 'w' ? 0 : 56;
      const K = c === 'w' ? 'K' : 'k', R = c === 'w' ? 'R' : 'r';
      if (f === base && !attacked(b, base, enemy)) {
        if (cr.includes(K) && b[base+1] === '.' && b[base+2] === '.' && b[rookK] === R && stepSafe(b, base, base+1, c)) a.push([f, base+2, '']);
        if (cr.includes(c === 'w' ? 'Q' : 'q') && b[base-1] === '.' && b[base-2] === '.' && b[base-3] === '.' && b[rookQ] === R && stepSafe(b, base, base-1, c)) a.push([f, base-2, '']);
      }
    }
  }
  return a;
}
function play(s, m) {
  const [f, t, pro, isEP] = m, b = s.b.slice(), p = b[f], c = s.turn;
  const taken = b[t]; b[f] = '.'; b[t] = pro ? (c === 'w' ? pro : pro.toLowerCase()) : p;
  if (isEP) b[t + (c === 'w' ? -8 : 8)] = '.';
  if (p.toLowerCase() === 'k' && Math.abs(t - f) === 2) {
    const rf = t > f ? f + 3 : f - 4, rt = t > f ? f + 1 : f - 1;
    b[rt] = b[rf]; b[rf] = '.';
  }
  let cr = s.cr;
  if (p === 'K') cr = cr.replace(/[KQ]/g, '');
  if (p === 'k') cr = cr.replace(/[kq]/g, '');
  const corners = [[0,'Q'],[7,'K'],[56,'q'],[63,'k']];
  for (const [z, right] of corners) if ((f === z && p.toLowerCase() === 'r') || (t === z && taken.toLowerCase() === 'r')) cr = cr.replace(right, '');
  return { b, turn: other(c), cr, ep: p.toLowerCase() === 'p' && Math.abs(t-f) === 16 ? (t+f)/2 : -1 };
}
function legal(s, m) {
  const n = play(s, m), king = s.turn === 'w' ? 'K' : 'k', k = n.b.indexOf(king);
  return k >= 0 && !attacked(n.b, k, n.turn);
}
const state = { b: board, turn: fen[1] === 'b' ? 'b' : 'w', cr: fen[2] || '-', ep: at(fen[3]) };
const moves = pseudo(state).filter(m => legal(state, m));
const m = moves[0];
const sq = i => String.fromCharCode(97 + (i & 7)) + (1 + (i >> 3));
if (m) process.stdout.write(sq(m[0]) + sq(m[1]) + (m[2] ? m[2].toLowerCase() : ''));
