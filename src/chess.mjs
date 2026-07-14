const FILES = "abcdefgh";
const PROMOTIONS = ["q", "r", "b", "n"];

/**
 * Parse a standard FEN string.
 * @returns {{board:(string|null)[],turn:'w'|'b',castling:string,enPassant:number|null,halfmove:number,fullmove:number}}
 */
export function parseFen(fen) {
  if (typeof fen !== "string") throw new TypeError("FEN must be a string");
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6) throw new Error("FEN must contain six fields");
  const [placement, turn, castling, ep, halfmoveText, fullmoveText] = fields;
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new Error("FEN must contain eight ranks");
  const board = Array(64).fill(null);
  for (let fenRank = 0; fenRank < 8; fenRank++) {
    let file = 0;
    for (const token of ranks[fenRank]) {
      if (/^[1-8]$/.test(token)) file += Number(token);
      else if (/^[prnbqkPRNBQK]$/.test(token)) {
        if (file >= 8) throw new Error("Invalid FEN rank width");
        board[(7 - fenRank) * 8 + file++] = token;
      } else throw new Error(`Invalid FEN piece: ${token}`);
    }
    if (file !== 8) throw new Error("Invalid FEN rank width");
  }
  if (turn !== "w" && turn !== "b") throw new Error("Invalid active color");
  if (castling !== "-" && !/^(?:K?Q?k?q?)$/.test(castling)) throw new Error("Invalid castling rights");
  const enPassant = ep === "-" ? null : squareIndex(ep);
  if (ep !== "-" && !/^[a-h][36]$/.test(ep)) throw new Error("Invalid en passant square");
  const halfmove = Number(halfmoveText);
  const fullmove = Number(fullmoveText);
  if (!Number.isInteger(halfmove) || halfmove < 0 || !Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error("Invalid FEN move counters");
  }
  if (board.filter((piece) => piece === "K").length !== 1 || board.filter((piece) => piece === "k").length !== 1) {
    throw new Error("FEN must contain exactly one king per side");
  }
  return { board, turn, castling: castling === "-" ? "" : castling, enPassant, halfmove, fullmove };
}

/** Serialize a position object as a standard six-field FEN string. */
export function toFen(position) {
  validatePosition(position);
  const ranks = [];
  for (let rank = 7; rank >= 0; rank--) {
    let text = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = position.board[rank * 8 + file];
      if (!piece) empty++;
      else {
        if (empty) text += empty;
        empty = 0;
        text += piece;
      }
    }
    if (empty) text += empty;
    ranks.push(text);
  }
  return `${ranks.join("/")} ${position.turn} ${position.castling || "-"} ${position.enPassant == null ? "-" : squareName(position.enPassant)} ${position.halfmove} ${position.fullmove}`;
}

/** Return every legal move for the active color as UCI strings. */
export function generateLegalMoves(position) {
  validatePosition(position);
  const color = position.turn;
  return pseudoMoves(position).filter((move) => {
    const next = applyUnchecked(position, move);
    return !kingInCheck(next, color);
  }).map(toUci);
}

/** Apply a legal UCI move and return a new position object with the same shape as parseFen(). */
export function applyUciMove(position, uci) {
  const legal = generateLegalMoves(position);
  if (!legal.includes(uci)) throw new Error(`Illegal move: ${uci}`);
  const move = pseudoMoves(position).find((candidate) => toUci(candidate) === uci);
  return applyUnchecked(position, move);
}

/** Return whether a UCI string is legal in the supplied position. */
export function isLegalUciMove(position, uci) {
  return typeof uci === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)
    && generateLegalMoves(position).includes(uci);
}

/**
 * Classify the position.
 * @returns {{status:'ongoing'|'checkmate'|'stalemate',winner:'w'|'b'|null,inCheck:boolean}}
 */
export function terminalStatus(position) {
  const inCheck = kingInCheck(position, position.turn);
  if (generateLegalMoves(position).length) return { status: "ongoing", winner: null, inCheck };
  return inCheck
    ? { status: "checkmate", winner: opposite(position.turn), inCheck: true }
    : { status: "stalemate", winner: null, inCheck: false };
}

