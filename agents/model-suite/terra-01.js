import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const b = [];
for (const row of rows) {
  for (const x of row) {
    if (x >= '1' && x <= '8') for (let n = +x; n--;) b.push('.');
    else b.push(x);
  }
}
const side = fen[1], castle = fen[2] || '-', ep = fen[3] && fen[3] !== '-' ? sq(fen[3]) : -1;
const own = x => x !== '.' && (side === 'w' ? x === x.toUpperCase() : x === x.toLowerCase());
const enemy = x => x !== '.' && !own(x);
const rc = i => [i >> 3, i & 7];
function sq(s) { return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97; }
function name(i) { return String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3)); }
function attacked(a, target, white) {
  const [tr, tc] = rc(target), pawn = white ? 'P' : 'p', knight = white ? 'N' : 'n', king = white ? 'K' : 'k';
  const pr = tr + (white ? 1 : -1);
  for (const dc of [-1, 1]) if (pr >= 0 && pr < 8 && tc + dc >= 0 && tc + dc < 8 && a[pr * 8 + tc + dc] === pawn) return true;
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const r=tr+dr,c=tc+dc; if(r>=0&&r<8&&c>=0&&c<8&&a[r*8+c]===knight)return true;
  }
  for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const r=tr+dr,c=tc+dc; if(r>=0&&r<8&&c>=0&&c<8&&a[r*8+c]===king)return true;
  }
  for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
    for(let r=tr+dr,c=tc+dc;r>=0&&r<8&&c>=0&&c<8;r+=dr,c+=dc) {
      const q=a[r*8+c]; if(q!=='.') { const z=q.toLowerCase(), diagonal=dr&&dc; if((diagonal?(z==='b'||z==='q'):(z==='r'||z==='q')) && (white?q===q.toUpperCase():q===q.toLowerCase())) return true; break; }
    }
  }
  return false;
}
function moves() {
  const out=[], white=side==='w', d=white?-1:1, promo=white?0:7;
  const put=(f,t,p='',e=false,c='')=>out.push({f,t,p,e,c});
  for(let f=0;f<64;f++) if(own(b[f])) {
    const q=b[f], z=q.toLowerCase(), [r,col]=rc(f);
    if(z==='p') {
      const nr=r+d, one=nr*8+col;
      const add=(t,e=false)=> { if(nr===promo) for(const p of 'qrbn')put(f,t,p,e); else put(f,t,'',e); };
      if(nr>=0&&nr<8&&b[one]==='.') { add(one); const two=(r+2*d)*8+col; if(r===(white?6:1)&&b[two]==='.')put(f,two); }
      for(const dc of [-1,1]) if(nr>=0&&nr<8&&col+dc>=0&&col+dc<8) { const t=nr*8+col+dc; if(enemy(b[t]))add(t); else if(t===ep&&b[t+(white?8:-8)]===(white?'p':'P'))put(f,t,'',true); }
    } else if(z==='n') {
      for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {const R=r+dr,C=col+dc;if(R>=0&&R<8&&C>=0&&C<8&&!own(b[R*8+C]))put(f,R*8+C);}
    } else if(z==='k') {
      for(const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {const R=r+dr,C=col+dc;if(R>=0&&R<8&&C>=0&&C<8&&!own(b[R*8+C]))put(f,R*8+C);}
      const base=white?56:0, k=base+4, foe=!white;
      if(f===k&&!attacked(b,k,foe)) {
        if(castle.includes(white?'K':'k')&&b[base+5]==='.'&&b[base+6]==='.'&&b[base+7]===(white?'R':'r')&&!attacked(b,base+5,foe)&&!attacked(b,base+6,foe))put(f,base+6,'',false,'K');
        if(castle.includes(white?'Q':'q')&&b[base+1]==='.'&&b[base+2]==='.'&&b[base+3]==='.'&&b[base]===(white?'R':'r')&&!attacked(b,base+3,foe)&&!attacked(b,base+2,foe))put(f,base+2,'',false,'Q');
      }
    } else {
      const ds=z==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:z==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for(const [dr,dc] of ds) for(let R=r+dr,C=col+dc;R>=0&&R<8&&C>=0&&C<8;R+=dr,C+=dc){const t=R*8+C;if(own(b[t]))break;put(f,t);if(b[t]!=='.')break;}
    }
  }
  return out;
}
function legal(m) {
  const a=b.slice(), piece=a[m.f]; a[m.f]='.'; a[m.t]=m.p?(side==='w'?m.p.toUpperCase():m.p):piece;
  if(m.e)a[m.t+(side==='w'?8:-8)]='.';
  if(m.c) { const base=side==='w'?56:0; if(m.c==='K'){a[base+5]=a[base+7];a[base+7]='.';} else {a[base+3]=a[base];a[base]='.';} }
  const k=a.indexOf(side==='w'?'K':'k'); return k>=0&&!attacked(a,k,side!=='w');
}
const m=moves().find(legal);
if(m) process.stdout.write(name(m.f)+name(m.t)+m.p);
