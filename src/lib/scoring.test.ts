import { describe, expect, it } from 'vitest'
import type { EngineEvaluation } from './engine'
import { evaluationToPawns, matePenalty, movePenalty, numericPenalty, winnerPenalty } from './scoring'

function evaluation(cp: number | null, mate: number | null = null): EngineEvaluation {
  return { cp, mate, depth: 18, bestMove: 'e2e4', pv: [] }
}

describe('round scoring', () => {
  it('scores a winner guess using White’s perspective, including a dead draw', () => {
    expect(winnerPenalty('w', 230)).toBe(0)
    expect(winnerPenalty('b', -400)).toBe(0)
    expect(winnerPenalty('w', -400)).toBe(4)
    expect(winnerPenalty('b', 230)).toBe(2.3)
    expect(winnerPenalty('w', -175)).toBe(1.75)
    expect(winnerPenalty('b', 864)).toBe(8.64)
    expect(winnerPenalty('b', 0)).toBe(0)
  })

  it('uses absolute pawn error in either direction', () => {
    expect(numericPenalty(2.3, 230)).toBe(0)
    expect(numericPenalty(-4, -250)).toBe(1.5)
    expect(numericPenalty(-1, -250)).toBe(1.5)
    expect(numericPenalty(1, -100)).toBe(2)
    expect(numericPenalty(2.3, 227)).toBe(0.03)
  })

  it('measures evaluation loss from the moving side’s perspective', () => {
    expect(movePenalty(evaluation(300), evaluation(100), 'w')).toBe(2)
    expect(movePenalty(evaluation(-300), evaluation(-100), 'b')).toBe(2)
    expect(movePenalty(evaluation(-300), evaluation(100), 'b')).toBe(4)
    expect(movePenalty(evaluation(300), evaluation(400), 'w')).toBe(0)
    expect(movePenalty(evaluation(-300), evaluation(-400), 'b')).toBe(0)
  })

  it('never penalizes the engine’s exact best move because of search drift', () => {
    expect(movePenalty(evaluation(300), evaluation(290), 'w', 'e2e4')).toBe(0)
  })

  it('uses a finite, color-aware mate score and caps ordinary move scores', () => {
    expect(evaluationToPawns(evaluation(null, 3))).toBe(20)
    expect(evaluationToPawns(evaluation(null, -2))).toBe(-20)
    expect(evaluationToPawns(evaluation(null, -0))).toBe(-20)
    expect(evaluationToPawns(evaluation(null, 0))).toBe(20)
    expect(evaluationToPawns(evaluation(4000))).toBe(20)
    expect(movePenalty(evaluation(null, -3), evaluation(-1000), 'b')).toBe(10)
    expect(movePenalty(evaluation(null, 3), evaluation(null, 5), 'w')).toBe(0)
  })

  it('scores mate distance in full moves and rejects invalid guesses', () => {
    expect(matePenalty(3, 3)).toBe(0)
    expect(matePenalty(5, 3)).toBe(2)
    expect(matePenalty(1, 3)).toBe(2)
    expect(() => matePenalty(0, 3)).toThrow()
    expect(() => matePenalty(2.5, 3)).toThrow()
    expect(() => numericPenalty(Number.NaN, 0)).toThrow()
    expect(() => numericPenalty(1, Number.POSITIVE_INFINITY)).toThrow()
    expect(() => numericPenalty(1e200, 0)).toThrow('too large')
    expect(() => evaluationToPawns(evaluation(null))).toThrow()
  })
})
