import fs from "node:fs";

const input = fs.readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const rows = (fields[0] || "").split("/");
const board = Array(64).fill(".");
let side = fields[1] === "b" ? "b" : "w";
let rights = fields[2] === "-" ? "" : (fields[2] || "");
let ep = fields[3] && fields[3] !== "-" ? sq(fields[3]) : -1;

for (let r = 0; r < 8; r++) {
  let c = 0;
  for (const x of rows[r] || "") {
    if (x >= "1" && x <= "8") c += +x;
    else if (c < 8) board[r * 8 + c++] = x;
  }
}

const knight = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const kingDirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const ortho = [[-1,0],[1,0],[0,-1],[0,1]];
const diag = [[-1,-1],[-1,1],[1,-1],[1,1]];

function sq(s) {
  return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97;
}
function name(n) {
  return String.fromCharCode(97 + n % 8) + (8 - Math.floor(n / 8));
}
function color(p) {
  return p === "." ? "" : p === p.toUpperCase() ? "w" : "b";
}
function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}
function attacked(b, target, by) {
  const tr = Math.floor(target / 8), tc = target % 8;
  const pawn = by === "w" ? "P" : "p";
  const pr = by === "w" ? tr + 1 : tr - 1;
  for (const dc of [-1, 1]) {
    const c = tc + dc;
    if (inside(pr, c) && b[pr * 8 + c] === pawn) return true;
  }
  const kn = by === "w" ? "N" : "n";
  for (const [dr, dc] of knight) {
    const r = tr + dr, c = tc + dc;
    if (inside(r, c) && b[r * 8 + c] === kn) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (const [dr, dc] of kingDirs) {
    const r = tr + dr, c = tc + dc;
    if (inside(r, c) && b[r * 8 + c] === king) return true;
  }
  const rook = by === "w" ? "R" : "r";
  const queen = by === "w" ? "Q" : "q";
  for (const [dr, dc] of ortho) {
    let r = tr + dr, c = tc + dc;
    while (inside(r, c)) {
      const p = b[r * 8 + c];
      if (p !== ".") {
        if (p === rook || p === queen) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  const bishop = by === "w" ? "B" : "b";
  for (const [dr, dc] of diag) {
    let r = tr + dr, c = tc + dc;
    while (inside(r, c)) {
      const p = b[r * 8 + c];
      if (p !== ".") {
        if (p === bishop || p === queen) return true;
        break;
      }
      r += dr; c += dc;
    }
  }
  return false;
}
function inCheck(b, who) {
  const k = who === "w" ? "K" : "k";
  const n = b.indexOf(k);
  return n < 0 || attacked(b, n, who === "w" ? "b" : "w");
}
function addPawnMove(moves, from, to, p, capture = false, enPassant = false) {
  const r = Math.floor(to / 8);
  if (r === 0 || r === 7) {
    for (const q of ["q", "r", "b", "n"])
      moves.push({ from, to, prom: p === "P" ? q.toUpperCase() : q, ep: enPassant });
  } else {
    moves.push({ from, to, ep: enPassant });
  }
}
function pseudo(b, who, cr, epSquare) {
  const moves = [];
  const enemy = who === "w" ? "b" : "w";
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (color(p) !== who) continue;
    const u = p.toUpperCase();
    const r = Math.floor(from / 8), c = from % 8;
    if (u === "P") {
      const d = who === "w" ? -1 : 1;
      const start = who === "w" ? 6 : 1;
      const nr = r + d;
      if (inside(nr, c) && b[nr * 8 + c] === ".") {
        addPawnMove(moves, from, nr * 8 + c, p);
        const nr2 = r + 2 * d;
        if (r === start && b[nr2 * 8 + c] === ".")
          moves.push({ from, to: nr2 * 8 + c });
      }
      for (const dc of [-1, 1]) {
        const nc = c + dc;
        if (!inside(nr, nc)) continue;
        const to = nr * 8 + nc;
        if (color(b[to]) === enemy && b[to].toUpperCase() !== "K")
          addPawnMove(moves, from, to, p);
        else if (to === epSquare && b[to] === ".")
          addPawnMove(moves, from, to, p, true, true);
      }
    } else if (u === "N" || u === "K") {
      const ds = u === "N" ? knight : kingDirs;
      for (const [dr, dc] of ds) {
        const nr = r + dr, nc = c + dc;
        if (!inside(nr, nc)) continue;
        const to = nr * 8 + nc;
        if (color(b[to]) !== who && b[to].toUpperCase() !== "K")
          moves.push({ from, to });
      }
      if (u === "K") {
        const home = who === "w" ? 60 : 4;
        if (from === home && !inCheck(b, who)) {
          const rank = who === "w" ? 7 : 0;
          const enemySide = who === "w" ? "b" : "w";
          if (cr.includes(who === "w" ? "K" : "k") &&
              b[rank * 8 + 5] === "." && b[rank * 8 + 6] === "." &&
              b[rank * 8 + 7] === (who === "w" ? "R" : "r") &&
              !attacked(b, rank * 8 + 5, enemySide) &&
              !attacked(b, rank * 8 + 6, enemySide))
            moves.push({ from, to: rank * 8 + 6, castle: true });
          if (cr.includes(who === "w" ? "Q" : "q") &&
              b[rank * 8 + 1] === "." && b[rank * 8 + 2] === "." &&
              b[rank * 8 + 3] === "." &&
              b[rank * 8] === (who === "w" ? "R" : "r") &&
              !attacked(b, rank * 8 + 3, enemySide) &&
              !attacked(b, rank * 8 + 2, enemySide))
            moves.push({ from, to: rank * 8 + 2, castle: true });
        }
      }
    } else {
      const ds = u === "B" ? diag : u === "R" ? ortho : kingDirs;
      for (const [dr, dc] of ds) {
        let nr = r + dr, nc = c + dc;
        while (inside(nr, nc)) {
          const to = nr * 8 + nc, q = b[to];
          if (q === ".") moves.push({ from, to });
          else {
            if (color(q) === enemy && q.toUpperCase() !== "K")
              moves.push({ from, to });
            break;
          }
          if (u === "B" || u === "R") {
            nr += dr; nc += dc;
          } else break;
        }
      }
    }
  }
  return moves;
}
function apply(b, m, who, cr, epSquare) {
  const n = b.slice();
  const p = n[m.from];
  const captured = m.ep ? n[m.to + (who === "w" ? 8 : -8)] : n[m.to];
  n[m.from] = ".";
  n[m.to] = m.prom || p;
  if (m.ep) n[m.to + (who === "w" ? 8 : -8)] = ".";
  if (m.castle) {
    if (m.to > m.from) {
      n[m.to - 1] = n[m.to + 1];
      n[m.to + 1] = ".";
    } else {
      n[m.to + 1] = n[m.to - 2];
      n[m.to - 2] = ".";
    }
  }
  let rights = cr;
  if (p === "K") rights = rights.replace(/[KQ]/g, "");
  if (p === "k") rights = rights.replace(/[kq]/g, "");
  if (p === "R" || captured === "R") {
    if (m.from === 63 || m.to === 63) rights = rights.replace("K", "");
    if (m.from === 56 || m.to === 56) rights = rights.replace("Q", "");
  }
  if (p === "r" || captured === "r") {
    if (m.from === 7 || m.to === 7) rights = rights.replace("k", "");
    if (m.from === 0 || m.to === 0) rights = rights.replace("q", "");
  }
  let nextEp = -1;
  if (p.toUpperCase() === "P" && Math.abs(m.to - m.from) === 16)
    nextEp = (m.to + m.from) / 2;
  return { board: n, rights, ep: nextEp };
}
function legalMoves(b, who, cr, epSquare) {
  return pseudo(b, who, cr, epSquare).filter(m => {
    const x = apply(b, m, who, cr, epSquare);
    return !inCheck(x.board, who);
  });
}

const moves = legalMoves(board, side, rights, ep);
if (moves.length) {
  const m = moves[0];
  process.stdout.write(name(m.from) + name(m.to) + (m.prom ? m.prom.toLowerCase() : ""));
}