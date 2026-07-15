'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

const pieces: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

type Board = (string | null)[][];
type Cell = { row: number; column: number };

function parseBoard(fen: string): Board {
  return fen.split(' ')[0].split('/').map((rank) => {
    const cells: (string | null)[] = [];
    for (const token of rank) {
      if (/\d/.test(token)) cells.push(...Array(Number(token)).fill(null));
      else cells.push(token);
    }
    return cells;
  });
}

function squareToCell(square?: string | null): Cell | null {
  if (!square || !/^[a-h][1-8]$/.test(square)) return null;
  return {
    row: 8 - Number(square[1]),
    column: square.charCodeAt(0) - 97,
  };
}

function pieceAt(board: Board | null, cell: Cell | null): string | null {
  if (!board || !cell) return null;
  return board[cell.row]?.[cell.column] ?? null;
}

export function ChessBoard({
  fen,
  previousFen,
  lastMove,
}: {
  fen: string;
  previousFen?: string | null;
  lastMove?: string | null;
}) {
  const board = parseBoard(fen);
  const previousBoard = previousFen ? parseBoard(previousFen) : null;
  const from = lastMove?.slice(0, 2);
  const to = lastMove?.slice(2, 4);
  const fromCell = squareToCell(from);
  const toCell = squareToCell(to);
  const movingPiece = pieceAt(previousBoard, fromCell) ?? pieceAt(board, toCell);
  const shouldAnimate = Boolean(previousBoard && fromCell && toCell && movingPiece);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (!shouldAnimate) {
      setAnimating(false);
      return undefined;
    }
    setAnimating(true);
    const timer = window.setTimeout(() => setAnimating(false), 280);
    return () => window.clearTimeout(timer);
  }, [fen, lastMove, previousFen, shouldAnimate]);

  const moveStyle = fromCell && toCell ? {
    left: `${fromCell.column * 12.5}%`,
    top: `${fromCell.row * 12.5}%`,
    '--move-x': `${(toCell.column - fromCell.column) * 100}%`,
    '--move-y': `${(toCell.row - fromCell.row) * 100}%`,
  } as CSSProperties : undefined;

  return (
    <div className="chess-board" role="img" aria-label={`Chess position: ${fen}`}>
      {board.flatMap((rank, row) => rank.map((piece, column) => {
        const square = `${String.fromCharCode(97 + column)}${8 - row}`;
        const dark = (row + column) % 2 === 1;
        const fromSquare = square === from;
        const toSquare = square === to;
        const moved = fromSquare || toSquare;
        const visiblePiece = animating && toSquare ? null : piece;
        return (
          <div className={`chess-square ${dark ? 'dark' : 'light'} ${moved ? 'last-move' : ''} ${fromSquare ? 'move-from' : ''} ${toSquare ? 'move-to' : ''}`} key={square}>
            {visiblePiece ? <span className={`chess-piece ${visiblePiece === visiblePiece.toUpperCase() ? 'white-piece' : 'black-piece'}`}>{pieces[visiblePiece]}</span> : null}
            {column === 0 ? <small className="rank-label">{8 - row}</small> : null}
            {row === 7 ? <small className="file-label">{String.fromCharCode(97 + column)}</small> : null}
          </div>
        );
      }))}
      {animating && movingPiece && moveStyle ? (
        <span className="chess-piece-animator" style={moveStyle} aria-hidden="true">
          <span className={`chess-piece ${movingPiece === movingPiece.toUpperCase() ? 'white-piece' : 'black-piece'}`}>{pieces[movingPiece]}</span>
        </span>
      ) : null}
    </div>
  );
}
