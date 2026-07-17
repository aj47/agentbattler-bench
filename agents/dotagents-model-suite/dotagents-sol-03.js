import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
let rank = 0, file = 0;
for (const ch of fields[0]) {
  if (ch === "/") { rank++; file = 0; }
  else if (/\d/.test(ch)) file += Number(ch);
  else board[rank * 8 + file++] = ch;
}
const position = {
  b: board,
  side: fields[1],
  castle: fields[2] === "-" ? "" : fields[2],
  ep: fields[3] === "-" ? -1 : square(fields[3])
};

function square(s) {
  return (8 - Number(s[1])) * 8 + s.charCodeAt(0) - 97;
}
function name(s) {
  return String.fromCharCode(97 + s % 8) + (8 - Math.floor(s / 8));
}
function white(p) { return p && p === p.toUpperCase(); }
function mine(p, side) { return p && white(p) === (side === "w"); }
function enemy(p, side) { return p && white(p) !== (side === "w"); }
function inside(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function attacked(b, target, by) {
  const tr = Math.floor(target / 8), tc = target % 8;
  const pawn = by === "w" ? "P" : "p";
  const pawnRow = tr + (by === "w" ? 1 : -1);
  for (const dc of [-1, 1]) {
    const c = tc + dc;
    if (inside(pawnRow, c) && b[pawnRow * 8 + c] === pawn) return true;
  }
  const knight = by === "w" ? "N" : "n";
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const r = tr + dr, c = tc + dc;
    if (inside(r, c) && b[r * 8 + c] === knight) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const r = tr + dr, c = tc + dc;
    if (inside(r, c) && b[r * 8 + c] === king) return true;
  }
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let r = tr + dr, c = tc + dc;
    while (inside(r, c)) {
      const p = b[r * 8 + c];
      if (p) {
        if (mine(p, by)) {
          const t = p.toLowerCase();
          if (t === "q" || (t === "r" && (!dr || !dc)) || (t === "b" && dr && dc)) return true;
        }
        break;
      }
      r += dr; c += dc;
    }
  }
  return false;
}

function addPawnMoves(pos, moves, from, p) {
  const b = pos.b, side = pos.side, r = Math.floor(from / 8), c = from % 8;
  const d = side === "w" ? -1 : 1, last = side === "w" ? 0 : 7;
  const oneR = r + d;
  if (inside(oneR, c) && !b[oneR * 8 + c]) {
    const to = oneR * 8 + c;
    if (oneR === last) for (const q of ["q","r","b","n"]) moves.push({ f: from, t: to, p: q });
    else {
      moves.push({ f: from, t: to });
      const start = side === "w" ? 6 : 1, twoR = r + 2 * d;
      if (r === start && !b[twoR * 8 + c]) moves.push({ f: from, t: twoR * 8 + c });
    }
  }
  for (const dc of [-1, 1]) {
    const cr = r + d, cc = c + dc;
    if (!inside(cr, cc)) continue;
    const to = cr * 8 + cc, victim = b[to];
    if ((enemy(victim, side) && victim.toLowerCase() !== "k") || to === pos.ep) {
      if (cr === last) for (const q of ["q","r","b","n"]) moves.push({ f: from, t: to, p: q });
      else moves.push({ f: from, t: to });
    }
  }
}

function pseudo(pos) {
  const moves = [], b = pos.b, side = pos.side;
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!mine(p, side)) continue;
    const type = p.toLowerCase(), r = Math.floor(from / 8), c = from % 8;
    if (type === "p") { addPawnMoves(pos, moves, from, p); continue; }
    if (type === "n") {
      for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, cc = c + dc;
        if (!inside(rr, cc)) continue;
        const to = rr * 8 + cc, q = b[to];
        if (!mine(q, side) && (!q || q.toLowerCase() !== "k")) moves.push({ f: from, t: to });
      }
      continue;
    }
    const dirs = type === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]]
      : type === "r" ? [[-1,0],[1,0],[0,-1],[0,1]]
      : type === "q" ? [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]
      : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [dr,dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inside(rr, cc)) {
        const to = rr * 8 + cc, q = b[to];
        if (mine(q, side)) break;
        if (!q || q.toLowerCase() !== "k") moves.push({ f: from, t: to });
        if (q || type === "k") break;
        rr += dr; cc += dc;
      }
    }
    if (type === "k") addCastles(pos, moves, from);
  }
  return moves;
}

function addCastles(pos, moves, from) {
  const b = pos.b, s = pos.side, foe = s === "w" ? "b" : "w";
  const home = s === "w" ? 60 : 4;
  if (from !== home || b[home] !== (s === "w" ? "K" : "k") || attacked(b, home, foe)) return;
  const kingSide = s === "w" ? "K" : "k", queenSide = s === "w" ? "Q" : "q";
  const rook = s === "w" ? "R" : "r";
  if (pos.castle.includes(kingSide) && b[home + 3] === rook && !b[home + 1] && !b[home + 2]) {
    const x = b.slice(); x[home] = null; x[home + 1] = s === "w" ? "K" : "k";
    if (!attacked(x, home + 1, foe)) moves.push({ f: home, t: home + 2 });
  }
  if (pos.castle.includes(queenSide) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] && !b[home - 3]) {
    const x = b.slice(); x[home] = null; x[home - 1] = s === "w" ? "K" : "k";
    if (!attacked(x, home - 1, foe)) moves.push({ f: home, t: home - 2 });
  }
}

function play(pos, m) {
  const b = pos.b.slice(), piece = b[m.f], side = pos.side;
  const oldEp = pos.ep, captured = b[m.t];
  b[m.f] = null;
  if (piece.toLowerCase() === "p" && m.t === oldEp && !captured)
    b[m.t + (side === "w" ? 8 : -8)] = null;
  b[m.t] = m.p ? (side === "w" ? m.p.toUpperCase() : m.p) : piece;
  if (piece.toLowerCase() === "k" && Math.abs(m.t - m.f) === 2) {
    const rf = m.t > m.f ? m.f + 3 : m.f - 4, rt = m.t > m.f ? m.f + 1 : m.f - 1;
    b[rt] = b[rf]; b[rf] = null;
  }
  let castle = pos.castle;
  if (piece === "K") castle = castle.replace(/[KQ]/g, "");
  if (piece === "k") castle = castle.replace(/[kq]/g, "");
  for (const [sq, right] of [[63,"K"],[56,"Q"],[7,"k"],[0,"q"]])
    if (m.f === sq || m.t === sq) castle = castle.replace(right, "");
  let ep = -1;
  if (piece.toLowerCase() === "p" && Math.abs(m.t - m.f) === 16) ep = (m.t + m.f) / 2;
  return { b, side: side === "w" ? "b" : "w", castle, ep };
}

function legal(pos) {
  const result = [], foe = pos.side === "w" ? "b" : "w";
  for (const m of pseudo(pos)) {
    const next = play(pos, m), king = next.b.indexOf(pos.side === "w" ? "K" : "k");
    if (king >= 0 && !attacked(next.b, king, foe)) result.push(m);
  }
  return result;
}

const moves = legal(position);
if (moves.length) {
  // Prefer special moves when available; every candidate has already passed
  // full king-safety validation above.
  const m = moves.find(x => x.p)
    || moves.find(x => Math.abs(x.t - x.f) === 2 && position.b[x.f].toLowerCase() === "k")
    || moves.find(x => x.t === position.ep && position.b[x.f].toLowerCase() === "p" && !position.b[x.t])
    || moves.find(x => position.b[x.t])
    || moves[0];
  process.stdout.write(name(m.f) + name(m.t) + (m.p || ""));
}
