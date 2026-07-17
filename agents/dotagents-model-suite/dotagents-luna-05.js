import { stdin, stdout } from 'node:process';

const input = await new Promise((resolve, reject) => {
  let s = '';
  stdin.setEncoding('utf8');
  stdin.on('data', x => s += x);
  stdin.on('end', () => resolve(s));
  stdin.on('error', reject);
});
const fields = input.trim().split(/\s+/);
const board = Array(64).fill('.');
const ranks = fields[0].split('/');
for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const ch of ranks[row]) {
    if (ch >= '1' && ch <= '8') file += +ch;
    else board[(7 - row) * 8 + file++] = ch;
  }
}
const white = fields[1] === 'w';
const rights = fields[2] || '-';
const ep = fields[3] && fields[3] !== '-' ?
  (fields[3].charCodeAt(0) - 97) + 8 * (+fields[3][1] - 1) : -1;

const knightSteps = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const kingSteps = [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
const bishopDirs = [[1,1],[1,-1],[-1,1],[-1,-1]];
const rookDirs = [[1,0],[-1,0],[0,1],[0,-1]];
const isWhite = p => p !== '.' && p === p.toUpperCase();

function attacked(s, byWhite, b) {
  const r = s >> 3, f = s & 7;
  const pawn = byWhite ? 'P' : 'p';
  const pr = byWhite ? r - 1 : r + 1;
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const knight = byWhite ? 'N' : 'n';
  for (const [df, dr] of knightSteps) {
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === knight) return true;
  }
  const king = byWhite ? 'K' : 'k';
  for (const [df, dr] of kingSteps) {
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === king) return true;
  }
  const sliders = (dirs, a, q) => {
    for (const [df, dr] of dirs) {
      let x = f + df, y = r + dr;
      while (x >= 0 && x < 8 && y >= 0 && y < 8) {
        const p = b[y * 8 + x];
        if (p !== '.') {
          if (p === a || p === q) return true;
          break;
        }
        x += df; y += dr;
      }
    }
    return false;
  };
  return sliders(bishopDirs, byWhite ? 'B' : 'b', byWhite ? 'Q' : 'q') ||
         sliders(rookDirs, byWhite ? 'R' : 'r', byWhite ? 'Q' : 'q');
}

function play(m, b, sideWhite) {
  const x = b.slice(), p = x[m.f];
  x[m.f] = '.';
  if (m.ep) x[m.t + (sideWhite ? -8 : 8)] = '.';
  if (m.castle) {
    const rf = m.t > m.f ? m.f + 3 : m.f - 4;
    const rt = m.t > m.f ? m.f + 1 : m.f - 1;
    x[rt] = x[rf]; x[rf] = '.';
  }
  x[m.t] = m.promote ? (sideWhite ? m.promote.toUpperCase() : m.promote) : p;
  return x;
}

function moves(b, sideWhite) {
  const out = [], own = sideWhite ? /[A-Z]/ : /[a-z]/;
  const add = (f, t, extra = {}) => out.push({ f, t, ...extra });
  const promotions = ['q', 'r', 'b', 'n'];
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (p === '.' || !own.test(p)) continue;
    const r = s >> 3, f = s & 7, low = p.toLowerCase();
    if (low === 'p') {
      const d = sideWhite ? 8 : -8, start = sideWhite ? 1 : 6;
      const nr = r + (sideWhite ? 1 : -1);
      if (nr >= 0 && nr < 8 && b[s + d] === '.') {
        if (nr === 0 || nr === 7) for (const promote of promotions) add(s, s + d, { promote });
        else add(s, s + d);
        if (r === start && b[s + 2 * d] === '.') add(s, s + 2 * d);
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const t = s + d + df, target = b[t];
        if ((target !== '.' && isWhite(target) !== sideWhite) || t === ep) {
          const extra = t === ep ? { ep: true } : {};
          if (nr === 0 || nr === 7) for (const promote of promotions) add(s, t, { ...extra, promote });
          else add(s, t, extra);
        }
      }
    } else if (low === 'n') {
      for (const [df, dr] of knightSteps) {
        const x = f + df, y = r + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8 &&
            (b[y * 8 + x] === '.' || isWhite(b[y * 8 + x]) !== sideWhite)) add(s, y * 8 + x);
      }
    } else if (low === 'b' || low === 'r' || low === 'q') {
      const dirs = low === 'b' ? bishopDirs : low === 'r' ? rookDirs : bishopDirs.concat(rookDirs);
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const t = y * 8 + x, target = b[t];
          if (target === '.') add(s, t);
          else { if (isWhite(target) !== sideWhite) add(s, t); break; }
          x += df; y += dr;
        }
      }
    } else if (low === 'k') {
      for (const [df, dr] of kingSteps) {
        const x = f + df, y = r + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8 &&
            (b[y * 8 + x] === '.' || isWhite(b[y * 8 + x]) !== sideWhite)) add(s, y * 8 + x);
      }
      const enemy = !sideWhite;
      const safe = t => {
        const z = b.slice();
        z[s] = '.'; z[t] = sideWhite ? 'K' : 'k';
        return !attacked(t, enemy, z);
      };
      if (!attacked(s, enemy, b)) {
        const rank = sideWhite ? 0 : 7;
        if (s === rank * 8 + 4) {
          if (rights.includes(sideWhite ? 'K' : 'k') && b[s + 1] === '.' && b[s + 2] === '.' &&
              b[s + 3] === (sideWhite ? 'R' : 'r') && safe(s + 1) && safe(s + 2))
            add(s, s + 2, { castle: true });
          if (rights.includes(sideWhite ? 'Q' : 'q') && b[s - 1] === '.' && b[s - 2] === '.' && b[s - 3] === '.' &&
              b[s - 4] === (sideWhite ? 'R' : 'r') && safe(s - 1) && safe(s - 2))
            add(s, s - 2, { castle: true });
        }
      }
    }
  }
  return out;
}

function kingSquare(b, sideWhite) {
  const k = sideWhite ? 'K' : 'k';
  return b.indexOf(k);
}

const legal = moves(board, white).filter(m => {
  const after = play(m, board, white);
  const k = kingSquare(after, white);
  return k >= 0 && !attacked(k, !white, after);
});
const m = legal[0];
const square = s => String.fromCharCode(97 + (s & 7)) + (1 + (s >> 3));
stdout.write(square(m.f) + square(m.t) + (m.promote || ''));
