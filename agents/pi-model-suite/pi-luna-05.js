import * as fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8').trim();
const fields = input.split(/\s+/);
const board = Array(64).fill('.');
let n = 56;
for (const row of fields[0].split('/')) {
  let x = n;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') x += +ch;
    else board[x++] = ch;
  }
  n -= 8;
}
const turn = fields[1] === 'b' ? 1 : 0;
const rights = fields[2] || '-';
const ep = fields[3] && fields[3] !== '-' ? sq(fields[3]) : -1;

function sq(s) { return (s.charCodeAt(0) - 97) + 8 * (+s[1] - 1); }
function file(i) { return i & 7; }
function rank(i) { return i >> 3; }
function inside(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
function mine(p, c) { return p !== '.' && (p === p.toUpperCase()) === (c === 0); }
function enemy(p, c) { return p !== '.' && !mine(p, c); }

function attacked(b, at, by) {
  const f = file(at), r = rank(at);
  const pr = r + (by ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === (by ? 'p' : 'P')) return true;
    if (f < 7 && b[pr * 8 + f + 1] === (by ? 'p' : 'P')) return true;
  }
  for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
    const x = f + df, y = r + dr;
    if (inside(x,y) && b[y * 8 + x] === (by ? 'n' : 'N')) return true;
  }
  for (const [df, dr, chars] of [[1,0,'rq'],[-1,0,'rq'],[0,1,'rq'],[0,-1,'rq'],[1,1,'bq'],[1,-1,'bq'],[-1,1,'bq'],[-1,-1,'bq']]) {
    let x = f + df, y = r + dr;
    while (inside(x,y)) {
      const p = b[y * 8 + x];
      if (p !== '.') {
        if (mine(p, by) && chars.includes(p.toLowerCase())) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const x = f + df, y = r + dr;
    if (inside(x,y) && b[y * 8 + x] === (by ? 'k' : 'K')) return true;
  }
  return false;
}

function putMove(list, from, to, prom = '', flags = '') {
  list.push({ from, to, prom, flags });
}
function pseudo(b, c) {
  const out = [], forward = c ? -1 : 1, start = c ? 6 : 1, last = c ? 0 : 7;
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!mine(p,c)) continue;
    const t = p.toLowerCase(), f = file(from), r = rank(from);
    if (t === 'p') {
      let rr = r + forward;
      if (rr >= 0 && rr < 8) {
        const to = rr * 8 + f;
        if (b[to] === '.') {
          if (rr === last) for (const q of 'qrbn') putMove(out,from,to,q);
          else putMove(out,from,to);
          if (r === start) {
            const to2 = (r + 2 * forward) * 8 + f;
            if (b[to2] === '.') putMove(out,from,to2);
          }
        }
        for (const df of [-1,1]) {
          const x = f + df;
          if (x < 0 || x > 7) continue;
          const dst = rr * 8 + x;
          if (enemy(b[dst],c) || dst === ep) {
            if (rr === last) for (const q of 'qrbn') putMove(out,from,dst,q,dst === ep ? 'e' : '');
            else putMove(out,from,dst,'',dst === ep ? 'e' : '');
          }
        }
      }
    } else if (t === 'n' || t === 'k') {
      const steps = t === 'n' ? [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [df,dr] of steps) {
        const x=f+df, y=r+dr;
        if (inside(x,y) && !mine(b[y*8+x],c)) putMove(out,from,y*8+x);
      }
      if (t === 'k') {
        const home = c ? 60 : 4, rook = c ? (c === 1 ? 'r' : 'R') : 'R';
        if (from === home && !attacked(b,from,1-c)) {
          const specs = c ? [['K',62,61,63],['Q',58,59,56]] : [['K',6,5,7],['Q',2,3,0]];
          for (const [letter,to,mid,ri] of specs) {
            if (rights.includes(c ? (letter === 'K' ? 'k' : 'q') : letter) && b[ri] === rook && b[mid] === '.' && b[to] === '.' && (letter === 'K' || b[ri + 1] === '.') && !attacked(step(b,from,mid),mid,1-c)) putMove(out,from,to,'','c');
          }
        }
      }
    } else {
      const dirs = t === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : t === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [df,dr] of dirs) {
        let x=f+df, y=r+dr;
        while (inside(x,y)) {
          const to=y*8+x;
          if (b[to] === '.') putMove(out,from,to);
          else { if (enemy(b[to],c)) putMove(out,from,to); break; }
          x+=df; y+=dr;
        }
      }
    }
  }
  return out;
}
function step(b, from, to) { const x=b.slice(); x[to]=x[from]; x[from]='.'; return x; }
function make(b, m) {
  const x = b.slice(), p=x[m.from];
  x[m.to] = m.prom ? (turn ? m.prom : m.prom.toUpperCase()) : p;
  x[m.from]='.';
  if (m.flags === 'e') x[m.to + (turn ? 8 : -8)]='.';
  if (m.flags === 'c') {
    const d=m.to-m.from, rf=d>0?m.from+3:m.from-4, rt=d>0?m.from+1:m.from-1;
    x[rt]=x[rf]; x[rf]='.';
  }
  return x;
}
function legalMoves() {
  const result=[];
  for (const m of pseudo(board,turn)) {
    const x=make(board,m), k=x.findIndex(p=>p === (turn ? 'k' : 'K'));
    if (k >= 0 && !attacked(x,k,1-turn)) result.push(m);
  }
  return result;
}
function uci(m) { return String.fromCharCode(97+file(m.from))+(rank(m.from)+1)+String.fromCharCode(97+file(m.to))+(rank(m.to)+1)+(m.prom||''); }
const moves=legalMoves();
if (moves.length) process.stdout.write(uci(moves[0]));
