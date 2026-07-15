import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim();
const fields = input.split(/\s+/);
const files = "abcdefgh";
const val = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const knight = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const king = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const diag = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const orth = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function square(x) {
  return x === "-" || !x ? -1 : (8 - +x[1]) * 8 + files.indexOf(x[0]);
}

function parse() {
  const b = Array(64).fill(".");
  let i = 0;
  for (const row of fields[0].split("/")) {
    for (const c of row) {
      if (/\d/.test(c)) i += +c;
      else b[i++] = c;
    }
  }
  let r = 0;
  for (const c of fields[2] || "") r |= { K: 1, Q: 2, k: 4, q: 8 }[c] || 0;
  return { b, t: fields[1] === "b" ? "b" : "w", r, ep: square(fields[3]) };
}

function mine(p, side) {
  return p !== "." && (side === "w" ? p < "a" : p >= "a");
}

function enemy(p, side) {
  return p !== "." && !mine(p, side);
}

function attacked(b, q, by) {
  const r = q >> 3, f = q & 7;
  const pawn = by === "w" ? "P" : "p";
  const pr = r + (by === "w" ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const kn = by === "w" ? "N" : "n";
  for (const [dr, df] of knight) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === kn) return true;
  }
  const bi = by === "w" ? "B" : "b", ro = by === "w" ? "R" : "r";
  const qu = by === "w" ? "Q" : "q", ki = by === "w" ? "K" : "k";
  for (const [dr, df] of diag) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = b[rr * 8 + ff];
      if (p !== ".") { if (p === bi || p === qu) return true; break; }
      rr += dr; ff += df;
    }
  }
  for (const [dr, df] of orth) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = b[rr * 8 + ff];
      if (p !== ".") { if (p === ro || p === qu) return true; break; }
      rr += dr; ff += df;
    }
  }
  for (const [dr, df] of king) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === ki) return true;
  }
  return false;
}

function inCheck(s, side) {
  const k = side === "w" ? "K" : "k";
  const q = s.b.indexOf(k);
  return q < 0 || attacked(s.b, q, side === "w" ? "b" : "w");
}

function add(a, f, t, x = "", ep = false, castle = false) {
  a.push({ f, t, p: x, ep, castle });
}

function moves(s) {
  const a = [], b = s.b, side = s.t, pawn = side === "w" ? "P" : "p";
  const dir = side === "w" ? -1 : 1, start = side === "w" ? 6 : 1, last = side === "w" ? 0 : 7;
  const promo = ["q", "r", "b", "n"];
  const put = (f, t, ep = false) => {
    if ((t >> 3) === last) for (const p of promo) add(a, f, t, p, ep);
    else add(a, f, t, "", ep);
  };
  for (let f = 0; f < 64; f++) {
    const p = b[f];
    if (!mine(p, side)) continue;
    const r = f >> 3, c = f & 7, u = p.toLowerCase();
    if (u === "p") {
      const rr = r + dir;
      if (rr >= 0 && rr < 8) {
        const t = rr * 8 + c;
        if (b[t] === ".") {
          put(f, t);
          if (r === start && b[f + 16 * dir] === ".") add(a, f, f + 16 * dir);
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc > 7) continue;
          const to = rr * 8 + cc, ep = to === s.ep;
          if ((enemy(b[to], side) && b[to].toLowerCase() !== "k") || ep) put(f, to, ep);
        }
      }
    } else if (u === "n" || u === "k") {
      const ds = u === "n" ? knight : king;
      for (const [dr, dc] of ds) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const t = rr * 8 + cc;
        if ((b[t] === "." || (enemy(b[t], side) && b[t].toLowerCase() !== "k"))) add(a, f, t);
      }
      if (u === "k" && !inCheck(s, side)) {
        const row = side === "w" ? 7 : 0, base = row * 8;
        const rights = side === "w" ? [1, 2] : [4, 8];
        if (f === base + 4 && (s.r & rights[0]) && b[base + 5] === "." && b[base + 6] === "." &&
            b[base + 7] === (side === "w" ? "R" : "r") && !attacked(b, base + 5, side === "w" ? "b" : "w") &&
            !attacked(b, base + 6, side === "w" ? "b" : "w")) add(a, f, base + 6, "", false, true);
        if (f === base + 4 && (s.r & rights[1]) && b[base + 1] === "." && b[base + 2] === "." &&
            b[base + 3] === "." && b[base] === (side === "w" ? "R" : "r") && !attacked(b, base + 3, side === "w" ? "b" : "w") &&
            !attacked(b, base + 2, side === "w" ? "b" : "w")) add(a, f, base + 2, "", false, true);
      }
    } else {
      const ds = u === "b" ? diag : u === "r" ? orth : diag.concat(orth);
      for (const [dr, dc] of ds) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const t = rr * 8 + cc, q = b[t];
          if (q === ".") add(a, f, t);
          else { if (enemy(q, side) && q.toLowerCase() !== "k") add(a, f, t); break; }
          rr += dr; cc += dc;
        }
      }
    }
  }
  return a;
}

