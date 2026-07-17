import { readFileSync } from 'node:fs';

const s=readFileSync(0,'utf8').trim().split(/\s+/), fen=s[0]||'', turn=s[1]||'w', rights=s[2]||'-', eps=s[3]||'-';
const b=Array(64).fill('.'); let k=0;
for(const row of fen.split('/')){for(const c of row){if(c>='1'&&c<='8')k+=+c;else b[k++]=c}}
const side=turn==='w'?'w':'b', enemy=side==='w'?'b':'w';
const own=p=>p!=='.'&&(side==='w'?p===p.toUpperCase():p===p.toLowerCase());
const foe=p=>p!=='.'&&!own(p)&&p.toLowerCase()!=='k';
const land=p=>!own(p)&&p.toLowerCase()!=='k';
const xy=i=>[i&7,i>>3], at=(x,y)=>x>=0&&x<8&&y>=0&&y<8?y*8+x:-1;
const ep=eps==='-'?-1:at(eps.charCodeAt(0)-97,8-(+eps[1]));
function attacked(q,t,by){
 const [x,y]=xy(t), pawn=by==='w'?'P':'p', knight=by==='w'?'N':'n', king=by==='w'?'K':'k', rook=by==='w'?'R':'r', bishop=by==='w'?'B':'b', queen=by==='w'?'Q':'q';
 const py=y+(by==='w'?1:-1); for(const dx of[-1,1]){const z=at(x+dx,py);if(z>=0&&q[z]===pawn)return true}
 for(const[d,e]of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]){const z=at(x+d,y+e);if(z>=0&&q[z]===knight)return true}
 for(const[d,e]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){const z=at(x+d,y+e);if(z>=0&&q[z]===king)return true}
 for(const[d,e,aa,bb]of [[1,0,rook,queen],[-1,0,rook,queen],[0,1,rook,queen],[0,-1,rook,queen],[1,1,bishop,queen],[1,-1,bishop,queen],[-1,1,bishop,queen],[-1,-1,bishop,queen]]){let X=x+d,Y=y+e,z;while((z=at(X,Y))>=0){if(q[z]!=='.'){if(q[z]===aa||q[z]===bb)return true;break}X+=d;Y+=e}}
 return false;
}
function apply(m){const q=b.slice(),p=q[m.f];q[m.f]='.';q[m.t]=m.prom?(side==='w'?m.prom.toUpperCase():m.prom):p;if(m.ep)q[m.t+(side==='w'?8:-8)]='.';if(m.castle){const a=m.t>m.f?m.f+3:m.f-4,d=m.t>m.f?m.f+1:m.f-1;q[d]=q[a];q[a]='.'}return q}
const pseudo=[]; const add=(f,t,o={})=>pseudo.push({f,t,...o});
for(let f=0;f<64;f++)if(own(b[f])){
 const p=b[f].toLowerCase(),[x,y]=xy(f);
 if(p==='p'){
  const dy=side==='w'?-1:1, st=side==='w'?6:1, last=side==='w'?0:7, one=at(x,y+dy);
  const put=(t,o={})=>{if((t>>3)===last)for(const prom of ['q','r','b','n'])add(f,t,{...o,prom});else add(f,t,o)};
  if(one>=0&&b[one]==='.'){put(one);const two=at(x,y+2*dy);if(y===st&&b[two]==='.')add(f,two)}
  for(const dx of[-1,1]){const t=at(x+dx,y+dy);if(t>=0&&(foe(b[t])||t===ep))put(t,t===ep?{ep:true}:{})}
 }else if(p==='n')for(const[d,e]of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]){const t=at(x+d,y+e);if(t>=0&&land(b[t]))add(f,t)}
 else if(p==='k'){
  for(const[d,e]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){const t=at(x+d,y+e);if(t>=0&&land(b[t]))add(f,t)}
  const home=side==='w'?60:4, R=side==='w'?'R':'r';
  if(f===home&&!attacked(b,f,enemy)){
   const ks=side==='w'?'K':'k',qs=side==='w'?'Q':'q';
   if(rights.includes(ks)&&b[home+3]===R&&b[home+1]==='.'&&b[home+2]==='.'&&!attacked(b,home+1,enemy)&&!attacked(b,home+2,enemy))add(f,home+2,{castle:true});
   if(rights.includes(qs)&&b[home-4]===R&&b[home-1]==='.'&&b[home-2]==='.'&&b[home-3]==='.'&&!attacked(b,home-1,enemy)&&!attacked(b,home-2,enemy))add(f,home-2,{castle:true});
  }
 }else{
  const ds=p==='b'?[[1,1],[1,-1],[-1,1],[-1,-1]]:p==='r'?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  for(const[d,e]of ds){let X=x+d,Y=y+e,t;while((t=at(X,Y))>=0){if(own(b[t])||b[t].toLowerCase()==='k')break;add(f,t);if(b[t]!=='.')break;X+=d;Y+=e}}
 }
}
const legal=pseudo.filter(m=>{const q=apply(m), king=side==='w'?'K':'k', z=q.indexOf(king);return z>=0&&!attacked(q,z,enemy)});
const val={p:100,n:320,b:330,r:500,q:900,k:0};
legal.sort((a,c)=>{const A=(b[a.t]==='.'?0:val[b[a.t].toLowerCase()])+(a.prom?val[a.prom]:0),C=(b[c.t]==='.'?0:val[b[c.t].toLowerCase()])+(c.prom?val[c.prom]:0);return C-A});
if(legal.length){const m=legal[0],name=i=>String.fromCharCode(97+(i&7))+(8-(i>>3));process.stdout.write(name(m.f)+name(m.t)+(m.prom||''));}
