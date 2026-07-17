import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const board = Array(64).fill(null);
const ranks = (fields[0] || "").split("/");
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const ch of ranks[r] || "") {
    if (ch >= "1" && ch <= "8") f += +ch;
    else if (f < 8) board[r * 8 + f++] = ch;
  }
}
const side = fields[1] === "b" ? "b" : "w";
const initial = {
  board,
  side,
  rights: fields[2] || "-",
  ep: fields[3] && fields[3] !== "-" ? square(fields[3]) : -1
};

function square(s) {
  return (s.charCodeAt(0) - 97) + (8 - +s[1]) * 8;
}
function file(i) { return i & 7; }
function rank(i) { return i >> 3; }
function mine(p, c) {
  return !!p && (c === "w" ? p >= "A" && p <= "Z" : p >= "a" && p <= "z");
}
function enemy(p, c) { return !!p && !mine(p, c); }
function other(c) { return c === "w" ? "b" : "w"; }

function attacked(b, sq, by) {
  const f = file(sq), r = rank(sq);
  const pawn = by === "w" ? "P" : "p";
  if (by === "w") {
    if (r < 7) {
      if (f > 0 && b[sq + 7] === pawn) return true;
      if (f < 7 && b[sq + 9] === pawn) return true;
    }
  } else if (r > 0) {
    if (f > 0 && b[sq - 9] === pawn) return true;
    if (f < 7 && b[sq - 7] === pawn) return true;
  }

  const knight = by === "w" ? "N" : "n";
  for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 &&
        b[nr * 8 + nf] === knight) return true;
  }

  const king = by === "w" ? "K" : "k";
  for (const [df, dr] of [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]) {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 &&
        b[nr * 8 + nf] === king) return true;
  }

  const diag = by === "w" ? ["B", "Q"] : ["b", "q"];
  for (const [df, dr] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        if (diag.includes(p)) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }

  const straight = by === "w" ? ["R", "Q"] : ["r", "q"];
  for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        if (straight.includes(p)) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  return false;
}

function inCheck(st, c = st.side) {
  const k = c === "w" ? "K" : "k";
  const at = st.board.indexOf(k);
  return at < 0 || attacked(st.board, at, other(c));
}

function copyState(st) {
  return { board: st.board.slice(), side: st.side, rights: st.rights, ep: st.ep };
}
function removeRights(s, chars) {
  let x = s === "-" ? "" : s;
  for (const c of chars) x = x.replace(c, "");
  return x || "-";
}

function apply(st, m) {
  const n = copyState(st), b = n.board;
  const p = b[m.from];
  b[m.from] = null;
  if (m.ep) b[m.capture] = null;
  b[m.to] = m.prom ? (st.side === "w" ? m.prom : m.prom.toLowerCase()) : p;

  if (p === "K") n.rights = removeRights(n.rights, "KQ");
  if (p === "k") n.rights = removeRights(n.rights, "kq");
  if (m.from === 0 || m.to === 0) n.rights = removeRights(n.rights, "q");
  if (m.from === 7 || m.to === 7) n.rights = removeRights(n.rights, "k");
  if (m.from === 56 || m.to === 56) n.rights = removeRights(n.rights, "Q");
  if (m.from === 63 || m.to === 63) n.rights = removeRights(n.rights, "K");

  if (m.castle) {
    if (m.to > m.from) {
      b[m.from + 1] = b[m.from + 3];
      b[m.from + 3] = null;
    } else {
      b[m.from - 1] = b[m.from - 4];
      b[m.from - 4] = null;
    }
  }

  n.ep = -1;
  if (p === "P" || p === "p") {
    if (Math.abs(m.to - m.from) === 16) n.ep = (m.to + m.from) >> 1;
  }
  n.side = other(st.side);
  return n;
}

