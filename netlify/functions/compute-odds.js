"use strict";
/* =====================================================================
   compute-odds.js  (Netlify Function, plain JavaScript, no dependencies)

   1. Pulls prematch tennis fixtures from Pinnwire (key = env var PINNWIRE_KEY)
   2. Keeps ATP and WTA tour singles and ATP Challengers (not men's Slams yet: best of five)
   3. Merges the plain and "(Games)" copies of each match, and keeps the SET lines
      (+-1.5 sets, 2.5 sets total) apart from the GAME lines
   4. Fits the serve strengths that reproduce the game handicap + total ladders, with the
      overall serve level (S) anchored to the first-set total lines and the set split
      (instead of a tour-average guess). No first-set lines? S is assumed and every pick
      is re-checked at S -0.04 and +0.04; only picks that survive keep their probability.
   5. TRUST GATES drop loose fits and any match where the model disagrees with Pinnacle.
   6. Per match it returns a few picks only: winner, game-handicap protection, a total with a cushion,
      winner + total and a "bet of the game" (odds >= CFG.MIN_ODDS, handicap preferred), plus an options
      list the page uses for the bet of the day and the accumulators.
   ===================================================================== */

const CFG = {
  URL: "https://pinnwire.com/kit/v1/prematch/fixtures?sport_id=2",
  CACHE_MS: 20 * 60 * 1000,
  MARGIN: 0.045,
  MAX_GAP: 0.08,          // model vs moneyline disagreement (probability) -> drop match
  MAX_ERR_T: 0.03,        // total-games fit error when S is assumed
  MAX_ERR_T_ANCHORED: 0.04, // looser when S is anchored: the total line is traded off against the set lines on purpose
  MAX_ERR_M: 0.01,        // handicap fit error
  MAX_LINE_DRIFT: 1.0,    // games between model median and market line
  MAX_P3_GAP: 0.06,       // model three-set chance vs the set lines
  MAX_S1_GAP: 0.08,       // model vs first-set total lines
  MIN_ODDS: 1.18,         // a pick must pay at least this (estimated bookmaker odds) to be offered
  BOOK_MARGIN: 0,         // 0 = fair odds (no vig). Set e.g. 0.07 to subtract a typical bookmaker margin
  H_EXT: 2,               // handicap lines may reach this many games beyond the range Pinnacle actually posts
  T_EXT: 3,               // total lines may reach this many games beyond the range Pinnacle actually posts
  ELIGIBLE: 0.40,         // only a player with at least this winner chance gets a handicap or winner+total pick
  TOTAL_WINDOW: 5.5,      // total-games lines considered: expected total +- this many games
  HMAX_CAP: 8.5,          // largest handicap protection considered
  S_ROBUST: 0.04,         // serve-level swing used when S could not be anchored
  PICKEM: [1.70, 2.50],
  MAX_MATCHES: 250,        // no longer the limit: the time budget is, and unfinished matches carry over to the next request
  BUDGET_MS: 6500,         // time one request may spend fitting matches
  LOOKAHEAD_H: 72,
  MAX_TT_GAP: 0.07,       // mean gap on each player's own games lines (team totals)
  W_TT: 0.5               // weight of team totals in the serve-level fit (their limits are thin)
};
const ATP_1000 = /(indian wells|miami|monte[- ]?carlo|madrid|rome|canada|toronto|montreal|cincinnati|shanghai|paris)/i;
const WTA_1000 = /(doha|dubai|indian wells|miami|madrid|rome|canada|toronto|montreal|cincinnati|beijing|wuhan)/i;
const ROUND_RE = /\s+-\s+(R\d+|Q\d*|QF|SF|F|Final|Qualifying)\b.*$/i;

/* ---------------------------- TENNIS MATH ---------------------------- */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function hold(s) {
  s = clamp(s, 0.01, 0.99);
  const q = 1 - s;
  return Math.pow(s, 4) * (1 + 4 * q + 10 * q * q) +
         20 * Math.pow(s, 3) * Math.pow(q, 3) * (s * s / (s * s + q * q));
}

function tiebreak(sA, sB, aFirst) {
  const dp = Array.from({ length: 7 }, () => Array(7).fill(0));
  dp[0][0] = 1;
  let win = 0;
  for (let n = 0; n < 12; n++) {
    for (let a = 0; a <= 6; a++) {
      const b = n - a;
      if (b < 0 || b > 6) continue;
      const p = dp[a][b];
      if (!p) continue;
      const aServes = ((((n + 1) >> 1) % 2) === 0) === aFirst;
      const pa = aServes ? sA : 1 - sB;
      if (a + 1 === 7) win += p * pa; else dp[a + 1][b] += p * pa;
      if (b + 1 !== 7) dp[a][b + 1] += p * (1 - pa);
    }
  }
  const x = sA * (1 - sB), y = (1 - sA) * sB;
  return win + dp[6][6] * x / (x + y);
}

function setDist(sA, sB, aFirst) {
  const hA = hold(sA), hB = hold(sB), tb = tiebreak(sA, sB, aFirst);
  const D = Array.from({ length: 8 }, () => Array(8).fill(0));
  D[0][0] = 1;
  const out = [];
  for (let n = 0; n <= 12; n++) {
    for (let i = 0; i <= 7; i++) {
      const j = n - i;
      if (j < 0 || j > 7) continue;
      const p = D[i][j];
      if (!p) continue;
      if ((i === 6 && j <= 4) || (j === 6 && i <= 4) || (i === 7 && j === 5) || (j === 7 && i === 5)) { out.push([i, j, p]); continue; }
      if (i === 6 && j === 6) { out.push([7, 6, p * tb], [6, 7, p * (1 - tb)]); continue; }
      const aServes = (n % 2 === 0) === aFirst;
      const pa = aServes ? hA : 1 - hB;
      D[i + 1][j] += p * pa;
      D[i][j + 1] += p * (1 - pa);
    }
  }
  return out;
}

function matchStats(sA, sB, hur) {
  hur = hur || {};
  let pm = 0, pt = 0;
  const gd = Array(60).fill(0), md = Array(81).fill(0), ja = Array(60).fill(0), hg = Array(45).fill(0), ag = Array(45).fill(0), s1g = Array(14).fill(0), s2g = Array(14).fill(0);
  const dist = { t: setDist(sA, sB, true), f: setDist(sA, sB, false) };
  const flip = (f, games) => (games % 2 === 0 ? f : !f);
  let pA = 0, eT = 0, eM = 0, A20 = 0, A21 = 0, B20 = 0, B21 = 0;
  for (const f1 of [true, false]) {
    for (const [a1, b1, p1] of dist[f1 ? "t" : "f"]) {
      const f2 = flip(f1, a1 + b1);
      for (const [a2, b2, p2] of dist[f2 ? "t" : "f"]) {
        const w = 0.5 * p1 * p2, s1 = a1 > b1, s2 = a2 > b2;
        s1g[a1 + b1] += w; s2g[a2 + b2] += w;
        if (s1 === s2) {
          const g = a1 + b1 + a2 + b2, m = a1 - b1 + a2 - b2;
          if (s1) { pA += w; A20 += w; ja[g] += w; } else B20 += w;
          eT += w * g; eM += w * m; gd[g] += w; md[m + 40] += w; hg[a1 + a2] += w; ag[b1 + b2] += w;
          if (m > hur.m) pm += w;
          if (g > hur.t) pt += w;
        } else {
          const f3 = flip(f2, a2 + b2);
          for (const [a3, b3, p3] of dist[f3 ? "t" : "f"]) {
            const q = w * p3, g = a1 + b1 + a2 + b2 + a3 + b3, m = a1 - b1 + a2 - b2 + a3 - b3;
            if (a3 > b3) { pA += q; A21 += q; ja[g] += q; } else B21 += q;
            eT += q * g; eM += q * m; gd[g] += q; md[m + 40] += q; hg[a1 + a2 + a3] += q; ag[b1 + b2 + b3] += q;
            if (m > hur.m) pm += q;
            if (g > hur.t) pt += q;
          }
        }
      }
    }
  }
  return { pA, eT, eM, A20, A21, B20, B21, pm, pt, gd, md, ja, hg, ag, s1g, s2g };
}

