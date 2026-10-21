// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Chess } from 'chess.js'
import App from './App'
import { evaluatePosition } from './lib/engine'
import { ROUND_PLAN, createGame, formatEvaluation, puzzles, storageKey, type GameState } from './lib/game'

// The real browser WASM entrypoint is exercised in engine.integration.test.ts.
// Here only its asynchronous evaluation boundary is mocked; the board, legal
// move generation, scoring, persistence, and all seven rounds are real.
vi.mock('./lib/engine', () => ({ evaluatePosition: vi.fn() }))

function savedGame(mode: 'daily' | 'practice' = 'daily'): GameState {
  return JSON.parse(localStorage.getItem(storageKey(mode))!) as GameState
}

function positionFor(game: GameState, index = game.index) {
  return puzzles.find(puzzle => puzzle.id === game.puzzleIds[index])!
}

function expectSideToPlayAtBottom(fen: string) {
  const blackToPlay = new Chess(fen).turn() === 'b'
  const squares = [...document.querySelectorAll('[data-square]')]
    .map(square => square.getAttribute('data-square'))
  expect(squares).toHaveLength(64)
  expect(squares.slice(0, 8)).toEqual(blackToPlay
    ? ['h1', 'g1', 'f1', 'e1', 'd1', 'c1', 'b1', 'a1']
    : ['a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8'])
  expect(squares.slice(-8)).toEqual(blackToPlay
    ? ['h8', 'g8', 'f8', 'e8', 'd8', 'c8', 'b8', 'a8']
    : ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1'])
}

function selectMove(uci: string) {
  fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(`^${uci.slice(0, 2)},`) }))
  const destination = screen.getByRole('gridcell', { name: new RegExp(`^${uci.slice(2, 4)},`) })
  expect(destination.getAttribute('aria-label')).toContain('legal destination')
  fireEvent.click(destination)
  if (uci.length === 5) {
    const names: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
    fireEvent.click(screen.getByRole('button', { name: `Promote to ${names[uci[4]]}` }))
  }
}

function advanceTo(index: number): GameState {
  const game = createGame('daily')
  game.index = index
  game.results = Array.from({ length: index }, (_, round) => {
    const puzzle = positionFor(game, round)
    return {
      puzzleId: puzzle.id,
      guess: round < 2 ? puzzle.evaluation.cp! > 0 ? 'White' : 'Black' : 'Correct',
      answer: round < 2 ? puzzle.evaluation.cp! > 0 ? 'White' : 'Black' : 'Correct',
      penalty: 0,
      evaluation: puzzle.evaluation,
      ...(ROUND_PLAN[round].type === 'move' ? { move: puzzle.evaluation.bestMove } : {}),
    }
  })
  localStorage.setItem(storageKey('daily'), JSON.stringify(game))
  return game
}

