const M = require('../netlify/functions/compute-odds.js')._test;
const now = Date.parse("2026-10-06T11:48:08Z");

// ---- 1. a REAL event from your feed (Barrena v Pucinelli, games copy only, Challenger) ----
const real = [{event_id:1637742309,league_name:"ATP Challenger Antofagasta - R1",home:"Alex Barrena (Games)",away:"Matheus Pucinelli De Almeida (Games)",starts:"2026-10-06T15:00:00Z",
periods:{num_0:{money_line:null,spreads:{"1":{hdp:1,home:2.05,away:1.763},"2":{hdp:2,home:1.901,away:1.901},"3":{hdp:3,home:1.704,away:2.13},"-0.5":{hdp:-0.5,home:2.08,away:1.741},"0.5":{hdp:0.5,home:1.943,away:1.847},"1.5":{hdp:1.5,home:1.971,away:1.826},"2.5":{hdp:2.5,home:1.826,away:1.971}},
totals:{"21":{points:21,over:1.758,under:2.07},"22":{points:22,over:1.971,under:1.833},"23":{points:23,over:2.19,under:1.676},"21.5":{points:21.5,over:1.862,under:1.962},"20.5":{points:20.5,over:1.685,under:2.18},"22.5":{points:22.5,over:2.09,under:1.741}},
team_total:{home:{points:11,over:1.556,under:2.39},away:{points:13,over:2.62,under:1.472}},
team_totals:{home:{"11":{points:11,over:1.556,under:2.39},"13":{points:13,over:2.84,under:1.41},"12.5":{points:12.5,over:2.32,under:1.588},"11.5":{points:11.5,over:1.625,under:2.29}},away:{"13":{points:13,over:2.62,under:1.472},"12.5":{points:12.5,over:2.08,under:1.752},"11.5":{points:11.5,over:1.348,under:3.12}}}},
num_1:{spreads:{"1.5":{hdp:1.5,home:1.901,away:1.901},"-1.5":{hdp:-1.5,home:2.47,away:1.535},"3.5":{hdp:3.5,home:1.186,away:4.69}},totals:{"8.5":{points:8.5,over:1.4,under:2.96},"10.5":{points:10.5,over:3.9,under:1.249}}}}}];
let t=Date.now(); let o = M.build(real, now, null, null);
console.log("REAL: ms", Date.now()-t, "kept", o.meta.kept, "skipped", JSON.stringify(o.meta.skipped));
o.matches.forEach(m=>{const p=m[5],md=p.model; console.log(m[0],"v",m[1],"win%",m[3],"S",md.S,"anchor:",md.anchor,"holds",md.holds,"3set",md.three,"tb1",md.tb1,"ttGap",md.ttGap,"med",md.medTotal,"picks",p.opts.length);
 p.opts.filter(x=>x.p>=70).slice(0,6).forEach(x=>console.log("   ",x.mk,x.l,x.p));});

// ---- 2. synthetic round trip: make Pinnacle-style prices from a KNOWN match, recover it ----
function price(p, m){ // fair prob p for side A -> odds with proportional margin
  return [1/(p*(1+m)), 1/((1-p)*(1+m))].map(x=>Math.round(x*1000)/1000); }
function synth(sA,sB,tau,id,opts={}){
  const r = M.mix(sA,sB,tau,{m:0,t:0}), m=0.04;
  const sp={}, tt={}, tmH={}, tmA={}, s1sp={}, s1t={};
  const overOf=(a,L)=>a.reduce((s,p,g)=>g>L?s+p:s,0);
  for (const k of [-3.5,-2.5,-1.5,-0.5,0.5,1.5,2.5,3.5]) { let h=0; for(let mm=-40;mm<=40;mm++) if(mm+k>0) h+=r.md[mm+40]; const [a,b]=price(h,m); sp[k]={hdp:k,home:a,away:b}; }
  const med=r.gd.reduce((s,p,g)=>s+p*g,0);
  for (let L=Math.round(med)-2.5; L<=Math.round(med)+2.5; L+=1) { const [a,b]=price(overOf(r.gd,L),m); tt[L]={points:L,over:a,under:b}; }
  for (const L of [10.5,11.5,12.5]) { const [a,b]=price(overOf(M.set1Dist(sA,sB,tau),L),m); }
  const g1=M.set1Dist(sA,sB,tau); const s1={}; for(const L of [8.5,10.5,12.5]){ const [a,b]=price(overOf(g1,L),m); s1[L]={points:L,over:a,under:b}; }
  const tm={h:{},a:{}}; const hm=r.hg.reduce((s,p,g)=>s+p*g,0), am=r.ag.reduce((s,p,g)=>s+p*g,0);
  for (const L of [Math.floor(hm)-0.5,Math.floor(hm)+0.5]) { const [a,b]=price(overOf(r.hg,L),m); tmH[L]={points:L,over:a,under:b}; }
  for (const L of [Math.floor(am)-0.5,Math.floor(am)+0.5]) { const [a,b]=price(overOf(r.ag,L),m); tmA[L]={points:L,over:a,under:b}; }
  const gamesEv={event_id:id,league_name:opts.league||"ATP Tokyo - R1",home:"P"+id+" (Games)",away:"Q"+id+" (Games)",starts:"2026-10-06T15:00:00Z",periods:{num_0:{spreads:sp,totals:tt,team_totals:{home:tmH,away:tmA}},num_1:{totals:s1}}};
  const evs=[gamesEv];
  if (opts.plain) { const ps={}; const [a,b]=price(r.A20,m); ps["-1.5"]={hdp:-1.5,home:a,away:b}; const [c,d]=price(1-r.B20,m); ps["1.5"]={hdp:1.5,home:c,away:d};
    const [e,f]=price(r.A21+r.B21,m);
    evs.push({event_id:id+1,league_name:opts.league||"ATP Tokyo - R1",home:"P"+id,away:"Q"+id,starts:"2026-10-06T15:00:00Z",periods:{num_0:{money_line:{home:price(r.pA,m)[0],away:price(r.pA,m)[1]},spreads:ps,totals:{"2.5":{points:2.5,over:e,under:f}}}}}); }
  return {evs, truth:{sA,sB,tau,hold:[M.hold(sA),M.hold(sB)],p3:r.A21+r.B21,pA:r.pA,med, tb1:g1[13]}};
}
const cases=[[0.66,0.60,0.03,1001,{plain:1}],[0.70,0.68,0.02,1002,{}],[0.60,0.52,0.04,1003,{plain:1,league:"WTA Beijing - R1"}],[0.64,0.62,0.03,1004,{league:"ATP Challenger Foo - R1"}]];
for (const [a,b,tau,id,op] of cases){ const {evs,truth}=synth(a,b,tau,id,op); const t0=Date.now(); const out=M.build(evs,now,null,null);
  console.log("\nSYN",id,op.league||"ATP","truth holds",truth.hold.map(x=>(x*100).toFixed(1)),"p3",(truth.p3*100).toFixed(1),"tb1",(truth.tb1*100).toFixed(1),"pWin",(truth.pA*100).toFixed(1),"| ms",Date.now()-t0,"kept",out.meta.kept,JSON.stringify(out.meta.skipped));
  out.matches.forEach(m=>{const md=m[5].model; console.log("   fit holds",md.holds,"S",md.S,"3set",md.three,"tb1",md.tb1,"ttGap",md.ttGap,"win",m[3][0],"anchor:",md.anchor,"| picks",m[5].opts.length,"sets:",m[5].opts.filter(x=>x.mk==="Set").map(x=>x.l+" "+x.p).join("; "));});}