function addPawnMoves(st, moves, from, p) {
  const c = st.side, b = st.board, f = file(from), r = rank(from);
  const d = c === "w" ? -1 : 1;
  const one = from + d * 8;
  const promotionRank = c === "w" ? 0 : 7;
  const add = (to, extra = {}) => {
    if (rank(to) === promotionRank) {
      for (const prom of ["Q", "R", "B", "N"]) moves.push({from, to, prom, ...extra});
    } else moves.push({from, to, ...extra});
  };

  if (one >= 0 && one < 64 && !b[one]) {
    add(one);
    const start = c === "w" ? 6 : 1;
    const two = from + d * 16;
    if (r === start && !b[two]) moves.push({from, to: two});
  }
  for (const df of [-1, 1]) {
    const nf = f + df;
    if (nf < 0 || nf > 7) continue;
    const to = from + d * 8 + df;
    if (to < 0 || to >= 64) continue;
    if (enemy(b[to], c) && b[to].toLowerCase() !== "k") add(to);
    if (to === st.ep) add(to, {ep: true, capture: to - d * 8});
  }
}

function pseudo(st) {
  const b = st.board, c = st.side, moves = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!mine(p, c)) continue;
    const q = p.toLowerCase();
    if (q === "p") {
      addPawnMoves(st, moves, from, p);
      continue;
    }
    if (q === "n") {
      for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
        const nf = file(from) + df, nr = rank(from) + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if ((!b[to] || enemy(b[to], c)) && b[to]?.toLowerCase() !== "k")
          moves.push({from, to});
      }
      continue;
    }
    if (q === "b" || q === "r" || q === "q") {
      const dirs = q === "b" ? [[1,1],[1,-1],[-1,1],[-1,-1]] :
        q === "r" ? [[1,0],[-1,0],[0,1],[0,-1]] :
        [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let nf = file(from) + df, nr = rank(from) + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf, t = b[to];
          if (!t) moves.push({from, to});
          else {
            if (enemy(t, c) && t.toLowerCase() !== "k") moves.push({from, to});
            break;
          }
          nf += df; nr += dr;
        }
      }
      continue;
    }
    if (q === "k") {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = file(from) + df, nr = rank(from) + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if ((!b[to] || enemy(b[to], c)) && b[to]?.toLowerCase() !== "k")
          moves.push({from, to});
      }
      const home = c === "w" ? 60 : 4;
      const enemySide = other(c);
      if (from === home && !inCheck(st, c)) {
        const rights = st.rights;
        const kingSide = c === "w" ? "K" : "k";
        const queenSide = c === "w" ? "Q" : "q";
        if (rights.includes(kingSide) && !b[home + 1] && !b[home + 2] &&
            b[home + 3]?.toLowerCase() === "r" &&
            !attacked(b, home + 1, enemySide)) {
          moves.push({from, to: home + 2, castle: true});
        }
        if (rights.includes(queenSide) && !b[home - 1] && !b[home - 2] && !b[home - 3] &&
            b[home - 4]?.toLowerCase() === "r" &&
            !attacked(b, home - 1, enemySide)) {
          moves.push({from, to: home - 2, castle: true});
        }
      }
    }
  }
  return moves;
}

function legalMoves(st) {
  return pseudo(st).filter(m => !inCheck(apply(st, m), st.side));
}
function coord(i) {
  return String.fromCharCode(97 + file(i)) + String(8 - rank(i));
}

const moves = legalMoves(initial);
moves.sort((a, b) => {
  const av = (a.prom ? 1000 : 0) + (initial.board[a.to] ? 100 : 0) + (a.ep ? 90 : 0);
  const bv = (b.prom ? 1000 : 0) + (initial.board[b.to] ? 100 : 0) + (b.ep ? 90 : 0);
  return bv - av || a.from - b.from || a.to - b.to;
});
const move = moves[0];
if (move) process.stdout.write(coord(move.from) + coord(move.to) + (move.prom ? move.prom.toLowerCase() : ""));