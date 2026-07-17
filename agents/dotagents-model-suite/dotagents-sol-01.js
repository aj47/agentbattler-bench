import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
let rank = 7, file = 0;
for (const c of fields[0]) {
  if (c === '/') { rank--; file = 0; }
  else if (c >= '1' && c <= '8') file += Number(c);
  else board[rank * 8 + file++] = c;
}
const parseSquare = s => s === '-' ? -1 : s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const initial = { b: board, s: fields[1], cr: fields[2] === '-' ? '' : fields[2], ep: parseSquare(fields[3]) };
const enemy = s => s === 'w' ? 'b' : 'w';
const mine = (p, s) => p && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const sqName = q => String.fromCharCode(97 + q % 8) + String(1 + Math.floor(q / 8));

function attacked(st, sq, by) {
  const b = st.b, f = sq & 7, r = sq >> 3;
  if (by === 'w') {
    if (f > 0 && sq >= 9 && b[sq - 9] === 'P') return true;
    if (f < 7 && sq >= 7 && b[sq - 7] === 'P') return true;
  } else {
    if (f > 0 && sq <= 56 && b[sq + 7] === 'p') return true;
    if (f < 7 && sq <= 54 && b[sq + 9] === 'p') return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === knight) return true;
  }
  for (const [df, dr, kinds] of [[1,0,'rq'],[-1,0,'rq'],[0,1,'rq'],[0,-1,'rq'],[1,1,'bq'],[-1,1,'bq'],[1,-1,'bq'],[-1,-1,'bq']]) {
    let x = f + df, y = r + dr;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p) {
        if (mine(p, by) && kinds.includes(p.toLowerCase())) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) if (df || dr) {
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === king) return true;
  }
  return false;
}

function pseudo(st) {
  const out = [], b = st.b, s = st.s;
  const add = (f, t, pr = '', ep = false, ca = false) => {
    const target = b[t];
    if (!target || (!mine(target, s) && target.toLowerCase() !== 'k')) out.push({ f, t, pr, ep, ca });
  };
  for (let q = 0; q < 64; q++) {
    const p = b[q];
    if (!mine(p, s)) continue;
    const type = p.toLowerCase(), f = q & 7, r = q >> 3;
    if (type === 'p') {
      const d = s === 'w' ? 8 : -8, home = s === 'w' ? 1 : 6, last = s === 'w' ? 7 : 0;
      const one = q + d;
      if (one >= 0 && one < 64 && !b[one]) {
        if ((one >> 3) === last) for (const pr of ['q','r','b','n']) add(q, one, pr);
        else {
          add(q, one);
          const two = q + 2 * d;
          if (r === home && !b[two]) add(q, two);
        }
      }
      for (const df of [-1, 1]) {
        if (f + df < 0 || f + df > 7) continue;
        const t = q + d + df;
        if (t < 0 || t >= 64) continue;
        if (b[t] && !mine(b[t], s) && b[t].toLowerCase() !== 'k') {
          if ((t >> 3) === last) for (const pr of ['q','r','b','n']) add(q, t, pr);
          else add(q, t);
        } else if (t === st.ep) {
          const victim = b[t - d];
          if (victim && victim.toLowerCase() === 'p' && !mine(victim, s)) add(q, t, '', true);
        }
      }
    } else if (type === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const x = f + df, y = r + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8) add(q, y * 8 + x);
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = type === 'b' ? [[1,1],[-1,1],[1,-1],[-1,-1]] : type === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const t = y * 8 + x;
          if (b[t]) { add(q, t); break; }
          add(q, t); x += df; y += dr;
        }
      }
    } else if (type === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) if (df || dr) {
        const x = f + df, y = r + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8) add(q, y * 8 + x);
      }
      const foe = enemy(s);
      if (s === 'w' && q === 4 && p === 'K') {
        if (st.cr.includes('K') && b[7] === 'R' && !b[5] && !b[6] && !attacked(st,4,foe) && !attacked(st,5,foe) && !attacked(st,6,foe)) add(4,6,'',false,true);
        if (st.cr.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] && !attacked(st,4,foe) && !attacked(st,3,foe) && !attacked(st,2,foe)) add(4,2,'',false,true);
      } else if (s === 'b' && q === 60 && p === 'k') {
        if (st.cr.includes('k') && b[63] === 'r' && !b[61] && !b[62] && !attacked(st,60,foe) && !attacked(st,61,foe) && !attacked(st,62,foe)) add(60,62,'',false,true);
        if (st.cr.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] && !attacked(st,60,foe) && !attacked(st,59,foe) && !attacked(st,58,foe)) add(60,58,'',false,true);
      }
    }
  }
  return out;
}

function play(st, m) {
  const b = st.b.slice(), piece = b[m.f], side = st.s;
  b[m.f] = null;
  if (m.ep) b[m.t + (side === 'w' ? -8 : 8)] = null;
  b[m.t] = m.pr ? (side === 'w' ? m.pr.toUpperCase() : m.pr) : piece;
  if (m.ca) {
    if (m.t === 6) { b[5] = b[7]; b[7] = null; }
    else if (m.t === 2) { b[3] = b[0]; b[0] = null; }
    else if (m.t === 62) { b[61] = b[63]; b[63] = null; }
    else { b[59] = b[56]; b[56] = null; }
  }
  let cr = st.cr;
  if (piece === 'K') cr = cr.replace(/[KQ]/g, '');
  if (piece === 'k') cr = cr.replace(/[kq]/g, '');
  if (m.f === 0 || m.t === 0) cr = cr.replace('Q', '');
  if (m.f === 7 || m.t === 7) cr = cr.replace('K', '');
  if (m.f === 56 || m.t === 56) cr = cr.replace('q', '');
  if (m.f === 63 || m.t === 63) cr = cr.replace('k', '');
  const ep = piece.toLowerCase() === 'p' && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) >> 1 : -1;
  return { b, s: enemy(side), cr, ep };
}

