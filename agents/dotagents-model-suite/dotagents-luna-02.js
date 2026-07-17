import {readFileSync} from "node:fs";

const f = readFileSync(0, "utf8").trim().split(/\s+/);
const b = new Int8Array(64);
const val = {p:1,n:2,b:3,r:4,q:5,k:6};
for (const [r, row] of f[0].split("/").entries()) {
  let x = 0;
  for (const ch of row) {
    if (ch >= "1" && ch <= "8") x += +ch;
    else {
      const v = val[ch.toLowerCase()];
      b[(7-r)*8+x] = ch === ch.toUpperCase() ? v : -v;
      ++x;
    }
  }
}
const side = f[1] === "w" ? 1 : -1;
const rights = f[2] || "-";
const ep = f[3] && f[3] !== "-" ? f[3].charCodeAt(0)-97 + (+f[3][1]-1)*8 : -1;
const moves = [];

function attacked(s, by) {
  const r = s >> 3, x = s & 7;
  for (const dx of [-1, 1]) {
    const qx = x-dx, qr = r-by;
    if (qx >= 0 && qx < 8 && qr >= 0 && qr < 8 && b[qr*8+qx] === by) return true;
  }
  for (const [dr, dx] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const qr=r+dr, qx=x+dx;
    if (qr >= 0 && qr < 8 && qx >= 0 && qx < 8 && b[qr*8+qx] === by*2) return true;
  }
  for (const [dr, dx] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let qr=r+dr, qx=x+dx;
    while (qr >= 0 && qr < 8 && qx >= 0 && qx < 8) {
      const p=b[qr*8+qx];
      if (p) { if (p === by*3 || p === by*5) return true; break; }
      qr += dr; qx += dx;
    }
  }
  for (const [dr, dx] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let qr=r+dr, qx=x+dx;
    while (qr >= 0 && qr < 8 && qx >= 0 && qx < 8) {
      const p=b[qr*8+qx];
      if (p) { if (p === by*4 || p === by*5) return true; break; }
      qr += dr; qx += dx;
    }
  }
  for (let dr=-1; dr<=1; ++dr) for (let dx=-1; dx<=1; ++dx) {
    if (!dr && !dx) continue;
    const qr=r+dr, qx=x+dx;
    if (qr >= 0 && qr < 8 && qx >= 0 && qx < 8 && b[qr*8+qx] === by*6) return true;
  }
  return false;
}

function add(from, to, promotion=0, enPassant=0, castle=0) {
  if (to >= 0 && to < 64 && b[to] !== -side*6) moves.push({from,to,promotion,enPassant,castle});
}
function promote(from, to, enPassant=0) {
  const rank=to >> 3;
  if (rank === 0 || rank === 7) for (const p of [5,4,3,2]) add(from,to,p,enPassant);
  else add(from,to,0,enPassant);
}

for (let from=0; from<64; ++from) {
  const piece=b[from];
  if (piece*side <= 0) continue;
  const type=Math.abs(piece), r=from>>3, x=from&7;
  if (type === 1) {
    const d=side*8, to=from+d;
    if (to >= 0 && to < 64 && !b[to]) {
      promote(from,to);
      if (r === (side===1 ? 1 : 6) && !b[from+2*d]) add(from,from+2*d);
    }
    for (const dx of [-1,1]) {
      const qx=x+dx, to=from+d+dx;
      if (qx < 0 || qx > 7 || to < 0 || to >= 64) continue;
      if (b[to]*side < 0) promote(from,to);
      else if (to === ep && b[to] === 0 && b[to-d] === -side) promote(from,to,1);
    }
  } else if (type === 2) {
    for (const [dr,dx] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const rr=r+dr, xx=x+dx;
      if (rr >= 0 && rr < 8 && xx >= 0 && xx < 8 && b[rr*8+xx]*side <= 0) add(from,rr*8+xx);
    }
  } else if (type === 3 || type === 4 || type === 5) {
    const dirs = type === 3 ? [[-1,-1],[-1,1],[1,-1],[1,1]] : type === 4 ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr,dx] of dirs) {
      let rr=r+dr, xx=x+dx;
      while (rr >= 0 && rr < 8 && xx >= 0 && xx < 8) {
        const to=rr*8+xx;
        if (!b[to]) add(from,to);
        else { if (b[to]*side < 0) add(from,to); break; }
        rr += dr; xx += dx;
      }
    }
  } else if (type === 6) {
    for (let dr=-1; dr<=1; ++dr) for (let dx=-1; dx<=1; ++dx) {
      if (!dr && !dx) continue;
      const rr=r+dr, xx=x+dx;
      if (rr >= 0 && rr < 8 && xx >= 0 && xx < 8 && b[rr*8+xx]*side <= 0) add(from,rr*8+xx);
    }
    const home=side===1 ? 4 : 60;
    if (from === home && b[from] === side*6 && !attacked(from,-side)) {
      for (const [ch,dir,rook,empty] of [[side===1?"K":"k",1,home+3,[home+1,home+2]],[side===1?"Q":"q",-1,home-4,[home-1,home-2,home-3]]]) {
        if (rights.includes(ch) && b[rook] === side*4 && empty.every(q=>!b[q]) && !attacked(home+dir,-side) && !attacked(home+2*dir,-side)) add(from,home+2*dir,0,0,1);
      }
    }
  }
}

function legal(m) {
  const piece=b[m.from], captured=b[m.to];
  const epSquare=m.enPassant ? m.to-side*8 : -1, epPiece=epSquare < 0 ? 0 : b[epSquare];
  let rookFrom=-1, rookTo=-1, rookPiece=0;
  b[m.from]=0;
  if (m.enPassant) b[epSquare]=0;
  b[m.to]=m.promotion ? side*m.promotion : piece;
  if (m.castle) {
    const d=m.to>m.from ? 1 : -1;
    rookFrom=m.from+(d>0 ? 3 : -4); rookTo=m.from+d; rookPiece=b[rookFrom];
    b[rookFrom]=0; b[rookTo]=rookPiece;
  }
  let king=m.to;
  if (Math.abs(piece)!==6) for (king=0; king<64 && b[king]!==side*6; ++king);
  const ok=king<64 && !attacked(king,-side);
  if (m.castle) { b[rookFrom]=rookPiece; b[rookTo]=0; }
  b[m.from]=piece; b[m.to]=captured;
  if (m.enPassant) b[epSquare]=epPiece;
  return ok;
}
function square(s) { return String.fromCharCode(97+(s&7)) + (1+(s>>3)); }
function notation(m) { return square(m.from)+square(m.to)+(m.promotion ? ["","","n","b","r","q"][m.promotion] : ""); }
const legalMoves=moves.filter(legal);
if (legalMoves.length) process.stdout.write(notation(legalMoves[0])+"\n");
