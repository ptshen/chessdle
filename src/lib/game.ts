import { Chess } from 'chess.js';
import type { EngineEvaluation } from './engine';
import { SCORING_VERSION, matePenalty, numericPenalty, winnerPenalty } from './scoring';
import puzzleData from '../data/puzzles.json';

export type Mode = 'daily' | 'practice';
export type RoundType = 'winner' | 'evaluation' | 'move' | 'mate';
export interface Puzzle {
  id: string; rawPuzzleId?: string; phase?: 'before' | 'after'; fen: string; rating: number;
  themes: string[]; sourceUrl: string; gameUrl?: string; evaluation: EngineEvaluation;
}
export const puzzles = puzzleData as Puzzle[];
export const ROUND_PLAN: { type: RoundType; difficulty: 'Medium' | 'Hard'; label: string; title: string }[] = [
  { type: 'winner', difficulty: 'Medium', label: 'Winning side', title: 'Who’s winning?' },
  { type: 'winner', difficulty: 'Hard', label: 'Winning side', title: 'Who’s winning?' },
  { type: 'evaluation', difficulty: 'Medium', label: 'Evaluation', title: 'Evaluate the position' },
  { type: 'evaluation', difficulty: 'Hard', label: 'Evaluation', title: 'Evaluate the position' },
  { type: 'move', difficulty: 'Hard', label: 'Best move', title: 'Find the best move' },
  { type: 'move', difficulty: 'Hard', label: 'Best move', title: 'Find the best move' },
  { type: 'mate', difficulty: 'Hard', label: 'Mate in N', title: 'Mate in how many?' },
];
export interface RoundResult { puzzleId: string; guess: string; answer: string; penalty: number; evaluation: EngineEvaluation; move?: string; }
export interface GameState { version: 1; scoringVersion?: number; id: string; mode: Mode; date: string; puzzleIds: string[]; index: number; results: RoundResult[]; finished: boolean; }
export interface CompletedGame { id: string; mode: Mode; date: string; score: number; scoringVersion?: number; }
export function localDate(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function millisecondsUntilLocalMidnight(now = new Date()): number {
  // Advance the calendar date rather than adding 24 hours: DST days may be shorter or longer.
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}
const sourcePuzzleId = (puzzle: Puzzle) => puzzle.rawPuzzleId ?? puzzle.id.replace('-before', '');
function eligibleForRound(puzzle: Puzzle, round: typeof ROUND_PLAN[number]): boolean {
  if (round.type === 'mate') return puzzle.phase !== 'before' && puzzle.evaluation.mate !== null && Math.abs(puzzle.evaluation.mate) >= 2;
  if (puzzle.evaluation.cp === null || puzzle.evaluation.mate !== null || Math.abs(puzzle.evaluation.cp) < 50 || Math.abs(puzzle.evaluation.cp) > 1000) return false;
  if (round.type === 'move' && puzzle.phase === 'before') return false;
  return round.difficulty === 'Medium' ? puzzle.rating < 1800 : puzzle.rating >= 1800;
}
function randomFromSeed(seed: string) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => { value += 0x6d2b79f5; let t = Math.imul(value ^ value >>> 15, 1 | value); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function selectPuzzles(seed: string): string[] {
  const random = randomFromSeed(seed);
  const used = new Set<string>();
  return ROUND_PLAN.map((round) => {
    const eligible = puzzles.filter(p => !used.has(sourcePuzzleId(p)) && eligibleForRound(p, round));
    if (!eligible.length) throw new Error('The position library needs more verified positions for this round.');
    const selected = eligible[Math.floor(random() * eligible.length)];
    used.add(sourcePuzzleId(selected));
    return selected.id;
  });
}
export function createGame(mode: Mode, date = localDate()): GameState {
  const seed = mode === 'daily' ? `chessdle-v1-${date}` : `practice-${crypto.randomUUID()}`;
  return { version: 1, scoringVersion: SCORING_VERSION, id: seed, mode, date, puzzleIds: selectPuzzles(seed), index: 0, results: [], finished: false };
}
export function readStorage<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function saveStorage(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export const storageKey = (mode: Mode, date = localDate()) => `chessdle:v1:${mode === 'daily' ? date : 'practice'}`;
const uciMove = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
function validEvaluation(value: unknown): value is EngineEvaluation {
  if (!object(value)) return false;
  return ((typeof value.cp === 'number' && Number.isFinite(value.cp) && value.mate === null) ||
    (value.cp === null && typeof value.mate === 'number' && Number.isInteger(value.mate) && value.mate !== 0)) &&
    typeof value.bestMove === 'string' && uciMove.test(value.bestMove) &&
    Number.isInteger(value.depth) && Number(value.depth) > 0 && Number(value.depth) <= 64 &&
    Array.isArray(value.pv) && value.pv.length > 0 && value.pv.every(m => typeof m === 'string' && uciMove.test(m));
}
function validGame(value: unknown, mode: Mode, expectedDailyDate = localDate()): value is GameState {
  if (!object(value) || value.version !== 1 || value.mode !== mode || typeof value.id !== 'string' || !value.id ||
    typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    !Number.isFinite(Date.parse(value.date)) || typeof value.finished !== 'boolean' ||
    (value.scoringVersion !== undefined && (typeof value.scoringVersion !== 'number' || ![1, 2, SCORING_VERSION].includes(value.scoringVersion)))) return false;
  if (mode === 'daily' && (value.date !== expectedDailyDate || value.id !== `chessdle-v1-${value.date}`)) return false;
  if (!Array.isArray(value.puzzleIds) || value.puzzleIds.length !== 7 || new Set(value.puzzleIds).size !== 7 ||
    !value.puzzleIds.every(id => typeof id === 'string' && puzzles.some(p => p.id === id))) return false;
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || value.index > 6 ||
    !Array.isArray(value.results) || value.results.length > 7 ||
    (value.results.length !== value.index && value.results.length !== value.index + 1) ||
    (value.finished && (value.results.length !== 7 || value.index !== 6))) return false;
  const ids = value.puzzleIds;
  return value.results.every((result, index) => {
    if (!object(result) || result.puzzleId !== ids[index] || typeof result.guess !== 'string' || typeof result.answer !== 'string' ||
      typeof result.penalty !== 'number' || !Number.isFinite(result.penalty) || result.penalty < 0 || !validEvaluation(result.evaluation)) return false;
    if (ROUND_PLAN[index].type === 'move') {
      // Round 5 was an evaluation round before scoring version 3.
      if (index === 4 && value.scoringVersion !== SCORING_VERSION && result.move === undefined) return true;
      if (typeof result.move !== 'string' || !uciMove.test(result.move)) return false;
      try {
        const board = new Chess(puzzles.find(p => p.id === ids[index])!.fen);
        board.move({ from: result.move.slice(0, 2), to: result.move.slice(2, 4), promotion: result.move[4] });
      } catch { return false; }
    }
    return true;
  });
}
export function loadGame(mode: Mode): GameState {
  const date = localDate();
  const key = storageKey(mode, date);
  const saved = readStorage<unknown>(key, null);
  if (!validGame(saved, mode, date)) return createGame(mode, date);
  let game: GameState;
  try { game = normalizeGame(saved); } catch { return createGame(mode, date); }
  if (game !== saved) saveStorage(key, game);
  if (saved.finished && !game.finished) {
    // Keep legacy totals, but never show a rewound game as a current completion.
    const history = storedCompletedGames();
    const remaining = history.filter(entry => entry.id !== game.id || entry.scoringVersion !== SCORING_VERSION);
    if (history.length !== remaining.length) saveStorage('chessdle:v1:history', remaining);
  }
  if (game.finished) recordCompletion(game);
  return game;
}

function normalizeGame(game: GameState): GameState {
  const current = migrateGame(game);
  // Migrate first: a legacy seven-answer game may need to resume at round five.
  return current.mode === 'daily' && current.results.length === ROUND_PLAN.length && !current.finished
    ? { ...current, index: ROUND_PLAN.length - 1, finished: true }
    : current;
}

function sameResult(left: RoundResult, right: RoundResult): boolean {
  const a = left.evaluation; const b = right.evaluation;
  return left.puzzleId === right.puzzleId && left.guess === right.guess && left.answer === right.answer &&
    left.penalty === right.penalty && left.move === right.move && a.cp === b.cp && a.mate === b.mate &&
    a.bestMove === b.bestMove && a.depth === b.depth && a.pv.length === b.pv.length &&
    a.pv.every((move, index) => move === b.pv[index]);
}

function sameGame(left: GameState, right: GameState): boolean {
  return left.version === right.version && left.scoringVersion === right.scoringVersion &&
    left.id === right.id && left.mode === right.mode && left.date === right.date &&
    left.index === right.index && left.finished === right.finished &&
    left.puzzleIds.length === right.puzzleIds.length && left.puzzleIds.every((id, index) => id === right.puzzleIds[index]) &&
    left.results.length === right.results.length && left.results.every((result, index) => sameResult(result, right.results[index]));
}

/** Save progress without letting an older tab replace an already answered daily. */
export function saveGame(game: GameState): { game: GameState; saved: boolean } {
  if (!validGame(game, game.mode, game.date)) return { game, saved: false };
  let next: GameState;
  try { next = normalizeGame(game); } catch { return { game, saved: false }; }
  const key = storageKey(game.mode, game.date);
  let raw: string | null;
  try { raw = localStorage.getItem(key); } catch { return { game: next, saved: false }; }
  let stored: unknown = null;
  try { stored = raw ? JSON.parse(raw) : null; } catch { /* Replace malformed storage with valid progress. */ }
  const validStored = validGame(stored, game.mode, game.date) ? stored : null;
  if (game.mode === 'daily' && validStored) {
    let latest: GameState | null = null;
    try { latest = normalizeGame(validStored); } catch { /* An unmigratable snapshot cannot replace current progress. */ }
    if (latest) {
      const differentPositions = latest.puzzleIds.some((id, index) => id !== next.puzzleIds[index]);
      const conflictingAnswers = latest.results.slice(0, next.results.length)
        .some((result, index) => !sameResult(result, next.results[index]));
      if (latest.finished || latest.results.length > next.results.length || differentPositions || conflictingAnswers) {
        next = latest;
      } else if (latest.results.length === next.results.length && latest.index > next.index) {
        next = { ...next, index: latest.index };
      }
    }
  }
  // React callers can adopt newer progress without looping on freshly parsed objects.
  if (sameGame(next, game)) next = game;
  let saved = raw === JSON.stringify(next) || saveStorage(key, next);
  if (next.finished) {
    saved = recordCompletion(next) && saved;
  } else if (game.finished || validStored?.finished) {
    const history = storedCompletedGames();
    const remaining = history.filter(entry => entry.id !== next.id || entry.scoringVersion !== SCORING_VERSION);
    if (history.length !== remaining.length) saved = saveStorage('chessdle:v1:history', remaining) && saved;
  }
  return { game: next, saved };
}

function migrateGame(game: GameState): GameState {
  const legacy = game.scoringVersion !== SCORING_VERSION;
  let changed = legacy;
  let puzzleIds = game.puzzleIds;
  let rewind = legacy && !!game.results[4] && !game.results[4].move;
  if (legacy) {
    const roundFive = puzzles.find(puzzle => puzzle.id === puzzleIds[4])!;
    const otherSources = new Set(puzzleIds.filter((_, index) => index !== 4).map(id => sourcePuzzleId(puzzles.find(puzzle => puzzle.id === id)!)));
    if (!eligibleForRound(roundFive, ROUND_PLAN[4]) || otherSources.has(sourcePuzzleId(roundFive))) {
      const eligible = puzzles.filter(puzzle => eligibleForRound(puzzle, ROUND_PLAN[4]) && !otherSources.has(sourcePuzzleId(puzzle)));
      const replacement = eligible[Math.floor(randomFromSeed(`${game.id}:round-five-move`)() * eligible.length)];
      puzzleIds = [...puzzleIds];
      puzzleIds[4] = replacement.id;
      rewind ||= game.results.length > 4;
    }
  }
  const retained = rewind ? game.results.slice(0, 4) : game.results;
  const results = retained.map((result, index) => {
    const type = ROUND_PLAN[index].type;
    let penalty = result.penalty;
    if (type === 'winner' && result.evaluation.cp !== null && (result.guess === 'White' || result.guess === 'Black')) {
      penalty = winnerPenalty(result.guess === 'White' ? 'w' : 'b', result.evaluation.cp);
    } else if (legacy) {
      // Old move results store the squared loss, not the played position score.
      penalty = Math.round(Math.sqrt(result.penalty) * 10_000) / 10_000;
      if (type === 'evaluation' && result.evaluation.cp !== null && Number.isFinite(Number(result.guess))) {
        penalty = numericPenalty(Number(result.guess), result.evaluation.cp);
      } else if (type === 'mate' && result.evaluation.mate !== null) {
        const guess = Number(result.guess.replace(/^Mate in /, ''));
        if (Number.isInteger(guess) && guess > 0) penalty = matePenalty(guess, Math.abs(result.evaluation.mate));
      }
    }
    if (penalty === result.penalty) return result;
    changed = true;
    return { ...result, penalty };
  });
  return changed ? { ...game, scoringVersion: SCORING_VERSION, puzzleIds, results,
    ...(rewind ? { index: 4, finished: false } : {}) } : game;
}
export const totalScore = (results: RoundResult[]) => results.reduce((total, result) => total + result.penalty, 0);
export const formatEvaluation = (evaluation: EngineEvaluation) => evaluation.mate !== null ? `${evaluation.mate > 0 ? 'White' : 'Black'} mates in ${Math.abs(evaluation.mate)}` : `${(evaluation.cp ?? 0) > 0 ? '+' : ''}${((evaluation.cp ?? 0) / 100).toFixed(2)}`;
function storedCompletedGames(): CompletedGame[] {
  const stored = readStorage<unknown>('chessdle:v1:history', []);
  return Array.isArray(stored) ? stored.filter((g): g is CompletedGame => g && typeof g.id === 'string' && (g.mode === 'daily' || g.mode === 'practice') && typeof g.date === 'string' && Number.isFinite(g.score) && g.score >= 0 && (g.scoringVersion === undefined || g.scoringVersion === 1 || g.scoringVersion === 2 || g.scoringVersion === SCORING_VERSION)) : [];
}
export function completedGames(): CompletedGame[] {
  // Legacy aggregate scores cannot be recalculated without the round answers.
  // Retain them in storage, but compare only games using the current rules.
  return storedCompletedGames().filter(game => game.scoringVersion === SCORING_VERSION);
}
export function recordCompletion(game: GameState) {
  const current = migrateGame(game);
  if (!current.finished || current.results.length !== 7) return true;
  const history = storedCompletedGames();
  const completed: CompletedGame = { id: game.id, mode: game.mode, date: game.date, score: totalScore(current.results), scoringVersion: SCORING_VERSION };
  const index = history.findIndex(entry => entry.id === game.id);
  if (index >= 0) {
    if (history[index].score === completed.score && history[index].scoringVersion === SCORING_VERSION) return true;
    history[index] = completed;
  } else history.push(completed);
  return saveStorage('chessdle:v1:history', history.slice(-365));
}
