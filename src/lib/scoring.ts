import type { EngineEvaluation } from './engine'

export const SCORING_VERSION = 3
/** Mate is represented as ±20 pawns for move-loss scoring; ordinary scores are capped at this value. */
export const MATE_SCORE_PAWNS = 20

function finite(value: number) {
  if (!Number.isFinite(value)) throw new Error('Scoring requires a finite number.')
  return value
}

function absolute(value: number) {
  // Avoid displaying artifacts such as 0.0899999999999999.
  const result = Math.abs(value)
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER / 10_000) {
    throw new Error('That guess is too large. Enter an evaluation in pawns.')
  }
  return Math.round(result * 10_000) / 10_000
}

export function winnerPenalty(guess: 'w' | 'b', cp: number): number {
  finite(cp)
  if (cp === 0) return 0
  return (guess === 'w') === (cp > 0) ? 0 : Math.abs(cp) / 100
}

/** Numerical guesses are in pawns, while Stockfish scores are in centipawns. */
export function numericPenalty(guess: number, cp: number): number {
  return absolute(finite(guess) - finite(cp) / 100)
}

export function evaluationToPawns(evaluation: Pick<EngineEvaluation, 'cp' | 'mate'>): number {
  if (evaluation.mate !== null) {
    finite(evaluation.mate)
    return evaluation.mate < 0 || Object.is(evaluation.mate, -0) ? -MATE_SCORE_PAWNS : MATE_SCORE_PAWNS
  }
  if (evaluation.cp === null) throw new Error('The position has no engine evaluation.')
  return Math.max(-MATE_SCORE_PAWNS, Math.min(MATE_SCORE_PAWNS, finite(evaluation.cp) / 100))
}

/**
 * Evaluation loss in pawns from the moving player's perspective. Pass a search
 * of the original FEN restricted to the player's move for equal search depth.
 * Improving on an earlier engine score cannot earn a negative penalty.
 */
export function movePenalty(
  before: EngineEvaluation,
  after: EngineEvaluation,
  turn: 'w' | 'b',
  playedMove?: string,
): number {
  if (playedMove && playedMove === before.bestMove) return 0
  const sign = turn === 'w' ? 1 : -1
  const loss = Math.max(0, (evaluationToPawns(before) - evaluationToPawns(after)) * sign)
  return absolute(loss)
}

export function matePenalty(guess: number, actual: number): number {
  finite(guess)
  finite(actual)
  if (!Number.isInteger(guess) || !Number.isInteger(actual) || guess < 1 || actual < 1) {
    throw new Error('Mate distances must be positive whole numbers.')
  }
  return absolute(guess - actual)
}
