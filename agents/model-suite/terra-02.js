import{readFileSync as R}from'node:fs';
let F=R(0,'utf8').trim().split(/\s+/),A=F[0].split('/'),B=[],S=F[1]=='w',C=F[2]||'-',H=F[3],E=H=='-'?-1:(8-+H[1])*8+H.charCodeAt(0)-97;
for(let x of A)for(let q of x)if(q>='1'&&q<='8')B.push(...'.'.repeat(+q));else B.push(q);
const I=(r,c)=>r>=0&&r<8&&c>=0&&c<8?r*8+c:-1, W=p=>p>='A'&&p<='Z',O=p=>p!='.'&&W(p)!=S, K=p=>p.toLowerCase()=='k',N='qrbn';
function hit(t,b,w){let r=t>>3,c=t&7,p;
 for(let d of[-1,1]){let z=I(r+(w?1:-1),c+d);if(z>=0&&b[z]==(w?'P':'p'))return 1}
 for(let d of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){let z=I(r+d[0],c+d[1]);if(z>=0&&b[z]==(w?'N':'n'))return 1}
 for(let d of[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]){let z=I(r+d[0],c+d[1]);if(z>=0&&b[z]==(w?'K':'k'))return 1}
 for(let [dr,dc,ch] of[[-1,0,'rq'],[1,0,'rq'],[0,-1,'rq'],[0,1,'rq'],[-1,-1,'bq'],[-1,1,'bq'],[1,-1,'bq'],[1,1,'bq']])for(let y=r+dr,x=c+dc;(p=I(y,x))>=0;y+=dr,x+=dc){let v=b[p];if(v!='.'){if(W(v)==w&&ch.includes(v.toLowerCase()))return 1;break}}
 return 0
}
function put(a,f,t,p){a.push([f,t,p||'',0])}
function pseudo(s){let a=[],b=s.b,w=s.s;
 for(let f=0;f<64;f++){let p=b[f];if(p=='.'||W(p)!=w)continue;let r=f>>3,c=f&7,l=p.toLowerCase(),z;
  if(l=='p'){let d=w?-1:1,rr=r+d,pr=w?0:7;if((z=I(rr,c))>=0&&b[z]=='.'){if(rr==pr)for(let x of N)put(a,f,z,x);else put(a,f,z);if(r==(w?6:1)&&(z=I(r+2*d,c))>=0&&b[z]=='.')put(a,f,z)}for(let dc of[-1,1])if((z=I(rr,c+dc))>=0&&(O(b[z])&&!K(b[z])||z==s.e)){if(rr==pr)for(let x of N)put(a,f,z,x);else put(a,f,z)}
  }else if(l=='n'){for(let d of[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])if((z=I(r+d[0],c+d[1]))>=0&&(b[z]=='.'||O(b[z])&&!K(b[z])))put(a,f,z)
  }else if(l=='k'){for(let dr=-1;dr<2;dr++)for(let dc=-1;dc<2;dc++)if((dr||dc)&&(z=I(r+dr,c+dc))>=0&&(b[z]=='.'||O(b[z])&&!K(b[z])))put(a,f,z);let row=w?7:0,base=row*8,kk=w?'K':'k',qq=w?'Q':'q',rook=w?'R':'r';let step=(u,v)=>{let x=b.slice();x[f]='.';x[u]=p;return!hit(u,x,!w)&&!hit(v,x,!w)};if(f==base+4&&!hit(f,b,!w)){if(C.includes(kk)&&b[base+5]=='.'&&b[base+6]=='.'&&b[base+7]==rook&&step(base+5,base+6))put(a,f,base+6);if(C.includes(qq)&&b[base+1]=='.'&&b[base+2]=='.'&&b[base+3]=='.'&&b[base]==rook&&step(base+3,base+2))put(a,f,base+2)}
  }else{let ds=l=='b'?[[-1,-1],[-1,1],[1,-1],[1,1]]:l=='r'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];for(let d of ds)for(let y=r+d[0],x=c+d[1];(z=I(y,x))>=0;y+=d[0],x+=d[1]){if(b[z]=='.')put(a,f,z);else{if(O(b[z])&&!K(b[z]))put(a,f,z);break}}}
 }return a
}
function play(s,m){let[b,w,c,e]=[s.b.slice(),s.s,s.c,s.e],[f,t,p]=m,x=b[f],cap=b[t];b[f]='.';b[t]=p?(w?p.toUpperCase():p):x;if(x.toLowerCase()=='p'&&t==e&&cap=='.')b[t+(w?8:-8)]='.';if(x.toLowerCase()=='k'&&Math.abs(t-f)==2){let q=t>f?f+3:f-4,u=t>f?f+1:f-1;b[u]=b[q];b[q]='.'}if(x=='K')c=c.replace(/[KQ]/g,'');if(x=='k')c=c.replace(/[kq]/g,'');if(f==63||t==63)c=c.replace('K','');if(f==56||t==56)c=c.replace('Q','');if(f==7||t==7)c=c.replace('k','');if(f==0||t==0)c=c.replace('q','');return{b,s:!w,c,e:x.toLowerCase()=='p'&&Math.abs(t-f)==16?(f+t)/2:-1}}
let T={b:B,s:S,c:C,e:E},M=pseudo(T).filter(m=>{let u=play(T,m),k=u.b.indexOf(S?'K':'k');return k>=0&&!hit(k,u.b,!S)});
M.sort((a,b)=>{let v=m=>(T.b[m[1]]!='.'?10:0)+(m[1]==E?9:0)+(m[2]?8:0)+(T.b[m[0]].toLowerCase()=='k'&&Math.abs(m[1]-m[0])==2?11:0)+(m[1]&7==3?1:0);return v(b)-v(a)});let m=M[0];process.stdout.write(String.fromCharCode(97+(m[0]&7))+String(8-(m[0]>>3))+String.fromCharCode(97+(m[1]&7))+String(8-(m[1]>>3))+m[2]);
