import { readFileSync } from 'node:fs';

const f=readFileSync(0,'utf8').trim().split(/\s+/), rows=f[0].split('/'), b=[];
for(const x of rows) for(const z of x) { if(z>='1'&&z<='8') for(let i=0;i<+z;i++)b.push('.'); else b.push(z); }
const turn=f[1], rights=f[2]||'-', ep=f[3]&&f[3]!='-'?sq(f[3]):-1;
const W=x=>x>='A'&&x<='Z', own=(x,s)=>x!='.'&&(W(x)==(s=='w'));
function sq(s){return (8-(+s[1]))*8+s.charCodeAt(0)-97}
function uci(i){return String.fromCharCode(97+i%8)+(8-(i/8|0))}
function atk(a,t,s){
 const tr=t/8|0,tc=t%8;
 for(let i=0;i<64;i++)if(own(a[i],s)){
  const p=a[i].toLowerCase(),r=i/8|0,c=i%8,dr=tr-r,dc=tc-c;
  if(p=='p'&&dr==(s=='w'?-1:1)&&Math.abs(dc)==1)return true;
  if(p=='n'&&((Math.abs(dr)==2&&Math.abs(dc)==1)||(Math.abs(dr)==1&&Math.abs(dc)==2)))return true;
  if(p=='k'&&Math.max(Math.abs(dr),Math.abs(dc))==1)return true;
  let ok=(p=='b'&&(Math.abs(dr)==Math.abs(dc)))||(p=='r'&&(dr==0||dc==0))||(p=='q'&&(dr==0||dc==0||Math.abs(dr)==Math.abs(dc)));
  if(ok){let sr=Math.sign(dr),sc=Math.sign(dc),rr=r+sr,cc=c+sc,clear=true;while(rr!=tr||cc!=tc){if(a[rr*8+cc]!='.'){clear=false;break}rr+=sr;cc+=sc}if(clear)return true}
 }
 return false;
}
function moves(a,s){
 const out=[], add=(from,to,p='',flag='')=>out.push({from,to,p,flag});
 for(let i=0;i<64;i++)if(own(a[i],s)){
  const P=a[i],p=P.toLowerCase(),r=i/8|0,c=i%8;
  if(p=='p'){
   const d=s=='w'?-1:1,st=s=='w'?6:1,pr=s=='w'?0:7,one=(r+d)*8+c;
   if(r+d>=0&&r+d<8&&a[one]=='.'){if(r+d==pr)for(const q of'qrbn')add(i,one,q);else add(i,one);let two=(r+2*d)*8+c;if(r==st&&a[two]=='.')add(i,two)}
   for(const dc of[-1,1]){let rr=r+d,cc=c+dc;if(rr<0||rr>7||cc<0||cc>7)continue;let t=rr*8+cc;if((a[t]!='.'&&!own(a[t],s))||t==ep){if(rr==pr)for(const q of'qrbn')add(i,t,q,t==ep?'e':'');else add(i,t,'',t==ep?'e':'')}}
  } else if(p=='n'||p=='k'){
   const ds=p=='n'?[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
   for(const [dr,dc] of ds){let rr=r+dr,cc=c+dc;if(rr>=0&&rr<8&&cc>=0&&cc<8&&!own(a[rr*8+cc],s))add(i,rr*8+cc)}
   if(p=='k'){
    const e=s=='w'?60:4, enemy=s=='w'?'b':'w';
    if(i==e&&!atk(a,e,enemy)){
     if((s=='w'?rights.includes('K'):rights.includes('k'))&&a[e+1]=='.'&&a[e+2]=='.'&&a[e+3]==(s=='w'?'R':'r')&&!atk(a,e+1,enemy)&&!atk(a,e+2,enemy))add(i,e+2,'','c');
     if((s=='w'?rights.includes('Q'):rights.includes('q'))&&a[e-1]=='.'&&a[e-2]=='.'&&a[e-3]=='.'&&a[e-4]==(s=='w'?'R':'r')&&!atk(a,e-1,enemy)&&!atk(a,e-2,enemy))add(i,e-2,'','c');
    }
   }
  } else {
   const ds=p=='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:p=='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
   for(const [dr,dc] of ds)for(let rr=r+dr,cc=c+dc;rr>=0&&rr<8&&cc>=0&&cc<8;rr+=dr,cc+=dc){let t=rr*8+cc;if(own(a[t],s))break;add(i,t);if(a[t]!='.')break}
  }
 }
 return out;
}
function play(a,m,s){let n=a.slice(),x=n[m.from];n[m.from]='.';if(m.flag=='e')n[(m.from/8|0)*8+m.to%8]='.';n[m.to]=m.p?(s=='w'?m.p.toUpperCase():m.p):x;if(m.flag=='c'){let d=m.to>m.from?1:-1,rf=m.from+(d>0?3:-4);n[m.from+d]=n[rf];n[rf]='.'}return n}
const enemy=turn=='w'?'b':'w', legal=moves(b,turn).filter(m=>{let n=play(b,m,turn),k=n.findIndex(x=>x==(turn=='w'?'K':'k'));return k>=0&&!atk(n,k,enemy)});
const val={p:100,n:320,b:330,r:500,q:900,k:0,'.':0};
legal.sort((x,y)=>{let X=val[b[x.to].toLowerCase()]+(x.p?800:0)+(x.flag=='c'||x.flag=='e'?2000:0),Y=val[b[y.to].toLowerCase()]+(y.p?800:0)+(y.flag=='c'||y.flag=='e'?2000:0);return Y-X});
if(legal.length){let m=legal[0];process.stdout.write(uci(m.from)+uci(m.to)+m.p)}
