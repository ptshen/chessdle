import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROUND_PLAN, completedGames, createGame, loadGame, puzzles, readStorage,
  localDate, millisecondsUntilLocalMidnight, recordCompletion, saveGame, saveStorage, selectPuzzles, storageKey, totalScore,
  type GameState, type RoundResult,
} from './game'
import { SCORING_VERSION } from './scoring'

const TODAY = '2026-10-18'

function answerFor(game: GameState, index: number): RoundResult {
  const puzzle = puzzles.find(candidate => candidate.id === game.puzzleIds[index])!
  return {
    puzzleId: puzzle.id,
    guess: ROUND_PLAN[index].type === 'move' ? puzzle.evaluation.bestMove : '1',
    answer: ROUND_PLAN[index].type === 'move' ? puzzle.evaluation.bestMove : '1',
    penalty: index / 4,
    evaluation: puzzle.evaluation,
    ...(ROUND_PLAN[index].type === 'move' ? { move: puzzle.evaluation.bestMove } : {}),
  }
}

function answeredGame(index = 0, finished = false): GameState {
  const game = createGame('daily', TODAY)
  return { ...game, index, results: Array.from({ length: index + 1 }, (_, i) => answerFor(game, i)), finished }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 18, 12))
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('seven-round puzzle selection', () => {
  it('uses two winner rounds, two evaluation rounds, two best-move rounds, and one mate round', () => {
    expect(ROUND_PLAN.map(round => round.type)).toEqual(['winner', 'winner', 'evaluation', 'evaluation', 'move', 'move', 'mate'])
    expect(ROUND_PLAN.slice(4, 6).map(round => round.difficulty)).toEqual(['Hard', 'Hard'])
  })

  it('is deterministic and satisfies all round constraints across 1,000 seeds', () => {
    const layouts = new Set<string>()
    for (let seed = 0; seed < 1_000; seed++) {
      const ids = selectPuzzles(`selection-regression-${seed}`)
      expect(selectPuzzles(`selection-regression-${seed}`)).toEqual(ids)
      expect(ids).toHaveLength(7)
      layouts.add(ids.join(','))
      const positions = ids.map(id => puzzles.find(puzzle => puzzle.id === id)!)
      expect(positions.every(Boolean)).toBe(true)
      expect(new Set(positions.map(p => p.rawPuzzleId ?? p.id.replace('-before', ''))).size).toBe(7)
      positions.forEach((position, index) => {
        const round = ROUND_PLAN[index]
        if (index === 6) {
          expect(position.phase).not.toBe('before')
          expect(position.evaluation.mate).not.toBeNull()
          expect(Math.abs(position.evaluation.mate!)).toBeGreaterThanOrEqual(2)
        } else {
          expect(position.evaluation.mate).toBeNull()
          expect(position.evaluation.cp).not.toBeNull()
          expect(Math.abs(position.evaluation.cp!)).toBeGreaterThanOrEqual(50)
          expect(Math.abs(position.evaluation.cp!)).toBeLessThanOrEqual(1000)
          if (round.difficulty === 'Medium') expect(position.rating).toBeLessThan(1800)
          else expect(position.rating).toBeGreaterThanOrEqual(1800)
          if (round.type === 'move') expect(position.phase).not.toBe('before')
        }
      })
    }
    expect(layouts.size).toBeGreaterThan(100)
  })

  it('shares a daily challenge and creates independent practice challenges', () => {
    expect(createGame('daily', TODAY)).toEqual(createGame('daily', TODAY))
    const first = createGame('practice', TODAY)
    const second = createGame('practice', TODAY)
    expect(first.id).not.toBe(second.id)
    expect(first).toMatchObject({ mode: 'practice', index: 0, results: [], finished: false })
  })

  it('isolates dated daily progress from practice', () => {
    expect(storageKey('daily', TODAY)).not.toBe(storageKey('daily', '2026-10-19'))
    expect(storageKey('practice', TODAY)).toBe(storageKey('practice', '2026-10-19'))
    expect(storageKey('practice', TODAY)).not.toBe(storageKey('daily', TODAY))
  })
})

