import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
const rows = fields[0].split("/");
for (let r = 0; r < 8; r++) {
  let file = 0;
  for (const c of rows[r]) {
    if (c >= "1" && c <= "8") file += Number(c);
    else board[(7 - r) * 8 + file++] = c;
  }
}

const state = {
  b: board,
  turn: fields[1],
  castle: fields[2] === "-" ? "" : fields[2],
  ep: fields[3] === "-" ? -1 : square(fields[3]),
  half: Number(fields[4]) || 0
};

function square(s) { return s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49); }
function name(s) { return String.fromCharCode(97 + (s & 7)) + String(1 + (s >> 3)); }
function white(p) { return p !== null && p >= "A" && p <= "Z"; }
function sameSide(p, side) { return p !== null && white(p) === (side === "w"); }
function enemy(p, side) { return p !== null && white(p) !== (side === "w"); }
function type(p) { return p.toLowerCase(); }

function attacked(s, target, by) {
  const b = s.b, tf = target & 7, tr = target >> 3;
  const pawn = by === "w" ? "P" : "p";
  const pawnRank = tr + (by === "w" ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    if (tf > 0 && b[pawnRank * 8 + tf - 1] === pawn) return true;
    if (tf < 7 && b[pawnRank * 8 + tf + 1] === pawn) return true;
  }
  const knight = by === "w" ? "N" : "n";
  const jumps = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  for (const [df, dr] of jumps) {
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === knight) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const f = tf + df, r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === king) return true;
  }
  const rays = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let d = 0; d < rays.length; d++) {
    const [df, dr] = rays[d];
    let f = tf + df, r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p) {
        if (white(p) === (by === "w")) {
          const q = type(p);
          if (q === "q" || (d < 4 ? q === "r" : q === "b")) return true;
        }
        break;
      }
      f += df; r += dr;
    }
  }
  return false;
}

function kingSquare(s, side) { return s.b.indexOf(side === "w" ? "K" : "k"); }
function inCheck(s, side = s.turn) {
  const k = kingSquare(s, side);
  return k >= 0 && attacked(s, k, side === "w" ? "b" : "w");
}

function apply(s, m) {
  const b = s.b.slice(), side = s.turn, piece = b[m.f], captured = b[m.t];
  b[m.f] = null;
  if (m.e) b[m.t + (side === "w" ? -8 : 8)] = null;
  b[m.t] = m.p ? (side === "w" ? m.p.toUpperCase() : m.p) : piece;
  if (m.c) {
    const rf = m.t > m.f ? m.f + 3 : m.f - 4;
    const rt = m.t > m.f ? m.f + 1 : m.f - 1;
    b[rt] = b[rf]; b[rf] = null;
  }
  let castle = s.castle;
  if (piece === "K") castle = castle.replace(/[KQ]/g, "");
  if (piece === "k") castle = castle.replace(/[kq]/g, "");
  const removeRookRight = x => {
    if (x === 0) castle = castle.replace("Q", "");
    if (x === 7) castle = castle.replace("K", "");
    if (x === 56) castle = castle.replace("q", "");
    if (x === 63) castle = castle.replace("k", "");
  };
  if (type(piece) === "r") removeRookRight(m.f);
  if (captured && type(captured) === "r") removeRookRight(m.t);
  const ep = type(piece) === "p" && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) >> 1 : -1;
  return { b, turn: side === "w" ? "b" : "w", castle, ep,
    half: type(piece) === "p" || captured || m.e ? 0 : s.half + 1 };
}

function pseudo(s) {
  const out = [], b = s.b, side = s.turn;
  const add = (f, t, p = null, e = false, c = false) => out.push({f,t,p,e,c});
  for (let f = 0; f < 64; f++) {
    const pc = b[f];
    if (!sameSide(pc, side)) continue;
    const q = type(pc), ff = f & 7, rr = f >> 3;
    if (q === "p") {
      const d = side === "w" ? 8 : -8, start = side === "w" ? 1 : 6;
      const last = side === "w" ? 7 : 0, one = f + d;
      if (one >= 0 && one < 64 && !b[one]) {
        if ((one >> 3) === last) for (const p of ["q","r","b","n"]) add(f, one, p);
        else {
          add(f, one);
          const two = f + 2 * d;
          if (rr === start && !b[two]) add(f, two);
        }
      }
      for (const df of [-1, 1]) {
        if (ff + df < 0 || ff + df > 7) continue;
        const t = f + d + df;
        if (t < 0 || t >= 64) continue;
        if (enemy(b[t], side)) {
          if ((t >> 3) === last) for (const p of ["q","r","b","n"]) add(f, t, p);
          else add(f, t);
        } else if (t === s.ep && !b[t]) {
          const victim = b[t + (side === "w" ? -8 : 8)];
          if (victim === (side === "w" ? "p" : "P")) add(f, t, null, true);
        }
      }
    } else if (q === "n") {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const x = ff + df, y = rr + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8 && !sameSide(b[y*8+x], side)) add(f, y*8+x);
      }
    } else if (q === "b" || q === "r" || q === "q") {
      const dirs = q === "b" ? [[1,1],[1,-1],[-1,1],[-1,-1]] : q === "r" ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [df, dr] of dirs) {
        let x = ff + df, y = rr + dr;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const t = y * 8 + x;
          if (!b[t]) add(f, t);
          else { if (enemy(b[t], side)) add(f, t); break; }
          x += df; y += dr;
        }
      }
    } else if (q === "k") {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const x = ff + df, y = rr + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8 && !sameSide(b[y*8+x], side)) add(f, y*8+x);
      }
      const foe = side === "w" ? "b" : "w";
      if (side === "w" && f === 4 && !attacked(s, 4, foe)) {
        if (s.castle.includes("K") && b[7] === "R" && !b[5] && !b[6] && !attacked(s,5,foe) && !attacked(s,6,foe)) add(4,6,null,false,true);
        if (s.castle.includes("Q") && b[0] === "R" && !b[1] && !b[2] && !b[3] && !attacked(s,3,foe) && !attacked(s,2,foe)) add(4,2,null,false,true);
      }
      if (side === "b" && f === 60 && !attacked(s, 60, foe)) {
        if (s.castle.includes("k") && b[63] === "r" && !b[61] && !b[62] && !attacked(s,61,foe) && !attacked(s,62,foe)) add(60,62,null,false,true);
        if (s.castle.includes("q") && b[56] === "r" && !b[57] && !b[58] && !b[59] && !attacked(s,59,foe) && !attacked(s,58,foe)) add(60,58,null,false,true);
      }
    }
  }
  return out;
}

