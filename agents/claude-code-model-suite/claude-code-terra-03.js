import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const board = Array(64).fill('.');
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const x of rows[r]) {
    if (x >= '1' && x <= '8') f += +x;
    else board[r * 8 + f++] = x;
  }
}
const turn = fen[1] === 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? sq(fen[3]) : -1;

function sq(s) {
  return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97;
}
function uci(n) {
  return String.fromCharCode(97 + n % 8) + (8 - Math.floor(n / 8));
}
function isWhite(p) {
  return p >= 'A' && p <= 'Z';
}
function same(p, side) {
  return p !== '.' && isWhite(p) === side;
}
function enemy(p, side) {
  return p !== '.' && isWhite(p) !== side && p.toLowerCase() !== 'k';
}
function attacked(b, target, byWhite) {
  const tr = Math.floor(target / 8), tf = target % 8;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!same(p, byWhite)) continue;
    const q = p.toLowerCase(), r = Math.floor(s / 8), f = s % 8;
    if (q === 'p') {
      if (tr === r + (byWhite ? -1 : 1) && Math.abs(tf - f) === 1) return true;
    } else if (q === 'n') {
      const dr = Math.abs(tr - r), df = Math.abs(tf - f);
      if ((dr === 1 && df === 2) || (dr === 2 && df === 1)) return true;
    } else if (q === 'k') {
      if (Math.max(Math.abs(tr - r), Math.abs(tf - f)) === 1) return true;
    } else {
      const dr = tr - r, df = tf - f;
      let ok = false;
      if (q === 'b') ok = Math.abs(dr) === Math.abs(df) && dr !== 0;
      if (q === 'r') ok = (dr === 0) !== (df === 0);
      if (q === 'q') ok = (Math.abs(dr) === Math.abs(df) && dr !== 0) || ((dr === 0) !== (df === 0));
      if (!ok) continue;
      const sr = Math.sign(dr), sf = Math.sign(df);
      let rr = r + sr, ff = f + sf, clear = true;
      while (rr !== tr || ff !== tf) {
        if (b[rr * 8 + ff] !== '.') { clear = false; break; }
        rr += sr; ff += sf;
      }
      if (clear) return true;
    }
  }
  return false;
}
function apply(b, m) {
  const n = b.slice();
  const piece = n[m.f];
  n[m.f] = '.';
  if (m.e) n[m.t + (isWhite(piece) ? 8 : -8)] = '.';
  n[m.t] = m.p || piece;
  if (piece.toLowerCase() === 'k' && Math.abs(m.t - m.f) === 2) {
    if (m.t > m.f) {
      n[m.t - 1] = n[m.t + 1];
      n[m.t + 1] = '.';
    } else {
      n[m.t + 1] = n[m.t - 2];
      n[m.t - 2] = '.';
    }
  }
  return n;
}
function safeStep(b, from, to, side) {
  const n = b.slice();
  n[to] = n[from];
  n[from] = '.';
  return !attacked(n, to, !side);
}
function pseudo(b, side) {
  const out = [];
  const add = (f, t, extra = {}) => {
    const p = b[f];
    if (p.toLowerCase() === 'p' && (Math.floor(t / 8) === 0 || Math.floor(t / 8) === 7)) {
      for (const z of 'qrbn') out.push({ f, t, ...extra, p: side ? z.toUpperCase() : z });
    } else out.push({ f, t, ...extra });
  };
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!same(p, side)) continue;
    const kind = p.toLowerCase(), r = Math.floor(s / 8), f = s % 8;
    if (kind === 'p') {
      const d = side ? -8 : 8, start = side ? 6 : 1, one = s + d;
      if (one >= 0 && one < 64 && b[one] === '.') {
        add(s, one);
        const two = s + 2 * d;
        if (r === start && b[two] === '.') add(s, two);
      }
      for (const df of [-1, 1]) {
        const nf = f + df, t = s + d + df;
        if (nf < 0 || nf > 7 || t < 0 || t >= 64) continue;
        if (enemy(b[t], side)) add(s, t);
        else if (t === ep) add(s, t, { e: true });
      }
    } else if (kind === 'n') {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const t = rr * 8 + ff;
          if (!same(b[t], side) && b[t].toLowerCase() !== 'k') add(s, t);
        }
      }
    } else if (kind === 'b' || kind === 'r' || kind === 'q') {
      const dirs = [];
      if (kind !== 'r') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      if (kind !== 'b') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const t = rr * 8 + ff;
          if (same(b[t], side)) break;
          if (b[t].toLowerCase() !== 'k') add(s, t);
          if (b[t] !== '.') break;
          rr += dr; ff += df;
        }
      }
    } else if (kind === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const t = rr * 8 + ff;
          if (!same(b[t], side) && b[t].toLowerCase() !== 'k') add(s, t);
        }
      }
      const home = side ? 60 : 4, rookK = side ? 63 : 7, rookQ = side ? 56 : 0;
      const rk = side ? 'K' : 'k', rq = side ? 'Q' : 'q';
      if (s === home && !attacked(b, home, !side)) {
        if (rights.includes(rk) && b[rookK] === (side ? 'R' : 'r') &&
            b[home + 1] === '.' && b[home + 2] === '.' &&
            safeStep(b, home, home + 1, side)) add(home, home + 2);
        if (rights.includes(rq) && b[rookQ] === (side ? 'R' : 'r') &&
            b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.' &&
            safeStep(b, home, home - 1, side)) add(home, home - 2);
      }
    }
  }
  return out;
}
const legal = pseudo(board, turn).filter(m => {
  const n = apply(board, m);
  const k = n.indexOf(turn ? 'K' : 'k');
  return k >= 0 && !attacked(n, k, !turn);
});
if (legal.length) {
  const m = legal[0];
  process.stdout.write(uci(m.f) + uci(m.t) + (m.p ? m.p.toLowerCase() : '') + '\n');
}