describe('local calendar days', () => {
  it.each([
    ['America/New_York', '2026-10-19T03:59:59.999Z', '2026-10-18', 1],
    ['America/New_York', '2026-10-19T04:00:00.000Z', '2026-10-19', 86_400_000],
    ['Asia/Tokyo', '2026-10-18T14:59:59.999Z', '2026-10-18', 1],
    ['Asia/Tokyo', '2026-10-18T15:00:00.000Z', '2026-10-19', 86_400_000],
  ])('uses the device day in %s at %s', (timezone, instant, expectedDay, remaining) => {
    vi.stubEnv('TZ', timezone)
    vi.setSystemTime(new Date(instant))
    expect(localDate()).toBe(expectedDay)
    expect(millisecondsUntilLocalMidnight()).toBe(remaining)
    expect(createGame('daily')).toEqual(createGame('daily', expectedDay))
    expect(storageKey('daily')).toBe(storageKey('daily', expectedDay))
    expect(loadGame('daily').date).toBe(expectedDay)
  })

  it.each([
    ['2026-03-08T00:00:00-05:00', 23],
    ['2026-11-01T00:00:00-04:00', 25],
  ])('schedules the next local midnight on a DST day starting %s', (instant, hours) => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(millisecondsUntilLocalMidnight(new Date(instant))).toBe(hours * 60 * 60 * 1_000)
  })

  it('pads the local month and day and advances across a year boundary', () => {
    expect(localDate(new Date(2026, 0, 2))).toBe('2026-01-02')
    const lastMoment = new Date(2026, 11, 31, 23, 59, 59, 999)
    expect(localDate(lastMoment)).toBe('2026-12-31')
    expect(millisecondsUntilLocalMidnight(lastMoment)).toBe(1)
    expect(localDate(new Date(lastMoment.getTime() + 1))).toBe('2027-01-01')
  })
})

