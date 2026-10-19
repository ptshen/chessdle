import { Chess } from '../../vendor/chess.js/chess.js';

// Lichess's fields contain no line breaks; quoted commas and escaped quotes are supported.
export function parseCsvRow(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  fields.push(field);
  return fields;
}

export function playUci(chess, uci) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    throw new Error(`Invalid UCI move: ${uci}`);
  }
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

export function preparePositions(record) {
  const { PuzzleId, FEN, Moves, Rating, Themes, GameUrl } = record;
  if (!PuzzleId || !FEN || !Moves || !Number.isFinite(Number(Rating))) {
    throw new Error('Missing required puzzle fields');
  }
  const chess = new Chess(FEN);
  const moves = Moves.trim().split(/\s+/);
  const initialFen = chess.fen();
  playUci(chess, moves[0]);
  const puzzleFen = chess.fen();
  // Validate the entire supplied solution before accepting this source record.
  for (const move of moves.slice(1)) playUci(chess, move);
  const common = {
    rawPuzzleId: PuzzleId,
    rating: Number(Rating),
    themes: Themes.trim().split(/\s+/),
    sourceUrl: `https://lichess.org/training/${PuzzleId}`,
    gameUrl: GameUrl,
    initialFen,
    setupMove: moves[0],
    solution: moves.slice(1),
  };
  return [
    { ...common, id: `${PuzzleId}-before`, fen: initialFen, phase: 'before' },
    { ...common, id: PuzzleId, fen: puzzleFen, phase: 'after' },
  ];
}

export function prepareEarlierPositions(record, history) {
  if (!history) return [];
  const [before] = preparePositions(record);
  const chess = new Chess();
  const snapshots = [chess.fen()];
  let found = false;
  for (const san of history.moves.trim().split(/\s+/)) {
    chess.move(san);
    snapshots.push(chess.fen());
    if (chess.fen() === before.fen) { found = true; break; }
  }
  if (!found) throw new Error(`${record.PuzzleId}: source game does not reach the CSV position`);
  return [1, 3, 5, 7].map((offset) => snapshots.length - 1 - offset).filter((ply) => ply > 10).map((ply) => ({
    ...before,
    id: `${record.PuzzleId}-ply${ply}`,
    fen: snapshots[ply],
    positionOrigin: 'earlier-game',
    sourcePly: ply,
    gameUrl: `${record.GameUrl.split('#')[0]}#${ply}`,
  }));
}

export function parseEngineInfo(line, fen) {
  if (!line.startsWith('info ') || /\b(?:lowerbound|upperbound)\b/.test(line)) return null;
  const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
  const depth = /\bdepth (\d+)/.exec(line);
  const pv = /\bpv (.+)$/.exec(line);
  if (!score || !depth || !pv) return null;
  // UCI scores are from the root side's perspective; the app always uses White's.
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  const value = Number(score[2]) * sign;
  return {
    cp: score[1] === 'cp' ? value : null,
    mate: score[1] === 'mate' ? value : null,
    depth: Number(depth[1]),
    pv: pv[1].trim().split(/\s+/),
  };
}

export function validateEvaluation(position, evaluation) {
  const chess = new Chess(position.fen);
  if (!evaluation.bestMove || evaluation.bestMove === '(none)') {
    throw new Error(`${position.id}: engine did not return a legal move`);
  }
  playUci(chess, evaluation.bestMove);
  const variation = new Chess(position.fen);
  for (const move of evaluation.pv) playUci(variation, move);
  if (evaluation.cp === null && evaluation.mate === null) {
    throw new Error(`${position.id}: engine did not return a score`);
  }
}

export function selectPack(positions, limit) {
  const buckets = new Map();
  // Start with positions where the winning side is waiting, otherwise the puzzle
  // convention that the player to move is winning can accidentally give away the answer.
  const orderedPositions = [...positions].sort((a, b) => {
    const waiting = (position) => position.evaluation.cp !== null
      && (position.evaluation.cp > 0 ? 'w' : 'b') !== position.fen.split(' ')[1];
    return Number(waiting(b)) - Number(waiting(a));
  });
  for (const position of orderedPositions) {
    const { cp, mate } = position.evaluation;
    let key;
    if (mate !== null) {
      // A positive root-side mate means the player, rather than the opponent, can force it.
      const rootMate = mate * (position.fen.split(' ')[1] === 'w' ? 1 : -1);
      if (position.phase !== 'after' || rootMate < 1 || rootMate > 4) continue;
      const theme = position.themes.find((theme) => /^mateIn[1-5]$/.test(theme));
      if (!theme || Number(theme.slice(6)) !== rootMate) continue;
      key = 'mate';
    } else {
      if (cp === null || Math.abs(cp) < 50 || Math.abs(cp) > 800) continue;
      const level = position.rating < 1800 ? 'medium' : 'hard';
      const winner = cp > 0 ? 'w' : 'b';
      const turn = position.fen.split(' ')[1];
      key = `${level}-${winner}-${winner === turn ? 'to-move' : 'waiting'}`;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(position);
  }

  // Keep a useful spread of difficulty, winning color, and side to move.
  // Pick only one phase of each source puzzle so a single session cannot show near-duplicates.
  const selected = [];
  const seen = new Set();
  const mateTarget = Math.min(8, Math.max(2, Math.floor(limit / 6)));
  const mates = buckets.get('mate') ?? [];
  for (const position of mates.slice(0, mateTarget)) {
    selected.push(position);
    seen.add(position.rawPuzzleId);
  }
  buckets.delete('mate');
  while (selected.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      let position;
      do { position = bucket.shift(); } while (position && seen.has(position.rawPuzzleId));
      if (!position) continue;
      selected.push(position);
      seen.add(position.rawPuzzleId);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}