function play(s, m) {
  const b = s.b.slice(), side = s.t, p = b[m.f];
  b[m.f] = ".";
  if (m.ep) b[m.t + (side === "w" ? 8 : -8)] = ".";
  b[m.t] = m.p ? (side === "w" ? m.p.toUpperCase() : m.p) : p;
  if (m.castle) {
    const row = side === "w" ? 7 : 0, base = row * 8;
    if ((m.t & 7) === 6) { b[base + 5] = b[base + 7]; b[base + 7] = "."; }
    else { b[base + 3] = b[base]; b[base] = "."; }
  }
  let r = s.r;
  if (p === "K") r &= ~3;
  if (p === "k") r &= ~12;
  if (p.toLowerCase() === "r") {
    if (m.f === 56) r &= ~2; if (m.f === 63) r &= ~1;
    if (m.f === 0) r &= ~8; if (m.f === 7) r &= ~4;
  }
  const captured = s.b[m.t];
  if (captured === "R") { if (m.t === 56) r &= ~2; if (m.t === 63) r &= ~1; }
  if (captured === "r") { if (m.t === 0) r &= ~8; if (m.t === 7) r &= ~4; }
  return { b, t: side === "w" ? "b" : "w", r, ep: p.toLowerCase() === "p" && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) >> 1 : -1 };
}

function legal(s) {
  return moves(s).filter(m => !inCheck(play(s, m), s.t));
}

function material(s, perspective) {
  let n = 0;
  for (const p of s.b) if (p !== ".") {
    const x = val[p.toLowerCase()] || 0;
    n += p < "a" ? x : -x;
  }
  return perspective === "w" ? n : -n;
}

function order(s, m) {
  const q = s.b[m.t];
  return (m.p ? 800 : 0) + (q !== "." ? (val[q.toLowerCase()] || 0) * 10 - (val[s.b[m.f].toLowerCase()] || 0) : 0) + (m.ep ? 1000 : 0) + (m.castle ? 30 : 0);
}

function search(s, depth, alpha, beta, perspective) {
  const a = legal(s);
  if (!a.length) return inCheck(s, s.t) ? (s.t === perspective ? -100000 - depth : 100000 + depth) : 0;
  if (!depth) return material(s, perspective);
  a.sort((x, y) => order(s, y) - order(s, x));
  const max = s.t === perspective;
  let best = max ? -Infinity : Infinity;
  for (const m of a) {
    const z = search(play(s, m), depth - 1, alpha, beta, perspective);
    if (max) { if (z > best) best = z; if (best > alpha) alpha = best; }
    else { if (z < best) best = z; if (best < beta) beta = best; }
    if (beta <= alpha) break;
  }
  return best;
}

function uci(m) {
  return files[m.f & 7] + (8 - (m.f >> 3)) + files[m.t & 7] + (8 - (m.t >> 3)) + (m.p || "");
}

const state = parse();
const options = legal(state).sort((x, y) => order(state, y) - order(state, x));
let chosen = options[0];
let best = state.t === "w" ? -Infinity : Infinity;
for (const m of options) {
  const score = search(play(state, m), 2, -Infinity, Infinity, state.t);
  if ((state.t === "w" && score > best) || (state.t === "b" && score < best)) { best = score; chosen = m; }
}
process.stdout.write(chosen ? uci(chosen) : "0000");
