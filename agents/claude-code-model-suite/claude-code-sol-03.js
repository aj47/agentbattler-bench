import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(".");
const rows = fields[0].split("/");

for (let i = 0; i < 8; i++) {
  let file = 0;
  const rank = 7 - i;
  for (const ch of rows[i]) {
    if (ch >= "1" && ch <= "8") file += Number(ch);
    else board[rank * 8 + file++] = ch;
  }
}

let castle = 0;
if ((fields[2] || "").includes("K")) castle |= 1;
if ((fields[2] || "").includes("Q")) castle |= 2;
if ((fields[2] || "").includes("k")) castle |= 4;
if ((fields[2] || "").includes("q")) castle |= 8;

function squareIndex(s) {
  return s && s !== "-" ? s.charCodeAt(0) - 97 + 8 * (Number(s[1]) - 1) : -1;
}

const initial = {
  b: board,
  side: fields[1] === "b" ? -1 : 1,
  castle,
  ep: squareIndex(fields[3])
};

function piece(side, type) {
  return side === 1 ? type.toUpperCase() : type;
}

function colorOf(p) {
  return p === p.toUpperCase() ? 1 : -1;
}

function attacked(b, sq, by) {
  const x = sq & 7;
  const y = sq >> 3;
  const pawnRank = y - by;
  const pawn = piece(by, "p");

  if (pawnRank >= 0 && pawnRank < 8) {
    if (x > 0 && b[pawnRank * 8 + x - 1] === pawn) return true;
    if (x < 7 && b[pawnRank * 8 + x + 1] === pawn) return true;
  }

  const knight = piece(by, "n");
  const knightSteps = [
    [1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2]
  ];
  for (const [dx, dy] of knightSteps) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8 &&
        b[ny * 8 + nx] === knight) return true;
  }

  const king = piece(by, "k");
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8 &&
          b[ny * 8 + nx] === king) return true;
    }
  }

  const rays = [
    [1, 0, "rq"], [-1, 0, "rq"], [0, 1, "rq"], [0, -1, "rq"],
    [1, 1, "bq"], [1, -1, "bq"], [-1, 1, "bq"], [-1, -1, "bq"]
  ];
  for (const [dx, dy, types] of rays) {
    let nx = x + dx, ny = y + dy;
    while (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
      const p = b[ny * 8 + nx];
      if (p !== ".") {
        if (colorOf(p) === by && types.includes(p.toLowerCase())) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  return false;
}

function inCheck(s) {
  const king = piece(s.side, "k");
  const sq = s.b.indexOf(king);
  return sq >= 0 && attacked(s.b, sq, -s.side);
}

function applyMove(s, m) {
  const b = s.b.slice();
  const moving = b[m.f];
  const side = s.side;
  let rights = s.castle;

  if (moving.toLowerCase() === "k") {
    rights &= side === 1 ? ~3 : ~12;
  }
  if (m.f === 0 || m.t === 0) rights &= ~2;
  if (m.f === 7 || m.t === 7) rights &= ~1;
  if (m.f === 56 || m.t === 56) rights &= ~8;
  if (m.f === 63 || m.t === 63) rights &= ~4;

  b[m.f] = ".";
  if (m.ep) b[m.t - side * 8] = ".";
  b[m.t] = m.p ? piece(side, m.p) : moving;

  if (m.castle) {
    if (m.t === 6) {
      b[5] = "R";
      b[7] = ".";
    } else if (m.t === 2) {
      b[3] = "R";
      b[0] = ".";
    } else if (m.t === 62) {
      b[61] = "r";
      b[63] = ".";
    } else if (m.t === 58) {
      b[59] = "r";
      b[56] = ".";
    }
  }

  return {
    b,
    side: -side,
    castle: rights,
    ep: moving.toLowerCase() === "p" && Math.abs(m.t - m.f) === 16
      ? (m.f + m.t) >> 1
      : -1
  };
}

function pseudoMoves(s) {
  const b = s.b;
  const side = s.side;
  const moves = [];

  function add(f, t, p = "", ep = false, castling = false) {
    const target = b[t];
    if (target !== "." && target.toLowerCase() === "k") return;
    moves.push({
      f,
      t,
      p,
      ep,
      castle: castling,
      cap: ep ? "p" : target === "." ? "" : target.toLowerCase()
    });
  }

  for (let from = 0; from < 64; from++) {
    const pc = b[from];
    if (pc === "." || colorOf(pc) !== side) continue;

    const type = pc.toLowerCase();
    const x = from & 7;
    const y = from >> 3;

    if (type === "p") {
      const ny = y + side;
      if (ny >= 0 && ny < 8) {
        const one = ny * 8 + x;
        if (b[one] === ".") {
          if (ny === 0 || ny === 7) {
            for (const promotion of ["q", "r", "b", "n"]) add(from, one, promotion);
          } else {
            add(from, one);
            const startRank = side === 1 ? 1 : 6;
            const two = from + side * 16;
            if (y === startRank && b[two] === ".") add(from, two);
          }
        }

        for (const dx of [-1, 1]) {
          const nx = x + dx;
          if (nx < 0 || nx > 7) continue;
          const to = ny * 8 + nx;
          if (b[to] !== "." && colorOf(b[to]) === -side) {
            if (ny === 0 || ny === 7) {
              for (const promotion of ["q", "r", "b", "n"]) add(from, to, promotion);
            } else add(from, to);
          } else if (
            to === s.ep &&
            b[to] === "." &&
            b[to - side * 8] === piece(-side, "p")
          ) {
            add(from, to, "", true);
          }
        }
      }
      continue;
    }

    if (type === "n") {
      const steps = [
        [1, 2], [2, 1], [2, -1], [1, -2],
        [-1, -2], [-2, -1], [-2, 1], [-1, 2]
      ];
      for (const [dx, dy] of steps) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
        const to = ny * 8 + nx;
        if (b[to] === "." || colorOf(b[to]) === -side) add(from, to);
      }
      continue;
    }

    if (type === "b" || type === "r" || type === "q") {
      const dirs = [];
      if (type === "b" || type === "q") {
        dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      }
      if (type === "r" || type === "q") {
        dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      }
      for (const [dx, dy] of dirs) {
        let nx = x + dx, ny = y + dy;
        while (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
          const to = ny * 8 + nx;
          if (b[to] === ".") add(from, to);
          else {
            if (colorOf(b[to]) === -side) add(from, to);
            break;
          }
          nx += dx;
          ny += dy;
        }
      }
      continue;
    }

    if (type === "k") {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx > 7 || ny < 0 || ny > 7) continue;
          const to = ny * 8 + nx;
          if (b[to] === "." || colorOf(b[to]) === -side) add(from, to);
        }
      }

      if (side === 1 && from === 4 && pc === "K") {
        if (
          (s.castle & 1) && b[7] === "R" && b[5] === "." && b[6] === "." &&
          !attacked(b, 4, -1) && !attacked(b, 5, -1)
        ) add(4, 6, "", false, true);
        if (
          (s.castle & 2) && b[0] === "R" &&
          b[1] === "." && b[2] === "." && b[3] === "." &&
          !attacked(b, 4, -1) && !attacked(b, 3, -1)
        ) add(4, 2, "", false, true);
      } else if (side === -1 && from === 60 && pc === "k") {
        if (
          (s.castle & 4) && b[63] === "r" && b[61] === "." && b[62] === "." &&
          !attacked(b, 60, 1) && !attacked(b, 61, 1)
        ) add(60, 62, "", false, true);
        if (
          (s.castle & 8) && b[56] === "r" &&
          b[57] === "." && b[58] === "." && b[59] === "." &&
          !attacked(b, 60, 1) && !attacked(b, 59, 1)
        ) add(60, 58, "", false, true);
      }
    }
  }
  return moves;
}