function completedDaily(game: GameState): GameState {
  return { ...game, index: 6, finished: true, results: game.puzzleIds.map((_, index) => {
    if (game.results[index]) return game.results[index]
    const puzzle = positionFor(game, index)
    return {
      puzzleId: puzzle.id, guess: 'Correct', answer: 'Correct', penalty: 0,
      evaluation: puzzle.evaluation,
      ...(ROUND_PLAN[index].type === 'move' ? { move: puzzle.evaluation.bestMove } : {}),
    }
  }) }
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', '')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request in an App test')))
  // Node 26 exposes its own optional localStorage global; use jsdom's actual
  // origin-scoped browser storage for this UI suite.
  const dom = (globalThis as unknown as { jsdom: { window: { localStorage: Storage } } }).jsdom
  vi.stubGlobal('localStorage', dom.window.localStorage)
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 18, 12))
  vi.stubGlobal('crypto', { randomUUID })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  // jsdom has dialog elements but does not implement the browser's modal methods.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false } },
  })
  vi.mocked(evaluatePosition).mockReset()
  vi.mocked(evaluatePosition).mockImplementation(async (fen) => {
    const puzzle = puzzles.find(position => position.fen === fen)
    if (!puzzle) throw new Error('Unexpected test position')
    return puzzle.evaluation
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('playing Chessdle', () => {
  it('submits the last daily answer and restores its percentile with the same player after reload', async () => {
    const origin = 'https://app-test.supabase.co'
    vi.stubEnv('VITE_SUPABASE_URL', origin)
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test-only')
    const game = advanceTo(6)
    const puzzle = positionFor(game)
    const response = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === `${origin}/auth/v1/signup`) return response({
        access_token: 'test-access', refresh_token: 'test-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'test-player' },
      })
      if (url === `${origin}/rest/v1/rpc/submit_daily_score`) return response({
        day: game.date, scoring_version: 3, score: 2, rank: 2, total_players: 4,
        better_than_percentile: 100 * 2 / 3, tied_players: 1,
        distribution: { bin_width: 0.5, min_score: 0, max_score: 5,
          bins: [0, 2, 3, 5].map(start => ({ start, count: 1 })),
        },
      })
      throw new Error('Unexpected test endpoint')
    })
    vi.stubGlobal('fetch', fetch)
    let view = render(<App />)
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mate in how many moves' }), {
      target: { value: String(Math.abs(puzzle.evaluation.mate!) + 2) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    const [url, request] = fetch.mock.calls[1]
    expect(url).toBe(`${origin}/rest/v1/rpc/submit_daily_score`)
    expect(JSON.parse(request.body)).toEqual({
      p_day: game.date, p_scoring_version: 3, p_puzzle_ids: game.puzzleIds,
      p_round_penalties: [0, 0, 0, 0, 0, 0, 2],
    })
    expect(request.headers.Authorization).toBe('Bearer test-access')
    expect(savedGame().finished).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: 'See my results' }))
    expect(await screen.findByText('66.7%')).toBeTruthy()
    expect(screen.getByText('✓ Saved')).toBeTruthy()
    expect(screen.getByText('You · 2.00')).toBeTruthy()
    expect(screen.getByText('Normal estimate')).toBeTruthy()
    expect(screen.getByRole('img', { name: /Daily score distribution/ }).querySelector('desc')?.textContent)
      .toContain('4 players’ scores, from 0.00 to 5.00 points')
    view.unmount()
    view = render(<App />)
    expect(await screen.findByText('66.7%')).toBeTruthy()
    expect(screen.getByText('You · 2.00')).toBeTruthy()
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/signup'))).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer test-access')
    view.unmount()
  })

  it('reopens daily results after the seventh answer even without clicking Results', async () => {
    const game = advanceTo(6)
    const puzzle = positionFor(game)
    let view = render(<App />)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Mate in how many moves' }), {
      target: { value: String(Math.abs(puzzle.evaluation.mate!)) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
    expect(await screen.findByRole('region', { name: 'Round 7 result' })).toBeTruthy()
    expect(savedGame().finished).toBe(true)
    view.unmount()

    view = render(<App />)
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Round 7 result' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Daily challenge' }))
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(savedGame().puzzleIds).toEqual(game.puzzleIds)
    expect(JSON.parse(localStorage.getItem('chessdle:v1:history')!)).toHaveLength(1)
    view.unmount()
  })

  it('keeps today’s boards through reloads and switches days at local midnight on focus', () => {
    const game = advanceTo(2)
    let view = render(<App />)
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59))
    fireEvent.focus(window)
    expect(savedGame()).toEqual(game)
    view.unmount()
    view = render(<App />)
    expect(savedGame()).toEqual(game)
    expect(screen.getByRole('heading', { name: ROUND_PLAN[2].title })).toBeTruthy()

    vi.setSystemTime(new Date(2026, 9, 19))
    fireEvent.focus(window)
    expect(savedGame()).toEqual(createGame('daily', '2026-10-19'))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(storageKey('daily', game.date))!)).toEqual(game)
    view.unmount()
  })

  it('keeps the same daily after UTC midnight while it is still the previous local day', () => {
    vi.stubEnv('TZ', 'America/New_York')
    vi.setSystemTime(new Date('2026-10-18T23:59:59Z'))
    const game = advanceTo(2)
    const view = render(<App />)
    vi.setSystemTime(new Date('2026-10-19T00:00:01Z'))
    fireEvent.focus(window)
    expect(savedGame()).toEqual(game)
    expect(game.date).toBe('2026-10-18')
    view.unmount()
    render(<App />)
    expect(savedGame()).toEqual(game)
    expect(screen.getByRole('heading', { name: ROUND_PLAN[2].title })).toBeTruthy()
  })

  it('automatically opens the next daily at local midnight and keeps yesterday’s scores in Statistics', () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59))
    const completed = completedDaily(createGame('daily'))
    localStorage.setItem(storageKey('daily'), JSON.stringify(completed))
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(screen.getByText('Next daily at midnight, your time.')).toBeTruthy()

    act(() => { vi.advanceTimersByTime(999) })
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(101) })
    expect(savedGame()).toEqual(createGame('daily', '2026-10-19'))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(storageKey('daily', completed.date))!)).toEqual(completed)

    fireEvent.click(screen.getByRole('button', { name: 'Your statistics' }))
    expect(screen.getByText(completed.date)).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('chessdle:v1:history')!)).toHaveLength(1)
  })

  it('catches up after a mobile tab sleeps through local midnight', () => {
    const game = advanceTo(2)
    render(<App />)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.setSystemTime(new Date(2026, 9, 19, 1))
    fireEvent(document, new Event('visibilitychange'))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[2].title })).toBeTruthy()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    expect(savedGame()).toEqual(createGame('daily', '2026-10-19'))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(storageKey('daily', game.date))!)).toEqual(game)
  })

  it('saves an in-flight move to its original day before opening the new daily', async () => {
    const game = advanceTo(5)
    const puzzle = positionFor(game)
    let resolve!: (evaluation: typeof puzzle.evaluation) => void
    vi.mocked(evaluatePosition).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<App />)
    selectMove(puzzle.evaluation.bestMove)
    fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
    vi.setSystemTime(new Date(2026, 9, 19))
    fireEvent.focus(window)
    resolve(puzzle.evaluation)
    await screen.findByRole('heading', { name: ROUND_PLAN[0].title })
    expect(savedGame()).toEqual(createGame('daily', '2026-10-19'))
    const previous = JSON.parse(localStorage.getItem(storageKey('daily', game.date))!) as GameState
    expect(previous.results).toHaveLength(6)
    expect(previous.results[5].move).toBe(puzzle.evaluation.bestMove)
  })

  it('shows results when another tab completes today’s daily', () => {
    const game = advanceTo(2)
    render(<App />)
    const completed = completedDaily(game)
    localStorage.setItem(storageKey('daily'), JSON.stringify(completed))
    fireEvent(window, new StorageEvent('storage', { key: storageKey('daily') }))
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(savedGame()).toEqual(completed)
  })

  it('preserves a completed daily when an older tab finishes an engine search', async () => {
    const game = advanceTo(5)
    const puzzle = positionFor(game)
    let resolve!: (evaluation: typeof puzzle.evaluation) => void
    vi.mocked(evaluatePosition).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    render(<App />)
    selectMove(puzzle.evaluation.bestMove)
    fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
    expect(screen.getByRole('button', { name: 'Analyzing move' })).toBeTruthy()

    const completed = completedDaily(game)
    localStorage.setItem(storageKey('daily'), JSON.stringify(completed))
    fireEvent(window, new StorageEvent('storage', { key: storageKey('daily') }))
    resolve(puzzle.evaluation)
    expect(await screen.findByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(savedGame()).toEqual(completed)
    expect(screen.queryByRole('button', { name: 'Next position' })).toBeNull()
  })

  it('completes all seven rounds, restores progress, shares and reviews results, and starts practice', async () => {
    let view = render(<App />)
    const daily = savedGame()
    expect(ROUND_PLAN.map(round => round.type)).toEqual(['winner', 'winner', 'evaluation', 'evaluation', 'move', 'move', 'mate'])
    for (let index = 0; index < 7; index += 1) {
      const round = ROUND_PLAN[index]
      const puzzle = positionFor(daily, index)
      expect(screen.getByRole('heading', { name: round.title })).toBeTruthy()
      expectSideToPlayAtBottom(puzzle.fen)
      const submit = screen.getByRole('button', { name: `Submit ${round.type === 'move' ? 'move' : 'answer'}` }) as HTMLButtonElement
      expect(submit.disabled).toBe(true)

      if (round.type === 'winner') {
        const color = puzzle.evaluation.cp! > 0 ? 'White' : 'Black'
        fireEvent.click(screen.getByRole('button', { name: `${color} is winning` }))
      } else if (round.type === 'evaluation') {
        // A two-pawn miss adds two points under L1, rather than four.
        const guess = puzzle.evaluation.cp! / 100 + (index === 2 ? 2 : 0)
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Evaluation' }), { target: { value: guess.toFixed(2) } })
      } else if (round.type === 'mate') {
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Mate in how many moves' }), { target: { value: String(Math.abs(puzzle.evaluation.mate!)) } })
      } else {
        const board = new Chess(puzzle.fen)
        const opponent = board.board().flat().find(piece => piece && piece.color !== board.turn())!
        fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(`^${opponent.square},`) }))
        expect(submit.disabled).toBe(true)
        selectMove(puzzle.evaluation.bestMove)
        expectSideToPlayAtBottom(puzzle.fen)
        expect(submit.disabled).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Choose another move' }))
        expect(submit.disabled).toBe(true)
        selectMove(puzzle.evaluation.bestMove)
      }

      expect(submit.disabled).toBe(false)
      fireEvent.click(submit)
      const nextName = index === 6 ? 'See my results' : 'Next position'
      await screen.findByRole('button', { name: nextName }).catch(() => {
        throw new Error(`Round ${index + 1} did not submit: ${document.querySelector('.answer-controls')?.textContent}; inputs: ${[...document.querySelectorAll('input')].map(input => `${input.value} valid=${input.checkValidity()}`).join(', ')}`)
      })
      expect(screen.getByText(index === 2 ? '+2.00 points' : '+0.00 points')).toBeTruthy()
      expect(savedGame().results).toHaveLength(index + 1)
      expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()

      if (index === 2) {
        view.unmount()
        view = render(<App />)
        expect(screen.getByRole('heading', { name: round.title })).toBeTruthy()
        expect(screen.getByText('+2.00 points')).toBeTruthy()
        expect(savedGame().results).toHaveLength(3)
      }
      fireEvent.click(screen.getByRole('button', { name: nextName }))
    }

    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(screen.getByText('2.00')).toBeTruthy()
    expect(savedGame()).toMatchObject({ finished: true, index: 6 })
    expect(savedGame().results).toHaveLength(7)
    expect(evaluatePosition).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Review round 1' }))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    expectSideToPlayAtBottom(positionFor(daily, 0).fen)
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share my results' }))
    const share = await screen.findByRole('textbox', { name: 'Copy your results' }) as HTMLTextAreaElement
    expect(share.value).toContain('2.00 points · 7/7')

    view.unmount()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('chessdle:v1:history')!)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Keep practicing' }))
    expect(screen.getByRole('heading', { name: ROUND_PLAN[0].title })).toBeTruthy()
    expectSideToPlayAtBottom(positionFor(savedGame('practice')).fen)
    expect(savedGame('practice')).toMatchObject({ mode: 'practice', index: 0, results: [], finished: false })
    expect(savedGame('practice').id).not.toBe(daily.id)
    fireEvent.click(screen.getByRole('button', { name: 'Daily challenge' }))
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeTruthy()
  }, 15_000)

  it.each([{ index: 0, sign: 1 }, { index: 1, sign: -1 }])(
    'adds the absolute pawn evaluation for a wrong winner in round $index', async ({ index, sign }) => {
      const game = advanceTo(index)
      const puzzle = puzzles.find(position =>
        !game.puzzleIds.includes(position.id) &&
        position.evaluation.cp !== null && position.evaluation.mate === null &&
        Math.sign(position.evaluation.cp) === sign &&
        Math.abs(position.evaluation.cp) >= 50 && Math.abs(position.evaluation.cp) <= 1000 &&
        Math.abs(position.evaluation.cp) !== 400 &&
        (position.rating < 1800) === (index === 0))!
      game.puzzleIds[index] = puzzle.id
      localStorage.setItem(storageKey('daily'), JSON.stringify(game))
      render(<App />)
      expect(screen.queryByRole('region', { name: `Round ${index + 1} result` })).toBeNull()
      expect(screen.queryByTitle('Evaluation in pawns, from White’s perspective')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: `${sign > 0 ? 'Black' : 'White'} is winning` }))
      fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
      await screen.findByRole('button', { name: 'Next position' })
      const penalty = Math.abs(puzzle.evaluation.cp!) / 100
      expect(screen.getByText(`+${penalty.toFixed(2)} points`)).toBeTruthy()
      const overlay = screen.getByRole('region', { name: `Round ${index + 1} result` })
      expect(within(overlay).getByText(formatEvaluation(puzzle.evaluation))).toBeTruthy()
      expect(document.activeElement).toBe(within(overlay).getByRole('button', { name: 'Next position' }))
      expect(screen.queryByRole('img', { name: /^Chess position/ })).toBeNull()
      fireEvent.click(within(overlay).getByRole('button', { name: 'View position' }))
      expect(screen.queryByRole('region', { name: `Round ${index + 1} result` })).toBeNull()
      expect(screen.getByRole('grid', { name: /^Chess board/ })).toBeTruthy()
      expect(screen.getByText(`+${penalty.toFixed(2)} points`)).toBeTruthy()
      expect(savedGame().results[index]).toMatchObject({
        penalty, guess: sign > 0 ? 'Black' : 'White', answer: sign > 0 ? 'White' : 'Black',
      })
    },
  )

  it.each([
    { index: 4, side: 'w' }, { index: 4, side: 'b' },
    { index: 5, side: 'w' }, { index: 5, side: 'b' },
  ] as const)(
    'keeps the original $side perspective at move index $index through preview, restore, and review', async ({ index, side }) => {
      const game = advanceTo(index)
      const puzzle = puzzles.find(position =>
        !game.puzzleIds.includes(position.id) &&
        position.fen.split(' ')[1] === side && position.phase !== 'before' &&
        position.rating >= 1800 && position.evaluation.cp !== null &&
        Math.abs(position.evaluation.cp) >= 50 && Math.abs(position.evaluation.cp) <= 1000)!
      game.puzzleIds[index] = puzzle.id
      localStorage.setItem(storageKey('daily'), JSON.stringify(game))
      const uci = puzzle.evaluation.bestMove

      let view = render(<App />)
      expectSideToPlayAtBottom(puzzle.fen)
      selectMove(uci)
      expectSideToPlayAtBottom(puzzle.fen)
      fireEvent.click(screen.getByRole('button', { name: 'Choose another move' }))
      expectSideToPlayAtBottom(puzzle.fen)
      selectMove(uci)
      fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
      await screen.findByRole('button', { name: 'Next position' })
      expectSideToPlayAtBottom(puzzle.fen)

      view.unmount()
      view = render(<App />)
      expectSideToPlayAtBottom(puzzle.fen)
      fireEvent.click(screen.getByRole('button', { name: 'Next position' }))
      if (index === 4) {
        const nextMovePuzzle = positionFor(game, 5)
        expectSideToPlayAtBottom(nextMovePuzzle.fen)
        expect((screen.getByRole('button', { name: 'Submit move' }) as HTMLButtonElement).disabled).toBe(true)
        selectMove(nextMovePuzzle.evaluation.bestMove)
        expectSideToPlayAtBottom(nextMovePuzzle.fen)
        fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Next position' }))
      }
      const mate = positionFor(game, 6)
      expectSideToPlayAtBottom(mate.fen)
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Mate in how many moves' }), {
        target: { value: String(Math.abs(mate.evaluation.mate!)) },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
      fireEvent.click(await screen.findByRole('button', { name: 'See my results' }))
      fireEvent.click(screen.getByRole('button', { name: `Review round ${index + 1}` }))
      expect(screen.getByRole('heading', { name: ROUND_PLAN[index].title })).toBeTruthy()
      expectSideToPlayAtBottom(puzzle.fen)
      expect(screen.queryByRole('button', { name: 'Submit move' })).toBeNull()
      view.unmount()
    },
  )

  it('opens interactive analysis after View position without changing the saved answer or score', async () => {
    const game = advanceTo(2)
    const puzzle = positionFor(game)
    vi.mocked(evaluatePosition).mockImplementation(async fen => {
      const board = new Chess(fen)
      const next = board.moves({ verbose: true })[0]
      const uci = `${next.from}${next.to}${next.promotion ?? ''}`
      return { cp: -125, mate: null, bestMove: uci, pv: [uci], depth: 14 }
    })
    render(<App />)
    expect(screen.queryByRole('region', { name: 'Position analysis' })).toBeNull()
    expect(screen.queryByRole('img', { name: /^Evaluation/ })).toBeNull()
    expect(document.querySelector('.chess-best-move')).toBeNull()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Evaluation' }), {
      target: { value: String(puzzle.evaluation.cp! / 100 + 1) },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
    await screen.findByRole('region', { name: 'Round 3 result' })
    expect(screen.queryByRole('region', { name: 'Position analysis' })).toBeNull()
    const answered = savedGame()
    expect(answered.results[2].penalty).toBe(1)
    expect(evaluatePosition).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'View position' }))
    const analysis = screen.getByRole('region', { name: 'Position analysis' })
    expect(within(analysis).getByRole('img', { name: /^Evaluation/ })).toBeTruthy()
    expect(document.querySelector('.chess-best-move')).toBeTruthy()
    selectMove(puzzle.evaluation.bestMove)
    const board = new Chess(puzzle.fen)
    board.move({ from: puzzle.evaluation.bestMove.slice(0, 2), to: puzzle.evaluation.bestMove.slice(2, 4), promotion: puzzle.evaluation.bestMove[4] })
    await waitFor(() => expect(evaluatePosition).toHaveBeenCalledWith(board.fen(), expect.objectContaining({ depth: 14 })))
    expect(within(analysis).getByRole('grid').getAttribute('aria-label'))
      .toContain(`${board.turn() === 'w' ? 'White' : 'Black'} to move`)
    expectSideToPlayAtBottom(puzzle.fen)
    expect(savedGame()).toEqual(answered)

    fireEvent.click(screen.getByRole('button', { name: 'Reset analysis position' }))
    expect(within(analysis).getByRole('grid').getAttribute('aria-label'))
      .toContain(`${new Chess(puzzle.fen).turn() === 'w' ? 'White' : 'Black'} to move`)
    expect(savedGame()).toEqual(answered)
    fireEvent.click(screen.getByRole('button', { name: 'Next position' }))
    expect(savedGame().index).toBe(3)
    expect(savedGame().results).toEqual(answered.results)
    expect(screen.queryByRole('region', { name: 'Position analysis' })).toBeNull()
    expect(screen.queryByRole('img', { name: /^Evaluation/ })).toBeNull()
    expect(document.querySelector('.chess-best-move')).toBeNull()
  })

  it('lets mobile players switch evaluation signs without a keyboard minus key', () => {
    advanceTo(2)
    render(<App />)
    const input = screen.getByRole('spinbutton', { name: 'Evaluation' }) as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('decimal')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle evaluation sign' }))
    expect(input.value).toBe('-0.0')
    fireEvent.change(input, { target: { value: '2.3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle evaluation sign' }))
    expect(Number(input.value)).toBe(-2.3)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle evaluation sign' }))
    expect(Number(input.value)).toBe(2.3)
    expect((screen.getByRole('button', { name: 'Submit answer' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a failed engine search retryable and only records the move once', async () => {
    const game = advanceTo(5)
    const puzzle = positionFor(game)
    vi.mocked(evaluatePosition).mockRejectedValueOnce(new Error('Engine could not start. Please retry.'))
    render(<App />)
    selectMove(puzzle.evaluation.bestMove)
    fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Please retry')
    expect(savedGame().results).toHaveLength(5)
    expect((screen.getByRole('button', { name: 'Submit move' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
    await screen.findByRole('button', { name: 'Next position' })
    expect(savedGame().results).toHaveLength(6)
    expect(savedGame().results[5].move).toBe(puzzle.evaluation.bestMove)
    expect(evaluatePosition).toHaveBeenCalledTimes(2)
  })

  it('scores an alternative legal move using equal-depth searches from the same position', async () => {
    const game = advanceTo(5)
    const puzzle = positionFor(game)
    const board = new Chess(puzzle.fen)
    const alternate = board.moves({ verbose: true }).find(move => `${move.from}${move.to}${move.promotion ?? ''}` !== puzzle.evaluation.bestMove)!
    const uci = `${alternate.from}${alternate.to}${alternate.promotion ?? ''}`
    const sign = board.turn() === 'w' ? 1 : -1
    vi.mocked(evaluatePosition)
      .mockResolvedValueOnce({ ...puzzle.evaluation, cp: 300 * sign })
      .mockResolvedValueOnce({ ...puzzle.evaluation, cp: 100 * sign, bestMove: uci })
    render(<App />)
    selectMove(uci)
    fireEvent.click(screen.getByRole('button', { name: 'Submit move' }))
    await screen.findByRole('button', { name: 'Next position' })
    expect(screen.getByText('+2.00 points')).toBeTruthy()
    expect(savedGame().results[5]).toMatchObject({ move: uci, guess: alternate.san, penalty: 2 })
    expect(evaluatePosition).toHaveBeenNthCalledWith(1, puzzle.fen, { depth: puzzle.evaluation.depth })
    expect(evaluatePosition).toHaveBeenNthCalledWith(2, puzzle.fen, { depth: puzzle.evaluation.depth, searchMoves: [uci] })
  })

  it('only accepts positive whole move counts in the final round', () => {
    advanceTo(6)
    render(<App />)
    const input = screen.getByRole('spinbutton', { name: 'Mate in how many moves' })
    const submit = screen.getByRole('button', { name: 'Submit answer' }) as HTMLButtonElement
    for (const invalid of ['0', '-1', '1.5', '21', '']) {
      fireEvent.change(input, { target: { value: invalid } })
      expect(submit.disabled).toBe(true)
    }
    fireEvent.change(input, { target: { value: '3' } })
    expect(submit.disabled).toBe(false)
  })
})