describe('saved game recovery', () => {
  it('resumes before submission, after submission, and after moving to the next round', () => {
    const unsubmitted = createGame('daily', TODAY)
    const submitted = answeredGame()
    const nextRound = { ...submitted, index: 1 }
    for (const state of [unsubmitted, submitted, nextRound, answeredGame(6, true)]) {
      expect(saveStorage(storageKey('daily'), state)).toBe(true)
      expect(loadGame('daily')).toEqual(state)
    }
  })

  it('opens results after seven saved daily answers even without clicking Results', () => {
    const finalFeedback = answeredGame(6)
    saveStorage(storageKey('daily'), finalFeedback)
    const resumed = loadGame('daily')
    expect(resumed).toEqual({ ...finalFeedback, finished: true })
    expect(readStorage(storageKey('daily'), null)).toEqual(resumed)
    expect(completedGames()).toEqual([{
      id: finalFeedback.id, mode: 'daily', date: TODAY,
      score: totalScore(finalFeedback.results), scoringVersion: SCORING_VERSION,
    }])
    expect(loadGame('daily')).toEqual(resumed)
    expect(completedGames()).toHaveLength(1)
  })

  it('recovers from missing, invalid JSON, and unavailable browser storage', () => {
    const fresh = createGame('daily', TODAY)
    expect(loadGame('daily')).toEqual(fresh)
    localStorage.setItem(storageKey('daily'), '{broken')
    expect(loadGame('daily')).toEqual(fresh)
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('Storage blocked') })
    expect(readStorage('unavailable', 'fallback')).toBe('fallback')
    expect(loadGame('daily')).toEqual(fresh)
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('Quota reached') })
    expect(saveStorage('unavailable', fresh)).toBe(false)
  })

  it.each([
    ['null result', (game: any) => { game.results = [null] }],
    ['incomplete result', (game: any) => { game.results = [{ penalty: 0 }] }],
    ['missing evaluation', (game: any) => { delete game.results[0].evaluation }],
    ['invalid evaluation', (game: any) => { game.results[0].evaluation = { cp: null, mate: null, depth: 18, bestMove: '', pv: [] } }],
    ['invalid principal variation', (game: any) => { game.results[0].evaluation.pv = null }],
    ['invalid guess', (game: any) => { game.results[0].guess = {} }],
    ['invalid answer', (game: any) => { game.results[0].answer = {} }],
    ['mismatched result position', (game: any) => { game.results[0].puzzleId = game.puzzleIds[1] }],
    ['negative penalty', (game: any) => { game.results[0].penalty = -1 }],
    ['non-numeric penalty', (game: any) => { game.results[0].penalty = '0' }],
    ['missing game id', (game: any) => { delete game.id }],
    ['invalid date', (game: any) => { game.date = 'not-a-date' }],
    ['non-boolean finished', (game: any) => { game.finished = 0 }],
    ['duplicate positions', (game: any) => { game.puzzleIds[1] = game.puzzleIds[0] }],
    ['unknown position', (game: any) => { game.puzzleIds[2] = 'missing-position' }],
    ['wrong number of positions', (game: any) => { game.puzzleIds.pop() }],
    ['negative round index', (game: any) => { game.index = -1 }],
    ['fractional round index', (game: any) => { game.index = 0.5 }],
    ['skipped rounds', (game: any) => { game.index = 4 }],
    ['premature completion', (game: any) => { game.finished = true }],
    ['wrong mode', (game: any) => { game.mode = 'practice' }],
    ['unknown version', (game: any) => { game.version = 2 }],
    ['unknown scoring version', (game: any) => { game.scoringVersion = 99 }],
    ['invalid scoring version', (game: any) => { game.scoringVersion = '3' }],
  ])('starts fresh after a saved game has %s', (_, corrupt) => {
    const saved = structuredClone(answeredGame())
    corrupt(saved)
    localStorage.setItem(storageKey('daily'), JSON.stringify(saved))
    expect(() => loadGame('daily')).not.toThrow()
    expect(loadGame('daily')).toEqual(createGame('daily', TODAY))
  })

  it('records a completed game once when it is loaded repeatedly', () => {
    const game = answeredGame(6, true)
    recordCompletion(game)
    recordCompletion(game)
    expect(completedGames()).toEqual([{ id: game.id, mode: 'daily', date: TODAY, score: totalScore(game.results), scoringVersion: SCORING_VERSION }])
  })

  it('recalculates legacy winner penalties while preserving the saved challenge and later rounds', () => {
    const saved = answeredGame(3)
    saved.results[0] = { ...saved.results[0], guess: 'Black', answer: 'White', penalty: 4,
      evaluation: { ...saved.results[0].evaluation, cp: 230 } }
    saved.results[1] = { ...saved.results[1], guess: 'White', answer: 'Black', penalty: 4,
      evaluation: { ...saved.results[1].evaluation, cp: -175 } }
    saveStorage(storageKey('daily'), saved)

    const resumed = loadGame('daily')
    expect(resumed).toEqual({ ...saved, results: [
      { ...saved.results[0], penalty: 2.3 },
      { ...saved.results[1], penalty: 1.75 },
      ...saved.results.slice(2),
    ] })
    expect(readStorage(storageKey('daily'), null)).toEqual(resumed)
    expect(loadGame('daily')).toEqual(resumed)
  })

  it('keeps correct winner answers at zero when resuming', () => {
    const saved = answeredGame(1)
    saved.results[0] = { ...saved.results[0], guess: 'White', answer: 'White', penalty: 0,
      evaluation: { ...saved.results[0].evaluation, cp: 230 } }
    saved.results[1] = { ...saved.results[1], guess: 'Black', answer: 'Black', penalty: 0,
      evaluation: { ...saved.results[1].evaluation, cp: -400 } }
    saveStorage(storageKey('daily'), saved)
    expect(loadGame('daily')).toEqual(saved)
  })

  it.each([undefined, 1, 2])('converts version %s numeric scores to absolute error exactly once', scoringVersion => {
    const saved = answeredGame(3)
    saved.scoringVersion = scoringVersion
    saved.results[0] = { ...saved.results[0], guess: 'White', penalty: 0,
      evaluation: { ...saved.results[0].evaluation, cp: 230 } }
    saved.results[1] = { ...saved.results[1], guess: 'Black', penalty: 4,
      evaluation: { ...saved.results[1].evaluation, cp: 175 } }
    saved.results[2] = { ...saved.results[2], guess: '+2.30', penalty: 2.25,
      evaluation: { ...saved.results[2].evaluation, cp: 80 } }
    saved.results[3] = { ...saved.results[3], guess: '-4.00', penalty: 4,
      evaluation: { ...saved.results[3].evaluation, cp: -200 } }
    saveStorage(storageKey('daily'), saved)

    const resumed = loadGame('daily')
    expect(resumed).toMatchObject({ id: saved.id, puzzleIds: saved.puzzleIds, index: 3, scoringVersion: SCORING_VERSION })
    expect(resumed.results.map(result => result.penalty)).toEqual([0, 1.75, 1.5, 2])
    expect(loadGame('daily')).toEqual(resumed)
  })

  it('preserves the challenge and rewinds a completed legacy evaluation round 5', () => {
    const saved = answeredGame(6, true)
    saved.scoringVersion = 2
    const usedSources = new Set(saved.puzzleIds.filter((_, index) => index !== 4).map(id => puzzles.find(p => p.id === id)!.rawPuzzleId))
    const oldPosition = puzzles.find(p => p.phase === 'before' && p.rating >= 1800 && !usedSources.has(p.rawPuzzleId))!
    saved.puzzleIds[4] = oldPosition.id
    saved.results[4] = { puzzleId: oldPosition.id, guess: '+2.00', answer: '+3.50', penalty: 2.25, evaluation: oldPosition.evaluation }
    const oldTotal = { id: saved.id, mode: saved.mode, date: saved.date, score: totalScore(saved.results), scoringVersion: 2 }
    saveStorage(storageKey('daily'), saved)
    saveStorage('chessdle:v1:history', [oldTotal])

    const resumed = loadGame('daily')
    expect(resumed).toMatchObject({ id: saved.id, mode: saved.mode, date: saved.date, index: 4, finished: false, scoringVersion: SCORING_VERSION })
    expect(resumed.results).toHaveLength(4)
    expect(resumed.results.map(result => result.puzzleId)).toEqual(saved.results.slice(0, 4).map(result => result.puzzleId))
    expect(resumed.puzzleIds.filter((_, index) => index !== 4)).toEqual(saved.puzzleIds.filter((_, index) => index !== 4))
    const replacement = puzzles.find(p => p.id === resumed.puzzleIds[4])!
    expect(replacement.phase).toBe('after')
    expect(replacement.rating).toBeGreaterThanOrEqual(1800)
    expect(usedSources.has(replacement.rawPuzzleId)).toBe(false)
    expect(completedGames()).toEqual([])
    recordCompletion(saved)
    expect(readStorage('chessdle:v1:history', [])).toEqual([oldTotal])
    expect(loadGame('daily')).toEqual(resumed)
    saveStorage(storageKey('daily'), saved)
    expect(loadGame('daily')).toEqual(resumed)
  })

  it('retains an eligible round 5 position while discarding its old evaluation answer', () => {
    const saved = answeredGame(4)
    saved.scoringVersion = 2
    delete saved.results[4].move
    saved.results[4].guess = '+1.00'
    saveStorage(storageKey('daily'), saved)
    const resumed = loadGame('daily')
    expect(resumed).toMatchObject({ id: saved.id, puzzleIds: saved.puzzleIds, index: 4, finished: false })
    expect(resumed.results).toHaveLength(4)
  })

  it('preserves practice progress before round 5 when replacing its old position', () => {
    const saved = createGame('practice', TODAY)
    saved.scoringVersion = 2
    saved.index = 2
    saved.results = [answerFor(saved, 0), answerFor(saved, 1)]
    const usedSources = new Set(saved.puzzleIds.filter((_, index) => index !== 4).map(id => puzzles.find(p => p.id === id)!.rawPuzzleId))
    saved.puzzleIds[4] = puzzles.find(p => p.phase === 'before' && p.rating >= 1800 && !usedSources.has(p.rawPuzzleId))!.id
    saveStorage(storageKey('practice'), saved)
    const resumed = loadGame('practice')
    expect(resumed).toMatchObject({ id: saved.id, mode: 'practice', index: 2, finished: false })
    expect(resumed.results).toHaveLength(2)
    expect(resumed.puzzleIds[4]).not.toBe(saved.puzzleIds[4])
    expect(loadGame('practice')).toEqual(resumed)
  })

  it('converts saved move and mate scores once when round 5 already contains a move', () => {
    const saved = answeredGame(6, true)
    saved.scoringVersion = 2
    saved.results[4].penalty = 2.25
    saved.results[5].penalty = 6.25
    saved.results[6].guess = `Mate in ${Math.abs(saved.results[6].evaluation.mate!) + 2}`
    saved.results[6].penalty = 4
    saveStorage(storageKey('daily'), saved)
    const resumed = loadGame('daily')
    expect(resumed.finished).toBe(true)
    expect(resumed.results.slice(4).map(result => result.penalty)).toEqual([1.5, 2.5, 2])
    expect(loadGame('daily')).toEqual(resumed)
    expect(completedGames()[0].score).toBe(totalScore(resumed.results))
  })

  it('updates an already completed legacy total without losing older aggregate history', () => {
    const saved = answeredGame(6, true)
    saved.results[0] = { ...saved.results[0], guess: 'Black', answer: 'White', penalty: 4,
      evaluation: { ...saved.results[0].evaluation, cp: 230 } }
    saved.results[1] = { ...saved.results[1], guess: 'Black', answer: 'Black', penalty: 0,
      evaluation: { ...saved.results[1].evaluation, cp: -175 } }
    const earlier = { id: 'chessdle-v1-2026-10-17', mode: 'daily', date: '2026-10-17', score: 8 }
    const legacy = { id: saved.id, mode: saved.mode, date: saved.date, score: totalScore(saved.results) }
    saveStorage(storageKey('daily'), saved)
    saveStorage('chessdle:v1:history', [earlier, legacy])

    const resumed = loadGame('daily')
    const updated = { ...legacy, score: totalScore(resumed.results), scoringVersion: SCORING_VERSION }
    expect(updated.score).toBeCloseTo(legacy.score - 1.7)
    expect(completedGames()).toEqual([updated])
    expect(readStorage('chessdle:v1:history', [])).toEqual([earlier, updated])
    recordCompletion(resumed)
    expect(readStorage('chessdle:v1:history', [])).toEqual([earlier, updated])
  })

  it('preserves aggregate-only legacy history when recording a new game', () => {
    const legacy = { id: 'old-practice', mode: 'practice', date: TODAY, score: 6, scoringVersion: 2 }
    saveStorage('chessdle:v1:history', [legacy])
    expect(completedGames()).toEqual([])
    recordCompletion(answeredGame(6, true))
    expect(completedGames()).toHaveLength(1)
    expect(readStorage('chessdle:v1:history', [])).toHaveLength(2)
    expect(readStorage('chessdle:v1:history', [])[0]).toEqual(legacy)
  })

  it('ignores corrupt history entries without hiding valid completed games', () => {
    const good = { id: 'completed', mode: 'daily', date: TODAY, score: 3.25, scoringVersion: SCORING_VERSION }
    saveStorage('chessdle:v1:history', [null, {}, good, { ...good, score: 'broken' }])
    expect(completedGames()).toEqual([good])
    saveStorage('chessdle:v1:history', 'bad history')
    expect(completedGames()).toEqual([])
  })
})