function legalMoves(s) {
  const result = [];
  const ownKing = piece(s.side, "k");
  for (const m of pseudoMoves(s)) {
    const child = applyMove(s, m);
    const kingSquare = child.b.indexOf(ownKing);
    if (kingSquare >= 0 && !attacked(child.b, kingSquare, -s.side)) {
      m.s = child;
      result.push(m);
    }
  }
  return result;
}

const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evaluate(s) {
  let whiteScore = 0;
  let nonPawnMaterial = 0;
  let whiteBishops = 0, blackBishops = 0;

  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq];
    if (p === ".") continue;
    const type = p.toLowerCase();
    const side = colorOf(p);
    if (type !== "p" && type !== "k") nonPawnMaterial += values[type];
    if (type === "b") side === 1 ? whiteBishops++ : blackBishops++;
  }

  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq];
    if (p === ".") continue;
    const type = p.toLowerCase();
    const side = colorOf(p);
    const x = sq & 7;
    const y = sq >> 3;
    const ry = side === 1 ? y : 7 - y;
    const center = Math.abs(x - 3.5) + Math.abs(y - 3.5);
    let bonus = 0;

    if (type === "p") {
      bonus += ry * 8;
      bonus += Math.max(0, 10 - Math.abs(x - 3.5) * 4);
      if (x === 3 || x === 4) bonus += 5;
    } else if (type === "n") {
      bonus += Math.round(35 - center * 10);
      if (ry === 0) bonus -= 12;
    } else if (type === "b") {
      bonus += Math.round(24 - center * 5);
      if (ry > 0) bonus += 5;
    } else if (type === "r") {
      bonus += ry * 2;
      if (ry === 6) bonus += 12;
    } else if (type === "q") {
      bonus += Math.round(8 - center * 2);
    } else if (type === "k") {
      if (nonPawnMaterial <= 1400) {
        bonus += Math.round(35 - center * 9);
      } else {
        if (ry === 0 && (x === 2 || x === 6)) bonus += 38;
        bonus -= Math.max(0, Math.round(30 - center * 8));
        bonus -= ry * 8;
      }
    }

    whiteScore += side * (values[type] + bonus);
  }

  if (whiteBishops >= 2) whiteScore += 25;
  if (blackBishops >= 2) whiteScore -= 25;
  if (s.castle & 3) whiteScore += 7;
  if (s.castle & 12) whiteScore -= 7;
  return whiteScore * s.side;
}

