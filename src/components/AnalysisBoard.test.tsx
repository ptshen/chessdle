// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Chess } from 'chess.js'
import { evaluatePosition, type EngineEvaluation } from '../lib/engine'
import { AnalysisBoard } from './AnalysisBoard'

vi.mock('../lib/engine', () => ({ evaluatePosition: vi.fn() }))

const initialFen = new Chess().fen()
const initialEvaluation: EngineEvaluation = { cp: 230, mate: null, bestMove: 'e2e4', depth: 16, pv: ['e2e4'] }
const evaluation = (cp: number, bestMove = 'e7e5'): EngineEvaluation => ({ cp, mate: null, bestMove, depth: 14, pv: [bestMove] })

function deferred() {
  let resolve!: (value: EngineEvaluation) => void
  let reject!: (error: Error) => void
  const promise = new Promise<EngineEvaluation>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function move(uci: string) {
  fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(`^${uci.slice(0, 2)},`) }))
  fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(`^${uci.slice(2, 4)},`) }))
  if (uci.length === 5) {
    const names: Record<string, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }
    fireEvent.click(screen.getByRole('button', { name: `Promote to ${names[uci[4]]}` }))
  }
}

function firstSquare() {
  return document.querySelector('[data-square]')?.getAttribute('data-square')
}

beforeEach(() => {
  vi.mocked(evaluatePosition).mockReset()
  vi.mocked(evaluatePosition).mockImplementation(async fen => {
    const first = new Chess(fen).moves({ verbose: true })[0]
    return evaluation(125, first ? `${first.from}${first.to}${first.promotion ?? ''}` : '')
  })
})
afterEach(cleanup)

