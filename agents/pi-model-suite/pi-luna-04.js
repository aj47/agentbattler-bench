import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const board = Array(64).fill(".");
let at = 56;
for (const row of (fields[0] || "").split("/")) {
  let file = 0;
  for (const ch of row) {
    if (ch >= "1" && ch <= "8") file += +ch;
    else if (file < 8) board[at + file++] = ch;
  }
  at -= 8;
}
const state = {
  b: board,
  w: (fields[1] || "w") === "w",
  cr: fields[2] === "-" ? "" : (fields[2] || ""),
  ep: fields[3] && fields[3] !== "-" ? square(fields[3]) : -1
};

function square(x) {
  return (x.charCodeAt(1) - 49) * 8 + x.charCodeAt(0) - 97;
}
function name(x) {
  return String.fromCharCode(97 + (x & 7)) + (1 + (x >> 3));
}
function mine(c, w) {
  return c !== "." && (w ? c >= "A" && c <= "Z" : c >= "a" && c <= "z");
}
function enemy(c, w) {
  return c !== "." && (w ? c >= "a" && c <= "z" : c >= "A" && c <= "Z");
}

function attacked(s, q, byWhite) {
  const r = q >> 3, f = q & 7;
  const pawnRank = r + (byWhite ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    for (const df of [-1, 1]) {
      const x = f + df;
      if (x >= 0 && x < 8 && s.b[pawnRank * 8 + x] === (byWhite ? "P" : "p")) return true;
    }
  }
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && s.b[rr * 8 + ff] === (byWhite ? "N" : "n")) return true;
  }
  for (const [dr, df] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const c = s.b[rr * 8 + ff];
      if (c !== ".") {
        if (c === (byWhite ? "B" : "b") || c === (byWhite ? "Q" : "q")) return true;
        break;
      }
      rr += dr; ff += df;
    }
  }
  for (const [dr, df] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const c = s.b[rr * 8 + ff];
      if (c !== ".") {
        if (c === (byWhite ? "R" : "r") || c === (byWhite ? "Q" : "q")) return true;
        break;
      }
      rr += dr; ff += df;
    }
  }
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if (!dr && !df) continue;
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && s.b[rr * 8 + ff] === (byWhite ? "K" : "k")) return true;
  }
  return false;
}

function addPawnMoves(s, moves, from, w) {
  const r = from >> 3, f = from & 7, d = w ? 8 : -8;
  const last = w ? 7 : 0;
  const start = w ? 1 : 6;
  const promote = (to, ep = false) => {
    if ((to >> 3) === last) {
      for (const x of w ? ["Q","R","B","N"] : ["q","r","b","n"])
        moves.push({ f: from, t: to, p: x, ep });
    } else moves.push({ f: from, t: to, ep });
  };
  let to = from + d;
  if (to >= 0 && to < 64 && s.b[to] === ".") {
    promote(to);
    if (r === start && s.b[from + 2 * d] === ".") moves.push({ f: from, t: from + 2 * d });
  }
  for (const df of [-1, 1]) {
    const ff = f + df;
    if (ff < 0 || ff > 7) continue;
    to = from + d + df;
    if (to < 0 || to >= 64) continue;
    if (enemy(s.b[to], w)) {
      if (s.b[to].toUpperCase() !== "K") promote(to);
    } else if (to === s.ep && s.b[to] === ".") promote(to, true);
  }
}

function generate(s) {
  const moves = [], w = s.w;
  for (let from = 0; from < 64; from++) {
    const p = s.b[from], u = p.toUpperCase();
    if (!mine(p, w)) continue;
    const r = from >> 3, f = from & 7;
    if (u === "P") {
      addPawnMoves(s, moves, from, w);
    } else if (u === "N") {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && (!mine(s.b[rr*8+ff],w)) && s.b[rr*8+ff].toUpperCase() !== "K")
          moves.push({ f: from, t: rr * 8 + ff });
      }
    } else if (u === "B" || u === "R" || u === "Q") {
      const dirs = u === "B" ? [[-1,-1],[-1,1],[1,-1],[1,1]] : u === "R" ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const to = rr * 8 + ff, c = s.b[to];
          if (c === ".") moves.push({ f: from, t: to });
          else {
            if (enemy(c,w) && c.toUpperCase() !== "K") moves.push({ f: from, t: to });
            break;
          }
          rr += dr; ff += df;
        }
      }
    } else if (u === "K") {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && !mine(s.b[rr*8+ff],w) && s.b[rr*8+ff].toUpperCase() !== "K")
          moves.push({ f: from, t: rr * 8 + ff });
      }
      const home = w ? 4 : 60, step = w ? 1 : -1;
      if (from === home && !attacked(s, from, !w)) {
        const kingRight = w ? "K" : "k", queenRight = w ? "Q" : "q";
        if (s.cr.includes(kingRight) && s.b[home+1] === "." && s.b[home+2] === "." && s.b[home+3] === (w ? "R" : "r") &&
            !attacked(s, home+step, !w) && !attacked(s, home+2*step, !w))
          moves.push({ f: from, t: home + 2, castle: true });
        if (s.cr.includes(queenRight) && s.b[home-1] === "." && s.b[home-2] === "." && s.b[home-3] === "." && s.b[home-4] === (w ? "R" : "r") &&
            !attacked(s, home-step, !w) && !attacked(s, home-2*step, !w))
          moves.push({ f: from, t: home - 2, castle: true });
      }
    }
  }
  return moves.filter(m => legal(s, m));
}

function apply(s, m) {
  const b = s.b.slice(), p = b[m.f], w = s.w;
  b[m.f] = ".";
  if (m.ep) b[m.t + (w ? -8 : 8)] = ".";
  if (m.castle) {
    const rf = m.t > m.f ? m.f + 3 : m.f - 4;
    const rt = m.t > m.f ? m.f + 1 : m.f - 1;
    b[rt] = b[rf]; b[rf] = ".";
  }
  b[m.t] = m.p || p;
  let cr = s.cr;
  if (p === "K") cr = cr.replace(/[KQ]/g, "");
  if (p === "k") cr = cr.replace(/[kq]/g, "");
  const rights = [[0,"Q"],[7,"K"],[56,"q"],[63,"k"]];
  for (const [x, right] of rights) if (m.f === x || m.t === x) cr = cr.replace(right, "");
  const ep = p.toUpperCase() === "P" && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) / 2 : -1;
  return { b, w: !w, cr, ep };
}
function legal(s, m) {
  const n = apply(s, m), king = n.b.findIndex(x => x === (s.w ? "K" : "k"));
  return king >= 0 && !attacked(n, king, !s.w);
}

const legalMoves = generate(state);
let best = legalMoves[0];
let bestScore = -Infinity;
const value = { P:100, N:320, B:330, R:500, Q:900, K:20000 };
for (const m of legalMoves) {
  const captured = m.ep ? "P" : state.b[m.t];
  let score = (m.p ? value[m.p.toUpperCase()] + 700 : 0) + (captured && captured !== "." ? value[captured.toUpperCase()] : 0);
  if (m.castle) score += 30;
  const n = apply(state, m), ek = n.b.findIndex(x => x === (state.w ? "k" : "K"));
  if (ek >= 0 && attacked(n, ek, state.w)) score += 45;
  if (score > bestScore) { bestScore = score; best = m; }
}
if (best) {
  let out = name(best.f) + name(best.t);
  if (best.p) out += best.p.toLowerCase();
  process.stdout.write(out);
}
