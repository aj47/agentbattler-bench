import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const board = Array(64).fill(".");
const rows = (fields[0] || "8/8/8/8/8/8/8/8").split("/");
for (let r = 0; r < 8; r++) {
  let file = 0;
  for (const ch of (rows[r] || "8")) {
    if (ch >= "1" && ch <= "8") file += +ch;
    else if (file < 8) board[(7 - r) * 8 + file++] = ch;
  }
}
const square = x => (x && x !== "-" ? (x.charCodeAt(0) - 97) + (x.charCodeAt(1) - 49) * 8 : -1);
const state = {
  b: board,
  turn: fields[1] === "b" ? 1 : 0,
  rights: fields[2] === "-" || !fields[2] ? 0 :
    (fields[2].includes("K") ? 1 : 0) | (fields[2].includes("Q") ? 2 : 0) |
    (fields[2].includes("k") ? 4 : 0) | (fields[2].includes("q") ? 8 : 0),
  ep: square(fields[3])
};

const own = (p, side) => p !== "." && (p === p.toUpperCase()) === (side === 0);
const enemy = (p, side) => p !== "." && !own(p, side);
const rank = i => i >> 3;
const file = i => i & 7;
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const at = (f, r) => r * 8 + f;

function attacked(s, target, by) {
  const tf = file(target), tr = rank(target);
  for (let i = 0; i < 64; i++) {
    const p = s.b[i];
    if (!own(p, by)) continue;
    const pf = file(i), pr = rank(i), df = tf - pf, dr = tr - pr;
    const q = p.toLowerCase();
    if (q === "p" && dr === (by ? -1 : 1) && Math.abs(df) === 1) return true;
    if (q === "n" && ((Math.abs(df) === 1 && Math.abs(dr) === 2) || (Math.abs(df) === 2 && Math.abs(dr) === 1))) return true;
    if (q === "k" && Math.max(Math.abs(df), Math.abs(dr)) === 1) return true;
    if ((q === "b" || q === "q") && Math.abs(df) === Math.abs(dr) && df !== 0) {
      const sf = Math.sign(df), sr = Math.sign(dr);
      let f = pf + sf, r = pr + sr, clear = true;
      while (f !== tf || r !== tr) { if (s.b[at(f, r)] !== ".") clear = false; f += sf; r += sr; }
      if (clear) return true;
    }
    if ((q === "r" || q === "q") && (df === 0) !== (dr === 0)) {
      const sf = Math.sign(df), sr = Math.sign(dr);
      let f = pf + sf, r = pr + sr, clear = true;
      while (f !== tf || r !== tr) { if (s.b[at(f, r)] !== ".") clear = false; f += sf; r += sr; }
      if (clear) return true;
    }
  }
  return false;
}

function inCheck(s, side) {
  const k = side ? "k" : "K";
  const i = s.b.indexOf(k);
  return i < 0 || attacked(s, i, 1 - side);
}

function push(list, from, to, p, promo = "", ep = false, castle = false) {
  list.push({ from, to, p, promo, ep, castle });
}

