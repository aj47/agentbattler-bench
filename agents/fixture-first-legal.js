#!/usr/bin/env node
/* NON-REFERENCE FIXTURE: deterministic first-legal agent, not harness-generated evidence. */
import fs from 'node:fs';
const input = fs.readFileSync(0, 'utf8').trim().split(/\r?\n/)[0];
const parts = input.split(/\s+/);
if (parts.length < 4) process.exit(2);
const b = Array(64).fill(null); let k = 0;
for (const ch of parts[0]) { if (ch !== '/') { if (/\d/.test(ch)) k += +ch; else b[k++] = ch; } }
if (k !== 64 || !/^[wb]$/.test(parts[1])) process.exit(2);
const side = parts[1], castle = parts[2], epText = parts[3];
const row = i => i >> 3, col = i => i & 7, idx = (r,f) => r*8+f;
const ok = (r,f) => r>=0&&r<8&&f>=0&&f<8;
const mine = (p,s) => p && (s==='w' ? p===p.toUpperCase() : p===p.toLowerCase());
const opp = s => s==='w'?'b':'w';
const sq = i => 'abcdefgh'[col(i)] + (8-row(i));
const ep = epText==='-' ? -1 : idx(8-+epText[1], epText.charCodeAt(0)-97);

function attacked(x,t,s) {
  const r=row(t),f=col(t), pawn=s==='w'?'P':'p', pr=r+(s==='w'?1:-1);
  for(const df of [-1,1]) if(ok(pr,f+df)&&x[idx(pr,f+df)]===pawn)return true;
  for(const [dr,df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(ok(r+dr,f+df)&&x[idx(r+dr,f+df)]===(s==='w'?'N':'n'))return true;
  for(const [dr,df,types] of [[-1,-1,'bq'],[-1,1,'bq'],[1,-1,'bq'],[1,1,'bq'],[-1,0,'rq'],[1,0,'rq'],[0,-1,'rq'],[0,1,'rq']]){
    let rr=r+dr,ff=f+df; while(ok(rr,ff)){const p=x[idx(rr,ff)];if(p){if(mine(p,s)&&types.includes(p.toLowerCase()))return true;break;}rr+=dr;ff+=df;}
  }
  for(let dr=-1;dr<=1;dr++)for(let df=-1;df<=1;df++)if((dr||df)&&ok(r+dr,f+df)&&x[idx(r+dr,f+df)]===(s==='w'?'K':'k'))return true;
  return false;
}
function candidates(){
  const a=[], add=(from,to,prom=null,isEp=false,cs=null)=>a.push({from,to,prom,isEp,cs});
  for(let from=0;from<64;from++){const p=b[from];if(!mine(p,side))continue;const r=row(from),f=col(from),t=p.toLowerCase();
    if(t==='p'){const dr=side==='w'?-1:1,start=side==='w'?6:1,end=side==='w'?0:7,r1=r+dr;
      if(ok(r1,f)&&!b[idx(r1,f)]){if(r1===end)for(const q of ['q','r','b','n'])add(from,idx(r1,f),q);else add(from,idx(r1,f));if(r===start&&!b[idx(r+2*dr,f)])add(from,idx(r+2*dr,f));}
      for(const df of [-1,1])if(ok(r1,f+df)){const to=idx(r1,f+df),cap=b[to];if((cap&&!mine(cap,side))||to===ep){if(r1===end)for(const q of ['q','r','b','n'])add(from,to,q,!cap);else add(from,to,null,!cap);}}
    }else if(t==='n'){for(const [dr,df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(ok(r+dr,f+df)&&!mine(b[idx(r+dr,f+df)],side))add(from,idx(r+dr,f+df));
    }else if('brq'.includes(t)){const d=t==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:t==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];for(const [dr,df]of d){let rr=r+dr,ff=f+df;while(ok(rr,ff)){const to=idx(rr,ff);if(mine(b[to],side))break;add(from,to);if(b[to])break;rr+=dr;ff+=df;}}
    }else{for(let dr=-1;dr<=1;dr++)for(let df=-1;df<=1;df++)if((dr||df)&&ok(r+dr,f+df)&&!mine(b[idx(r+dr,f+df)],side))add(from,idx(r+dr,f+df));const h=side==='w'?60:4,rk=side==='w'?63:7,rq=side==='w'?56:0,K=side==='w'?'K':'k',Q=side==='w'?'Q':'q',R=side==='w'?'R':'r';if(from===h&&castle.includes(K)&&b[rk]===R&&!b[h+1]&&!b[h+2]&&![h,h+1,h+2].some(z=>attacked(b,z,opp(side))))add(from,h+2,null,false,'k');if(from===h&&castle.includes(Q)&&b[rq]===R&&!b[h-1]&&!b[h-2]&&!b[h-3]&&![h,h-1,h-2].some(z=>attacked(b,z,opp(side))))add(from,h-2,null,false,'q');}
  }return a;
}
function moved(m){const x=b.slice(),p=x[m.from];x[m.from]=null;if(m.isEp)x[m.to+(side==='w'?8:-8)]=null;x[m.to]=m.prom?(side==='w'?m.prom.toUpperCase():m.prom):p;if(m.cs==='k'){x[m.to-1]=x[m.to+1];x[m.to+1]=null;}if(m.cs==='q'){x[m.to+1]=x[m.to-2];x[m.to-2]=null;}return x;}
const legal=candidates().filter(m=>{const x=moved(m),king=x.indexOf(side==='w'?'K':'k');return king>=0&&!attacked(x,king,opp(side));});
if(!legal.length)process.exit(3);
legal.sort((x,y)=>(sq(x.from)+sq(x.to)+(x.prom||'')).localeCompare(sq(y.from)+sq(y.to)+(y.prom||'')));
const m=legal[0];process.stdout.write(sq(m.from)+sq(m.to)+(m.prom||'')+'\n');
