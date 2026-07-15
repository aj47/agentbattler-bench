import { createReadStream } from 'fs';

const FILES = 'abcdefgh';
const RANKS = '87654321';

function squareToIndex(square) {
    return (8 - parseInt(square[1])) * 8 + (square.charCodeAt(0) - 97);
}

function indexToSquare(index) {
    return FILES[index % 8] + (8 - Math.floor(index / 8));
}

function parseFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let index = 0;
    for (const char of parts[0]) {
        if (char === '/') continue;
        if (/\d/.test(char)) {
            index += parseInt(char);
        } else {
            board[index++] = char;
        }
    }
    return {
        board,
        turn: parts[1] === 'w' ? 'white' : 'black',
        castling: {
            K: parts[2].includes('K'), Q: parts[2].includes('Q'),
            k: parts[2].includes('k'), q: parts[2].includes('q')
        },
        enPassant: parts[3] === '-' ? null : squareToIndex(parts[3]),
        halfMoveClock: parseInt(parts[4]) || 0,
        fullMoveNumber: parseInt(parts[5]) || 1
    };
}

function isWhite(piece) { return piece && piece === piece.toUpperCase(); }
function isBlack(piece) { return piece && piece === piece.toLowerCase(); }
function getPieceColor(piece) {
    if (!piece) return null;
    return isWhite(piece) ? 'white' : 'black';
}
function getPieceType(piece) { return piece ? piece.toLowerCase() : null; }

function onBoard(index) { return index >= 0 && index < 64; }
function getFile(index) { return index % 8; }
function getRank(index) { return Math.floor(index / 8); }

const PAWN_OFFSETS = { white: [-8, -16, -7, -9], black: [8, 16, 7, 9] };
const KNIGHT_OFFSETS = [-17, -15, -10, -6, 6, 10, 15, 17];
const BISHOP_OFFSETS = [-9, -7, 7, 9];
const ROOK_OFFSETS = [-8, -1, 1, 8];
const KING_OFFSETS = [-9, -8, -7, -1, 1, 7, 8, 9];

function isPawnStartRank(index, color) {
    return color === 'white' ? getRank(index) === 6 : getRank(index) === 1;
}

function isValidPawnMove(from, to, color, board, enPassant) {
    const direction = color === 'white' ? -1 : 1;
    const forward = from + direction * 8;
    const forwardTwo = from + direction * 16;
    
    if (to === forward && !board[to]) return true;
    if (to === forwardTwo && isPawnStartRank(from, color) && !board[forward] && !board[to]) return true;
    
    const captureLeft = from + direction * 8 - 1;
    const captureRight = from + direction * 8 + 1;
    
    if (to === captureLeft || to === captureRight) {
        if (board[to] && getPieceColor(board[to]) !== color) return true;
        if (to === enPassant) return true;
    }
    
    return false;
}

function getSlidingMoves(from, offsets, board, color) {
    const moves = [];
    for (const offset of offsets) {
        let to = from + offset;
        while (onBoard(to)) {
            const fileDiff = Math.abs(getFile(to) - getFile(from));
            const rankDiff = Math.abs(getRank(to) - getRank(from));
            
            if (offset === -7 || offset === 7 || offset === -9 || offset === 9) {
                if (fileDiff !== rankDiff) break;
            }
            if (offset === -1 || offset === 1) {
                if (getRank(to) !== getRank(from)) break;
            }
            if (offset === -8 || offset === 8) {
                if (getFile(to) !== getFile(from)) break;
            }
            
            if (board[to]) {
                if (getPieceColor(board[to]) !== color) moves.push(to);
                break;
            }
            moves.push(to);
            to += offset;
        }
    }
    return moves;
}

function getKnightMoves(from, board, color) {
    const moves = [];
    for (const offset of KNIGHT_OFFSETS) {
        const to = from + offset;
        if (!onBoard(to)) continue;
        const fileDiff = Math.abs(getFile(to) - getFile(from));
        const rankDiff = Math.abs(getRank(to) - getRank(from));
        if (fileDiff > 2 || rankDiff > 2) continue;
        if (!board[to] || getPieceColor(board[to]) !== color) {
            moves.push(to);
        }
    }
    return moves;
}

function getKingMoves(from, board, color) {
    const moves = [];
    for (const offset of KING_OFFSETS) {
        const to = from + offset;
        if (!onBoard(to)) continue;
        const fileDiff = Math.abs(getFile(to) - getFile(from));
        const rankDiff = Math.abs(getRank(to) - getRank(from));
        if (fileDiff > 1 || rankDiff > 1) continue;
        if (!board[to] || getPieceColor(board[to]) !== color) {
            moves.push(to);
        }
    }
    return moves;
}