function pseudo(s) {
  const out = [], side = s.turn;
  for (let i = 0; i < 64; i++) {
    const p = s.b[i];
    if (!own(p, side)) continue;
    const q = p.toLowerCase(), f = file(i), r = rank(i);
    if (q === "p") {
      const d = side ? -1 : 1, one = r + d;
      if (one >= 0 && one < 8) {
        const to = at(f, one);
        if (s.b[to] === ".") {
          if (one === (side ? 0 : 7)) for (const x of "q r b n".split(" ")) push(out, i, to, p, x);
          else {
            push(out, i, to, p);
            const two = r + 2 * d;
            if (r === (side ? 6 : 1) && s.b[at(f, two)] === ".") push(out, i, at(f, two), p);
          }
        }
        for (const df of [-1, 1]) if (f + df >= 0 && f + df < 8) {
          const to2 = at(f + df, one), target = s.b[to2];
          const epCapture = to2 === s.ep && target === "." && s.b[to2 + (side ? 8 : -8)] === (side ? "P" : "p");
          if ((enemy(target, side) && target.toLowerCase() !== "k") || epCapture) {
            if (one === (side ? 0 : 7)) for (const x of "q r b n".split(" ")) push(out, i, to2, p, x, epCapture);
            else push(out, i, to2, p, "", epCapture);
          }
        }
      }
    } else if (q === "n") {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        if (!inside(f + df, r + dr)) continue;
        const to = at(f + df, r + dr);
        if (!own(s.b[to], side) && s.b[to].toLowerCase() !== "k") push(out, i, to, p);
      }
    } else if (q === "b" || q === "r" || q === "q") {
      const dirs = q === "b" ? [[1,1],[1,-1],[-1,1],[-1,-1]] : q === "r" ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (inside(nf, nr)) {
          const to = at(nf, nr), target = s.b[to];
          if (target === ".") push(out, i, to, p);
          else { if (enemy(target, side) && target.toLowerCase() !== "k") push(out, i, to, p); break; }
          nf += df; nr += dr;
        }
      }
    } else if (q === "k") {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if ((!df && !dr) || !inside(f + df, r + dr)) continue;
        const to = at(f + df, r + dr);
        if (!own(s.b[to], side) && s.b[to].toLowerCase() !== "k") push(out, i, to, p);
      }
      const home = side ? 60 : 4, enemySide = 1 - side;
      if (i === home && !inCheck(s, side)) {
        const kingRight = side ? 4 : 1, queenRight = side ? 8 : 2;
        if ((s.rights & kingRight) && s.b[home + 1] === "." && s.b[home + 2] === "." &&
            s.b[home + 3] === (side ? "r" : "R") && !attacked(s, home + 1, enemySide) && !attacked(s, home + 2, enemySide))
          push(out, i, home + 2, p, "", false, true);
        if ((s.rights & queenRight) && s.b[home - 1] === "." && s.b[home - 2] === "." && s.b[home - 3] === "." &&
            s.b[home - 4] === (side ? "r" : "R") && !attacked(s, home - 1, enemySide) && !attacked(s, home - 2, enemySide))
          push(out, i, home - 2, p, "", false, true);
      }
    }
  }
  return out;
}

function rookRight(i) {
  return i === 0 ? 2 : i === 7 ? 1 : i === 56 ? 8 : i === 63 ? 4 : 0;
}
function make(s, m) {
  const b = s.b.slice(), side = s.turn, moving = b[m.from], captured = b[m.to];
  let rights = s.rights & ~rookRight(m.from);
  if (moving.toLowerCase() === "k") rights &= side ? ~12 : ~3;
  const captureSquare = m.ep ? m.to + (side ? 8 : -8) : m.to;
  if (captured !== "." || m.ep) rights &= ~rookRight(captureSquare);
  b[m.from] = ".";
  if (m.ep) b[captureSquare] = ".";
  b[m.to] = m.promo ? (side ? m.promo : m.promo.toUpperCase()) : moving;
  if (m.castle) {
    const rookFrom = m.to > m.from ? m.from + 3 : m.from - 4;
    const rookTo = m.to > m.from ? m.from + 1 : m.from - 1;
    b[rookTo] = b[rookFrom]; b[rookFrom] = ".";
  }
  const ep = moving.toLowerCase() === "p" && Math.abs(m.to - m.from) === 16 ? (m.to + m.from) >> 1 : -1;
  return { b, turn: 1 - side, rights, ep };
}
function legal(s) {
  const side = s.turn;
  return pseudo(s).filter(m => !inCheck(make(s, m), side));
}

const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
function evaluate(s, perspective) {
  let score = 0;
  for (const p of s.b) if (p !== ".") score += (p === p.toUpperCase() ? 1 : -1) * values[p.toLowerCase()];
  return perspective ? -score : score;
}
function search(s, depth, me) {
  const moves = legal(s);
  if (!moves.length) return inCheck(s, s.turn) ? (s.turn === me ? -1000000 : 1000000) : 0;
  if (!depth) return evaluate(s, me);
  let best = s.turn === me ? -Infinity : Infinity;
  for (const m of moves) {
    const v = search(make(s, m), depth - 1, me);
    if (s.turn === me ? v > best : v < best) best = v;
  }
  return best;
}

const moves = legal(state);
let chosen = moves[0];
let best = -Infinity;
for (const m of moves) {
  const v = search(make(state, m), 1, state.turn);
  if (v > best) { best = v; chosen = m; }
}
const uci = i => String.fromCharCode(97 + file(i)) + String(rank(i) + 1);
process.stdout.write(chosen ? uci(chosen.from) + uci(chosen.to) + (chosen.promo || "") : "");