function moveOrder(m, s) {
  const attacker = s.b[m.f].toLowerCase();
  let score = 0;
  if (m.cap) score += 10000 + 10 * values[m.cap] - values[attacker];
  if (m.p) score += 8000 + values[m.p];
  if (m.castle) score += 300;
  if (m.last !== undefined) score += m.last;
  return score;
}

function orderMoves(moves, s) {
  moves.sort((a, b) => moveOrder(b, s) - moveOrder(a, s));
}

let nodes = 0;
const deadline = Date.now() + 950;
const TIMEOUT = {};

function checkTime() {
  if ((++nodes & 1023) === 0 && Date.now() >= deadline) throw TIMEOUT;
}

function quiescence(s, alpha, beta, ply, qdepth = 0) {
  checkTime();
  const checked = inCheck(s);
  const stand = evaluate(s);

  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qdepth >= 10) return alpha;
  } else if (qdepth >= 12) {
    return stand;
  }

  let moves = legalMoves(s);
  if (!checked) moves = moves.filter(m => m.cap || m.p);
  if (!moves.length) return checked ? -100000 + ply : alpha;
  orderMoves(moves, s);

  for (const m of moves) {
    const score = -quiescence(m.s, -beta, -alpha, ply + 1, qdepth + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(s, depth, alpha, beta, ply) {
  checkTime();
  if (depth === 0) return quiescence(s, alpha, beta, ply);

  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s) ? -100000 + ply : 0;
  orderMoves(moves, s);

  for (const m of moves) {
    const score = -search(m.s, depth - 1, -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

const rootMoves = legalMoves(initial);
let bestMove = rootMoves[0];
let bestScore = -Infinity;

if (rootMoves.length > 1) {
  orderMoves(rootMoves, initial);

  for (let depth = 1; depth <= 7; depth++) {
    try {
      let alpha = -Infinity;
      let iterationBest = rootMoves[0];
      let iterationScore = -Infinity;
      const scores = new Map();

      for (const m of rootMoves) {
        const score = -search(m.s, depth - 1, -Infinity, -alpha, 1);
        scores.set(m, score);
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = m;
        }
        if (score > alpha) alpha = score;
      }

      bestMove = iterationBest;
      bestScore = iterationScore;
      for (const m of rootMoves) m.last = scores.get(m) || 0;
      rootMoves.sort((a, b) => {
        if (a === bestMove) return -1;
        if (b === bestMove) return 1;
        return (b.last || 0) - (a.last || 0);
      });
      if (Math.abs(bestScore) > 90000 || Date.now() >= deadline) break;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
}

function uci(m) {
  const name = sq =>
    String.fromCharCode(97 + (sq & 7)) + String((sq >> 3) + 1);
  return name(m.f) + name(m.t) + (m.p || "");
}

if (bestMove) process.stdout.write(uci(bestMove));