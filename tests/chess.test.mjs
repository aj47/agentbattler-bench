import test from "node:test";
import assert from "node:assert/strict";
import { applyUciMove, generateLegalMoves, isLegalUciMove, parseFen, terminalStatus, toFen } from "../src/chess.mjs";

test("parses standard FEN and generates the twenty opening moves", () => {
  const position = parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.equal(position.turn, "w");
  assert.equal(position.board[4], "K");
  assert.equal(position.board[60], "k");
  assert.equal(generateLegalMoves(position).length, 20);
  assert.equal(isLegalUciMove(position, "e2e4"), true);
  assert.equal(isLegalUciMove(position, "e2e5"), false);
});

test("applies moves immutably and updates turn, counters, and en passant", () => {
  const start = parseFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const afterWhite = applyUciMove(start, "e2e4");
  assert.equal(start.board[12], "P");
  assert.equal(afterWhite.board[28], "P");
  assert.equal(afterWhite.enPassant, 20);
  assert.equal(afterWhite.turn, "b");
  const afterBlack = applyUciMove(afterWhite, "g8f6");
  assert.equal(afterBlack.fullmove, 2);
  assert.equal(afterBlack.halfmove, 1);
  assert.throws(() => applyUciMove(start, "e2e5"), /Illegal move/);
});

test("round-trips positions through standard FEN", () => {
  const fen = "r3k2r/ppp2ppp/2n5/3pp3/3PP3/2N5/PPP2PPP/R3K2R b KQkq e3 7 12";
  assert.equal(toFen(parseFen(fen)), fen);
  const next = applyUciMove(parseFen("8/8/8/8/8/8/4k3/6K1 w - - 4 9"), "g1h1");
  assert.equal(toFen(next), "8/8/8/8/8/8/4k3/7K b - - 5 9");
});

test("filters moves that expose the king", () => {
  const pinned = parseFen("4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1");
  assert.equal(isLegalUciMove(pinned, "e2d2"), false);
  assert.equal(isLegalUciMove(pinned, "e2e8"), true);
});

test("supports castling and rejects castling through check", () => {
  const open = parseFen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.equal(isLegalUciMove(open, "e1g1"), true);
  assert.equal(isLegalUciMove(open, "e1c1"), true);
  const castled = applyUciMove(open, "e1g1");
  assert.equal(castled.board[6], "K");
  assert.equal(castled.board[5], "R");
  assert.equal(castled.castling, "kq");
  const attacked = parseFen("r3k2r/8/8/8/2b5/8/8/R3K2R w KQkq - 0 1");
  assert.equal(isLegalUciMove(attacked, "e1g1"), false);
  assert.equal(isLegalUciMove(attacked, "e1c1"), true);
});

test("supports en passant, including king-safety filtering", () => {
  const available = parseFen("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assert.equal(isLegalUciMove(available, "e5d6"), true);
  const captured = applyUciMove(available, "e5d6");
  assert.equal(captured.board[43], "P");
  assert.equal(captured.board[35], null);
  const exposesRook = parseFen("4r1k1/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assert.equal(isLegalUciMove(exposesRook, "e5d6"), false);
  const missingPawn = parseFen("4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1");
  assert.equal(isLegalUciMove(missingPawn, "e5d6"), false);
});

test("generates and applies all promotion choices", () => {
  const position = parseFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  const moves = generateLegalMoves(position);
  for (const suffix of ["q", "r", "b", "n"]) assert.ok(moves.includes(`a7a8${suffix}`));
  assert.equal(isLegalUciMove(position, "a7a8"), false);
  assert.equal(applyUciMove(position, "a7a8n").board[56], "N");
});

test("distinguishes checkmate, stalemate, and ongoing positions", () => {
  assert.deepEqual(
    terminalStatus(parseFen("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")),
    { status: "checkmate", winner: "w", inCheck: true },
  );
  assert.deepEqual(
    terminalStatus(parseFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")),
    { status: "stalemate", winner: null, inCheck: false },
  );
  assert.equal(terminalStatus(parseFen("7k/8/6K1/8/8/8/8/8 w - - 0 1")).status, "ongoing");
});

test("rejects malformed FEN", () => {
  assert.throws(() => parseFen("8/8/8/8/8/8/8 w - - 0 1"));
  assert.throws(() => parseFen("8/8/8/8/8/8/8/9 w - - 0 1"));
  assert.throws(() => parseFen("8/8/8/8/8/8/8/8 x - - 0 1"));
});

test("rejects positions without exactly one king per side", () => {
  assert.throws(() => parseFen("8/8/8/8/8/8/8/4K3 w - - 0 1"), /one king per side/);
  assert.throws(() => parseFen("4k3/8/8/8/8/8/4K3/4K3 w - - 0 1"), /one king per side/);
});