const GH = [[-2.857, 0.01126], [-1.3556, 0.2221], [0, 0.5333], [1.3556, 0.2221], [2.857, 0.01126]];
function mix(sA, sB, tau, hur) {
  const nodes = tau > 0 ? GH : [[0, 1]], ws = nodes.reduce((a, n) => a + n[1], 0);
  const out = { pA: 0, eT: 0, eM: 0, A20: 0, A21: 0, B20: 0, B21: 0, pm: 0, pt: 0, gd: Array(60).fill(0), md: Array(81).fill(0), ja: Array(60).fill(0), hg: Array(45).fill(0), ag: Array(45).fill(0), s1g: Array(14).fill(0), s2g: Array(14).fill(0) };
  for (const [z, w] of nodes) {
    const ww = w / ws, d = tau * z, r = matchStats(clamp(sA + d, 0.2, 0.92), clamp(sB - d, 0.2, 0.92), hur);
    for (const k of ["pA", "eT", "eM", "A20", "A21", "B20", "B21", "pm", "pt"]) out[k] += ww * r[k];
    for (let i = 0; i < 60; i++) { out.gd[i] += ww * r.gd[i]; out.ja[i] += ww * r.ja[i]; }
    for (let i = 0; i < 81; i++) out.md[i] += ww * r.md[i];
    for (let i = 0; i < 45; i++) { out.hg[i] += ww * r.hg[i]; out.ag[i] += ww * r.ag[i]; }
    for (let i = 0; i < 14; i++) { out.s1g[i] += ww * r.s1g[i]; out.s2g[i] += ww * r.s2g[i]; }
  }
  return out;
}

/* distribution of games in the FIRST set (who serves first is a coin toss), same form-shock average */
function set1Dist(sA, sB, tau) {
  const nodes = tau > 0 ? GH : [[0, 1]], ws = nodes.reduce((a, n) => a + n[1], 0), gd = Array(14).fill(0);
  for (const [z, w] of nodes) {
    const d = tau * z, a = clamp(sA + d, 0.2, 0.92), b = clamp(sB - d, 0.2, 0.92);
    for (const f of [true, false]) for (const [x, y, p] of setDist(a, b, f)) gd[x + y] += (w / ws) * 0.5 * p;
  }
  return gd;
}
const overG = (gd, L) => gd.reduce((s, p, g) => (g > L ? s + p : s), 0);

function medianTotal(gd) {
  let cum = 0;
  for (let k = 0; k < gd.length - 1; k++) {
    const before = 1 - cum;
    cum += gd[k];
    const after = 1 - cum;
    if (before >= 0.5 && after <= 0.5) return (k - 0.5) + (before - 0.5) / Math.max(before - after, 1e-9);
  }
  return null;
}
function medianMargin(md) {
  let prev = null;
  for (let k = -39.5; k <= 39.5; k += 1) {
    let above = 0;
    for (let m = Math.ceil(k); m <= 40; m++) above += md[m + 40];
    if (prev && prev.p >= 0.5 && above <= 0.5) return prev.k + (prev.p - 0.5) / Math.max(prev.p - above, 1e-9);
    prev = { k, p: above };
  }
  return null;
}

/* ---------------------------- FITTING ---------------------------- */
const TOUR_S = { "ATP 1000": 0.64, "WTA 1000": 0.565, "Challenger": 0.62, ATP: 0.63, WTA: 0.565 };