describe('saving daily progress across tabs', () => {
  it('saves completion with the seventh answer and keeps identical state references stable', () => {
    const finalFeedback = answeredGame(6)
    const saved = saveGame(finalFeedback)
    expect(saved.saved).toBe(true)
    expect(saved.game).toEqual({ ...finalFeedback, finished: true })
    expect(saved.game.puzzleIds).toBe(finalFeedback.puzzleIds)
    expect(saved.game.results).toBe(finalFeedback.results)
    expect(loadGame('daily')).toEqual(saved.game)
    expect(completedGames()).toHaveLength(1)
    const writeCount = vi.mocked(localStorage.setItem).mock.calls.length
    expect(saveGame(saved.game)).toEqual({ game: saved.game, saved: true })
    expect(saveGame(saved.game).game).toBe(saved.game)
    expect(vi.mocked(localStorage.setItem).mock.calls).toHaveLength(writeCount)
  })

  it('preserves completed daily answers when an older tab saves partial or conflicting complete progress', () => {
    const completed = saveGame(answeredGame(6)).game
    const partial = answeredGame(2)
    const conflicting = structuredClone(completed)
    conflicting.results[6] = { ...conflicting.results[6], guess: 'Mate in 19', penalty: 16 }
    for (const stale of [partial, conflicting]) {
      expect(saveGame(stale)).toEqual({ game: completed, saved: true })
      expect(loadGame('daily')).toEqual(completed)
    }
    expect(completedGames()[0].score).toBe(totalScore(completed.results))
  })

  it('adopts more advanced partial progress and never returns to its previous feedback screen', () => {
    const submitted = answeredGame(1)
    const advanced = { ...submitted, index: 2 }
    expect(saveGame(advanced).game).toBe(advanced)
    expect(saveGame(answeredGame()).game).toEqual(advanced)
    expect(saveGame(submitted).game).toEqual(advanced)
    expect(loadGame('daily')).toEqual(advanced)
  })

  it('accepts new answers only when they extend the saved daily answer prefix', () => {
    const first = answeredGame()
    saveGame(first)
    const conflicting = answeredGame(2)
    conflicting.results[0] = { ...conflicting.results[0], guess: 'different answer' }
    expect(saveGame(conflicting)).toEqual({ game: first, saved: true })
    expect(loadGame('daily')).toEqual(first)

    const extension = answeredGame(2)
    expect(saveGame(extension).game).toBe(extension)
    expect(loadGame('daily')).toEqual(extension)
  })

  it('keeps the saved daily layout when a different tab supplies another puzzle order', () => {
    const saved = createGame('daily', TODAY)
    saveGame(saved)
    const changed = { ...saved, puzzleIds: [...saved.puzzleIds] }
    ;[changed.puzzleIds[0], changed.puzzleIds[2]] = [changed.puzzleIds[2], changed.puzzleIds[0]]
    expect(saveGame(changed)).toEqual({ game: saved, saved: true })
    expect(loadGame('daily').puzzleIds).toEqual(saved.puzzleIds)
  })

  it('restores the same positions and answers throughout a local day, then starts the next daily', () => {
    vi.setSystemTime(new Date(2026, 9, 18, 0, 0, 1))
    const progress = { ...answeredGame(2), index: 3 }
    saveGame(progress)
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59))
    expect(loadGame('daily')).toEqual(progress)
    expect(createGame('daily').puzzleIds).toEqual(progress.puzzleIds)
    vi.setSystemTime(new Date(2026, 9, 19))
    const nextDay = loadGame('daily')
    expect(nextDay).toEqual(createGame('daily', '2026-10-19'))
    expect(nextDay.id).not.toBe(progress.id)
    expect(nextDay.results).toEqual([])
    expect(readStorage(storageKey('daily', TODAY), null)).toEqual(progress)
  })

  it('saves a previous-day snapshot to its own key without overwriting today', () => {
    const previous = answeredGame(6)
    vi.setSystemTime(new Date(2026, 9, 19))
    const today = createGame('daily')
    saveGame(today)
    expect(saveGame(previous).saved).toBe(true)
    expect(readStorage<GameState | null>(storageKey('daily', TODAY), null)?.finished).toBe(true)
    expect(loadGame('daily')).toEqual(today)
    expect(completedGames()).toEqual([{
      id: previous.id, mode: 'daily', date: TODAY,
      score: totalScore(previous.results), scoringVersion: SCORING_VERSION,
    }])
  })

  it('keeps completed daily results and history after local midnight without relabeling them', () => {
    const completed = saveGame(answeredGame(6)).game
    const history = completedGames()
    vi.setSystemTime(new Date(2026, 9, 19))
    saveGame(loadGame('daily'))
    expect(readStorage(storageKey('daily', TODAY), null)).toEqual(completed)
    expect(completedGames()).toEqual(history)
    expect(loadGame('daily')).toEqual(createGame('daily', '2026-10-19'))
    // Returning to the same local calendar date resumes the original results.
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59))
    expect(loadGame('daily')).toEqual(completed)
  })

  it('keeps practice independent and allows a fresh practice after a finished one', () => {
    const daily = saveGame(answeredGame(6)).game
    const practice = createGame('practice')
    practice.index = 6
    practice.results = ROUND_PLAN.map((_, index) => answerFor(practice, index))
    expect(saveGame(practice).game).toBe(practice)
    expect(loadGame('practice').finished).toBe(false)
    const finished = { ...practice, finished: true }
    saveGame(finished)
    const fresh = createGame('practice')
    expect(saveGame(fresh).game).toBe(fresh)
    expect(loadGame('practice')).toEqual(fresh)
    expect(loadGame('daily')).toEqual(daily)
    expect(completedGames()).toHaveLength(2)
  })

  it('does not mark a rewound legacy round five as complete when saving', () => {
    const legacy = answeredGame(6, true)
    legacy.scoringVersion = 2
    delete legacy.results[4].move
    saveStorage(storageKey('daily'), legacy)
    const saved = saveGame(legacy)
    expect(saved.saved).toBe(true)
    expect(saved.game).toMatchObject({ index: 4, finished: false, scoringVersion: SCORING_VERSION })
    expect(saved.game.results).toHaveLength(4)
    expect(loadGame('daily')).toEqual(saved.game)
    expect(completedGames()).toEqual([])
  })

  it('replaces corrupt stored data without accepting invalid incoming progress', () => {
    localStorage.setItem(storageKey('daily'), '{broken')
    const progress = answeredGame()
    expect(saveGame(progress)).toEqual({ game: progress, saved: true })
    const invalid = { ...progress, index: 6 }
    expect(saveGame(invalid)).toEqual({ game: invalid, saved: false })
    expect(loadGame('daily')).toEqual(progress)
  })

  it('reports inaccessible storage without writing over unknown existing progress', () => {
    const progress = answeredGame()
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('Storage blocked') })
    expect(saveGame(progress)).toEqual({ game: progress, saved: false })
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('reports write failures and retains the current in-memory game', () => {
    const progress = answeredGame()
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('Quota reached') })
    expect(saveGame(progress)).toEqual({ game: progress, saved: false })
  })

  it('reports completion-history write failures while preserving the saved daily answers', () => {
    const write = vi.mocked(localStorage.setItem).getMockImplementation()!
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key === 'chessdle:v1:history') throw new Error('Quota reached')
      write(key, value)
    })
    const saved = saveGame(answeredGame(6))
    expect(saved.saved).toBe(false)
    expect(saved.game.finished).toBe(true)
    expect(readStorage(storageKey('daily'), null)).toEqual(saved.game)
  })
})
