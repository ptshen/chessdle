import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { getCheckHighlights } from './check';

describe('check highlights', () => {
  it.each([
    ['black pawn', 'k7/8/8/4p3/3K4/8/8/8 w - - 0 1', 'd4', 'e5'],
    ['white pawn', '8/8/8/4k3/3P4/8/8/K7 b - - 0 1', 'e5', 'd4'],
    ['black knight', 'k7/8/8/8/8/5n2/8/4K3 w - - 0 1', 'e1', 'f3'],
    ['white knight', '4k3/8/5N2/8/8/8/8/K7 b - - 0 1', 'e8', 'f6'],
    ['rook', 'k3r3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1', 'e8'],
    ['bishop', 'k7/8/8/8/1b6/8/8/4K3 w - - 0 1', 'e1', 'b4'],
    ['queen on a file', 'k3q3/8/8/8/8/8/8/4K3 w - - 0 1', 'e1', 'e8'],
    ['queen on a diagonal', 'k7/8/8/8/7q/8/8/4K3 w - - 0 1', 'e1', 'h4'],
  ])('highlights the king and checking %s', (_, fen, king, attacker) => {
    expect(getCheckHighlights(new Chess(fen))).toEqual({ king, attackers: [attacker] });
  });

  it('highlights both pieces giving double check', () => {
    const highlights = getCheckHighlights(new Chess('k3r3/8/8/8/1b6/8/8/4K3 w - - 0 1'));
    expect(highlights.king).toBe('e1');
    expect(highlights.attackers.sort()).toEqual(['b4', 'e8']);
  });

  it('includes a checking piece that is pinned to its own king', () => {
    expect(getCheckHighlights(new Chess('4k3/8/8/8/8/8/K3r3/4R3 w - - 0 1')))
      .toEqual({ king: 'a2', attackers: ['e2'] });
  });

  it.each([
    ['starting position', new Chess().fen()],
    ['blocked rook', 'k3r3/8/8/8/4P3/8/8/4K3 w - - 0 1'],
    ['blocked bishop', 'k7/8/8/8/1b6/8/3P4/4K3 w - - 0 1'],
    ['black pawn facing away', 'k7/8/3K4/4p3/8/8/8/8 w - - 0 1'],
    ['white pawn facing away', '8/8/8/8/3P4/4k3/8/K7 b - - 0 1'],
  ])('does not highlight a position without check: %s', (_, fen) => {
    expect(getCheckHighlights(new Chess(fen))).toEqual({ king: null, attackers: [] });
  });

  it('leaves the board unchanged and removes highlights after check is resolved', () => {
    const chess = new Chess('k3r3/8/8/8/8/8/8/4K3 w - - 0 1');
    const initialFen = chess.fen();
    expect(getCheckHighlights(chess)).toEqual({ king: 'e1', attackers: ['e8'] });
    expect(chess.fen()).toBe(initialFen);
    expect(chess.history()).toEqual([]);

    chess.move('Kf1');
    const resolvedFen = chess.fen();
    expect(getCheckHighlights(chess)).toEqual({ king: null, attackers: [] });
    expect(chess.fen()).toBe(resolvedFen);
    expect(chess.history()).toEqual(['Kf1']);
  });
});