/* for one fixed serve level S: d pins the handicap, tau pins the total. null if it cannot be reached */
function solveAtS(L, hur, S) {
  const solveD = (tau) => {
    let lo = -0.34, hi = 0.34;
    const f = (d) => mix(S + d / 2, S - d / 2, tau, hur).pm;
    if (f(lo) > L.cover || f(hi) < L.cover) return null;
    for (let n = 0; n < 8; n++) { const m = (lo + hi) / 2; if (f(m) < L.cover) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const at = (tau) => {
    const d = solveD(tau);
    if (d == null) return null;
    const r = mix(S + d / 2, S - d / 2, tau, hur);
    return { S, tau, d, sA: S + d / 2, sB: S - d / 2, errM: r.pm - L.cover, errT: r.pt - L.pOver };
  };
  const t0 = at(0);
  if (!t0) return null;
  if (t0.errT <= 0) return t0;
  const t1 = at(0.10);
  if (!t1) return null;
  if (t1.errT >= 0) return t1;
  let lo = 0, hi = 0.10, mid = null;
  for (let n = 0; n < 6; n++) { const m = (lo + hi) / 2, x = at(m); if (!x) break; mid = x; if (x.errT > 0) lo = m; else hi = m; }
  return mid || t1;
}

/* how badly a fit misses the anchors: set split, first-set totals, the total line, and a weak pull toward the tour average */
function anchorLoss(c, hur, anc, S0) {
  const r = mix(c.sA, c.sB, c.tau, hur);
  let e = 2 * c.errT * c.errT + Math.pow((c.S - S0) * 0.4, 2);
  if (anc.p3 != null) e += Math.pow(r.A21 + r.B21 - anc.p3, 2);
  if (anc.s1) { const g1 = set1Dist(c.sA, c.sB, c.tau); for (const L in anc.s1) e += Math.pow(overG(g1, +L) - anc.s1[L], 2); }
  if (anc.ml != null) e += Math.pow(r.pA - anc.ml, 2);
  if (anc.h20 != null) e += Math.pow(r.A20 - anc.h20, 2);
  if (anc.a20 != null) e += Math.pow(r.B20 - anc.a20, 2);
  if (anc.tt) e += CFG.W_TT * ttSq(r, anc.tt);
  return e;
}

function solveMarket(L, S0, anc, hint) {
  const hur = { m: -L.hLine, t: L.tLine };
  const hasA = anc && (anc.p3 != null || anc.h20 != null || anc.a20 != null || anc.tt || (anc.s1 && Object.keys(anc.s1).length > 0));
  let best = null;
  if (hasA) {
    /* loss is smooth in S: three solves, a parabola through them, one solve at its minimum */
    const res = {};
    const tryS = (S) => {
      S = Math.round(S * 100) / 100;
      if (res[S] !== undefined || S < 0.48 || S > 0.80) return;
      const c = solveAtS(L, hur, S);
      res[S] = c ? (c.loss = anchorLoss(c, hur, anc, S0)) : null;
      if (c && (!best || c.loss < best.loss)) best = c;
    };
    /* a fit from an earlier refresh of the same match: the serve level barely moves, so one solve is enough */
    if (hint != null) {
      tryS(hint);
      if (best && Math.abs(best.errM) < 0.01) { best.anchored = true; return best; }
      best = null; for (const k in res) delete res[k];
    }
    /* grid centred on this tour's prior (the old fixed grid 0.62-0.74 never reached women's serve levels near 0.56) */
    const G = [S0 - 0.06, S0, S0 + 0.06].map((x) => Math.round(x * 100) / 100);
    G.forEach(tryS);
    const [x1, x2, x3] = G, y1 = res[x1], y2 = res[x2], y3 = res[x3];
    if (y1 != null && y2 != null && y3 != null && x1 < x2 && x2 < x3) {
      const curv = (y3 - y2) / (x3 - x2) - (y2 - y1) / (x2 - x1);
      if (curv > 1e-9) {
        const v = x2 - 0.5 * ((x2 - x1) * (x2 - x1) * (y2 - y3) - (x2 - x3) * (x2 - x3) * (y2 - y1)) / ((x2 - x1) * (y2 - y3) - (x2 - x3) * (y2 - y1));
        tryS(clamp(v, S0 - 0.12, S0 + 0.12));
      } else if (best) { tryS(best.S - 0.03); tryS(best.S + 0.03); }
    } else if (best) { tryS(best.S - 0.03); tryS(best.S + 0.03); }
    if (best) best.anchored = true;
  } else {
    for (const S of [hint != null ? hint : S0, S0, S0 - 0.03, S0 + 0.03, S0 - 0.06, S0 + 0.06, S0 - 0.09, S0 + 0.09, S0 - 0.12, S0 + 0.12]) {
      if (S < 0.45 || S > 0.76) continue;
      const c = solveAtS(L, hur, S);
      if (!c) continue;
      if (!best || Math.abs(c.errT) < Math.abs(best.errT)) best = c;
      if (Math.abs(best.errT) < 0.012) break;
    }
    if (best) {
      best.anchored = false;
      best.lo = solveAtS(L, hur, best.S - CFG.S_ROBUST);
      best.hi = solveAtS(L, hur, best.S + CFG.S_ROBUST);
    }
  }
  return best && Math.abs(best.errM) < 0.01 ? best : null;
}

/* ---------------------------- READING THE FEED ---------------------------- */
const clean = (s) => String(s || "").replace(/\s*\(games\)\s*$/i, "").trim();
const isGamesEv = (ev) => /\(games\)/i.test(String(ev.home));

/* power-method devig: fair chance of side x (removes the margin without overstating longshots) */
function devig2(x, y) {
  const a = 1 / x, b = 1 / y;
  let lo = 0.5, hi = 3;
  for (let n = 0; n < 40; n++) { const k = (lo + hi) / 2; if (Math.pow(a, k) + Math.pow(b, k) > 1) lo = k; else hi = k; }
  return Math.pow(a, (lo + hi) / 2);
}

const SLAM = /(australian open|roland[- ]garros|french open|wimbledon|us open)/i;
function categoryOf(lg) {
  const n = String(lg || "").replace(ROUND_RE, "");
  if (/doubles|mixed/i.test(n)) return "";
  if (/^ATP Challenger/i.test(n)) return "Challenger";
  if (/^ATP\s/i.test(n)) return ATP_1000.test(n) ? "ATP 1000" : (SLAM.test(n) ? "" : "Tour");   /* men's Slams are best of five: not supported yet */
  if (/^WTA\s/i.test(n) && !/125/.test(n)) return WTA_1000.test(n) ? "WTA 1000" : "Tour";
  return "";
}

function lis(pts) {
  const n = pts.length, len = Array(n).fill(1), prev = Array(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (pts[j].y < pts[i].y && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let k = len.indexOf(Math.max.apply(null, len)); const out = [];
  while (k >= 0) { out.unshift(pts[k]); k = prev[k]; }
  return out;
}
function crossing(pts) {
  if (pts.length < 2) return null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.y <= 0.5 && b.y >= 0.5) return a.x + (0.5 - a.y) * (b.x - a.x) / (b.y - a.y);
  }
  const [a, b] = pts[0].y > 0.5 ? [pts[0], pts[1]] : [pts[pts.length - 2], pts[pts.length - 1]];
  return clamp(a.x + (0.5 - a.y) * (b.x - a.x) / (b.y - a.y), pts[0].x - 1.5, pts[pts.length - 1].x + 1.5);
}
const isHalf = (v) => Math.abs(Math.abs(v) % 1 - 0.5) < 1e-9;
const isSetLine = (v) => Math.abs(Math.abs(v) - 1.5) < 1e-9;

/* GAME ladders. On a plain event the +-1.5 spreads and the 2.5 total are SET lines, so they are excluded here.
   On a "(Games)" event every line is a game line. */
function ladders(p0, isGames) {
  const sp = Object.values((p0 && p0.spreads) || {}).filter((l) => l && +l.home > 1 && +l.away > 1 && (isGames || !isSetLine(+l.hdp)))
    .map((l) => ({ x: +l.hdp, y: devig2(+l.home, +l.away), a: +l.home, b: +l.away }));
  const tt = Object.values((p0 && p0.totals) || {}).filter((l) => l && +l.points >= 10 && +l.over > 1 && +l.under > 1)
    .map((l) => ({ x: +l.points, y: 1 - devig2(+l.over, +l.under), a: +l.over, b: +l.under }));
  const prep = (arr) => {
    let a = arr.slice();
    const halves = a.filter((p) => isHalf(p.x));
    if (halves.length >= 2) a = halves;
    a.sort((p, q) => p.x - q.x);
    return lis(a);
  };
  const ps = prep(sp), pt = prep(tt);
  const s = crossing(ps), t = crossing(pt);
  if (s == null || t == null) return null;
  const near = (a) => { const h = a.filter((p) => isHalf(p.x)), pool = h.length ? h : a; return pool.reduce((b, p) => (Math.abs(p.y - 0.5) < Math.abs(b.y - 0.5) ? p : b)); };
  const ns = near(ps), nt = near(pt);
  return { hdp: s, total: t, hLine: ns.x, cover: ns.y, tLine: nt.x, pOver: 1 - nt.y, hPts: ps, tPts: pt, nSp: sp.length, nTt: tt.length };
}

/* SET lines from a plain event: +-1.5 set handicap and the 2.5 sets total. p3 = chance of a third set. */
function setInfo(p0) {
  const out = { p3: null, h20: null, a20: null };
  if (!p0) return out;
  let h20 = null, a20 = null, p3a = null;
  Object.values(p0.spreads || {}).forEach((l) => {
    if (!l || !(+l.home > 1) || !(+l.away > 1)) return;
    if (+l.hdp === -1.5) h20 = devig2(+l.home, +l.away);          // home -1.5 sets = home wins 2-0
    if (+l.hdp === 1.5) a20 = devig2(+l.away, +l.home);           // home +1.5 fails only if away wins 2-0
  });
  Object.values(p0.totals || {}).forEach((l) => { if (l && +l.points === 2.5 && +l.over > 1 && +l.under > 1) p3a = devig2(+l.over, +l.under); });
  const p3b = h20 != null && a20 != null ? 1 - h20 - a20 : null;
  const est = [p3a, p3b].filter((v) => v != null && v > 0.02 && v < 0.98);
  out.p3 = est.length ? est.reduce((a, b) => a + b, 0) / est.length : null;
  out.h20 = h20; out.a20 = a20;
  return out;
}

/* first-set total lines: { 10.5: chance of over, 12.5: ... }. "Over 12.5" in one set is a tie-break. */
function set1Info(p1) {
  const out = {};
  Object.values((p1 && p1.totals) || {}).forEach((l) => {
    const pt = l && +l.points;
    if (l && +l.over > 1 && +l.under > 1 && isHalf(pt) && pt >= 8.5 && pt <= 12.5) out[pt] = devig2(+l.over, +l.under);
  });
  return out;
}

/* ---------------------------- BUILD ---------------------------- */
const R1 = (x) => Math.round(x * 10) / 10, R2 = (x) => Math.round(x * 100) / 100;
const SOLVED = new Map();
const HINT = new Map();

/* Candidate picks from the fitted match distribution (chance between 50% and 97% only):
   - Handicap: protection only (a player gets +k games), never the spread
   - Total: over / under with lines within the expected total +- TOTAL_WINDOW
   Winner + total uses the model's total-given-winner scaled to the market's winner chance. */
function optionsFor(r, ctx) {
  const out = [], H = ctx.H, A = ctx.A, pW = ctx.pW;
  const eH = pW >= CFG.ELIGIBLE, eA = 1 - pW >= CFG.ELIGIBLE;
  /* only lines a bookmaker would plausibly list: near the range the ladder actually covers */
  const okH = (k) => !ctx.hr || (k >= ctx.hr[0] - CFG.H_EXT && k <= ctx.hr[1] + CFG.H_EXT);
  const okT = (L) => !ctx.tr || (L >= ctx.tr[0] - CFG.T_EXT && L <= ctx.tr[1] + CFG.T_EXT);
  const add = (mk, l, p, extra) => { if (ctx.raw || (p >= 0.5 && p <= 0.97)) out.push(Object.assign({ mk, l, p }, extra || {})); };
  const lab = (n, v) => n + " " + (v > 0 ? "+" : "") + v + " games";
  /* game handicap: every half-line from -kmax to +kmax, but only for a player with a real chance of winning */
  for (let k = -ctx.kmax; k <= ctx.kmax + 1e-9; k += 1) {
    let h = 0, a = 0;
    for (let m = -40; m <= 40; m++) { const w = r.md[m + 40]; if (m + k > 0) h += w; if (-m + k > 0) a += w; }
    if (eH && okH(k)) add("Handicap", lab(H, k), h);
    if (eA && okH(-k)) add("Handicap", lab(A, k), a);
  }
  const med = r.medTotal != null ? r.medTotal : 22;
  const pA = Math.max(r.pA, 1e-6), pB = Math.max(1 - r.pA, 1e-6);
  const overOf = (arr, L) => { let s = 0; for (let g = 0; g < arr.length; g++) if (g > L) s += arr[g]; return s; };
  const gB = r.gd.map((v, g) => v - r.ja[g]);
  for (let k = Math.round(med) - 7; k <= Math.round(med) + 7; k++) {
    const L = k + 0.5;
    if ((!ctx.raw && Math.abs(L - med) > CFG.TOTAL_WINDOW) || !okT(L)) continue;
    const ov = overOf(r.gd, L);
    add("Total", "Over " + L + " games", ov, { L, cush: med - L });
    add("Total", "Under " + L + " games", 1 - ov, { L, cush: L - med });
  }
  /* first-set and second-set total games. A set is 6 to 13 games, so the useful lines are 8.5 to 12.5.
     The first set is anchored when the feed posts first-set totals; the second set never has a posted line. */
  const mean = (a) => a.reduce((s, p, g) => s + p * g, 0);
  const m1 = mean(r.s1g), m2 = mean(r.s2g);
  for (const L of [8.5, 9.5, 10.5, 11.5, 12.5]) {
    const o1 = overG(r.s1g, L), o2 = overG(r.s2g, L);
    const e1 = ctx.s1Anchored ? undefined : { mod: 1 };
    add("Set1Total", "1st set Over " + L + " games", o1, Object.assign({ cush: m1 - L }, e1));
    add("Set1Total", "1st set Under " + L + " games", 1 - o1, Object.assign({ cush: L - m1 }, e1));
    add("Set2Total", "2nd set Over " + L + " games", o2, { cush: m2 - L, mod: 1 });
    add("Set2Total", "2nd set Under " + L + " games", 1 - o2, { cush: L - m2, mod: 1 });
  }
  /* each player's own total games ("Rune over 12.5 games") */
  [[H, r.hg, 0], [A, r.ag, 1]].forEach(([nm, arr, k]) => {
    const mu = mean(arr), rg = ctx.ttr && ctx.ttr[k];
    for (let q = Math.round(mu) - 5; q <= Math.round(mu) + 5; q++) {
      const L = q + 0.5;
      if (L < 4.5 || L > 20.5) continue;
      if (!ctx.raw && Math.abs(L - mu) > 3.5) continue;
      if (rg && !ctx.raw && (L < rg[0] - 2 || L > rg[1] + 2)) continue;
      const ov = overT(arr, L), x = rg ? undefined : { mod: 1 };
      add("PlayerTotal", nm + " Over " + L + " games", ov, Object.assign({ cush: mu - L }, x));
      add("PlayerTotal", nm + " Under " + L + " games", 1 - ov, Object.assign({ cush: L - mu }, x));
    }
  });
  /* set handicap +-1.5 sets. With a posted set line the fit is anchored and both kinds are offered.
     Without one the three-set chance is derived, and the engine runs low on three-setters (real ATP: 30% modelled
     vs 36% actual), which overstates 2-0 wins. So only the protection side (+1.5 sets, "not beaten 2-0") is offered,
     where that bias works in the bettor's favour; "-1.5 sets" needs a posted set line. */
  {
    const mod = ctx.setsAnchored ? undefined : { mod: 1 };
    if (eH) { if (ctx.setsAnchored) add("Set", H + " -1.5 sets", r.A20); add("Set", H + " +1.5 sets", 1 - r.B20, mod); }
    if (eA) { if (ctx.setsAnchored) add("Set", A + " -1.5 sets", r.B20); add("Set", A + " +1.5 sets", 1 - r.A20, mod); }
  }
  return out;
}

/* ---------------- team totals, set-split and rating helpers ---------------- */

/* chance a games count is over L. Integer lines have a push, which the bookmaker refunds, so it is left out. */
function overT(arr, L) {
  let o = 0, u = 0;
  for (let g = 0; g < arr.length; g++) { if (g > L) o += arr[g]; else if (g < L) u += arr[g]; }
  return Number.isInteger(L) ? o / Math.max(o + u, 1e-9) : o;
}
/* each player's own games line ("Rune over 12.5 games"). Home and away are the event's own home and away. */
function teamInfo(p0) {
  const out = { h: {}, a: {} };
  if (!p0) return out;
  const tt = p0.team_totals || {};
  [["h", "home"], ["a", "away"]].forEach(([k, side]) => {
    const rows = Object.values(tt[side] || {});
    if (!rows.length && p0.team_total && p0.team_total[side]) rows.push(p0.team_total[side]);
    rows.forEach((l) => { if (l && +l.over > 1 && +l.under > 1 && +l.points >= 5 && +l.points <= 18) out[k][+l.points] = devig2(+l.over, +l.under); });
  });
  return out;
}
function ttGaps(r, tt) {
  const g = [];
  [["h", r.hg], ["a", r.ag]].forEach(([k, arr]) => { for (const L in tt[k]) g.push(overT(arr, +L) - tt[k][L]); });
  return g;
}
const ttSq = (r, tt) => ttGaps(r, tt).reduce((s, x) => s + x * x, 0);
const ttMean = (r, tt) => { const g = ttGaps(r, tt); return g.length ? g.reduce((s, x) => s + Math.abs(x), 0) / g.length : 0; };

/* ----- market-implied ratings: what Pinnacle's own prices say about each player, accumulated over many matches -----
   serve points won  = tour level + tournament + player serve - opponent return      (ridge, so thin samples shrink to average)
   win chance (logit) = player skill - opponent skill                                   (ridge) */
function fitRatings(rows) {
  const obs = [], games = [], O = () => Object.create(null);
  rows.forEach((s) => {
    if (!(s.sA > 0.3 && s.sA < 0.9 && s.sB > 0.3 && s.sB < 0.9)) return;
    obs.push({ sv: s.home, rt: s.away, t: s.tourn, y: s.sA }, { sv: s.away, rt: s.home, t: s.tourn, y: s.sB });
    if (s.pH > 0.01 && s.pH < 0.99) games.push({ h: s.home, a: s.away, z: Math.log(s.pH / (1 - s.pH)) });
  });
  if (obs.length < 20) return null;
  const g = obs.reduce((a, o) => a + o.y, 0) / obs.length;
  const A = O(), Rr = O(), T = O(), nS = O(), nR = O(), nT = O();
  obs.forEach((o) => { A[o.sv] = 0; Rr[o.rt] = 0; T[o.t] = 0; nS[o.sv] = (nS[o.sv] || 0) + 1; nR[o.rt] = (nR[o.rt] || 0) + 1; nT[o.t] = (nT[o.t] || 0) + 1; });
  const LAM = 6, LT = 8;
  for (let it = 0; it < 40; it++) {
    let s = O();
    obs.forEach((o) => { s[o.t] = (s[o.t] || 0) + (o.y - g - A[o.sv] + Rr[o.rt]); });
    for (const t in T) T[t] = s[t] / (nT[t] + LT);
    s = O(); obs.forEach((o) => { s[o.sv] = (s[o.sv] || 0) + (o.y - g - T[o.t] + Rr[o.rt]); });
    for (const p in A) A[p] = s[p] / (nS[p] + LAM);
    s = O(); obs.forEach((o) => { s[o.rt] = (s[o.rt] || 0) + (g + T[o.t] + A[o.sv] - o.y); });
    for (const p in Rr) Rr[p] = s[p] / (nR[p] + LAM);
  }
  const K = O(), nK = O();
  games.forEach((m) => { K[m.h] = 0; K[m.a] = 0; nK[m.h] = (nK[m.h] || 0) + 1; nK[m.a] = (nK[m.a] || 0) + 1; });
  for (let it = 0; it < 40; it++) {
    const s = O();
    games.forEach((m) => { s[m.h] = (s[m.h] || 0) + m.z + K[m.a]; s[m.a] = (s[m.a] || 0) - m.z + K[m.h]; });
    for (const p in K) K[p] = s[p] / (nK[p] + 3);
  }
  let se = 0; obs.forEach((o) => { const e = o.y - (g + T[o.t] + A[o.sv] - Rr[o.rt]); se += e * e; });
  const names = new Set(Object.keys(A).concat(Object.keys(Rr), Object.keys(K))), players = {};
  names.forEach((p) => { players[p] = { serve: R4(A[p] || 0), ret: R4(Rr[p] || 0), skill: R4(K[p] || 0), n: nS[p] || nR[p] || 0 }; });
  const tourn = {}; for (const t in T) tourn[t] = R4(T[t]);
  return { g: R4(g), tourn, players, matches: obs.length / 2, rmse: R4(Math.sqrt(se / obs.length)) };
}
const R4 = (x) => Math.round(x * 10000) / 10000;

/* what the ratings alone would have predicted for a pairing (informational: it never removes a match) */
function ratingCheck(R, tourn, home, away) {
  const a = R && R.players[home], b = R && R.players[away];
  if (!a || !b || a.n < 4 || b.n < 4) return null;
  const T = R.tourn[tourn] != null ? R.tourn[tourn] : 0;
  return { sA: R.g + T + a.serve - b.ret, sB: R.g + T + b.serve - a.ret, pH: 1 / (1 + Math.exp(-(a.skill - b.skill))), n: Math.min(a.n, b.n) };
}

/* ---------------------------- BUILD ---------------------------- */
function build(events, nowMs, generatedAt, ratings, budgetMs) {
  budgetMs = budgetMs || CFG.BUDGET_MS;
  const skipped = {}, bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  const started = Date.now();
  if (SOLVED.size > 400) SOLVED.clear();

  const mlIdx = {};
  events.forEach((ev) => {
    const ml = ev.periods && ev.periods.num_0 && ev.periods.num_0.money_line;
    if (!ml || !(+ml.home > 1) || !(+ml.away > 1)) return;
    const h = clean(ev.home), a = clean(ev.away);
    mlIdx[h + "|" + a] = [+ml.home, +ml.away];
    mlIdx[a + "|" + h] = [+ml.away, +ml.home];
  });

  /* group the plain and "(Games)" copies of the same match */
  const groups = new Map();
  events.forEach((ev) => {
    const cat = categoryOf(ev.league_name);
    if (!cat) { bump("not tour or Challenger singles"); return; }
    if (/\//.test(String(ev.home) + String(ev.away))) { bump("doubles"); return; }
    const st = Date.parse(ev.starts || ev.start_ts);
    if (!(st > nowMs) || st > nowMs + CFG.LOOKAHEAD_H * 3600e3) { bump("not starting soon"); return; }
    const key = [clean(ev.home), clean(ev.away)].sort().join("|");
    let g = groups.get(key);
    if (!g) {
      g = { cat, st, plain: null, games: null, prior: cat === "Tour" ? (/^WTA/i.test(ev.league_name) ? TOUR_S.WTA : TOUR_S.ATP) : TOUR_S[cat] };
      groups.set(key, g);
    }
    if (isGamesEv(ev)) g.games = g.games || ev; else g.plain = g.plain || ev;
  });

  const cands = [];
  groups.forEach((g) => {
    const base = g.plain || g.games, home = clean(base.home), away = clean(base.away);
    const same = (e) => (e && clean(e.home) === home ? e : null);
    const gm = same(g.games), pl = same(g.plain);
    let lad = null;
    if (gm && gm.periods && gm.periods.num_0) lad = ladders(gm.periods.num_0, true);
    if (!lad && pl && pl.periods && pl.periods.num_0) lad = ladders(pl.periods.num_0, false);
    if (!lad) { bump("not enough spread/total lines"); return; }
    const info = setInfo(pl && pl.periods && pl.periods.num_0);
    const a = set1Info(gm && gm.periods && gm.periods.num_1), b = set1Info(pl && pl.periods && pl.periods.num_1);
    info.s1 = Object.keys(a).length >= Object.keys(b).length ? a : b;
    const tg = teamInfo(gm && gm.periods && gm.periods.num_0), tp = teamInfo(pl && pl.periods && pl.periods.num_0);
    info.tt = { h: Object.assign({}, tp.h, tg.h), a: Object.assign({}, tp.a, tg.a) };
    /* depth gate: a real ladder to fit, and Challengers (thin books) must also have set or first-set lines */
    const need = g.cat === "Challenger" ? 4 : 3;
    if (lad.nSp < need || lad.nTt < need) { bump("ladder too thin"); return; }
    if (g.cat === "Challenger" && !Object.keys(info.s1).length && info.p3 == null) { bump("Challenger without set or first-set lines"); return; }
    cands.push({ ev: base, cat: g.cat, st: g.st, prior: g.prior, home, away, lad, info });
  });
  /* tour matches first, Challengers last, then by start time */
  cands.sort((a, b) => ((a.cat === "Challenger") - (b.cat === "Challenger")) || a.st - b.st);

  const matches = [], snaps = [], used = [];
  let pending = 0, newSolved = 0;
  cands.slice(0, CFG.MAX_MATCHES).forEach((c) => {
    if (Date.now() - started > budgetMs) { pending++; return; }
    const L = c.lad, anc = {};
    const real = mlIdx[c.home + "|" + c.away] || null;
    const mlProb = real ? devig2(real[0], real[1]) : null;
    if (real) anc.ml = mlProb;
    if (Object.keys(c.info.s1).length) anc.s1 = c.info.s1;
    if (c.info.p3 != null) anc.p3 = c.info.p3;
    if (c.info.h20 != null) anc.h20 = c.info.h20;
    if (c.info.a20 != null) anc.a20 = c.info.a20;
    if (Object.keys(c.info.tt.h).length || Object.keys(c.info.tt.a).length) anc.tt = c.info.tt;
    const sig = c.ev.event_id + "|" + L.hLine + "|" + L.cover.toFixed(4) + "|" + L.tLine + "|" + L.pOver.toFixed(4) + "|" +
      JSON.stringify(anc, (k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v));
    let sol = SOLVED.get(sig);
    if (!sol) { sol = solveMarket(L, c.prior, anc, HINT.get(String(c.ev.event_id))); if (sol) { SOLVED.set(sig, sol); HINT.set(String(c.ev.event_id), sol.S); newSolved++; } }
    if (sol) used.push([sig, sol]);
    if (!sol) { bump("model did not fit the lines"); return; }
    const hur = { m: -L.hLine, t: L.tLine };
    const r = mix(sol.sA, sol.sB, sol.tau, hur);
    r.medTotal = medianTotal(r.gd);
    const pA = clamp(r.pA, 0.005, 0.995);
    const margin = -L.hdp, total = L.total;

    /* ---- TRUST GATE 1: the fit must reproduce both game lines closely ---- */
    const medT = r.medTotal, medS = medianMargin(r.md);
    const fitOK = Math.abs(sol.errT) <= (sol.anchored ? CFG.MAX_ERR_T_ANCHORED : CFG.MAX_ERR_T) && Math.abs(sol.errM) < CFG.MAX_ERR_M &&
      medT != null && Math.abs(medT - total) <= CFG.MAX_LINE_DRIFT &&
      medS != null && Math.abs(medS - margin) <= CFG.MAX_LINE_DRIFT;
    if (!fitOK) { bump("fit not tight"); return; }

    /* ---- TRUST GATE 2: the anchors (set split, 2-0 chances, first-set totals, each player's own games) must agree ---- */
    const p3m = r.A21 + r.B21;
    if (anc.p3 != null && Math.abs(p3m - anc.p3) > CFG.MAX_P3_GAP) { bump("set split disagrees"); return; }
    if ((anc.h20 != null && Math.abs(r.A20 - anc.h20) > CFG.MAX_P3_GAP) || (anc.a20 != null && Math.abs(r.B20 - anc.a20) > CFG.MAX_P3_GAP)) { bump("2-0 chances disagree"); return; }
    const g1 = set1Dist(sol.sA, sol.sB, sol.tau);
    if (anc.s1) for (const k in anc.s1) if (Math.abs(overG(g1, +k) - anc.s1[k]) > CFG.MAX_S1_GAP) { bump("first-set lines disagree"); return; }
    const ttm = anc.tt ? ttMean(r, anc.tt) : null;
    if (ttm != null && ttm > CFG.MAX_TT_GAP) { bump("player game totals disagree"); return; }

    /* ---- TRUST GATE 3: the model must agree with Pinnacle's moneyline when there is one ---- */
    if (real && Math.abs(pA - mlProb) > CFG.MAX_GAP) { bump("model vs moneyline disagree"); return; }

    const status = real ? "LEAN" : "MODEL";
    const pW = real ? mlProb : pA, pL = 1 - pW;
    const est = [Math.max(1.01, 1 / (pW * (1 + CFG.MARGIN))), Math.max(1.01, 1 / (pL * (1 + CFG.MARGIN)))];
    const o = (real || est).map(R2);
    const pickem = o.every((x) => x >= CFG.PICKEM[0] && x <= CFG.PICKEM[1]);
    const side = pW >= 0.5 ? 0 : 1, fav = side;
    const name = side ? c.away : c.home, pp = side ? pL : pW, favName = fav ? c.away : c.home;
    const parts = [anc.s1 ? "first-set lines" : "", (anc.p3 != null || anc.h20 != null || anc.a20 != null) ? "set split" : "", anc.tt ? "player game totals" : ""].filter(Boolean);
    const anchor = sol.anchored ? parts.join(" + ")
      : "assumed (checked at serve level " + (sol.S - CFG.S_ROBUST).toFixed(2) + " and " + (sol.S + CFG.S_ROBUST).toFixed(2) + ")";
    let reason = "Lines imply " + c.home + " " + (margin >= 0 ? "-" : "+") + Math.abs(margin).toFixed(1) +
      " games over " + total.toFixed(1) + " total. " + favName + " favoured at " + R1(Math.max(pW, pL) * 100) + "%. Serve level anchored by: " + anchor + ".";
    reason += real ? " Winner chance is the Pinnacle moneyline with the margin removed; the model agrees within " + Math.round(Math.abs(pA - mlProb) * 100) + " points."
                   : " No moneyline posted, so the winner is model-only and left out of the markets list.";

    /* ---- every candidate pick; the page chooses among them with the odds slider.
           When S could not be anchored, each chance is the lowest across three serve levels,
           and if either alternative fit fails, no tail pick is offered at all. ---- */
    const kmax = Math.min(CFG.HMAX_CAP, Math.floor(Math.abs(margin) + 4) + 0.5);
    const xs = (a) => a.map((q) => q.x);
    const ctx = { H: c.home, A: c.away, pW, kmax,
      s1Anchored: !!anc.s1,
      ttr: [Object.keys(c.info.tt.h).map(Number), Object.keys(c.info.tt.a).map(Number)].map((a) => (a.length ? [Math.min.apply(null, a), Math.max.apply(null, a)] : null)),
      setsAnchored: anc.p3 != null || anc.h20 != null || anc.a20 != null,
      hr: L.hPts.length ? [Math.min.apply(null, xs(L.hPts)), Math.max.apply(null, xs(L.hPts))] : null,
      tr: L.tPts.length ? [Math.min.apply(null, xs(L.tPts)), Math.max.apply(null, xs(L.tPts))] : null };
    const base = optionsFor(r, ctx);
    const alts = []; let robust = true;
    if (!sol.anchored) {
      for (const x of [sol.lo, sol.hi]) {
        if (!x) { robust = false; break; }
        const rr = mix(x.sA, x.sB, x.tau, hur); rr.medTotal = medianTotal(rr.gd);
        alts.push(new Map(optionsFor(rr, Object.assign({}, ctx, { raw: true })).map((q) => [q.mk + "|" + q.l, q.p])));
      }
    }
    const bookOdds = (p) => Math.max(1.01, R2(1 / (p * (1 + CFG.BOOK_MARGIN))));
    const opts = [];
    if (robust) base.forEach((q) => {
      let p = q.p;
      for (const m of alts) { const v = m.get(q.mk + "|" + q.l); if (v == null) { p = 0; break; } if (v < p) p = v; }
      if (p < 0.5 || p > 0.97) return;
      const x = { mk: q.mk, l: q.l, p: R1(p * 100), o: bookOdds(p) };
      if (q.cush != null) x.cush = R1(q.cush);
      if (q.mod) x.mod = 1;                       /* model estimate: no set line was posted */
      opts.push(x);
    });
    else reason += " The serve level could not be anchored and the safety re-fit failed, so only the winner is offered.";
    const wopt = { mk: "Winner", l: name, p: R1(pp * 100), o: bookOdds(pp) };
    if (status !== "LEAN") wopt.mo = 1;            /* model-only winner: no moneyline confirms it */
    opts.push(wopt);
    opts.forEach((x, n) => { x.k = x.mk[0].toLowerCase() + n; });

    let pOverMkt = 0; for (let g = 0; g < r.gd.length; g++) if (g > L.tLine) pOverMkt += r.gd[g];
    const lg = String(c.ev.league_name), rd = (lg.match(ROUND_RE) || [])[1] || "", tourn = lg.replace(ROUND_RE, "").trim();
    const rc = ratingCheck(ratings, tourn, c.home, c.away);
    const model = {
      fair: [1 / pW, 1 / pL].map(R2), book: est.map(R2),
      total: R1(r.eT), medTotal: R1(medT), spread: R1(r.eM), medSpread: R1(medS),
      holds: [R1(hold(sol.sA) * 100), R1(hold(sol.sB) * 100)],
      mktTotal: R1(total), mktSpread: R1(margin), pOverMkt: R1(pOverMkt * 100), loose: false,
      fit: { errM: R2(sol.errM * 100), errT: R2(sol.errT * 100) },
      S: R2(sol.S), anchor, anchored: !!sol.anchored,
      three: R1(p3m * 100), threeMkt: anc.p3 == null ? null : R1(anc.p3 * 100),
      tb1: R1(g1[13] * 100), ttGap: ttm == null ? null : R1(ttm * 100),
      rate: rc ? { sA: R2(rc.sA), sB: R2(rc.sB), gap: R2(Math.max(Math.abs(rc.sA - sol.sA), Math.abs(rc.sB - sol.sB))), pH: R1(rc.pH * 100), n: rc.n } : null
    };
    const pick = { model, odds: o, prediction: status, market: name + " Match Winner", pickOdds: o[side], prob: R1(pp * 100),
      reason, cat: c.cat, pickem, src: real ? "Pinnacle moneyline" : "estimated from model", exp: R1(medT), opts };
    matches.push([c.home, c.away, new Date(c.st).toISOString(), [R1(pW * 100), R1(pL * 100)],
      lg.replace(ROUND_RE, "") + (rd ? " " + rd : "") + " · " + c.cat, pick, "e" + c.ev.event_id]);

    /* the stored record: what the market said at this moment (also the price to compare with the close later) */
    snaps.push({ id: String(c.ev.event_id), home: c.home, away: c.away, tourn, cat: c.cat, start: new Date(c.st).toISOString(),
      snap: { t: new Date(nowMs).toISOString(), sA: R4(sol.sA), sB: R4(sol.sB), tau: R4(sol.tau), S: R4(sol.S), anchored: !!sol.anchored,
        pH: R4(pW), ml: !!real, p3: R4(p3m), tb1: R4(g1[13]), eT: R1(r.eT), med: R1(medT),
        mkt: { hLine: L.hLine, cover: R4(L.cover), tLine: L.tLine, pOver: R4(L.pOver), p3: anc.p3 == null ? null : R4(anc.p3) } } });
  });

  return { matches, meta: { v: 5, generated_at: generatedAt || new Date(nowMs).toISOString(), scanned: events.length, kept: matches.length, total: cands.length, pending, skipped }, snaps, solved: used, newSolved };
}

/* ---------------------------- STORAGE (Netlify Blobs; every call is optional and can never break the page) ---------------------------- */
let blobs = null;
try { blobs = require("@netlify/blobs"); } catch (e) { blobs = null; }
function openStore(event) {
  try {
    if (!blobs) return null;
    if (event && blobs.connectLambda) blobs.connectLambda(event);
    return blobs.getStore("callit");
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function persistSnaps(store, snaps) {
  for (let i = 0; i < snaps.length; i += 12) {
    await Promise.all(snaps.slice(i, i + 12).map(async (s) => {
      const key = "fit/" + s.id;
      let rec = null;
      try { rec = await store.get(key, { type: "json" }); } catch (e) { rec = null; }
      if (!rec || !Array.isArray(rec.snaps)) rec = { id: s.id, home: s.home, away: s.away, tourn: s.tourn, cat: s.cat, start: s.start, snaps: [] };
      const last = rec.snaps[rec.snaps.length - 1];
      if (last && Date.parse(s.snap.t) - Date.parse(last.t) < 25 * 60e3) return;
      rec.snaps.push(s.snap);
      if (rec.snaps.length > 16) rec.snaps.splice(1, 1);        /* keep the first look and the latest ones */
      rec.start = s.start;
      await store.setJSON(key, rec);
    }));
  }
}

async function refreshRatings(store, deadline) {
  const listed = await store.list({ prefix: "fit/" });
  const keys = ((listed && listed.blobs) || []).map((b) => b.key).slice(0, 2000), rows = [];
  for (let i = 0; i < keys.length; i += 25) {
    if (Date.now() > deadline) return null;
    const recs = await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: "json" }).catch(() => null)));
    recs.forEach((rec) => {
      if (!rec || !rec.snaps || !rec.snaps.length) return;
      const st = Date.parse(rec.start);
      const pre = rec.snaps.filter((s) => Date.parse(s.t) <= st);         /* the last look before the start = the closing price */
      const s = (pre.length ? pre : rec.snaps)[(pre.length ? pre : rec.snaps).length - 1];
      rows.push({ home: rec.home, away: rec.away, tourn: rec.tourn, sA: s.sA, sB: s.sB, pH: s.pH });
    });
  }
  const R = fitRatings(rows);
  if (R) await store.setJSON("ratings/latest", { t: new Date().toISOString(), R });
  return R ? { t: new Date().toISOString(), R } : null;
}
let RCACHE = null;
async function loadRatings(store) {
  if (RCACHE && Date.now() - RCACHE.ts < 30 * 60e3) return RCACHE.rec;
  let rec = null;
  try { rec = store ? await store.get("ratings/latest", { type: "json" }) : null; } catch (e) { rec = null; }
  RCACHE = { ts: Date.now(), rec };
  return rec;
}

/* ---------------------------- HANDLER ---------------------------- */
let CACHE = null, FEED = null;
const LASTP = new Map();
const reply = (status, body, ok) => ({
  statusCode: status,
  headers: Object.assign({ "Content-Type": "application/json" }, ok
    ? { "Cache-Control": "public, max-age=300", "Netlify-CDN-Cache-Control": "public, s-maxage=1200, stale-while-revalidate=3600" }
    : { "Cache-Control": "no-store" }),
  body: JSON.stringify(body)
});

/* fits already solved are kept in storage, so a day with 150 matches finishes over a few quick refreshes instead of being cut off */
async function loadSolved(store) {
  if (!store || SOLVED.size) return;
  try {
    const rec = await store.get("solved/latest", { type: "json" });
    if (rec && Array.isArray(rec.items)) rec.items.forEach((kv) => { SOLVED.set(kv[0], kv[1]); HINT.set(String(kv[0]).split("|")[0], kv[1].S); });
  } catch (e) { /* optional */ }
}

exports.handler = async function (event) {
  const t0 = Date.now(), q = (event && event.queryStringParameters) || {};
  const store = openStore(event);

  /* /.netlify/functions/compute-odds?view=ratings  (add &refresh=1 to rebuild them now) */
  if (q.view === "ratings") {
    if (!store) return reply(503, { error: "Storage is not available (is @netlify/blobs installed?)" });
    try {
      let rec = q.refresh ? await refreshRatings(store, t0 + 8000) : await loadRatings(store);
      if (!rec) rec = await refreshRatings(store, t0 + 8000);
      if (!rec) return reply(200, { note: "Not enough stored matches yet (needs about 20)." });
      if (q.refresh) RCACHE = { ts: Date.now(), rec };
      const P = rec.R.players, top = Object.keys(P).filter((n) => P[n].n >= 4).sort((a, b) => P[b].skill - P[a].skill).slice(0, 25).map((n) => [n, P[n]]);
      return reply(200, { updated: rec.t, matches: rec.R.matches, rmse: rec.R.rmse, players: Object.keys(P).length, top }, false);
    } catch (e) { return reply(502, { error: String(e.message || e) }); }
  }

  const key = process.env.TENNIS_FEED_TOKEN || process.env.PINNWIRE_KEY;
  if (!key) return reply(500, { error: "No API key found: set TENNIS_FEED_TOKEN (or PINNWIRE_KEY) in the Netlify environment variables" });
  if (CACHE && Date.now() - CACHE.ts < CFG.CACHE_MS) return reply(200, CACHE.payload, true);
  try {
    /* the feed is fetched at most once per cache window, even while a long day is still being fitted */
    if (!FEED || Date.now() - FEED.ts > CFG.CACHE_MS) {
      const res = await fetch(CFG.URL, { headers: { "x-api-key": key, "User-Agent": "CallIt/1.0" }, signal: AbortSignal.timeout(8000) });
      if (res.status === 401) return reply(502, { error: "Pinnwire rejected the key (401). Check PINNWIRE_KEY." });
      if (res.status === 429) throw new Error("Pinnwire rate limit hit (retry in " + (res.headers.get("retry-after") || "a while") + "s)");
      if (!res.ok) throw new Error("Pinnwire HTTP " + res.status);
      FEED = { ts: Date.now(), data: await res.json() };
    }
    const data = FEED.data;
    await loadSolved(store);
    const rr = await loadRatings(store);
    const budget = Math.max(1500, Math.min(CFG.BUDGET_MS, 8000 - (Date.now() - t0)));
    const out = build(Array.isArray(data.events) ? data.events : [], Date.now(), data.generated_at, rr && rr.R, budget);
    const snaps = out.snaps, solved = out.solved, newSolved = out.newSolved;
    delete out.snaps; delete out.solved; delete out.newSolved;
    const unfinished = out.meta.pending > 0;
    if (!unfinished) CACHE = { ts: Date.now(), payload: out };      /* unfinished answers are never cached: the page asks again */
    if (store) {
      const fresh = snaps.filter((s) => Date.now() - (LASTP.get(s.id) || 0) > 25 * 60e3);
      if (LASTP.size > 3000) LASTP.clear();
      fresh.forEach((s) => LASTP.set(s.id, Date.now()));
      let left = 9000 - (Date.now() - t0);
      if (newSolved && left > 600) {
        await Promise.race([store.setJSON("solved/latest", { t: new Date().toISOString(), items: solved.slice(0, 600) }).catch(() => {}), sleep(Math.min(left - 300, 1500))]);
        left = 9000 - (Date.now() - t0);
      }
      if (fresh.length && left > 700) await Promise.race([persistSnaps(store, fresh).catch(() => {}), sleep(left - 400)]);
      const stale = !rr || Date.now() - Date.parse(rr.t) > 12 * 3600e3, left2 = 9000 - (Date.now() - t0);
      if (!unfinished && stale && left2 > 3000) { try { const f = await refreshRatings(store, Date.now() + left2 - 1200); if (f) RCACHE = { ts: Date.now(), rec: f }; } catch (e) { /* later */ } }
    }
    return reply(200, out, !unfinished);
  } catch (e) {
    if (CACHE) return reply(200, Object.assign({}, CACHE.payload, { stale: true, warning: String(e.message || e) }), false);
    return reply(502, { error: String(e.message || e) });
  }
};

exports._test = { medianTotal, mix, hold, tiebreak, setDist, matchStats, solveMarket, solveAtS, ladders, setInfo, set1Info, set1Dist, teamInfo, overT, build, categoryOf, fitRatings, ratingCheck, devig2, CFG };
