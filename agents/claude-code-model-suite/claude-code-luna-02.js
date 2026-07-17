import fs from "node:fs";

const text = fs.readFileSync(0, "utf8").trim();
const fields = text.split(/\s+/);
const rows = fields[0].split("/");
const board = Array(64).fill(".");
for (let y = 7; y >= 0; y--) {
  const row = rows[7 - y];
  let x = 0;
  for (const c of row) {
    if (c >= "1" && c <= "8") x += +c;
    else board[y * 8 + x++] = c;
  }
}
const turn = fields[1] || "w";
const rights = fields[2] || "-";
let ep = -1;
if (fields[3] && fields[3] !== "-") {
  ep = (fields[3].charCodeAt(0) - 97) +
       (fields[3].charCodeAt(1) - 49) * 8;
}

const knightSteps = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2]
];
const kingSteps = [
  [1, 1], [1, 0], [1, -1], [0, 1],
  [0, -1], [-1, 1], [-1, 0], [-1, -1]
];
const bishopDirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const rookDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function whitePiece(p) {
  return p >= "A" && p <= "Z";
}
function own(p, white) {
  return p !== "." && whitePiece(p) === white;
}
function enemy(p, white) {
  return p !== "." && whitePiece(p) !== white;
}
function inside(x, y) {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
}
function attacked(b, sq, byWhite) {
  const x = sq & 7;
  const y = sq >> 3;

  const pawn = byWhite ? "P" : "p";
  const py = y + (byWhite ? -1 : 1);
  if (py >= 0 && py < 8) {
    if (x > 0 && b[py * 8 + x - 1] === pawn) return true;
    if (x < 7 && b[py * 8 + x + 1] === pawn) return true;
  }

  const knight = byWhite ? "N" : "n";
  for (const [dx, dy] of knightSteps) {
    const nx = x + dx, ny = y + dy;
    if (inside(nx, ny) && b[ny * 8 + nx] === knight) return true;
  }

  const bishop = byWhite ? "B" : "b";
  const rook = byWhite ? "R" : "r";
  const queen = byWhite ? "Q" : "q";
  for (const [dx, dy] of bishopDirs) {
    let nx = x + dx, ny = y + dy;
    while (inside(nx, ny)) {
      const p = b[ny * 8 + nx];
      if (p !== ".") {
        if (p === bishop || p === queen) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  for (const [dx, dy] of rookDirs) {
    let nx = x + dx, ny = y + dy;
    while (inside(nx, ny)) {
      const p = b[ny * 8 + nx];
      if (p !== ".") {
        if (p === rook || p === queen) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }

  const king = byWhite ? "K" : "k";
  for (const [dx, dy] of kingSteps) {
    const nx = x + dx, ny = y + dy;
    if (inside(nx, ny) && b[ny * 8 + nx] === king) return true;
  }
  return false;
}
function makeMove(b, m) {
  const n = b.slice();
  const p = n[m.from];
  n[m.from] = ".";
  if (m.ep) {
    n[m.to + (whitePiece(p) ? -8 : 8)] = ".";
  }
  n[m.to] = m.promotion || p;
  if (m.castle) {
    if (m.to > m.from) {
      n[m.from + 3] = ".";
      n[m.from + 1] = whitePiece(p) ? "R" : "r";
    } else {
      n[m.from - 4] = ".";
      n[m.from - 1] = whitePiece(p) ? "R" : "r";
    }
  }
  return n;
}
function legal(b, m, white) {
  const n = makeMove(b, m);
  let king = -1;
  const k = white ? "K" : "k";
  for (let i = 0; i < 64; i++) {
    if (n[i] === k) {
      king = i;
      break;
    }
  }
  return king >= 0 && !attacked(n, king, !white);
}
function add(moves, from, to, extra = {}) {
  moves.push({ from, to, ...extra });
}
function addPawn(moves, from, to, white, extra = {}) {
  const y = to >> 3;
  if (y === 0 || y === 7) {
    for (const q of white ? ["Q", "R", "B", "N"] : ["q", "r", "b", "n"]) {
      add(moves, from, to, { ...extra, promotion: q });
    }
  } else {
    add(moves, from, to, extra);
  }
}
function generate(b, white) {
  const moves = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!own(p, white)) continue;
    const x = from & 7, y = from >> 3;
    const type = p.toUpperCase();

    if (type === "P") {
      const d = white ? 1 : -1;
      const start = white ? 1 : 6;
      const ny = y + d;
      if (inside(x, ny)) {
        const one = ny * 8 + x;
        if (b[one] === ".") {
          addPawn(moves, from, one, white);
          if (y === start) {
            const two = (y + 2 * d) * 8 + x;
            if (b[two] === ".") add(moves, from, two);
          }
        }
        for (const dx of [-1, 1]) {
          const nx = x + dx;
          if (!inside(nx, ny)) continue;
          const to = ny * 8 + nx;
          if (enemy(b[to], white) && b[to].toUpperCase() !== "K") {
            addPawn(moves, from, to, white);
          } else if (to === ep && b[to] === ".") {
            const victim = to + (white ? -8 : 8);
            if (b[victim] === (white ? "p" : "P")) {
              addPawn(moves, from, to, white, { ep: true });
            }
          }
        }
      }
    } else if (type === "N") {
      for (const [dx, dy] of knightSteps) {
        const nx = x + dx, ny = y + dy;
        if (!inside(nx, ny)) continue;
        const to = ny * 8 + nx;
        if ((!own(b[to], white)) &&
            !(enemy(b[to], white) && b[to].toUpperCase() === "K")) {
          add(moves, from, to);
        }
      }
    } else if (type === "B" || type === "R" || type === "Q") {
      const dirs = type === "B" ? bishopDirs :
        type === "R" ? rookDirs : bishopDirs.concat(rookDirs);
      for (const [dx, dy] of dirs) {
        let nx = x + dx, ny = y + dy;
        while (inside(nx, ny)) {
          const to = ny * 8 + nx;
          if (b[to] === ".") add(moves, from, to);
          else {
            if (enemy(b[to], white) && b[to].toUpperCase() !== "K") {
              add(moves, from, to);
            }
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
    } else if (type === "K") {
      for (const [dx, dy] of kingSteps) {
        const nx = x + dx, ny = y + dy;
        if (!inside(nx, ny)) continue;
        const to = ny * 8 + nx;
        if (!own(b[to], white) &&
            !(enemy(b[to], white) && b[to].toUpperCase() === "K")) {
          add(moves, from, to);
        }
      }

      const home = white ? 4 : 60;
      if (from === home && !attacked(b, home, !white)) {
        const kingRight = white ? "K" : "k";
        const queenRight = white ? "Q" : "q";
        const rook = white ? "R" : "r";
        if (rights.includes(kingRight) &&
            b[home + 1] === "." && b[home + 2] === "." &&
            b[home + 3] === rook &&
            !attacked(b, home + 1, !white) &&
            !attacked(b, home + 2, !white)) {
          add(moves, from, home + 2, { castle: true });
        }
        if (rights.includes(queenRight) &&
            b[home - 1] === "." && b[home - 2] === "." &&
            b[home - 3] === "." && b[home - 4] === rook &&
            !attacked(b, home - 1, !white) &&
            !attacked(b, home - 2, !white)) {
          add(moves, from, home - 2, { castle: true });
        }
      }
    }
  }
  return moves;
}

const white = turn === "w";
const legalMoves = generate(board, white).filter(m => legal(board, m, white));
const move = legalMoves[0];

function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String(1 + (sq >> 3));
}
let output = "";
if (move) {
  output = squareName(move.from) + squareName(move.to);
  if (move.promotion) output += move.promotion.toLowerCase();
}
process.stdout.write(output);