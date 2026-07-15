import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
let b = [];
for (const row of rows) for (const x of row) {
  if (x >= '1' && x <= '8') b.push(...'.'.repeat(+x)); else b.push(x);
}
const side = fen[1] === 'b' ? 'b' : 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? sq(fen[3]) : -1;
const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const own = x => x !== '.' && (side === 'w' ? x === x.toUpperCase() : x === x.toLowerCase());
const foe = x => x !== '.' && !own(x) && x.toLowerCase() !== 'k';
function sq(s) { return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97; }
function uci(i) { return String.fromCharCode(97 + i % 8) + (8 - (i / 8 | 0)); }

function attacked(a, z, white) {
  const r = z / 8 | 0, c = z % 8;
  const pawn = white ? 'P' : 'p', knight = white ? 'N' : 'n', king = white ? 'K' : 'k';
  const rr = white ? r + 1 : r - 1;
  if (rr >= 0 && rr < 8 && ((c && a[rr * 8 + c - 1] === pawn) || (c < 7 && a[rr * 8 + c + 1] === pawn))) return true;
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) if (on(r + dr,c + dc) && a[(r + dr) * 8 + c + dc] === knight) return true;
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) if (on(r + dr,c + dc) && a[(r + dr) * 8 + c + dc] === king) return true;
  for (const [dr, dc, kinds] of [[-1,0,'rq'],[1,0,'rq'],[0,-1,'rq'],[0,1,'rq'],[-1,-1,'bq'],[-1,1,'bq'],[1,-1,'bq'],[1,1,'bq']]) {
    let y = r + dr, x = c + dc;
    while (on(y,x)) { const p = a[y * 8 + x]; if (p !== '.') { if (kinds.includes(p.toLowerCase()) && (white ? p === p.toUpperCase() : p === p.toLowerCase())) return true; break; } y += dr; x += dc; }
  }
  return false;
}
function play(m) {
  const a = b.slice(), p = a[m[0]];
  a[m[0]] = '.'; a[m[1]] = m[2] || p;
  if (m[3]) a[m[1] + (side === 'w' ? 8 : -8)] = '.';
  if (p.toLowerCase() === 'k' && Math.abs(m[1] - m[0]) === 2) {
    const k = m[1] > m[0] ? m[0] + 3 : m[0] - 4, d = m[1] > m[0] ? m[0] + 1 : m[0] - 1;
    a[d] = a[k]; a[k] = '.';
  }
  return a;
}
function safe(m) {
  const a = play(m), k = a.indexOf(side === 'w' ? 'K' : 'k');
  return k >= 0 && !attacked(a, k, side === 'b');
}
let ms = [];
function add(f,t,p='',e=false) { if (t >= 0 && t < 64 && !own(b[t]) && b[t].toLowerCase() !== 'k') ms.push([f,t,p,e]); }
for (let i=0;i<64;i++) if (own(b[i])) {
  const p=b[i].toLowerCase(), r=i/8|0,c=i%8, w=side==='w';
  if (p==='p') {
    const d=w?-8:8, start=w?6:1, last=w?0:7, t=i+d;
    const push=t=> { if ((t/8|0)===last) for(const q of 'qrbn') add(i,t,w?q.toUpperCase():q); else add(i,t); };
    if (t>=0&&t<64&&b[t]==='.') { push(t); if(r===start&&b[t+d]==='.') add(i,t+d); }
    for(const dc of [-1,1]) { const x=c+dc, q=i+d+dc; if(x>=0&&x<8&&q>=0&&q<64&&(foe(b[q])||(q===ep&&b[q-d]===(w?'p':'P')))) { if(q===ep) add(i,q,'',true); else push(q); } }
  } else if (p==='n') { for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) if(on(r+dr,c+dc)) add(i,(r+dr)*8+c+dc); }
  else if (p==='b'||p==='r'||p==='q') {
    const ds=p==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:p==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for(const [dr,dc] of ds) { let y=r+dr,x=c+dc; while(on(y,x)){const t=y*8+x;if(own(b[t]))break;add(i,t);if(b[t]!=='.')break;y+=dr;x+=dc;} }
  } else if (p==='k') {
    for(const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) if(on(r+dr,c+dc)) add(i,(r+dr)*8+c+dc);
    const home=w?60:4, enemy=!w;
    if(i===home&&!attacked(b,home,enemy)) {
      const K=w?'K':'k', Q=w?'Q':'q', rook=w?'R':'r';
      if(rights.includes(K)&&b[home+3]===rook&&b[home+1]==='.'&&b[home+2]==='.'&&!attacked(b,home+1,enemy)&&!attacked(b,home+2,enemy)) add(i,home+2);
      if(rights.includes(Q)&&b[home-4]===rook&&b[home-1]==='.'&&b[home-2]==='.'&&b[home-3]==='.'&&!attacked(b,home-1,enemy)&&!attacked(b,home-2,enemy)) add(i,home-2);
    }
  }
}
const move = ms.find(safe);
if (move) process.stdout.write(uci(move[0])+uci(move[1])+(move[2]?move[2].toLowerCase():''));
