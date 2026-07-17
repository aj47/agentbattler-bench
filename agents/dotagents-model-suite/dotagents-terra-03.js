import { readFileSync } from 'node:fs';

const s=readFileSync(0,'utf8').trim().split(/\s+/), rows=s[0].split('/');
let b=[];
for(const r of rows){for(const c of r){if(c>='1'&&c<='8')b.push(...'.'.repeat(+c));else b.push(c)}}
const white=s[1]==='w', cr=s[2]||'-', ep=s[3]&&s[3]!=='-'?sq(s[3]):-1;
function sq(a){return (8-(+a[1]))*8+a.charCodeAt(0)-97}
function xy(i){return [i&7,i>>3]}
function own(p){return p!=='.'&&(p===p.toUpperCase())===white}
function foe(p){return p!=='.'&&!own(p)}
function attacked(a,t,W){
 const [x,y]=xy(t), P=W?'P':'p',N=W?'N':'n',K=W?'K':'k',R=W?'R':'r',Q=W?'Q':'q',B=W?'B':'b';
 let py=y-(W?-1:1); for(const dx of [-1,1])if(x+dx>=0&&x+dx<8&&py>=0&&py<8&&a[py*8+x+dx]===P)return true;
 for(const [dx,dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]){let X=x+dx,Y=y+dy;if(X>=0&&X<8&&Y>=0&&Y<8&&a[Y*8+X]===N)return true}
 for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){let X=x+dx,Y=y+dy;while(X>=0&&X<8&&Y>=0&&Y<8){let p=a[Y*8+X];if(p!=='.'){if(p===R||p===Q)return true;break}X+=dx;Y+=dy}}
 for(const [dx,dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]){let X=x+dx,Y=y+dy;while(X>=0&&X<8&&Y>=0&&Y<8){let p=a[Y*8+X];if(p!=='.'){if(p===B||p===Q)return true;break}X+=dx;Y+=dy}}
 for(const dx of [-1,0,1])for(const dy of [-1,0,1])if((dx||dy)&&x+dx>=0&&x+dx<8&&y+dy>=0&&y+dy<8&&a[(y+dy)*8+x+dx]===K)return true;
 return false
}
function apply(m,a=b){let z=a.slice(),p=z[m.f];z[m.f]='.';z[m.t]=m.pr||p;if(m.ep)z[m.t+(white?8:-8)]='.';if(m.ca){let r=m.t>m.f?m.f+3:m.f-4, d=m.t>m.f?m.f+1:m.f-1;z[d]=z[r];z[r]='.'}return z}
function safe(m){let z=apply(m), k=z.indexOf(white?'K':'k');return k>=0&&!attacked(z,k,!white)}
let ms=[]; function add(f,t,o={}){if(t>=0&&t<64&&Math.abs((t&7)-(f&7))<=2)ms.push({f,t,...o})}
for(let f=0;f<64;f++){
 let p=b[f];if(!own(p))continue;let [x,y]=xy(f),q=p.toLowerCase();
 if(q==='p'){
  let d=white?-8:8, start=white?6:1, last=white?0:7, t=f+d;
  if(b[t]==='.'){add(f,t,y+(white?-1:1)===last?{pr:white?'Q':'q'}:{});if(y===start&&b[f+2*d]==='.')add(f,f+2*d)}
  for(const dx of [-1,1]){let X=x+dx,T=f+d+dx;if(X>=0&&X<8&&(foe(b[T])||T===ep))add(f,T,{...(y+(white?-1:1)===last?{pr:white?'Q':'q'}:{}),...(T===ep?{ep:1}:{})})}
 }else if(q==='n')for(const [dx,dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]){let X=x+dx,Y=y+dy;if(X>=0&&X<8&&Y>=0&&Y<8&&!own(b[Y*8+X]))add(f,Y*8+X)}
 else if(q==='k'){
  for(const dx of [-1,0,1])for(const dy of [-1,0,1]){let X=x+dx,Y=y+dy;if((dx||dy)&&X>=0&&X<8&&Y>=0&&Y<8&&!own(b[Y*8+X]))add(f,Y*8+X)}
  let home=white?60:4, enemy=!white;
  if(f===home&&!attacked(b,f,enemy)){
   if(cr.includes(white?'K':'k')&&b[f+1]==='.'&&b[f+2]==='.'&&b[f+3]===(white?'R':'r')){let mid={f,t:f+1};if(safe(mid)&&!attacked(b,f+2,enemy))add(f,f+2,{ca:1})}
   if(cr.includes(white?'Q':'q')&&b[f-1]==='.'&&b[f-2]==='.'&&b[f-3]==='.'&&b[f-4]===(white?'R':'r')){let mid={f,t:f-1};if(safe(mid)&&!attacked(b,f-2,enemy))add(f,f-2,{ca:1})}
  }
 }else{
  let ds=q==='b'?[[1,1],[1,-1],[-1,1],[-1,-1]]:q==='r'?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
  for(const [dx,dy] of ds){let X=x+dx,Y=y+dy;while(X>=0&&X<8&&Y>=0&&Y<8){let t=Y*8+X;if(own(b[t]))break;add(f,t);if(b[t]!=='.')break;X+=dx;Y+=dy}}
 }
}
let m=ms.find(m=>m.ca&&safe(m))||ms.find(safe);function u(i){return String.fromCharCode(97+(i&7))+(8-(i>>3))}process.stdout.write(m?u(m.f)+u(m.t)+(m.pr?m.pr.toLowerCase():''):'');
