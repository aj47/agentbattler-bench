const pieces: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

function parseBoard(fen: string): (string | null)[][] {
  return fen.split(' ')[0].split('/').map((rank) => {
    const cells: (string | null)[] = [];
    for (const token of rank) {
      if (/\d/.test(token)) cells.push(...Array(Number(token)).fill(null));
      else cells.push(token);
    }
    return cells;
  });
}

export function ChessBoard({ fen, lastMove }: { fen: string; lastMove?: string | null }) {
  const board = parseBoard(fen);
  const from = lastMove?.slice(0, 2);
  const to = lastMove?.slice(2, 4);

  return (
    <div className="chess-board" role="img" aria-label={`Chess position: ${fen}`}>
      {board.flatMap((rank, row) => rank.map((piece, column) => {
        const square = `${String.fromCharCode(97 + column)}${8 - row}`;
        const dark = (row + column) % 2 === 1;
        const moved = square === from || square === to;
        return (
          <div className={`chess-square ${dark ? 'dark' : 'light'} ${moved ? 'last-move' : ''}`} key={square}>
            {piece ? <span className={`chess-piece ${piece === piece.toUpperCase() ? 'white-piece' : 'black-piece'}`}>{pieces[piece]}</span> : null}
            {column === 0 ? <small className="rank-label">{8 - row}</small> : null}
            {row === 7 ? <small className="file-label">{String.fromCharCode(97 + column)}</small> : null}
          </div>
        );
      }))}
    </div>
  );
}
