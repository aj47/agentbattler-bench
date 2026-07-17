import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim();
const fields = fen.split(/\s+/);
const board = [];
for (const row of fields[0].split("/")) {
  for (const c of row) {
    if (c >= "1" && c <= "8") for (let i = 0; i < Number(c); i++) board.push(".");
    else board.push(c);
  }
}

const square = name => name === "-" ? -1 : (8 - Number(name[1])) * 8 + name.charCodeAt(0) - 97;
const state = {
  b: board,
  side: fields[1],
  rights: fields[2] === "-" ? "" : fields[2],
  ep: square(fields[3])
};

const color = p => p === "." ? "" : p === p.toUpperCase() ? "w" : "b";
const enemy = s => s === "w" ? "b" : "w";
const inside = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;

function attacked(s, at, by) {
  const b = s.b, r = at >> 3, f = at & 7;
  const pawn = by === "w" ? "P" : "p";
  const pr = r + (by === "w" ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f > 0 && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const knight = by === "w" ? "N" : "n";
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const nr = r + dr, nf = f + df;
    if (inside(nr, nf) && b[nr * 8 + nf] === knight) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if (!dr && !df) continue;
    const nr = r + dr, nf = f + df;
    if (inside(nr, nf) && b[nr * 8 + nf] === king) return true;
  }
  for (const [dr, df] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let nr = r + dr, nf = f + df;
    while (inside(nr, nf)) {
      const p = b[nr * 8 + nf];
      if (p !== ".") {
        if (color(p) === by) {
          const q = p.toLowerCase();
          if (q === "q" || (q === "r" && (dr === 0 || df === 0)) ||
              (q === "b" && dr !== 0 && df !== 0)) return true;
        }
        break;
      }
      nr += dr; nf += df;
    }
  }
  return false;
}

function checked(s, side = s.side) {
  const king = s.b.indexOf(side === "w" ? "K" : "k");
  return king >= 0 && attacked(s, king, enemy(side));
}

function moveKingTemporarily(s, from, to) {
  const b = s.b.slice();
  b[to] = b[from]; b[from] = ".";
  return { ...s, b };
}

function addPawnMove(out, from, to, side, extra = {}) {
  const rank = to >> 3;
  if (rank === 0 || rank === 7) {
    for (const p of ["q", "r", "b", "n"]) out.push({ f: from, t: to, p, ...extra });
  } else out.push({ f: from, t: to, ...extra });
}

function pseudoMoves(s) {
  const out = [], b = s.b, us = s.side, them = enemy(us);
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (color(piece) !== us) continue;
    const kind = piece.toLowerCase(), r = from >> 3, f = from & 7;
    if (kind === "p") {
      const dr = us === "w" ? -1 : 1, start = us === "w" ? 6 : 1;
      const nr = r + dr, one = nr * 8 + f;
      if (inside(nr, f) && b[one] === ".") {
        addPawnMove(out, from, one, us);
        const two = (r + 2 * dr) * 8 + f;
        if (r === start && b[two] === ".") out.push({ f: from, t: two });
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (!inside(nr, nf)) continue;
        const to = nr * 8 + nf;
        if (color(b[to]) === them) addPawnMove(out, from, to, us);
        else if (to === s.ep && b[to] === ".") {
          const captured = to + (us === "w" ? 8 : -8);
          if (b[captured] === (us === "w" ? "p" : "P")) addPawnMove(out, from, to, us, { ep: true });
        }
      }
    } else if (kind === "n") {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const nr = r + dr, nf = f + df;
        if (inside(nr, nf) && color(b[nr * 8 + nf]) !== us) out.push({ f: from, t: nr * 8 + nf });
      }
    } else if (kind === "b" || kind === "r" || kind === "q") {
      const dirs = kind === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]] :
        kind === "r" ? [[-1,0],[1,0],[0,-1],[0,1]] :
        [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) {
        let nr = r + dr, nf = f + df;
        while (inside(nr, nf)) {
          const to = nr * 8 + nf;
          if (color(b[to]) === us) break;
          out.push({ f: from, t: to });
          if (b[to] !== ".") break;
          nr += dr; nf += df;
        }
      }
    } else if (kind === "k") {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        const nr = r + dr, nf = f + df;
        if (inside(nr, nf) && color(b[nr * 8 + nf]) !== us) out.push({ f: from, t: nr * 8 + nf });
      }
      const home = us === "w" ? 60 : 4, rookK = us === "w" ? 63 : 7, rookQ = us === "w" ? 56 : 0;
      const rightK = us === "w" ? "K" : "k", rightQ = us === "w" ? "Q" : "q";
      const rook = us === "w" ? "R" : "r";
      if (from === home && !attacked(s, home, them)) {
        if (s.rights.includes(rightK) && b[rookK] === rook && b[home + 1] === "." && b[home + 2] === "." &&
            !attacked(moveKingTemporarily(s, home, home + 1), home + 1, them))
          out.push({ f: home, t: home + 2, castle: true });
        if (s.rights.includes(rightQ) && b[rookQ] === rook && b[home - 1] === "." && b[home - 2] === "." && b[home - 3] === "." &&
            !attacked(moveKingTemporarily(s, home, home - 1), home - 1, them))
          out.push({ f: home, t: home - 2, castle: true });
      }
    }
  }
  return out;
}