function validatePosition(position) {
  if (!position || !Array.isArray(position.board) || position.board.length !== 64) throw new TypeError("Invalid position");
  if (position.turn !== "w" && position.turn !== "b") throw new TypeError("Invalid position turn");
}

function pseudoMoves(position) {
  const moves = [];
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || colorOf(piece) !== position.turn) continue;
    const type = piece.toLowerCase();
    if (type === "p") pawnMoves(position, from, moves);
    else if (type === "n") jumpMoves(position, from, moves, [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
    else if (type === "b") slideMoves(position, from, moves, [[1, 1], [1, -1], [-1, 1], [-1, -1]]);
    else if (type === "r") slideMoves(position, from, moves, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
    else if (type === "q") slideMoves(position, from, moves, [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]);
    else if (type === "k") kingMoves(position, from, moves);
  }
  return moves;
}

function pawnMoves(position, from, moves) {
  const color = position.turn;
  const direction = color === "w" ? 1 : -1;
  const startRank = color === "w" ? 1 : 6;
  const promotionRank = color === "w" ? 7 : 0;
  const file = from % 8;
  const rank = Math.floor(from / 8);
  const one = from + direction * 8;
  if (inside(file, rank + direction) && !position.board[one]) {
    addPawnMove(moves, from, one, rank + direction === promotionRank);
    const two = from + direction * 16;
    if (rank === startRank && !position.board[two]) moves.push({ from, to: two });
  }
  for (const df of [-1, 1]) {
    const targetFile = file + df;
    const targetRank = rank + direction;
    if (!inside(targetFile, targetRank)) continue;
    const to = targetRank * 8 + targetFile;
    const target = position.board[to];
    const epPawn = color === "w" ? "p" : "P";
    const enPassant = to === position.enPassant && !target && position.board[to - direction * 8] === epPawn;
    if ((target && colorOf(target) !== color && target.toLowerCase() !== "k") || enPassant) {
      addPawnMove(moves, from, to, targetRank === promotionRank, enPassant);
    }
  }
}

function addPawnMove(moves, from, to, promotion, enPassant = false) {
  if (promotion) for (const promote of PROMOTIONS) moves.push({ from, to, promote });
  else moves.push({ from, to, enPassant });
}

function jumpMoves(position, from, moves, offsets) {
  const file = from % 8;
  const rank = Math.floor(from / 8);
  for (const [df, dr] of offsets) {
    if (!inside(file + df, rank + dr)) continue;
    const to = (rank + dr) * 8 + file + df;
    const target = position.board[to];
    if (!target || (colorOf(target) !== position.turn && target.toLowerCase() !== "k")) moves.push({ from, to });
  }
}

function slideMoves(position, from, moves, directions) {
  const file = from % 8;
  const rank = Math.floor(from / 8);
  for (const [df, dr] of directions) {
    for (let f = file + df, r = rank + dr; inside(f, r); f += df, r += dr) {
      const to = r * 8 + f;
      const target = position.board[to];
      if (!target) moves.push({ from, to });
      else {
        if (colorOf(target) !== position.turn && target.toLowerCase() !== "k") moves.push({ from, to });
        break;
      }
    }
  }
}

function kingMoves(position, from, moves) {
  jumpMoves(position, from, moves, [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]]);
  const color = position.turn;
  const enemy = opposite(color);
  const home = color === "w" ? 4 : 60;
  if (from !== home || attacked(position, home, enemy)) return;
  const kingRight = color === "w" ? "K" : "k";
  const queenRight = color === "w" ? "Q" : "q";
  const rook = color === "w" ? "R" : "r";
  if (position.castling.includes(kingRight) && position.board[home + 3] === rook
      && !position.board[home + 1] && !position.board[home + 2]
      && !attacked(position, home + 1, enemy) && !attacked(position, home + 2, enemy)) {
    moves.push({ from, to: home + 2, castle: "king" });
  }
  if (position.castling.includes(queenRight) && position.board[home - 4] === rook
      && !position.board[home - 1] && !position.board[home - 2] && !position.board[home - 3]
      && !attacked(position, home - 1, enemy) && !attacked(position, home - 2, enemy)) {
    moves.push({ from, to: home - 2, castle: "queen" });
  }
}

