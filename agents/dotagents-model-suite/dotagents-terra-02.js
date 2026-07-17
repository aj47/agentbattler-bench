import { readFileSync } from 'node:fs';

const z=readFileSync(0,'utf8').trim().split(/\s+/), rows=z[0].split('/');
let B=[];
for(const x of rows)for(const c of x){if(c>='1'&&c<='8')B.push(...Array(+c).fill('.'));else B.push(c)}
const S={b:B,turn:z[1],c:z[2]||'-',e:z[3]&&z[3]!='-'?(8-(+z[3][1]))*8+z[3].charCodeAt(0)-97:-1};
const white=p=>p!='.'&&p===p.toUpperCase();
const foe=x=>x==='w'?'b':'w';
const mine=(p,x)=>p!='.'&&(white(p)?'w':'b')===x;
const sq=i=>String.fromCharCode(97+i%8)+(8-Math.floor(i/8));
const inb=(r,f)=>r>=0&&r<8&&f>=0&&f<8;
function hit(b,t,side){
  for(let i=0;i<64;i++)if(mine(b[i],side)){
    const p=b[i].toLowerCase(),r=i>>3,f=i&7;
    if(p==='p'){
      const nr=r+(side==='w'?-1:1);
      if(nr>=0&&((f&&nr*8+f-1===t)||(f<7&&nr*8+f+1===t)))return true;
    } else if(p==='n'){
      for(const [a,d] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(inb(r+a,f+d)&&t===(r+a)*8+f+d)return true;
    } else if(p==='k'){
      if(Math.max(Math.abs((t>>3)-r),Math.abs((t&7)-f))===1)return true;
    } else {
      const ds=p==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:p==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for(const [a,d] of ds)for(let R=r+a,F=f+d;inb(R,F);R+=a,F+=d){const q=R*8+F;if(q===t)return true;if(b[q]!='.')break}
    }
  }
  return false;
}
function pseudo(s){
  const b=s.b, side=s.turn, out=[];
  const put=(f,t,x={})=>{if(b[t].toLowerCase()!=='k')out.push({f,t,...x})};
  const pawn=(f,t,x={})=>{if((t>>3)===0||(t>>3)===7)for(const q of 'qrbn')put(f,t,{...x,p:side==='w'?q.toUpperCase():q});else put(f,t,x)};
  for(let i=0;i<64;i++)if(mine(b[i],side)){
    const P=b[i],p=P.toLowerCase(),r=i>>3,f=i&7;
    if(p==='p'){
      const d=side==='w'?-1:1,one=i+d*8,two=i+d*16;
      if(inb(r+d,f)&&b[one]==='.'){
        pawn(i,one);
        if(r===(side==='w'?6:1)&&b[two]==='.')put(i,two);
      }
      for(const df of [-1,1])if(inb(r+d,f+df)){
        const t=(r+d)*8+f+df;
        if((b[t]!='.'&&!mine(b[t],side)))pawn(i,t);
        else if(t===s.e)put(i,t,{ep:true});
      }
    } else if(p==='n'){
      for(const [a,d] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if(inb(r+a,f+d)){const t=(r+a)*8+f+d;if(!mine(b[t],side))put(i,t)}
    } else if(p==='k'){
      for(let a=-1;a<=1;a++)for(let d=-1;d<=1;d++)if((a||d)&&inb(r+a,f+d)){const t=(r+a)*8+f+d;if(!mine(b[t],side))put(i,t)}
      const enemy=foe(side);
      if(!hit(b,i,enemy)){
        if(side==='w'&&i===60){
          if(s.c.includes('K')&&b[61]==='.'&&b[62]==='.'&&b[63]==='R'&&!hit(b,61,enemy)&&!hit(b,62,enemy))put(60,62,{ca:true});
          if(s.c.includes('Q')&&b[59]==='.'&&b[58]==='.'&&b[57]==='.'&&b[56]==='R'&&!hit(b,59,enemy)&&!hit(b,58,enemy))put(60,58,{ca:true});
        }
        if(side==='b'&&i===4){
          if(s.c.includes('k')&&b[5]==='.'&&b[6]==='.'&&b[7]==='r'&&!hit(b,5,enemy)&&!hit(b,6,enemy))put(4,6,{ca:true});
          if(s.c.includes('q')&&b[3]==='.'&&b[2]==='.'&&b[1]==='.'&&b[0]==='r'&&!hit(b,3,enemy)&&!hit(b,2,enemy))put(4,2,{ca:true});
        }
      }
    } else {
      const ds=p==='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:p==='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for(const [a,d] of ds)for(let R=r+a,F=f+d;inb(R,F);R+=a,F+=d){const t=R*8+F;if(mine(b[t],side))break;put(i,t);if(b[t]!='.')break}
    }
  }
  return out;
}
function play(s,m){
  const b=s.b.slice(),P=b[m.f]; let c=s.c;
  b[m.f]='.'; b[m.t]=m.p||P;
  if(m.ep)b[m.t+(s.turn==='w'?8:-8)]='.';
  if(m.ca){const k=m.t>m.f?1:-1,rf=k>0?m.f+3:m.f-4,rt=m.f+k;b[rt]=b[rf];b[rf]='.'}
  if(P==='K')c=c.replace(/[KQ]/g,''); if(P==='k')c=c.replace(/[kq]/g,'');
  if(m.f===63||m.t===63)c=c.replace('K',''); if(m.f===56||m.t===56)c=c.replace('Q','');
  if(m.f===7||m.t===7)c=c.replace('k',''); if(m.f===0||m.t===0)c=c.replace('q','');
  return {b,turn:foe(s.turn),c,e:P.toLowerCase()==='p'&&Math.abs(m.t-m.f)===16?(m.f+m.t)>>1:-1};
}
const val={p:100,n:320,b:330,r:500,q:900,k:0};
let best,score=-1e9;
for(const m of pseudo(S)){
  const n=play(S,m), k=n.b.indexOf(S.turn==='w'?'K':'k');
  if(k<0||hit(n.b,k,foe(S.turn)))continue;
  let v=(S.b[m.t]==='.'?0:val[S.b[m.t].toLowerCase()])+((m.p?val[m.p.toLowerCase()]-100:0));
  if(m.ep)v=100;
  if(v>score){score=v;best=m}
}
if(best)process.stdout.write(sq(best.f)+sq(best.t)+(best.p?best.p.toLowerCase():''));