function without(rights, chars) {
  for (const c of chars) rights = rights.replace(c, "");
  return rights;
}

function play(s, m) {
  const b = s.b.slice(), us = s.side, piece = b[m.f];
  let rights = s.rights;
  b[m.f] = ".";
  if (m.ep) b[m.t + (us === "w" ? 8 : -8)] = ".";
  if (m.castle) {
    if (m.t > m.f) { b[m.f + 1] = b[m.f + 3]; b[m.f + 3] = "."; }
    else { b[m.f - 1] = b[m.f - 4]; b[m.f - 4] = "."; }
  }
  b[m.t] = m.p ? (us === "w" ? m.p.toUpperCase() : m.p) : piece;
  if (piece === "K") rights = without(rights, "KQ");
  if (piece === "k") rights = without(rights, "kq");
  if (m.f === 63 || m.t === 63) rights = without(rights, "K");
  if (m.f === 56 || m.t === 56) rights = without(rights, "Q");
  if (m.f === 7 || m.t === 7) rights = without(rights, "k");
  if (m.f === 0 || m.t === 0) rights = without(rights, "q");
  const ep = piece.toLowerCase() === "p" && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) >> 1 : -1;
  return { b, side: enemy(us), rights, ep };
}

function legalMoves(s) {
  const us = s.side, them = enemy(us), moves = [];
  for (const m of pseudoMoves(s)) {
    const n = play(s, m), king = n.b.indexOf(us === "w" ? "K" : "k");
    if (king >= 0 && !attacked(n, king, them)) moves.push(m);
  }
  return moves;
}

const values = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.b[i];
    if (p === ".") continue;
    const white = color(p) === "w", kind = p.toLowerCase(), r = i >> 3, f = i & 7;
    let v = values[kind], center = 7 - Math.abs(7 - 2 * f) - Math.abs(7 - 2 * r);
    if (kind === "p") v += (white ? 6 - r : r - 1) * 9 + Math.max(0, center) * 2;
    else if (kind === "n") v += center * 5;
    else if (kind === "b") v += center * 3;
    else if (kind === "r") v += (white ? 7 - r : r) * 2;
    else if (kind === "q") v += center;
    score += white ? v : -v;
  }
  return s.side === "w" ? score : -score;
}

function moveKey(m) { return m.f + ":" + m.t + (m.p || ""); }
function tactical(s, m) { return m.ep || s.b[m.t] !== "." || Boolean(m.p); }
const killers = Array.from({ length: 32 }, () => []), history = new Map();
function order(s, moves, preferred, ply) {
  for (const m of moves) {
    let n = moveKey(m), score = n === preferred ? 10000000 : 0;
    const victim = m.ep ? "p" : s.b[m.t].toLowerCase();
    if (victim && victim !== ".") score += 100000 + 10 * values[victim] - values[s.b[m.f].toLowerCase()];
    if (m.p) score += 90000 + values[m.p];
    if (m.castle) score += 1000;
    if (killers[ply]?.includes(n)) score += 50000;
    score += history.get(n) || 0;
    m._score = score;
  }
  moves.sort((a, b) => b._score - a._score);
  return moves;
}

const MATE = 1000000;
let nodes = 0, deadline = Date.now() + 700;
function timeCheck() {
  if ((++nodes & 1023) === 0 && Date.now() > deadline) throw 1;
}

function quiesce(s, alpha, beta, ply) {
  timeCheck();
  const inCheck = checked(s), stand = evaluate(s);
  if (!inCheck) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply >= 12) return alpha;
  }
  let moves = legalMoves(s);
  if (inCheck && moves.length === 0) return -MATE + ply;
  if (!inCheck) moves = moves.filter(m => tactical(s, m));
  order(s, moves, "", ply);
  for (const m of moves) {
    const score = -quiesce(play(s, m), -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(s, depth, alpha, beta, ply) {
  timeCheck();
  if (depth <= 0) return quiesce(s, alpha, beta, ply);
  const moves = order(s, legalMoves(s), "", ply);
  if (moves.length === 0) return checked(s) ? -MATE + ply : 0;
  for (const m of moves) {
    const score = -search(play(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score >= beta) {
      if (!tactical(s, m)) {
        const k = moveKey(m);
        if (!killers[ply].includes(k)) killers[ply] = [k, killers[ply][0]].filter(Boolean);
        history.set(k, (history.get(k) || 0) + depth * depth);
      }
      return beta;
    }
    if (score > alpha) alpha = score;
  }
  return alpha;
}

const rootMoves = legalMoves(state);
let best = rootMoves[0], preferred = best ? moveKey(best) : "";
for (let depth = 1; best && depth <= 5; depth++) {
  try {
    let iterationBest = best, alpha = -MATE, iterationScore = -MATE;
    order(state, rootMoves, preferred, 0);
    for (const m of rootMoves) {
      const score = -search(play(state, m), depth - 1, -MATE, -alpha, 1);
      if (score > iterationScore) { iterationScore = score; iterationBest = m; }
      if (score > alpha) alpha = score;
    }
    best = iterationBest; preferred = moveKey(best);
    if (Math.abs(iterationScore) > MATE - 100) break;
  } catch { break; }
}

const coord = i => String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3));
if (best) process.stdout.write(coord(best.f) + coord(best.t) + (best.p || ""));
