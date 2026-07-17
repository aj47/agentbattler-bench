import fs from "node:fs";

const input = fs.readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const board = Array(64).fill(null);
const placement = fields[0] || "";
const turn = fields[1] === "b" ? "b" : "w";
const rights = fields[2] || "-";
const ep = fields[3] && fields[3] !== "-" ? square(fields[3]) : -1;

function square(s) {
  return (Number(s[1]) - 1) * 8 + s.charCodeAt(0) - 97;
}

function fileOf(s) {
  return s & 7;
}

function rankOf(s) {
  return s >> 3;
}

function colorOf(p) {
  return p && p === p.toUpperCase() ? "w" : "b";
}

function enemyPiece(p, side) {
  return p && colorOf(p) !== side && p.toLowerCase() !== "k";
}

let rank = 7;
let file = 0;
for (const ch of placement) {
  if (ch === "/") {
    rank--;
    file = 0;
  } else if (ch >= "1" && ch <= "8") {
    file += Number(ch);
  } else {
    board[rank * 8 + file] = ch;
    file++;
  }
}

function attacked(b, target, by) {
  const f = fileOf(target);
  const r = rankOf(target);

  const pawnRank = by === "w" ? r - 1 : r + 1;
  if (pawnRank >= 0 && pawnRank < 8) {
    if (f > 0 && b[pawnRank * 8 + f - 1] === (by === "w" ? "P" : "p")) return true;
    if (f < 7 && b[pawnRank * 8 + f + 1] === (by === "w" ? "P" : "p")) return true;
  }

  const knight = by === "w" ? "N" : "n";
  const knightSteps = [[1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  for (const [df, dr] of knightSteps) {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 &&
        b[nr * 8 + nf] === knight) return true;
  }

  const king = by === "w" ? "K" : "k";
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const nf = f + df, nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 &&
          b[nr * 8 + nf] === king) return true;
    }
  }

  const diagonals = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [df, dr] of diagonals) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        if (colorOf(p) === by &&
            (p.toLowerCase() === "b" || p.toLowerCase() === "q")) return true;
        break;
      }
      nf += df;
      nr += dr;
    }
  }

  const lines = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [df, dr] of lines) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = b[nr * 8 + nf];
      if (p) {
        if (colorOf(p) === by &&
            (p.toLowerCase() === "r" || p.toLowerCase() === "q")) return true;
        break;
      }
      nf += df;
      nr += dr;
    }
  }
  return false;
}

function moveKingBoard(b, from, to) {
  const n = b.slice();
  n[to] = n[from];
  n[from] = null;
  return n;
}

function apply(b, m, side) {
  const n = b.slice();
  const p = n[m.from];
  n[m.from] = null;

  if (p.toLowerCase() === "p" && m.to === ep && !n[m.to]) {
    n[m.to + (side === "w" ? -8 : 8)] = null;
  }

  n[m.to] = m.promotion ? (side === "w" ? m.promotion.toUpperCase() : m.promotion) : p;

  if (p.toLowerCase() === "k" && Math.abs(m.to - m.from) === 2) {
    if (m.to > m.from) {
      n[m.from + 1] = n[m.from + 3];
      n[m.from + 3] = null;
    } else {
      n[m.from - 1] = n[m.from - 4];
      n[m.from - 4] = null;
    }
  }
  return n;
}

function inCheck(b, side) {
  let king = -1;
  const k = side === "w" ? "K" : "k";
  for (let i = 0; i < 64; i++) if (b[i] === k) {
    king = i;
    break;
  }
  return king < 0 || attacked(b, king, side === "w" ? "b" : "w");
}

function addPawnMove(list, from, to, side, promotion) {
  if (promotion) {
    for (const x of ["q", "r", "b", "n"]) list.push({ from, to, promotion: x });
  } else {
    list.push({ from, to });
  }
}

function pseudoMoves(b, side) {
  const list = [];
  const forward = side === "w" ? 1 : -1;
  const pawn = side === "w" ? "P" : "p";
  const king = side === "w" ? "K" : "k";

  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || colorOf(p) !== side) continue;
    const f = fileOf(from), r = rankOf(from);
    const type = p.toLowerCase();

    if (type === "p") {
      const nr = r + forward;
      if (nr >= 0 && nr < 8) {
        const one = nr * 8 + f;
        if (!b[one]) {
          addPawnMove(list, from, one, side, nr === 0 || nr === 7);
          const start = side === "w" ? 1 : 6;
          const two = (r + 2 * forward) * 8 + f;
          if (r === start && !b[two]) list.push({ from, to: two });
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          if ((b[to] && enemyPiece(b[to], side)) || to === ep) {
            addPawnMove(list, from, to, side, nr === 0 || nr === 7);
          }
        }
      }
    } else if (type === "n") {
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2],
        [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const nf = f + df, nr = r + dr;
        if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (!b[to] || enemyPiece(b[to], side)) list.push({ from, to });
        }
      }
    } else if (type === "b" || type === "r" || type === "q") {
      const dirs = type === "b" ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
        : type === "r" ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
        : [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (!b[to]) list.push({ from, to });
          else {
            if (enemyPiece(b[to], side)) list.push({ from, to });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
    } else if (type === "k") {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (!df && !dr) continue;
          const nf = f + df, nr = r + dr;
          if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
            const to = nr * 8 + nf;
            if (!b[to] || enemyPiece(b[to], side)) list.push({ from, to });
          }
        }
      }

      const home = side === "w" ? 4 : 60;
      const enemy = side === "w" ? "b" : "w";
      if (from === home && !inCheck(b, side)) {
        const kingSide = side === "w" ? rights.includes("K") : rights.includes("k");
        const queenSide = side === "w" ? rights.includes("Q") : rights.includes("q");
        const rookRank = side === "w" ? 0 : 7;

        if (kingSide && b[rookRank * 8 + 7] === (side === "w" ? "R" : "r") &&
            !b[home + 1] && !b[home + 2] &&
            !attacked(moveKingBoard(b, home, home + 1), home + 1, enemy)) {
          list.push({ from: home, to: home + 2 });
        }
        if (queenSide && b[rookRank * 8] === (side === "w" ? "R" : "r") &&
            !b[home - 1] && !b[home - 2] && !b[home - 3] &&
            !attacked(moveKingBoard(b, home, home - 1), home - 1, enemy)) {
          list.push({ from: home, to: home - 2 });
        }
      }
    }
  }
  return list;
}

function notation(m) {
  const name = s => String.fromCharCode(97 + fileOf(s)) + String(rankOf(s) + 1);
  return name(m.from) + name(m.to) + (m.promotion || "");
}

const legal = [];
for (const m of pseudoMoves(board, turn)) {
  const next = apply(board, m, turn);
  if (!inCheck(next, turn)) legal.push(m);
}

if (legal.length) process.stdout.write(notation(legal[0]) + "\n");