function legal(st) {
  const side = st.s, foe = enemy(side), out = [];
  for (const m of pseudo(st)) {
    const n = play(st, m), king = n.b.indexOf(side === 'w' ? 'K' : 'k');
    if (king >= 0 && !attacked(n, king, foe)) out.push(m);
  }
  return out;
}

const values = { p:100, n:320, b:335, r:500, q:900, k:0 };
function evaluate(st) {
  let score = 0;
  for (let q = 0; q < 64; q++) {
    const p = st.b[q]; if (!p) continue;
    const white = p === p.toUpperCase(), t = p.toLowerCase(), f = q & 7, r = q >> 3;
    const rr = white ? r : 7-r, center = 7 - (Math.abs(f-3.5) + Math.abs(r-3.5));
    let bonus = 0;
    if (t === 'p') bonus = rr * 8 + (f > 1 && f < 6 ? 5 : 0);
    else if (t === 'n') bonus = center * 6;
    else if (t === 'b') bonus = center * 4;
    else if (t === 'r') bonus = rr * 2;
    else if (t === 'q') bonus = center;
    else bonus = rr < 2 ? -center * 2 : center * 2;
    score += (white ? 1 : -1) * (values[t] + bonus);
  }
  return st.s === 'w' ? score : -score;
}

const deadline = Date.now() + 650;
let nodes = 0;
const TIME = {};
const tt = new Map();
function checkTime() { if ((++nodes & 1023) === 0 && Date.now() >= deadline) throw TIME; }
function moveScore(st, m) {
  const victim = m.ep ? 'p' : st.b[m.t]?.toLowerCase();
  return (m.pr ? values[m.pr] + 800 : 0) + (victim ? 10 * values[victim] - values[st.b[m.f].toLowerCase()] : 0) + (m.ca ? 40 : 0);
}
function key(st) { return st.b.map(x => x || '.').join('') + st.s + st.cr + st.ep; }
function search(st, depth, alpha, beta, ply) {
  checkTime();
  const moves = legal(st);
  if (!moves.length) {
    const k = st.b.indexOf(st.s === 'w' ? 'K' : 'k');
    return attacked(st, k, enemy(st.s)) ? -100000 + ply : 0;
  }
  if (depth <= 0) return quiesce(st, alpha, beta, ply, moves);
  const k = key(st), old = tt.get(k);
  if (old && old.depth >= depth) {
    if (old.flag === 0) return old.value;
    if (old.flag < 0 && old.value <= alpha) return old.value;
    if (old.flag > 0 && old.value >= beta) return old.value;
  }
  const startAlpha = alpha;
  moves.sort((a,b) => (old && same(a,old.best) ? -1 : old && same(b,old.best) ? 1 : moveScore(st,b)-moveScore(st,a)));
  let best = moves[0], value = -Infinity;
  for (const m of moves) {
    const v = -search(play(st,m), depth-1, -beta, -alpha, ply+1);
    if (v > value) { value = v; best = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  tt.set(k, { depth, value, best, flag: value <= startAlpha ? -1 : value >= beta ? 1 : 0 });
  return value;
}
function quiesce(st, alpha, beta, ply, known) {
  checkTime();
  const king = st.b.indexOf(st.s === 'w' ? 'K' : 'k'), inCheck = attacked(st, king, enemy(st.s));
  let stand = evaluate(st);
  if (!inCheck) {
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
  }
  if (ply > 12) return inCheck ? alpha : stand;
  const moves = (known || legal(st)).filter(m => inCheck || m.ep || m.pr || st.b[m.t]);
  moves.sort((a,b) => moveScore(st,b)-moveScore(st,a));
  for (const m of moves) {
    const v = -quiesce(play(st,m), -beta, -alpha, ply+1);
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}
function same(a,b) { return a && b && a.f === b.f && a.t === b.t && a.pr === b.pr; }

const rootMoves = legal(initial);
let best = rootMoves[0];
if (best) {
  rootMoves.sort((a,b) => moveScore(initial,b)-moveScore(initial,a));
  best = rootMoves[0];
  try {
    for (let depth = 1; depth <= 6; depth++) {
      let iterationBest = best, alpha = -Infinity, top = -Infinity;
      const ordered = rootMoves.slice().sort((a,b) => same(a,best) ? -1 : same(b,best) ? 1 : moveScore(initial,b)-moveScore(initial,a));
      for (const m of ordered) {
        const v = -search(play(initial,m), depth-1, -Infinity, -alpha, 1);
        if (v > top) { top = v; iterationBest = m; }
        if (v > alpha) alpha = v;
      }
      best = iterationBest;
      if (Math.abs(top) > 99000 || Date.now() >= deadline) break;
    }
  } catch (e) { if (e !== TIME) throw e; }
  process.stdout.write(sqName(best.f) + sqName(best.t) + best.pr);
}