describe('post-answer position analysis', () => {
  it('shows the saved evaluation instantly, plays the best move, and updates its analysis', async () => {
    const search = deferred()
    vi.mocked(evaluatePosition).mockReturnValue(search.promise)
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    expect(screen.getByRole('region', { name: 'Position analysis' })).toBeTruthy()
    expect(screen.getByRole('img', { name: "Evaluation +2.30, White's perspective" })).toBeTruthy()
    expect(screen.getByText('e4')).toBeTruthy()
    expect(evaluatePosition).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Play best move' }))
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect(firstSquare()).toBe('a8')
    expect(screen.queryByText('+2.30')).toBeNull()
    expect(screen.queryByText('e4')).toBeNull()
    expect(screen.getByRole('img', { name: 'Evaluating position' })).toBeTruthy()
    const [fen, options] = vi.mocked(evaluatePosition).mock.calls[0]
    const expected = new Chess(initialFen)
    expected.move('e2e4')
    expect(fen).toBe(expected.fen())
    expect(options?.depth).toBe(14)
    act(() => options?.onUpdate?.(evaluation(-110)))
    expect(screen.getByText('−1.10')).toBeTruthy()
    expect(screen.getByText('e5')).toBeTruthy()
    await act(async () => search.resolve(evaluation(-160)))
    expect(screen.getByRole('img', { name: "Evaluation −1.60, White's perspective" })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Undo analysis move' }))
    expect(screen.getByText('White to move')).toBeTruthy()
    expect(screen.getByText('+2.30')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Undo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts after the submitted move and resets to the original puzzle without changing the answer', async () => {
    const search = deferred()
    vi.mocked(evaluatePosition).mockReturnValue(search.promise)
    const savedEvaluation = { ...initialEvaluation }
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={savedEvaluation} playedMove="d2d4" />)
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^d4, white pawn/i })).toBeTruthy()
    expect(screen.queryByText('+2.30')).toBeNull()
    const signal = vi.mocked(evaluatePosition).mock.calls[0][1]?.signal
    fireEvent.click(screen.getByRole('button', { name: 'Reset analysis position' }))
    expect(signal?.aborted).toBe(true)
    expect(screen.getByRole('gridcell', { name: /^d2, white pawn/i })).toBeTruthy()
    expect(screen.getByText('+2.30')).toBeTruthy()
    expect(savedEvaluation).toEqual(initialEvaluation)
  })

  it('locks Black at the bottom while scores remain from White’s perspective', async () => {
    const position = new Chess(initialFen)
    position.move('e2e4')
    render(<AnalysisBoard initialFen={position.fen()} initialEvaluation={evaluation(230, 'c7c5')} />)
    expect(firstSquare()).toBe('h1')
    expect(screen.getByText('+2.30')).toBeTruthy()
    expect(document.querySelector('.analysis-eval-track.white-at-top')).toBeTruthy()
    move('c7c5')
    expect(firstSquare()).toBe('h1')
    expect(screen.getByText('White to move')).toBeTruthy()
    await screen.findByText('+1.25')
    fireEvent.click(screen.getByRole('button', { name: 'Undo analysis move' }))
    expect(firstSquare()).toBe('h1')
    expect(screen.getByText('+2.30')).toBeTruthy()
  })

  it.each([
    ['7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', 'White wins · Checkmate', '+M0'],
    ['8/8/8/8/8/5k2/6q1/7K w - - 0 1', 'Black wins · Checkmate', '−M0'],
    ['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'Draw · Stalemate', '0.00'],
    ['7k/8/6K1/8/8/8/8/8 w - - 0 1', 'Draw · Insufficient material', '0.00'],
  ])('handles terminal positions without engine requests: %s', (fen, status, score) => {
    render(<AnalysisBoard initialFen={fen} initialEvaluation={initialEvaluation} />)
    expect(screen.getByText(status)).toBeTruthy()
    expect(screen.getByText(score)).toBeTruthy()
    expect(screen.queryByRole('grid')).toBeNull()
    expect(evaluatePosition).not.toHaveBeenCalled()
  })

  it('recognizes repetition from explored history and allows undoing it', async () => {
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']) {
      move(uci)
      await act(async () => undefined)
    }
    expect(evaluatePosition).toHaveBeenCalledTimes(7)
    move('f6g8')
    expect(screen.getByText('Draw · Repetition')).toBeTruthy()
    expect(screen.getByText('0.00')).toBeTruthy()
    expect(evaluatePosition).toHaveBeenCalledTimes(7)
    fireEvent.click(screen.getByRole('button', { name: 'Undo analysis move' }))
    expect(screen.queryByText('Draw · Repetition')).toBeNull()
    expect(screen.getByRole('grid')).toBeTruthy()
    expect(screen.getByText('Black to move')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByText('Draw · Repetition')).toBeTruthy()
    expect(screen.getByText('0.00')).toBeTruthy()
    expect(evaluatePosition).toHaveBeenCalledTimes(7)
  })

  it('uses Left and Right to step through multiple moves without losing the continuation', async () => {
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    expect((screen.getByRole('button', { name: 'Redo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(evaluatePosition).not.toHaveBeenCalled()
    for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
      move(uci)
      await act(async () => undefined)
    }
    expect(evaluatePosition).toHaveBeenCalledTimes(3)

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(screen.getByRole('gridcell', { name: /^g1, white knight/i })).toBeTruthy()
    expect(screen.getByText('White to move')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(screen.getByRole('gridcell', { name: /^e7, black pawn/i })).toBeTruthy()
    expect(screen.getByText('Black to move')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('gridcell', { name: /^e5, black pawn/i })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('gridcell', { name: /^f3, white knight/i })).toBeTruthy()
    expect(screen.getByText('Black to move')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Redo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
    expect(evaluatePosition).toHaveBeenCalledTimes(3)
  })

  it('truncates undone moves when playing a new continuation and Reset clears even fully undone history', async () => {
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    for (const uci of ['e2e4', 'e7e5', 'g1f3']) {
      move(uci)
      await act(async () => undefined)
    }
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    move('c7c5')
    await act(async () => undefined)
    expect((screen.getByRole('button', { name: 'Redo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('gridcell', { name: /^g1, white knight/i })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^e7, black pawn/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Undo analysis move' }))
    fireEvent.click(screen.getByRole('button', { name: 'Redo analysis move' }))
    expect(screen.getByRole('gridcell', { name: /^c5, black pawn/i })).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect((screen.getByRole('button', { name: 'Reset analysis position' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Reset analysis position' }))
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('gridcell', { name: /^e2, white pawn/i })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Undo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Redo analysis move' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('can undo and redo the submitted move without modifying the saved answer', async () => {
    const saved = { ...initialEvaluation }
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={saved} playedMove="d2d4" />)
    await act(async () => undefined)
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(screen.getByRole('gridcell', { name: /^d2, white pawn/i })).toBeTruthy()
    expect(screen.getByText('+2.30')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByRole('gridcell', { name: /^d4, white pawn/i })).toBeTruthy()
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect(evaluatePosition).toHaveBeenCalledTimes(1)
    expect(saved).toEqual(initialEvaluation)
  })

  it('handles a focused board exactly once and also works from the analysis toolbar', async () => {
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    for (const uci of ['e2e4', 'e7e5']) {
      move(uci)
      await act(async () => undefined)
    }
    const square = screen.getByRole('gridcell', { name: /^g1, white knight/i })
    square.focus()
    fireEvent.keyDown(square, { key: 'ArrowLeft' })
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^e4, white pawn/i })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^e7, black pawn/i })).toBeTruthy()
    fireEvent.keyDown(square, { key: 'ArrowRight' })
    expect(screen.getByText('White to move')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^e5, black pawn/i })).toBeTruthy()
    const undo = screen.getByRole('button', { name: 'Undo analysis move' })
    undo.focus()
    fireEvent.keyDown(undo, { key: 'ArrowLeft' })
    expect(screen.getByText('Black to move')).toBeTruthy()
  })

  it('leaves typing, modified arrows, composition, and already-handled events alone', async () => {
    render(<><AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />
      <input aria-label="Input" /><textarea aria-label="Text area" /><select aria-label="Select"><option>One</option></select>
      <div contentEditable suppressContentEditableWarning><span>Editable text</span></div>
    </>)
    move('e2e4')
    await act(async () => undefined)
    for (const target of [screen.getByLabelText('Input'), screen.getByLabelText('Text area'), screen.getByLabelText('Select'), screen.getByText('Editable text')]) {
      expect(fireEvent.keyDown(target, { key: 'ArrowLeft' })).toBe(true)
    }
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
      expect(fireEvent.keyDown(document.body, { key: 'ArrowLeft', [modifier]: true })).toBe(true)
    }
    const handled = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    handled.preventDefault()
    fireEvent(document.body, handled)
    expect(screen.getByText('Black to move')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^e4, white pawn/i })).toBeTruthy()
  })

  it('does not navigate while a promotion dialog is open', async () => {
    const fen = '7k/P7/8/8/8/8/8/7K b - - 0 1'
    render(<AnalysisBoard initialFen={fen} initialEvaluation={evaluation(500, 'h8g8')} playedMove="h8g8" />)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('gridcell', { name: /^a7, white pawn/i }))
    fireEvent.click(screen.getByRole('gridcell', { name: /^a8,/i }))
    const promotion = screen.getByRole('dialog', { name: 'Choose a promotion piece' })
    fireEvent.keyDown(promotion, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'Choose a promotion piece' })).toBeTruthy()
    expect(screen.getByText('White to move')).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: /^g8, black king/i })).toBeTruthy()
  })

  it('aborts undone analysis, ignores late results, and reuses completed redo evaluations', async () => {
    const oldSearch = deferred()
    const newSearch = deferred()
    vi.mocked(evaluatePosition).mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(newSearch.promise)
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    move('e2e4')
    const oldOptions = vi.mocked(evaluatePosition).mock.calls[0][1]
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(oldOptions?.signal?.aborted).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(evaluatePosition).toHaveBeenCalledTimes(2)
    act(() => oldOptions?.onUpdate?.(evaluation(900)))
    await act(async () => oldSearch.resolve(evaluation(999)))
    expect(screen.queryByText('+9.00')).toBeNull()
    expect(screen.queryByText('+9.99')).toBeNull()
    await act(async () => newSearch.resolve(evaluation(450)))
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByText('+4.50')).toBeTruthy()
    expect(evaluatePosition).toHaveBeenCalledTimes(2)
  })

  it('removes its keyboard shortcuts when analysis is closed', () => {
    const view = render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    expect(fireEvent.keyDown(document.body, { key: 'ArrowLeft' })).toBe(false)
    view.unmount()
    expect(fireEvent.keyDown(document.body, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(document.body, { key: 'ArrowRight' })).toBe(true)
  })

  it('aborts obsolete searches, ignores their late updates, and cancels when leaving analysis', async () => {
    const first = deferred()
    const second = deferred()
    vi.mocked(evaluatePosition).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const view = render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    move('e2e4')
    const firstOptions = vi.mocked(evaluatePosition).mock.calls[0][1]
    move('e7e5')
    const secondOptions = vi.mocked(evaluatePosition).mock.calls[1][1]
    expect(firstOptions?.signal?.aborted).toBe(true)
    expect(secondOptions?.signal?.aborted).toBe(false)
    act(() => firstOptions?.onUpdate?.(evaluation(900)))
    await act(async () => first.resolve(evaluation(999)))
    expect(screen.queryByText('+9.00')).toBeNull()
    expect(screen.queryByText('+9.99')).toBeNull()
    expect(screen.getByRole('img', { name: 'Evaluating position' })).toBeTruthy()
    await act(async () => second.resolve(evaluation(450, 'g1f3')))
    expect(screen.getByText('+4.50')).toBeTruthy()
    expect(screen.getByText('Nf3')).toBeTruthy()
    view.unmount()
    expect(secondOptions?.signal?.aborted).toBe(true)
  })

  it('retries failed analysis and keeps legal moves available during an engine failure', async () => {
    vi.mocked(evaluatePosition).mockRejectedValueOnce(new Error('Engine unavailable'))
    render(<AnalysisBoard initialFen={initialFen} initialEvaluation={initialEvaluation} />)
    move('e2e4')
    await screen.findByText('Analysis unavailable')
    expect(screen.getByRole('grid')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry analysis' }))
    await screen.findByText('+1.25')
    expect(evaluatePosition).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Analysis unavailable')).toBeNull()
  })

  it('accepts an underpromotion and analyzes the promoted position', async () => {
    const fen = '7k/P7/8/8/8/8/8/7K w - - 0 1'
    render(<AnalysisBoard initialFen={fen} initialEvaluation={evaluation(500, 'a7a8q')} />)
    move('a7a8r')
    expect(screen.getByRole('gridcell', { name: /^a8, white rook/i })).toBeTruthy()
    await waitFor(() => expect(evaluatePosition).toHaveBeenCalledTimes(1))
    const promoted = new Chess(fen)
    promoted.move('a7a8r')
    expect(vi.mocked(evaluatePosition).mock.calls[0][0]).toBe(promoted.fen())
  })
})
