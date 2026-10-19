import type { Chess, Square } from 'chess.js';

export function getCheckHighlights(chess: Chess): { king: Square | null; attackers: Square[] } {
  if (!chess.isCheck()) return { king: null, attackers: [] };

  const side = chess.turn();
  const king = chess.board().flat().find(piece => piece?.type === 'k' && piece.color === side)?.square;
  if (!king) return { king: null, attackers: [] };

  return { king, attackers: chess.attackers(king, side === 'w' ? 'b' : 'w') };
}
