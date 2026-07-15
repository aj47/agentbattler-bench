import { readFileSync } from 'fs';

const FILES = 'abcdefgh';
const RANKS = '12345678';

class ChessAgent {
  constructor() {
    this.board = Array(8).fill(null).map(() => Array(8).fill(null));
    this.turn = 'w';
    this.castling = { K: true, Q: true, k: true, q: true };
    this.enPassant = null;
    this.halfMove = 0;
    this.fullMove = 1;
  }

  parseFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const boardPart = parts[0];
    this.turn = parts[1] || 'w';
    const castlingPart = parts[2] || 'KQkq';
    this.enPassant = parts[3] || null;
    this.halfMove = parseInt(parts[4] || '0');
    this.fullMove = parseInt(parts[5] || '1');

    this.castling = { K: false, Q: false, k: false, q: false };
    for (const c of castlingPart) {
      if (c in this.castling) this.castling[c] = true;
    }

    let row = 0, col = 0;
    for (const char of boardPart) {
      if (char === '/') {
        row++;
        col = 0;
      } else if (char >= '1' && char <= '8') {
        col += parseInt(char);
      } else {
        this.board[row][col] = this.parsePiece(char);
        col++;
      }
    }
  }

  parsePiece(char) {
    const color = char === char.toUpperCase() ? 'w' : 'b';
    const type = char.toLowerCase();
    return { color, type };
  }

  getPiece(row, col) {
    if (row < 0 || row > 7 || col < 0 || col > 7) return null;
    return this.board[row][col];
  }

  isEmpty(row, col) {
    return this.getPiece(row, col) === null;
  }

  isEnemy(row, col, color) {
    const piece = this.getPiece(row, col);
    return piece && piece.color !== color;
  }

  isFriendly(row, col, color) {
    const piece = this.getPiece(row, col);
    return piece && piece.color === color;
  }

  generateMoves() {
    const moves = [];
    const color = this.turn;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = this.board[row][col];
        if (piece && piece.color === color) {
          this.generatePieceMoves(row, col, piece, moves);
        }
      }
    }
    return moves.filter(m => this.isLegal(m));
  }

  generatePieceMoves(row, col, piece, moves) {
    switch (piece.type) {
      case 'p': this.generatePawnMoves(row, col, piece, moves); break;
      case 'n': this.generateKnightMoves(row, col, piece, moves); break;
      case 'b': this.generateBishopMoves(row, col, piece, moves); break;
      case 'r': this.generateRookMoves(row, col, piece, moves); break;
      case 'q': this.generateQueenMoves(row, col, piece, moves); break;
      case 'k': this.generateKingMoves(row, col, piece, moves); break;
    }
  }

  generatePawnMoves(row, col, piece, moves) {
    const dir = piece.color === 'w' ? -1 : 1;
    const startRow = piece.color === 'w' ? 6 : 1;
    const promRow = piece.color === 'w' ? 0 : 7;

    const newRow = row + dir;
    if (newRow >= 0 && newRow <= 8 && this.isEmpty(newRow, col)) {
      if (newRow === promRow) {
        moves.push({ from: { row, col }, to: { row: newRow, col }, promotion: 'q' });
        moves.push({ from: { row, col }, to: { row: newRow, col }, promotion: 'r' });
        moves.push({ from: { row, col }, to: { row: newRow, col }, promotion: 'b' });
        moves.push({ from: { row, col }, to: { row: newRow, col }, promotion: 'n' });
      } else {
        moves.push({ from: { row, col }, to: { row: newRow, col } });
      }
      if (row === startRow && this.isEmpty(row + 2 * dir, col)) {
        moves.push({ from: { row, col }, to: { row: row + 2 * dir, col } });
      }
    }

    for (const dc of [-1, 1]) {
      const newCol = col + dc;
      if (newCol >= 0 && newCol <= 7) {
        if (this.isEnemy(newRow, newCol, piece.color)) {
          if (newRow === promRow) {
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol }, promotion: 'q' });
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol }, promotion: 'r' });
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol }, promotion: 'b' });
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol }, promotion: 'n' });
          } else {
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol } });
          }
        }
        if (this.enPassant) {
          const epCol = FILES.indexOf(this.enPassant[0]);
          const epRow = parseInt(this.enPassant[1]) - 1;
          if (newRow === epRow && newCol === epCol) {
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol }, enPassant: true });
          }
        }
      }
    }
  }

  generateKnightMoves(row, col, piece, moves) {
    const offsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of offsets) {
      const newRow = row + dr, newCol = col + dc;
      if (newRow >= 0 && newRow <= 7 && newCol >= 0 && newCol <= 7) {
        if (this.isEmpty(newRow, newCol) || this.isEnemy(newRow, newCol, piece.color)) {
          moves.push({ from: { row, col }, to: { row: newRow, col: newCol } });
        }
      }
    }
  }

  generateSlidingMoves(row, col, piece, moves, directions) {
    for (const [dr, dc] of directions) {
      let newRow = row + dr, newCol = col + dc;
      while (newRow >= 0 && newRow <= 7 && newCol >= 0 && newCol <= 7) {
        if (this.isEmpty(newRow, newCol)) {
          moves.push({ from: { row, col }, to: { row: newRow, col: newCol } });
        } else {
          if (this.isEnemy(newRow, newCol, piece.color)) {
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol } });
          }
          break;
        }
        newRow += dr;
        newCol += dc;
      }
    }
  }

  generateBishopMoves(row, col, piece, moves) {
    this.generateSlidingMoves(row, col, piece, moves, [[-1,-1],[-1,1],[1,-1],[1,1]]);
  }

  generateRookMoves(row, col, piece, moves) {
    this.generateSlidingMoves(row, col, piece, moves, [[-1,0],[1,0],[0,-1],[0,1]]);
  }

  generateQueenMoves(row, col, piece, moves) {
    this.generateSlidingMoves(row, col, piece, moves, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
  }

  generateKingMoves(row, col, piece, moves) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const newRow = row + dr, newCol = col + dc;
        if (newRow >= 0 && newRow <= 7 && newCol >= 0 && newCol <= 7) {
          if (this.isEmpty(newRow, newCol) || this.isEnemy(newRow, newCol, piece.color)) {
            moves.push({ from: { row, col }, to: { row: newRow, col: newCol } });
          }
        }
      }
    }

    if (piece.color === 'w') {
      if (this.castling.K && this.isEmpty(7, 5) && this.isEmpty(7, 6) && this.board[7][7]?.type === 'r') {
        if (!this.isSquareAttacked(7, 4, 'b') && !this.isSquareAttacked(7, 5, 'b') && !this.isSquareAttacked(7, 6, 'b')) {
          moves.push({ from: { row: 7, col: 4 }, to: { row: 7, col: 6 }, castling: 'K' });
        }
      }
      if (this.castling.Q && this.isEmpty(7, 1) && this.isEmpty(7, 2) && this.isEmpty(7, 3) && this.board[7][0]?.type === 'r') {
        if (!this.isSquareAttacked(7, 4, 'b') && !this.isSquareAttacked(7, 3, 'b') && !this.isSquareAttacked(7, 2, 'b')) {
          moves.push({ from: { row: 7, col: 4 }, to: { row: 7, col: 2 }, castling: 'Q' });
        }
      }
    } else {
      if (this.castling.k && this.isEmpty(0, 5) && this.isEmpty(0, 6) && this.board[0][7]?.type === 'r') {
        if (!this.isSquareAttacked(0, 4, 'w') && !this.isSquareAttacked(0, 5, 'w') && !this.isSquareAttacked(0, 6, 'w')) {
          moves.push({ from: { row: 0, col: 4 }, to: { row: 0, col: 6 }, castling: 'k' });
        }
      }
      if (this.castling.q && this.isEmpty(0, 1) && this.isEmpty(0, 2) && this.isEmpty(0, 3) && this.board[0][0]?.type === 'r') {
        if (!this.isSquareAttacked(0, 4, 'w') && !this.isSquareAttacked(0, 3, 'w') && !this.isSquareAttacked(0, 2, 'w')) {
          moves.push({ from: { row: 0, col: 4 }, to: { row: 0, col: 2 }, castling: 'q' });
        }
      }
    }
  }

  isSquareAttacked(row, col, byColor) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = this.board[r][c];
        if (piece && piece.color === byColor) {
          if (this.canAttack(r, c, row, col)) return true;
        }
      }
    }
    return false;
  }

  canAttack(fromRow, fromCol, toRow, toCol) {
    const piece = this.board[fromRow][fromCol];
    const dr = toRow - fromRow;
    const dc = toCol - fromCol;
    const absDr = Math.abs(dr);
    const absDc = Math.abs(dc);

    switch (piece.type) {
      case 'p':
        const dir = piece.color === 'w' ? -1 : 1;
        return dr === dir && absDc === 1;
      case 'n':
        return (absDr === 2 && absDc === 1) || (absDr === 1 && absDc === 2);
      case 'b':
        if (absDr !== absDc) return false;
        return this.isPathClear(fromRow, fromCol, toRow, toCol);
      case 'r':
        if (dr !== 0 && dc !== 0) return false;
        return this.isPathClear(fromRow, fromCol, toRow, toCol);
      case 'q':
        if (dr !== 0 && dc !== 0 && absDr !== absDc) return false;
        return this.isPathClear(fromRow, fromCol, toRow, toCol);
      case 'k':
        return absDr <= 1 && absDc <= 1;
    }
    return false;
  }

  isPathClear(fromRow, fromCol, toRow, toCol) {
    const dr = Math.sign(toRow - fromRow);
    const dc = Math.sign(toCol - fromCol);
    let r = fromRow + dr, c = fromCol + dc;
    while (r !== toRow || c !== toCol) {
      if (!this.isEmpty(r, c)) return false;
      r += dr;
      c += dc;
    }
    return true;
  }

  findKing(color) {
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = this.board[row][col];
        if (piece && piece.color === color && piece.type === 'k') {
          return { row, col };
        }
      }
    }
    return null;
  }

  isInCheck(color) {
    const king = this.findKing(color);
    if (!king) return false;
    const enemyColor = color === 'w' ? 'b' : 'w';
    return this.isSquareAttacked(king.row, king.col, enemyColor);
  }

  makeMove(move) {
    const piece = this.board[move.from.row][move.from.col];
    const captured = this.board[move.to.row][move.to.col];
    
    this.board[move.to.row][move.to.col] = piece;
    this.board[move.from.row][move.from.col] = null;

    if (move.promotion) {
      this.board[move.to.row][move.to.col] = { color: piece.color, type: move.promotion };
    }

    if (move.enPassant) {
      const captureRow = move.from.row;
      this.board[captureRow][move.to.col] = null;
    }

    if (move.castling) {
      if (move.castling === 'K') {
        this.board[7][5] = this.board[7][7];
        this.board[7][7] = null;
      } else if (move.castling === 'Q') {
        this.board[7][3] = this.board[7][0];
        this.board[7][0] = null;
      } else if (move.castling === 'k') {
        this.board[0][5] = this.board[0][7];
        this.board[0][7] = null;
      } else if (move.castling === 'q') {
        this.board[0][3] = this.board[0][0];
        this.board[0][0] = null;
      }
    }

    const oldTurn = this.turn;
    this.turn = this.turn === 'w' ? 'b' : 'w';

    return { piece, captured, oldTurn };
  }

  undoMove(move, undoInfo) {
    const { piece, captured, oldTurn } = undoInfo;
    
    this.board[move.from.row][move.from.col] = piece;
    this.board[move.to.row][move.to.col] = captured;

    if (move.castling) {
      if (move.castling === 'K') {
        this.board[7][7] = this.board[7][5];
        this.board[7][5] = null;
      } else if (move.castling === 'Q') {
        this.board[7][0] = this.board[7][3];
        this.board[7][3] = null;
      } else if (move.castling === 'k') {
        this.board[0][7] = this.board[0][5];
        this.board[0][5] = null;
      } else if (move.castling === 'q') {
        this.board[0][0] = this.board[0][3];
        this.board[0][3] = null;
      }
    }

    if (move.enPassant) {
      const captureRow = move.from.row;
      this.board[captureRow][move.to.col] = { color: oldTurn, type: 'p' };
    }

    this.turn = oldTurn;
  }

  isLegal(move) {
    const undoInfo = this.makeMove(move);
    const legal = !this.isInCheck(this.turn);
    this.undoMove(move, undoInfo);
    return legal;
  }

  moveToUCI(move) {
    let uci = FILES[move.from.col] + (move.from.row + 1) + FILES[move.to.col] + (move.to.row + 1);
    if (move.promotion) uci += move.promotion;
    return uci;
  }

  selectMove(moves) {
    if (moves.length === 0) return null;
    return moves[Math.floor(Math.random() * moves.length)];
  }
}

const fen = readFileSync(0, 'utf-8').trim();
const agent = new ChessAgent();
agent.parseFEN(fen);
const moves = agent.generateMoves();
const move = agent.selectMove(moves);
if (move) {
  console.log(agent.moveToUCI(move));
}