function getPawnMoves(from, board, color, enPassant) {
    const moves = [];
    const direction = color === 'white' ? -1 : 1;
    const forward = from + direction * 8;
    
    if (onBoard(forward) && !board[forward]) {
        moves.push(forward);
        const forwardTwo = from + direction * 16;
        if (isPawnStartRank(from, color) && !board[forwardTwo]) {
            moves.push(forwardTwo);
        }
    }
    
    const captureLeft = from + direction * 8 - 1;
    const captureRight = from + direction * 8 + 1;
    
    for (const to of [captureLeft, captureRight]) {
        if (!onBoard(to)) continue;
        if (getFile(to) === getFile(from)) continue;
        if (board[to] && getPieceColor(board[to]) !== color) {
            moves.push(to);
        } else if (to === enPassant) {
            moves.push(to);
        }
    }
    
    return moves;
}

function findKing(board, color) {
    const king = color === 'white' ? 'K' : 'k';
    for (let i = 0; i < 64; i++) {
        if (board[i] === king) return i;
    }
    return -1;
}

function isSquareAttacked(square, board, byColor) {
    const pawnDir = byColor === 'white' ? 8 : -8;
    const pawnAttacks = [square + pawnDir - 1, square + pawnDir + 1];
    for (const attack of pawnAttacks) {
        if (onBoard(attack)) {
            const piece = board[attack];
            if (piece && getPieceType(piece) === 'p' && getPieceColor(piece) === byColor) {
                return true;
            }
        }
    }
    
    for (const offset of KNIGHT_OFFSETS) {
        const to = square + offset;
        if (onBoard(to)) {
            const piece = board[to];
            if (piece && getPieceType(piece) === 'n' && getPieceColor(piece) === byColor) {
                return true;
            }
        }
    }
    
    for (const offsets of [BISHOP_OFFSETS, ROOK_OFFSETS]) {
        for (const offset of offsets) {
            let to = square + offset;
            while (onBoard(to)) {
                const fileDiff = Math.abs(getFile(to) - getFile(square));
                const rankDiff = Math.abs(getRank(to) - getRank(square));
                
                if (offset === -7 || offset === 7 || offset === -9 || offset === 9) {
                    if (fileDiff !== rankDiff) break;
                }
                if (offset === -1 || offset === 1) {
                    if (getRank(to) !== getRank(square)) break;
                }
                if (offset === -8 || offset === 8) {
                    if (getFile(to) !== getFile(square)) break;
                }
                
                if (board[to]) {
                    const piece = board[to];
                    const type = getPieceType(piece);
                    if (getPieceColor(piece) === byColor) {
                        if ((offsets === BISHOP_OFFSETS && (type === 'b' || type === 'q')) ||
                            (offsets === ROOK_OFFSETS && (type === 'r' || type === 'q'))) {
                            return true;
                        }
                    }
                    break;
                }
                to += offset;
            }
        }
    }
    
    for (const offset of KING_OFFSETS) {
        const to = square + offset;
        if (onBoard(to)) {
            const piece = board[to];
            if (piece && getPieceType(piece) === 'k' && getPieceColor(piece) === byColor) {
                return true;
            }
        }
    }
    
    return false;
}

function isInCheck(board, color) {
    const kingSquare = findKing(board, color);
    if (kingSquare === -1) return false;
    const opponentColor = color === 'white' ? 'black' : 'white';
    return isSquareAttacked(kingSquare, board, opponentColor);
}

function makeMove(board, from, to, color, enPassant, promotion) {
    const newBoard = [...board];
    const piece = newBoard[from];
    newBoard[from] = null;
    
    if (promotion) {
        newBoard[to] = color === 'white' ? promotion.toUpperCase() : promotion.toLowerCase();
    } else {
        newBoard[to] = piece;
    }
    
    if (getPieceType(piece) === 'p' && to === enPassant) {
        const capturedPawn = to + (color === 'white' ? 8 : -8);
        newBoard[capturedPawn] = null;
    }
    
    return newBoard;
}

