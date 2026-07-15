import fs from 'node:fs';

const fen = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const board = Array(64).fill('');
let file = 0;
for (let row = 0; row < 8; row++) {
  file = 0;
  for (const c of fen[0].split('/')[row]) {
    if (c >= '1' && c <= '8') file += +c;
    else board[(7 - row) * 8 + file++] = c;
  }
}
const side = fen[1];
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? square(fen[3]) : -1;

function square(s) { return s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49); }
function name(i) { return String.fromCharCode(97 + (i & 7)) + (1 + (i >> 3)); }
function mine(p, s) { return p && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase()); }
function enemy(p, s) { return p && !mine(p, s); }
function inside(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }

function attacked(b, target, by) {
  const tf = target & 7, tr = target >> 3;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!mine(p, by)) continue;
    const f = i & 7, r = i >> 3, dx = tf - f, dy = tr - r;
    const q = p.toLowerCase();
    if (q === 'p') { if (Math.abs(dx) === 1 && dy === (by === 'w' ? 1 : -1)) return true; continue; }
    if (q === 'n') { if ((Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1)) return true; continue; }
    if (q === 'k') { if (Math.max(Math.abs(dx), Math.abs(dy)) === 1) return true; continue; }
    const straight = dx === 0 || dy === 0, diagonal = Math.abs(dx) === Math.abs(dy);
    if (!((q === 'r' && straight) || (q === 'b' && diagonal) || (q === 'q' && (straight || diagonal))) || (!dx && !dy)) continue;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    let x = f + sx, y = r + sy, clear = true;
    while (x !== tf || y !== tr) { if (b[y * 8 + x]) { clear = false; break; } x += sx; y += sy; }
    if (clear) return true;
  }
  return false;
}
function check(b, s) {
  const king = s === 'w' ? 'K' : 'k';
  const at = b.indexOf(king);
  return at < 0 || attacked(b, at, s === 'w' ? 'b' : 'w');
}
function push(a, from, to, extra = '') { a.push({ from, to, extra }); }

function pseudo(b, s) {
  const out = [], dir = s === 'w' ? 1 : -1, start = s === 'w' ? 1 : 6, last = s === 'w' ? 7 : 0;
  const addPawn = (from, to) => {
    if ((to >> 3) === last) for (const x of 'qrbn') push(out, from, to, x);
    else push(out, from, to);
  };
  for (let from = 0; from < 64; from++) {
    const p = b[from]; if (!mine(p, s)) continue;
    const f = from & 7, r = from >> 3, q = p.toLowerCase();
    if (q === 'p') {
      const one = from + dir * 8;
      if (inside(f, r + dir) && !b[one]) {
        addPawn(from, one);
        const two = from + dir * 16;
        if (r === start && !b[two]) push(out, from, two);
      }
      for (const df of [-1, 1]) {
        const nf = f + df, to = from + dir * 8 + df;
        if (!inside(nf, r + dir)) continue;
        if (enemy(b[to], s)) addPawn(from, to);
        else if (to === ep && b[to - dir * 8] === (s === 'w' ? 'p' : 'P')) push(out, from, to, 'e');
      }
    } else if (q === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const nf = f + df, nr = r + dr; if (inside(nf, nr) && !mine(b[nr * 8 + nf], s)) push(out, from, nr * 8 + nf);
      }
    } else if (q === 'b' || q === 'r' || q === 'q') {
      const ds = q === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : q === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of ds) {
        let nf = f + df, nr = r + dr;
        while (inside(nf, nr)) { const to = nr * 8 + nf; if (mine(b[to], s)) break; push(out, from, to); if (b[to]) break; nf += df; nr += dr; }
      }
    } else if (q === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue; const nf = f + df, nr = r + dr;
        if (inside(nf, nr) && !mine(b[nr * 8 + nf], s)) push(out, from, nr * 8 + nf);
      }
      const foe = s === 'w' ? 'b' : 'w';
      if (!check(b, s)) {
        if (s === 'w' && from === 4) {
          if (rights.includes('K') && b[7] === 'R' && !b[5] && !b[6] && !attacked(b, 5, foe) && !attacked(b, 6, foe)) push(out, 4, 6, 'c');
          if (rights.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] && !attacked(b, 3, foe) && !attacked(b, 2, foe)) push(out, 4, 2, 'c');
        }
        if (s === 'b' && from === 60) {
          if (rights.includes('k') && b[63] === 'r' && !b[61] && !b[62] && !attacked(b, 61, foe) && !attacked(b, 62, foe)) push(out, 60, 62, 'c');
          if (rights.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] && !attacked(b, 59, foe) && !attacked(b, 58, foe)) push(out, 60, 58, 'c');
        }
      }
    }
  }
  return out;
}
function play(b, m, s) {
  const n = b.slice(), p = n[m.from]; n[m.from] = '';
  if (m.extra === 'e') n[m.to - (s === 'w' ? 8 : -8)] = '';
  n[m.to] = m.extra && m.extra !== 'e' && m.extra !== 'c' ? (s === 'w' ? m.extra.toUpperCase() : m.extra) : p;
  if (m.extra === 'c') {
    if (m.to === 6) { n[5] = n[7]; n[7] = ''; }
    else if (m.to === 2) { n[3] = n[0]; n[0] = ''; }
    else if (m.to === 62) { n[61] = n[63]; n[63] = ''; }
    else { n[59] = n[56]; n[56] = ''; }
  }
  return n;
}
const legal = pseudo(board, side).filter(m => !check(play(board, m, side), side));
const m = legal.find(x => x.extra === 'c') || legal.find(x => x.extra === 'e') || legal.find(x => x.extra && 'qrbn'.includes(x.extra)) || legal[0];
if (m) process.stdout.write(name(m.from) + name(m.to) + (m.extra && !'ec'.includes(m.extra) ? m.extra : '') + '\n');