function legal(s) {
  const side = s.turn, foe = side === "w" ? "b" : "w", result = [];
  for (const m of pseudo(s)) {
    const n = apply(s, m), k = kingSquare(n, side);
    if (k >= 0 && !attacked(n, k, foe)) result.push(m);
  }
  return result;
}

const value = {p:100,n:320,b:335,r:500,q:900,k:0};
function evaluate(s) {
  let score = 0, bishopsW = 0, bishopsB = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.b[i]; if (!p) continue;
    const sign = white(p) ? 1 : -1, q = type(p), f = i & 7, r = i >> 3;
    let bonus = 0;
    const center = 7 - (Math.abs(2*f-7) + Math.abs(2*r-7));
    if (q === "p") bonus = (white(p) ? r : 7-r) * 7 - Math.abs(2*f-7);
    else if (q === "n") bonus = center * 5;
    else if (q === "b") { bonus = center * 2; white(p) ? bishopsW++ : bishopsB++; }
    else if (q === "r") bonus = (white(p) ? r : 7-r) * 2;
    else if (q === "q") bonus = center;
    score += sign * (value[q] + bonus);
  }
  if (bishopsW >= 2) score += 25;
  if (bishopsB >= 2) score -= 25;
  return s.turn === "w" ? score : -score;
}

function moveScore(s, m, preferred) {
  if (preferred && m.f === preferred.f && m.t === preferred.t && m.p === preferred.p) return 100000;
  const victim = m.e ? "p" : s.b[m.t];
  let v = victim ? 10 * value[type(victim)] - value[type(s.b[m.f])] : 0;
  if (m.p) v += value[m.p] + 700;
  if (m.c) v += 60;
  return v;
}
function ordered(s, moves, preferred = null) {
  return moves.sort((a,b) => moveScore(s,b,preferred) - moveScore(s,a,preferred));
}

const started = Date.now(), limit = 850;
let nodes = 0;
const TIME = Symbol("time");
function checkTime() { if ((++nodes & 1023) === 0 && Date.now() - started >= limit) throw TIME; }
function qsearch(s, alpha, beta, ply, qdepth) {
  checkTime();
  const checked = inCheck(s), all = legal(s);
  if (!all.length) return checked ? -30000 + ply : 0;
  let stand = evaluate(s);
  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qdepth <= 0) return alpha;
  } else if (qdepth <= -3) return stand;
  const moves = checked ? all : all.filter(m => s.b[m.t] || m.e || m.p);
  for (const m of ordered(s, moves)) {
    const score = -qsearch(apply(s,m), -beta, -alpha, ply+1, qdepth-1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}
function negamax(s, depth, alpha, beta, ply) {
  checkTime();
  if (depth <= 0) return qsearch(s, alpha, beta, ply, 5);
  const moves = legal(s);
  if (!moves.length) return inCheck(s) ? -30000 + ply : 0;
  let best = -Infinity;
  for (const m of ordered(s, moves)) {
    const score = -negamax(apply(s,m), depth-1, -beta, -alpha, ply+1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

const rootMoves = legal(state);
let best = rootMoves[0] || null;
let previous = best;
for (let depth = 1; best && depth <= 8; depth++) {
  try {
    let iterationBest = null, iterationScore = -Infinity, alpha = -Infinity;
    for (const m of ordered(state, rootMoves.slice(), previous)) {
      const score = -negamax(apply(state,m), depth-1, -30001, -alpha, 1);
      if (score > iterationScore) { iterationScore = score; iterationBest = m; }
      if (score > alpha) alpha = score;
    }
    best = iterationBest;
    previous = best;
    if (Math.abs(iterationScore) > 29000) break;
  } catch (e) {
    if (e !== TIME) throw e;
    break;
  }
}
if (best) process.stdout.write(name(best.f) + name(best.t) + (best.p || "") + "\n");
else process.stdout.write("0000\n");