function applyUnchecked(position, move) {
  const board = position.board.slice();
  const piece = board[move.from];
  const captured = board[move.to];
  board[move.from] = null;
  if (move.enPassant) board[move.to + (position.turn === "w" ? -8 : 8)] = null;
  board[move.to] = move.promote ? (position.turn === "w" ? move.promote.toUpperCase() : move.promote) : piece;
  if (move.castle) {
    const rookFrom = move.castle === "king" ? move.from + 3 : move.from - 4;
    const rookTo = move.castle === "king" ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  let castling = position.castling;
  if (piece.toLowerCase() === "k") castling = strip(castling, position.turn === "w" ? "KQ" : "kq");
  const rightsBySquare = { 0: "Q", 7: "K", 56: "q", 63: "k" };
  if (piece.toLowerCase() === "r" && rightsBySquare[move.from]) castling = strip(castling, rightsBySquare[move.from]);
  if (captured?.toLowerCase() === "r" && rightsBySquare[move.to]) castling = strip(castling, rightsBySquare[move.to]);
  const enPassant = piece.toLowerCase() === "p" && Math.abs(move.to - move.from) === 16 ? (move.to + move.from) / 2 : null;
  const halfmove = piece.toLowerCase() === "p" || captured || move.enPassant ? 0 : position.halfmove + 1;
  return {
    board,
    turn: opposite(position.turn),
    castling,
    enPassant,
    halfmove,
    fullmove: position.fullmove + (position.turn === "b" ? 1 : 0),
  };
}

function kingInCheck(position, color) {
  const king = position.board.indexOf(color === "w" ? "K" : "k");
  if (king < 0) return true;
  return attacked(position, king, opposite(color));
}

function attacked(position, square, byColor) {
  const file = square % 8;
  const rank = Math.floor(square / 8);
  const pawn = byColor === "w" ? "P" : "p";
  const pawnSourceRank = rank + (byColor === "w" ? -1 : 1);
  for (const df of [-1, 1]) if (inside(file + df, pawnSourceRank) && position.board[pawnSourceRank * 8 + file + df] === pawn) return true;
  const knight = byColor === "w" ? "N" : "n";
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    if (inside(file + df, rank + dr) && position.board[(rank + dr) * 8 + file + df] === knight) return true;
  }
  const king = byColor === "w" ? "K" : "k";
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if ((df || dr) && inside(file + df, rank + dr) && position.board[(rank + dr) * 8 + file + df] === king) return true;
  }
  return rayAttacked(position, file, rank, byColor, [[1, 0], [-1, 0], [0, 1], [0, -1]], "rq")
    || rayAttacked(position, file, rank, byColor, [[1, 1], [1, -1], [-1, 1], [-1, -1]], "bq");
}

function rayAttacked(position, file, rank, color, directions, types) {
  for (const [df, dr] of directions) {
    for (let f = file + df, r = rank + dr; inside(f, r); f += df, r += dr) {
      const piece = position.board[r * 8 + f];
      if (!piece) continue;
      if (colorOf(piece) === color && types.includes(piece.toLowerCase())) return true;
      break;
    }
  }
  return false;
}

function squareIndex(square) {
  if (!/^[a-h][1-8]$/.test(square)) throw new Error(`Invalid square: ${square}`);
  return (Number(square[1]) - 1) * 8 + FILES.indexOf(square[0]);
}

function squareName(index) { return FILES[index % 8] + (Math.floor(index / 8) + 1); }
function toUci(move) { return squareName(move.from) + squareName(move.to) + (move.promote || ""); }
function colorOf(piece) { return piece === piece.toUpperCase() ? "w" : "b"; }
function opposite(color) { return color === "w" ? "b" : "w"; }
function inside(file, rank) { return file >= 0 && file < 8 && rank >= 0 && rank < 8; }
function strip(rights, chars) { return [...rights].filter((right) => !chars.includes(right)).join(""); }
