const M=require('../netlify/functions/compute-odds.js')._test;
let seed=12345; const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return ((seed>>>0)/4294967296)};
function game(s){let a=0,b=0;while(true){if(rnd()<s)a++;else b++;if(a>=4&&a-b>=2)return 1;if(b>=4&&b-a>=2)return 0;}}
function tb(sA,sB,aFirst){let a=0,b=0,n=0;while(true){const aServes=(((n+1)>>1)%2===0)===aFirst;const p=aServes?sA:1-sB;if(rnd()<p)a++;else b++;n++;if(a>=7&&a-b>=2)return 1;if(b>=7&&b-a>=2)return 0;}}
// true rule: servers alternate every game; the tiebreak counts as one game; whoever received first in it serves first next set
function set(sA,sB,aServesNext){let a=0,b=0,aS=aServesNext;
 while(true){ if(a===6&&b===6){const w=tb(sA,sB,aS);return{a:w?7:6,b:w?6:7,nextAserves:aS?false:true,tbk:1}}
  const w=aS?game(sA):1-game(sB); if(w)a++;else b++; aS=!aS;
  if((a>=6&&a-b>=2)||(b>=6&&b-a>=2)||(a===7&&b===5)||(b===7&&a===5)) return{a,b,nextAserves:aS,tbk:0}; } }
function match(sA,sB){let aS=rnd()<0.5,wa=0,wb=0,g=0,gh=0,s1tb=0,first=true;while(wa<2&&wb<2){const r=set(sA,sB,aS);aS=r.nextAserves;if(first){s1tb=r.tbk;first=false}g+=r.a+r.b;if(r.a>r.b)wa++;else wb++;}
 return{aw:wa===2,sets:wa+wb,g,s1tb}}
for(const [sA,sB] of [[0.66,0.60],[0.70,0.68],[0.58,0.55],[0.75,0.62]]){
 const N=200000;let aw=0,three=0,g=0,tb1=0,a20=0;for(let i=0;i<N;i++){const m=match(sA,sB);if(m.aw)aw++;if(m.sets===3)three++;g+=m.g;tb1+=m.s1tb;if(m.aw&&m.sets===2)a20++;}
 const r=M.mix(sA,sB,0,{m:0,t:0}),g1=M.set1Dist(sA,sB,0);
 const f=x=>(x*100).toFixed(1);
 console.log(`sA=${sA} sB=${sB}  (simulated | engine)`);
 console.log(`  A wins ${f(aw/N)} | ${f(r.pA)}   three sets ${f(three/N)} | ${f(r.A21+r.B21)}   A wins 2-0 ${f(a20/N)} | ${f(r.A20)}`);
 console.log(`  1st-set tiebreak ${f(tb1/N)} | ${f(g1[13])}   mean games ${(g/N).toFixed(2)} | ${r.eT.toFixed(2)}`);}
