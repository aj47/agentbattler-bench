import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const b = Array(64).fill('');
let q = 0;
for (const x of fen[0]) {
  if (x === '/') continue;
  if (x >= '1' && x <= '8') q += +x;
  else b[q++] = x;
}
const us = fen[1] === 'b' ? 'b' : 'w';
const them = us === 'w' ? 'b' : 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? (8 - +fen[3][1]) * 8 + fen[3].charCodeAt(0) - 97 : -1;
const mine = (p, s) => p && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const xy = i => [i % 8, i >> 3];
const at = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8 ? y * 8 + x : -1;

function attacked(a, z, s) {
  const [x, y] = xy(z), pawn = s === 'w' ? 'P' : 'p', pd = s === 'w' ? -1 : 1;
  for (const dx of [-1, 1]) { const i = at(x + dx, y - pd); if (i >= 0 && a[i] === pawn) return true; }
  for (const [dx, dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const i = at(x + dx, y + dy); if (i >= 0 && a[i] === (s === 'w' ? 'N' : 'n')) return true;
  }
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    for (let X = x + dx, Y = y + dy;; X += dx, Y += dy) {
      const i = at(X, Y); if (i < 0) break;
      const p = a[i]; if (!p) continue;
      if (!mine(p, s)) break;
      const l = p.toLowerCase();
      if (l === 'k' && Math.max(Math.abs(X-x), Math.abs(Y-y)) === 1) return true;
      if ((dx === 0 || dy === 0) ? l === 'r' || l === 'q' : l === 'b' || l === 'q') return true;
      break;
    }
  }
  return false;
}

function moves(a) {
  const out = [], dir = us === 'w' ? -1 : 1, pc = us === 'w' ? 'P' : 'p';
  const add = (f, t, pro = '', flag = '') => { if (t >= 0 && (!a[t] || (!mine(a[t], us) && a[t].toLowerCase() !== 'k'))) out.push([f,t,pro,flag]); };
  for (let f = 0; f < 64; f++) {
    const p = a[f]; if (!mine(p, us)) continue;
    const l = p.toLowerCase(), [x,y] = xy(f);
    if (l === 'p') {
      const one = at(x, y + dir), last = y + dir === (us === 'w' ? 0 : 7);
      const put = t => last ? ['q','r','b','n'].forEach(v => add(f,t,v)) : add(f,t);
      if (one >= 0 && !a[one]) {
        put(one);
        const two = at(x, y + 2 * dir);
        if (y === (us === 'w' ? 6 : 1) && !a[two]) add(f,two);
      }
      for (const dx of [-1, 1]) {
        const t = at(x + dx, y + dir);
        if (t >= 0 && a[t] && !mine(a[t], us) && a[t].toLowerCase() !== 'k') put(t);
        if (t === ep && !a[t] && a[t - dir * 8] === (us === 'w' ? 'p' : 'P')) add(f,t,'','e');
      }
    } else if (l === 'n') {
      for (const [dx,dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) add(f,at(x+dx,y+dy));
    } else if (l === 'b' || l === 'r' || l === 'q') {
      const ds = l === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : l === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dx,dy] of ds) for (let X=x+dx,Y=y+dy;;X+=dx,Y+=dy) { const t=at(X,Y); if(t<0) break; if(!a[t]) add(f,t); else { add(f,t); break; } }
    } else if (l === 'k') {
      for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) if (dx || dy) add(f,at(x+dx,y+dy));
      const bad = z => attacked(a,z,them);
      if (us === 'w' && f === 60 && !bad(60)) {
        if (rights.includes('K') && !a[61] && !a[62] && a[63] === 'R' && !bad(61) && !bad(62)) add(60,62,'','c');
        if (rights.includes('Q') && !a[59] && !a[58] && !a[57] && a[56] === 'R' && !bad(59) && !bad(58)) add(60,58,'','c');
      }
      if (us === 'b' && f === 4 && !bad(4)) {
        if (rights.includes('k') && !a[5] && !a[6] && a[7] === 'r' && !bad(5) && !bad(6)) add(4,6,'','c');
        if (rights.includes('q') && !a[3] && !a[2] && !a[1] && a[0] === 'r' && !bad(3) && !bad(2)) add(4,2,'','c');
      }
    }
  }
  return out;
}

function play(a, m) {
  const [f,t,pro,flag] = m, c = a.slice(), p = c[f]; c[f] = ''; c[t] = pro ? (us === 'w' ? pro.toUpperCase() : pro) : p;
  if (flag === 'e') c[t - (us === 'w' ? -8 : 8)] = '';
  if (flag === 'c') { const rf = t > f ? t + 1 : t - 2, rt = t > f ? t - 1 : t + 1; c[rt] = c[rf]; c[rf] = ''; }
  return c;
}
const legal = moves(b).filter(m => !attacked(play(b,m), play(b,m).indexOf(us === 'w' ? 'K' : 'k'), them));
const pick = legal.sort((u,v) => (b[v[1]] ? 1 : 0) - (b[u[1]] ? 1 : 0) || (v[2] ? 1 : 0) - (u[2] ? 1 : 0))[0];
const uci = i => String.fromCharCode(97 + i % 8) + (8 - (i >> 3));
process.stdout.write(uci(pick[0]) + uci(pick[1]) + pick[2]);
