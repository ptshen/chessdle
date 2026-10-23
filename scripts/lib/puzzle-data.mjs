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

export function prepareContinuationPositions(record) {
  const [, after] = preparePositions(record);
  if (!after.solution.length) return [];
  const chess = new Chess(after.fen);
  playUci(chess, after.solution[0]);
  // This is the supplied puzzle solution branch, not necessarily a position
  // played in the source game. Keep gameUrl unchanged for source attribution.
  return [{
    ...after,
    id: `${after.rawPuzzleId}-continuation`,
    fen: chess.fen(),
    phase: 'continuation',
    positionOrigin: 'puzzle-continuation',
    sourceSolutionPly: 1,
  }];
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

// Ignore move counters when identifying the same board; game fragments and the
// optional /black suffix likewise do not make a different source game.
export const positionKey = (position) => position.fen.split(' ').slice(0, 4).join(' ');
export function sourceGameKey(position) {
  if (!position.gameUrl) return null;
  const url = new URL(position.gameUrl);
  return `${url.hostname}/${url.pathname.split('/').filter(Boolean)[0]}`;
}

export function validateProvenance(position, expected) {
  if (!expected) throw new Error(`${position.id}: missing source record`);
  for (const key of ['id', 'rawPuzzleId', 'fen', 'rating', 'phase', 'themes', 'sourceUrl', 'gameUrl',
    'initialFen', 'setupMove', 'solution', 'positionOrigin', 'sourcePly', 'sourceSolutionPly']) {
    if (JSON.stringify(position[key]) !== JSON.stringify(expected[key])) {
      throw new Error(`${position.id}: source ${key} mismatch`);
    }
  }
}

export function validateMatingLine(position, evaluation = position.evaluation, minimumMate = 2) {
  const n = evaluation.mate * (position.fen.split(' ')[1] === 'w' ? 1 : -1);
  if (position.phase !== 'after' || evaluation.cp !== null || !Number.isInteger(n)
    || n < minimumMate || n > 4 || !position.themes.includes(`mateIn${n}`)) {
    throw new Error(`${position.id}: ineligible or theme-disagreeing mate`);
  }
  if (evaluation.pv.length !== 2 * n - 1) throw new Error(`${position.id}: incomplete mating line`);
  const chess = new Chess(position.fen);
  for (const move of evaluation.pv) playUci(chess, move);
  if (!chess.isCheckmate()) throw new Error(`${position.id}: mating line does not end in checkmate`);
}

export function selectPack(positions, limit, options = {}) {
  const mateTarget = Math.min(limit, options.mateLimit ?? Math.max(2, Math.floor(limit / 5)));
  const mediumTarget = options.mediumLimit ?? Math.ceil((limit - mateTarget) / 2);
  if (!Number.isInteger(mediumTarget) || mediumTarget < 0 || mediumTarget > limit - mateTarget) {
    throw new Error('mediumLimit must fit within the numerical position quota');
  }
  const hardTarget = limit - mateTarget - mediumTarget;
  const bestMoveTarget = Math.min(hardTarget, options.bestMoveLimit ?? Math.ceil(hardTarget * 0.75));
  const selected = [];
  const rawIds = new Set();
  const fens = new Set();
  const games = new Set();
  const remember = (position) => {
    rawIds.add(position.rawPuzzleId);
    fens.add(positionKey(position));
    const game = sourceGameKey(position);
    if (game) games.add(game);
  };
  for (const position of options.exclude ?? []) remember(position);
  const unseen = (position) => !rawIds.has(position.rawPuzzleId) && !fens.has(positionKey(position))
    && (!sourceGameKey(position) || !games.has(sourceGameKey(position)));
  const numerical = positions.filter(({ evaluation: { cp, mate } }) => mate === null
    && Number.isFinite(cp) && Math.abs(cp) >= 50 && Math.abs(cp) <= 800);
  const waiting = (position) => (position.evaluation.cp > 0 ? 'w' : 'b') !== position.fen.split(' ')[1];
  const balanceKey = (position) => position.evaluation.cp === null ? 'mate'
    : `${position.rating < 1800 ? 'medium' : 'hard'}-${position.evaluation.cp > 0 ? 'w' : 'b'}-${waiting(position) ? 'waiting' : 'to-move'}`;
  const waitingAlternatives = numerical.filter((position) => waiting(position) && unseen(position));
  const waitingSources = new Map();
  for (const position of waitingAlternatives) {
    const key = balanceKey(position);
    if (!waitingSources.has(key)) waitingSources.set(key, new Set());
    waitingSources.get(key).add(position.rawPuzzleId);
  }
  const waitingCosts = new Map();
  for (const position of waitingAlternatives) {
    // Reserve mates/moves from inflexible sources first. If a reservation must
    // consume a waiting-side alternative, prefer the more plentiful stratum.
    waitingCosts.set(position.rawPuzzleId, Math.max(waitingCosts.get(position.rawPuzzleId) ?? 0,
      1 / waitingSources.get(balanceKey(position)).size));
  }
  const reservationCost = (position) => waitingCosts.get(position.rawPuzzleId) ?? 0;

  // Balance cumulative answer/turn counts, including already reserved moves.
  // Prefer scarce strata and inflexible sources when counts are tied, so a
  // moving-side alternative does not consume a source needed for a waiting side.
  function takeBalanced(candidates, count, keyOf = balanceKey, priority = () => 0) {
    const buckets = new Map();
    const possibleKeys = new Map();
    for (const position of candidates) {
      const key = keyOf(position);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(position);
      if (!possibleKeys.has(position.rawPuzzleId)) possibleKeys.set(position.rawPuzzleId, new Set());
      possibleKeys.get(position.rawPuzzleId).add(key);
    }
    for (const bucket of buckets.values()) bucket.sort((left, right) => priority(left) - priority(right)
      || possibleKeys.get(left.rawPuzzleId).size - possibleKeys.get(right.rawPuzzleId).size);
    const counts = new Map([...buckets.keys()].map((key) => [key, 0]));
    for (const position of [...(options.exclude ?? []), ...selected]) {
      const key = keyOf(position);
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
    let added = 0;
    while (added < count && selected.length < limit) {
      let next;
      for (const [key, bucket] of buckets) {
        const available = bucket.filter(unseen);
        buckets.set(key, available);
        if (!available.length) continue;
        const sources = new Set(available.map((position) => position.rawPuzzleId)).size;
        if (!next || counts.get(key) < counts.get(next.key)
          || (counts.get(key) === counts.get(next.key) && sources < next.sources)) {
          next = { key, position: available[0], sources };
        }
      }
      if (!next) break;
      remember(next.position);
      selected.push(next.position);
      counts.set(next.key, counts.get(next.key) + 1);
      added++;
    }
    return added;
  }

  const mates = positions.filter((position) => {
    const { cp, mate } = position.evaluation;
    const rootMate = mate * (position.fen.split(' ')[1] === 'w' ? 1 : -1);
    return cp === null && mate !== null && position.phase === 'after'
      && rootMate >= 2 && rootMate <= 4 && position.themes.includes(`mateIn${rootMate}`);
  });
  takeBalanced(mates, mateTarget, (position) => `${Math.abs(position.evaluation.mate)}-${position.fen.split(' ')[1]}`, reservationCost);
  const hardMoves = numerical.filter((position) => position.rating >= 1800 && position.phase === 'after');
  const selectedMoves = takeBalanced(hardMoves, bestMoveTarget, balanceKey, reservationCost);
  const ordered = [...numerical].sort((a, b) => Number(waiting(b)) - Number(waiting(a)));
  takeBalanced(ordered.filter((position) => position.rating < 1800), mediumTarget);
  takeBalanced(ordered.filter((position) => position.rating >= 1800), hardTarget - selectedMoves);
  // A small input may not fill a stratum. Fill remaining slots with eligible
  // numerical positions, preserving balance without exceeding the mate quota.
  takeBalanced(ordered, limit - selected.length);
  return selected.sort((left, right) => left.id.localeCompare(right.id));
}