function getCastlingMoves(state) {
    const moves = [];
    const { board, turn, castling } = state;
    const kingSquare = findKing(board, turn);
    if (kingSquare === -1) return moves;
    
    if (isInCheck(board, turn)) return moves;
    
    const homeRank = turn === 'white' ? 7 : 0;
    const kingFile = 4;
    
    if (kingSquare !== homeRank * 8 + kingFile) return moves;
    
    const kingside = castling[turn === 'white' ? 'K' : 'k'];
    const queenside = castling[turn === 'white' ? 'Q' : 'q'];
    
    if (kingside) {
        const rookSquare = homeRank * 8 + 7;
        if (board[rookSquare] && getPieceType(board[rookSquare]) === 'r') {
            let pathClear = true;
            for (let f = 5; f <= 6; f++) {
                if (board[homeRank * 8 + f]) pathClear = false;
            }
            if (pathClear && !isSquareAttacked(homeRank * 8 + 5, board, turn === 'white' ? 'black' : 'white') &&
                !isSquareAttacked(homeRank * 8 + 6, board, turn === 'white' ? 'black' : 'white')) {
                moves.push({ from: kingSquare, to: homeRank * 8 + 6, castling: 'kingside' });
            }
        }
    }
    
    if (queenside) {
        const rookSquare = homeRank * 8 + 0;
        if (board[rookSquare] && getPieceType(board[rookSquare]) === 'r') {
            let pathClear = true;
            for (let f = 1; f <= 3; f++) {
                if (board[homeRank * 8 + f]) pathClear = false;
            }
            if (pathClear && !isSquareAttacked(homeRank * 8 + 3, board, turn === 'white' ? 'black' : 'white') &&
                !isSquareAttacked(homeRank * 8 + 2, board, turn === 'white' ? 'black' : 'white')) {
                moves.push({ from: kingSquare, to: homeRank * 8 + 2, castling: 'queenside' });
            }
        }
    }
    
    return moves;
}

function getLegalMoves(state) {
    const { board, turn, enPassant } = state;
    const moves = [];
    
    for (let from = 0; from < 64; from++) {
        const piece = board[from];
        if (!piece || getPieceColor(piece) !== turn) continue;
        
        const pieceType = getPieceType(piece);
        let candidateMoves = [];
        
        switch (pieceType) {
            case 'p':
                candidateMoves = getPawnMoves(from, board, turn, enPassant);
                break;
            case 'n':
                candidateMoves = getKnightMoves(from, board, turn);
                break;
            case 'b':
                candidateMoves = getSlidingMoves(from, BISHOP_OFFSETS, board, turn);
                break;
            case 'r':
                candidateMoves = getSlidingMoves(from, ROOK_OFFSETS, board, turn);
                break;
            case 'q':
                candidateMoves = [...getSlidingMoves(from, BISHOP_OFFSETS, board, turn), 
                               ...getSlidingMoves(from, ROOK_OFFSETS, board, turn)];
                break;
            case 'k':
                candidateMoves = getKingMoves(from, board, turn);
                break;
        }
        
        for (const to of candidateMoves) {
            let promotions = null;
            if (pieceType === 'p') {
                const toRank = getRank(to);
                if ((turn === 'white' && toRank === 0) || (turn === 'black' && toRank === 7)) {
                    promotions = ['q', 'r', 'b', 'n'];
                }
            }
            
            if (promotions) {
                for (const promotion of promotions) {
                    const newBoard = makeMove(board, from, to, turn, enPassant, promotion);
                    if (!isInCheck(newBoard, turn)) {
                        moves.push({ from, to, promotion });
                    }
                }
            } else {
                const newBoard = makeMove(board, from, to, turn, enPassant, null);
                if (!isInCheck(newBoard, turn)) {
                    moves.push({ from, to });
                }
            }
        }
    }
    
    const castlingMoves = getCastlingMoves(state);
    for (const move of castlingMoves) {
        const newBoard = [...board];
        const { from, to, castling: type } = move;
        newBoard[from] = null;
        newBoard[to] = turn === 'white' ? 'K' : 'k';
        
        if (type === 'kingside') {
            const rookFrom = to + 1;
            const rookTo = to - 1;
            newBoard[rookFrom] = null;
            newBoard[rookTo] = turn === 'white' ? 'R' : 'r';
        } else {
            const rookFrom = to - 2;
            const rookTo = to + 1;
            newBoard[rookFrom] = null;
            newBoard[rookTo] = turn === 'white' ? 'R' : 'r';
        }
        
        if (!isInCheck(newBoard, turn)) {
            moves.push(move);
        }
    }
    
    return moves;
}

function moveToUCI(move) {
    let uci = indexToSquare(move.from) + indexToSquare(move.to);
    if (move.promotion) {
        uci += move.promotion;
    }
    return uci;
}

async function main() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const fen = chunks.join('').trim();
    if (!fen) return;
    
    const state = parseFEN(fen);
    const legalMoves = getLegalMoves(state);
    
    if (legalMoves.length === 0) {
        return;
    }
    
    const selectedMove = legalMoves[0];
    const uci = moveToUCI(selectedMove);
    process.stdout.write(uci);
}

main().catch(console.error);