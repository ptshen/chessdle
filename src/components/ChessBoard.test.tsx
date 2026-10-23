// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Chess } from 'chess.js'
import ChessBoard from './ChessBoard'

afterEach(cleanup)

// jsdom 20 has MouseEvent but not PointerEvent or pointer capture.
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent)
})

afterAll(() => vi.unstubAllGlobals())

function square(name: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[data-square="${name}"]`)!
}

function corners() {
  const squares = document.querySelectorAll('.chess-square')
  return [squares[0], squares[squares.length - 1]].map((el) => el.getAttribute('data-square'))
}

function mockBoardRect() {
  const board = document.querySelector<HTMLDivElement>('.chess-board')!
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({
    x: 20, y: 30, left: 20, top: 30, right: 420, bottom: 430,
    width: 400, height: 400, toJSON: () => ({}),
  })
  return board
}

function point(name: string) {
  const squares = [...document.querySelectorAll<HTMLButtonElement>('.chess-square')]
  const index = squares.indexOf(square(name))
  return { clientX: 20 + index % 8 * 50 + 25, clientY: 30 + Math.floor(index / 8) * 50 + 25 }
}

function startDrag(from: string, pointerType = 'mouse', pointerId = 1) {
  const source = square(from)
  let captured = false
  source.setPointerCapture = vi.fn(() => { captured = true })
  source.hasPointerCapture = vi.fn(() => captured)
  source.releasePointerCapture = vi.fn(() => { captured = false })
  fireEvent.pointerDown(source, { ...point(from), pointerType, pointerId, button: 0 })
  return source
}

function drag(from: string, to: string, pointerType = 'mouse') {
  const source = startDrag(from, pointerType)
  // Capture retargets these events to the source even over another square.
  fireEvent.pointerMove(source, { ...point(to), pointerType, pointerId: 1 })
  fireEvent.pointerUp(source, { ...point(to), pointerType, pointerId: 1 })
  return source
}

describe('chess board perspective', () => {
  it('places White at the bottom when White is to move', () => {
    render(<ChessBoard fen={new Chess().fen()} />)
    expect(corners()).toEqual(['a8', 'h1'])
  })

  it('places Black at the bottom when Black is to move', () => {
    const chess = new Chess()
    chess.move('e4')
    render(<ChessBoard fen={chess.fen()} />)
    expect(corners()).toEqual(['h1', 'a8'])
  })

  it('updates the perspective when the side to move changes', () => {
    const chess = new Chess()
    const { rerender } = render(<ChessBoard fen={chess.fen()} />)
    expect(corners()).toEqual(['a8', 'h1'])
    chess.move('e4')
    rerender(<ChessBoard fen={chess.fen()} />)
    expect(corners()).toEqual(['h1', 'a8'])
    chess.move('e5')
    rerender(<ChessBoard fen={chess.fen()} />)
    expect(corners()).toEqual(['a8', 'h1'])
  })

  it('honors an explicit perspective override', () => {
    const chess = new Chess()
    const { rerender } = render(<ChessBoard fen={chess.fen()} flipped />)
    expect(corners()).toEqual(['h1', 'a8'])
    chess.move('e4')
    rerender(<ChessBoard fen={chess.fen()} flipped={false} />)
    expect(corners()).toEqual(['a8', 'h1'])
  })

  it('keeps history shortcut directions unchanged from Black’s perspective', () => {
    const chess = new Chess()
    chess.move('e4')
    const onHistoryNavigate = vi.fn()
    render(<ChessBoard fen={chess.fen()} interactive onHistoryNavigate={onHistoryNavigate} />)
    square('e7').focus()
    fireEvent.keyDown(square('e7'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(square('e7'))
    expect(onHistoryNavigate).not.toHaveBeenCalled()
    fireEvent.keyDown(square('e7'), { key: 'ArrowLeft' })
    expect(onHistoryNavigate).toHaveBeenLastCalledWith('undo')
    fireEvent.keyDown(square('e7'), { key: 'ArrowRight' })
    expect(onHistoryNavigate).toHaveBeenLastCalledWith('redo')
    expect(document.activeElement).toBe(square('e7'))
  })
})

describe('best move arrows', () => {
  it.each([
    { flipped: false, endpoints: ['4.5', '6.5', '4.5', '4.5'] },
    { flipped: true, endpoints: ['3.5', '1.5', '3.5', '3.5'] },
  ])('points from the source to the destination when flipped is $flipped', ({ flipped, endpoints }) => {
    render(<ChessBoard fen={new Chess().fen()} flipped={flipped} bestMove="e2e4" />)
    const arrow = document.querySelector('.chess-best-move')!
    const line = arrow.querySelector('line')!
    expect(['x1', 'y1', 'x2', 'y2'].map(attribute => line.getAttribute(attribute))).toEqual(endpoints)
    expect(arrow.getAttribute('aria-hidden')).toBe('true')
    expect(arrow.getAttribute('focusable')).toBe('false')
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Best move: e2 to e4.')
  })

  it('follows the automatic Black perspective', () => {
    const chess = new Chess()
    chess.move('e4')
    render(<ChessBoard fen={chess.fen()} bestMove="e7e5" />)
    const line = document.querySelector('.chess-best-move line')!
    expect(['x1', 'y1', 'x2', 'y2'].map(attribute => line.getAttribute(attribute))).toEqual(['3.5', '6.5', '3.5', '4.5'])
  })

  it.each([undefined, null, 'e2e5', 'e7e5', 'e2e4q', 'e2e4garbage', '0000'])('omits an absent or illegal suggestion (%s)', (bestMove) => {
    render(<ChessBoard fen={new Chess().fen()} bestMove={bestMove} />)
    expect(document.querySelector('.chess-best-move')).toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('Best move:')
  })

  it('excludes a move that leaves the king in check', () => {
    render(<ChessBoard fen="4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1" bestMove="e2f2" />)
    expect(document.querySelector('.chess-best-move')).toBeNull()
  })

  it('supports underpromotion and requires the promotion choice', () => {
    const fen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'
    const { rerender } = render(<ChessBoard fen={fen} bestMove="a7a8n" />)
    expect(document.querySelector('.chess-best-move')).not.toBeNull()
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Best move: a7 to a8, promote to knight.')
    rerender(<ChessBoard fen={fen} bestMove="a7a8" />)
    expect(document.querySelector('.chess-best-move')).toBeNull()
  })

  it('does not retain a suggestion that is invalid after the position changes', () => {
    const chess = new Chess()
    const { rerender } = render(<ChessBoard fen={chess.fen()} bestMove="e2e4" />)
    expect(document.querySelector('.chess-best-move')).not.toBeNull()
    chess.move('e4')
    rerender(<ChessBoard fen={chess.fen()} bestMove="e2e4" />)
    expect(document.querySelector('.chess-best-move')).toBeNull()
  })

  it('uses separate arrow markers when multiple boards are rendered', () => {
    render(<><ChessBoard fen={new Chess().fen()} bestMove="e2e4" /><ChessBoard fen={new Chess().fen()} bestMove="d2d4" /></>)
    const arrows = [...document.querySelectorAll('.chess-best-move')]
    const ids = arrows.map(arrow => arrow.querySelector('marker')!.id)
    expect(new Set(ids).size).toBe(2)
    arrows.forEach((arrow, index) => expect(arrow.querySelector('line')!.getAttribute('marker-end')).toBe(`url(#${ids[index]})`))
  })

  it('preserves selection, last move, and drag interaction when the suggestion updates', () => {
    const onMove = vi.fn()
    const fen = new Chess().fen()
    const { rerender } = render(<ChessBoard fen={fen} interactive bestMove="e2e4" lastMove="b1c3" onMove={onMove} />)
    fireEvent.click(square('e2'))
    rerender(<ChessBoard fen={fen} interactive bestMove="d2d4" lastMove="b1c3" onMove={onMove} />)
    expect(square('e2').classList.contains('is-selected')).toBe(true)
    expect(square('e4').classList.contains('is-destination')).toBe(true)
    expect([...document.querySelectorAll('.is-last-move')].map(element => element.getAttribute('data-square'))).toEqual(['c3', 'b1'])
    mockBoardRect()
    drag('e2', 'e4', 'touch')
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e2e4')
    expect(document.querySelector('.chess-best-move')).not.toBeNull()
  })
})

describe('legal chess board interactions', () => {
  it('shows legal targets and only accepts a move for the side to play', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    fireEvent.click(square('e7'))
    expect(document.querySelectorAll('.is-destination')).toHaveLength(0)
    fireEvent.click(square('e2'))
    expect([...document.querySelectorAll('.is-destination')].map(el => el.getAttribute('data-square')).sort()).toEqual(['e3', 'e4'])
    fireEvent.click(square('e5'))
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.click(square('e2'))
    fireEvent.click(square('e4'))
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e2e4')
  })

  it('allows legal castling and excludes castling through check', () => {
    const onMove = vi.fn()
    const { rerender } = render(<ChessBoard fen="4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1" interactive onMove={onMove} />)
    fireEvent.click(square('e1'))
    fireEvent.click(square('g1'))
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e1g1')
    onMove.mockClear()
    rerender(<ChessBoard fen="4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1" interactive onMove={onMove} />)
    fireEvent.click(square('e1'))
    fireEvent.click(square('g1'))
    expect(onMove).not.toHaveBeenCalled()
  })

  it('allows en passant', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen="4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1" interactive onMove={onMove} />)
    fireEvent.click(square('e5'))
    fireEvent.click(square('d6'))
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e5d6')
  })

  it('offers four promotion choices, traps focus, and supports underpromotion', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen="4k3/P7/8/8/8/8/8/4K3 w - - 0 1" interactive onMove={onMove} />)
    fireEvent.click(square('a7'))
    fireEvent.click(square('a8'))
    expect(screen.getByRole('dialog', { name: 'Choose a promotion piece' })).toBeTruthy()
    const queen = screen.getByRole('button', { name: 'Promote to queen' })
    expect(document.activeElement).toBe(queen)
    fireEvent.keyDown(queen, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Promote to knight' }))
    expect(onMove).toHaveBeenCalledExactlyOnceWith('a7a8n')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(square('a8'))
  })

  it('lets a player cancel promotion without making a move', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen="4k3/P7/8/8/8/8/8/4K3 w - - 0 1" interactive onMove={onMove} />)
    fireEvent.click(square('a7'))
    fireEvent.click(square('a8'))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Promote to queen' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onMove).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(square('a7'))
  })

  it('keeps arrow keys from navigating squares and allows Tab focus for every square', () => {
    render(<ChessBoard fen={new Chess().fen()} interactive />)
    square('e2').focus()
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      expect(fireEvent.keyDown(square('e2'), { key })).toBe(true)
      expect(document.activeElement).toBe(square('e2'))
    }
    expect(screen.getAllByRole('gridcell').every(cell => cell.tabIndex === 0)).toBe(true)
    expect(screen.getByRole('grid').getAttribute('aria-label')).toContain('use Tab to navigate squares')
  })

  it('uses unmodified Left and Right for analysis history without moving square focus', () => {
    const onHistoryNavigate = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onHistoryNavigate={onHistoryNavigate} />)
    square('e2').focus()
    expect(fireEvent.keyDown(square('e2'), { key: 'ArrowLeft' })).toBe(false)
    expect(onHistoryNavigate).toHaveBeenLastCalledWith('undo')
    expect(fireEvent.keyDown(square('e2'), { key: 'ArrowRight' })).toBe(false)
    expect(onHistoryNavigate).toHaveBeenLastCalledWith('redo')
    expect(onHistoryNavigate).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(square('e2'))
    for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing']) {
      expect(fireEvent.keyDown(square('e2'), { key: 'ArrowLeft', [modifier]: true })).toBe(true)
    }
    expect(onHistoryNavigate).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(square('e2'))
    expect(screen.getByRole('grid').getAttribute('aria-label')).toContain('undo and redo analysis moves')
  })

  it('keeps analysis shortcuts from dismissing promotion or navigating its squares', () => {
    const onHistoryNavigate = vi.fn()
    render(<ChessBoard fen="4k3/P7/8/8/8/8/8/4K3 w - - 0 1" interactive onHistoryNavigate={onHistoryNavigate} />)
    fireEvent.click(square('a7'))
    fireEvent.click(square('a8'))
    const promote = screen.getByRole('button', { name: 'Promote to queen' })
    fireEvent.keyDown(promote, { key: 'ArrowLeft' })
    fireEvent.keyDown(square('a7'), { key: 'ArrowRight' })
    expect(onHistoryNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Choose a promotion piece' })).toBeTruthy()
    expect(screen.getAllByRole('gridcell').every(cell => cell.tabIndex === -1)).toBe(true)
  })

  it('flips the board and exposes a readable static position', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} flipped selectedMove="e2e4" onMove={onMove} />)
    expect(document.querySelector('.chess-square')?.getAttribute('data-square')).toBe('h1')
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('White king on e1')
    expect(square('e2').disabled).toBe(true)
    expect(square('e2').classList.contains('is-last-move')).toBe(true)
    expect(square('e4').classList.contains('is-last-move')).toBe(true)
    fireEvent.click(square('e2'))
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('check highlights', () => {
  it('highlights a checked king and every checking piece, with readable labels', () => {
    render(<ChessBoard fen="4r2k/8/8/8/1b6/8/8/4K3 w - - 0 1" selectedMove="e8e1" />)
    expect(square('e1').classList.contains('is-in-check')).toBe(true)
    expect(square('e1').getAttribute('aria-label')).toContain('in check')
    expect(square('e8').classList.contains('is-checker')).toBe(true)
    expect(square('b4').classList.contains('is-checker')).toBe(true)
    expect(square('b4').getAttribute('aria-label')).toContain('checking piece')
    expect(document.querySelectorAll('.is-in-check')).toHaveLength(1)
    expect(document.querySelectorAll('.is-checker')).toHaveLength(2)
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('White king on e1 is in check')
  })

  it('highlights a checked black king and removes highlights after check is resolved', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/4R1K1 b - - 0 1')
    const { rerender } = render(<ChessBoard fen={chess.fen()} interactive />)
    expect(corners()).toEqual(['h1', 'a8'])
    expect(square('e8').classList.contains('is-in-check')).toBe(true)
    expect(square('e1').classList.contains('is-checker')).toBe(true)
    expect(screen.getByRole('grid').getAttribute('aria-label')).toContain('Black king on e8 is in check')
    chess.move('Kf7')
    rerender(<ChessBoard fen={chess.fen()} interactive />)
    expect(document.querySelectorAll('.is-in-check, .is-checker')).toHaveLength(0)
    expect(screen.getByRole('grid').getAttribute('aria-label')).not.toContain('in check')
  })
})

describe('pointer chess moves', () => {
  it.each(['mouse', 'touch', 'pen'])('drags a legal move using %s with a preview and legal targets', (pointerType) => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2', pointerType)
    expect(source.setPointerCapture).toHaveBeenCalledWith(1)
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 1, pointerType })
    expect(source.classList.contains('is-dragging')).toBe(true)
    expect(square('e3').classList.contains('is-destination')).toBe(true)
    expect(square('e4').classList.contains('is-drag-over')).toBe(true)
    const preview = document.querySelector<HTMLDivElement>('.chess-drag-preview')!
    expect(preview.style.left).toBe('225px')
    expect(preview.style.top).toBe('225px')
    expect(preview.style.width).toBe('50px')
    fireEvent.pointerUp(source, { ...point('e4'), pointerId: 1, pointerType })
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e2e4')
    expect(source.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    expect(document.querySelectorAll('.is-destination')).toHaveLength(0)
  })

  it('drags from Black’s perspective and from an explicitly fixed perspective', () => {
    const onMove = vi.fn()
    const chess = new Chess()
    chess.move('e4')
    const { rerender } = render(<ChessBoard fen={chess.fen()} interactive onMove={onMove} />)
    mockBoardRect()
    drag('e7', 'e5', 'touch')
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e7e5')
    onMove.mockClear()
    rerender(<ChessBoard fen={chess.fen()} flipped={false} interactive onMove={onMove} />)
    drag('e7', 'e5')
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e7e5')
  })

  it('preserves tap selection below the drag threshold and tap-to-move', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2', 'touch')
    const origin = point('e2')
    fireEvent.pointerMove(source, { ...origin, clientX: origin.clientX + 2, pointerId: 1, pointerType: 'touch' })
    fireEvent.pointerUp(source, { ...origin, clientX: origin.clientX + 2, pointerId: 1, pointerType: 'touch' })
    fireEvent.click(source, { detail: 1 })
    expect(source.classList.contains('is-selected')).toBe(true)
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    fireEvent.click(square('e4'), { detail: 1 })
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e2e4')
  })

  it('suppresses the synthetic click after a drag without blocking the next tap', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = drag('e2', 'e4')
    fireEvent.click(source, { detail: 1 })
    expect(source.classList.contains('is-selected')).toBe(false)
    expect(onMove).toHaveBeenCalledTimes(1)
    startDrag('g1', 'touch')
    fireEvent.pointerUp(square('g1'), { ...point('g1'), pointerId: 1, pointerType: 'touch' })
    fireEvent.click(square('g1'), { detail: 1 })
    fireEvent.click(square('f3'), { detail: 1 })
    expect(onMove).toHaveBeenLastCalledWith('g1f3')
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('keeps keyboard clicks available when a browser emits no post-drag click', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    drag('e2', 'e4')
    fireEvent.click(square('g1'), { detail: 0 })
    fireEvent.click(square('f3'), { detail: 0 })
    expect(onMove).toHaveBeenLastCalledWith('g1f3')
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('rejects illegal destinations, a drop back on the source, and drops outside the board', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    drag('e2', 'e5')
    const source = startDrag('e2')
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 1 })
    fireEvent.pointerUp(source, { ...point('e2'), pointerId: 1 })
    startDrag('e2')
    fireEvent.pointerMove(source, { clientX: 440, clientY: 220, pointerId: 1 })
    fireEvent.pointerUp(source, { clientX: 440, clientY: 220, pointerId: 1 })
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    expect(document.querySelectorAll('.is-destination')).toHaveLength(0)
  })

  it.each(['pointerCancel', 'lostPointerCapture'])('cancels cleanly on %s', (eventName) => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2')
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 1 })
    fireEvent[eventName as 'pointerCancel' | 'lostPointerCapture'](source, { pointerId: 1 })
    fireEvent.pointerUp(source, { ...point('e4'), pointerId: 1 })
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    expect(document.querySelectorAll('.is-destination')).toHaveLength(0)
  })

  it('cancels an active drag with Escape', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2')
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 1 })
    fireEvent.keyDown(source, { key: 'Escape' })
    fireEvent.pointerUp(source, { ...point('e4'), pointerId: 1 })
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
  })

  it.each(['position', 'orientation', 'interaction'])('cancels when the %s changes', (change) => {
    const onMove = vi.fn()
    const chess = new Chess()
    const { rerender } = render(<ChessBoard fen={chess.fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2')
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 1 })
    if (change === 'position') chess.move('d4')
    rerender(<ChessBoard fen={chess.fen()} flipped={change === 'orientation'} interactive={change !== 'interaction'} onMove={onMove} />)
    fireEvent.pointerUp(source, { ...point('e4'), pointerId: 1 })
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    expect(source.releasePointerCapture).toHaveBeenCalledWith(1)
  })

  it('only makes own pieces draggable and ignores right clicks and secondary pointers', () => {
    const onMove = vi.fn()
    const { rerender } = render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    expect(square('e2').classList.contains('is-draggable')).toBe(true)
    expect(square('e7').classList.contains('is-draggable')).toBe(false)
    expect(square('e4').classList.contains('is-draggable')).toBe(false)
    drag('e7', 'e5')
    fireEvent.pointerDown(square('e2'), { ...point('e2'), button: 2, pointerId: 1 })
    fireEvent.pointerMove(square('e2'), { ...point('e4'), pointerId: 1 })
    fireEvent.pointerUp(square('e2'), { ...point('e4'), pointerId: 1 })
    fireEvent.pointerDown(square('e2'), { ...point('e2'), button: 0, pointerId: 2, isPrimary: false })
    fireEvent.pointerMove(square('e2'), { ...point('e4'), pointerId: 2 })
    fireEvent.pointerUp(square('e2'), { ...point('e4'), pointerId: 2 })
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    rerender(<ChessBoard fen={new Chess().fen()} onMove={onMove} />)
    expect(document.querySelectorAll('.is-draggable')).toHaveLength(0)
    drag('e2', 'e4')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores other pointers during an active drag', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen={new Chess().fen()} interactive onMove={onMove} />)
    mockBoardRect()
    const source = startDrag('e2', 'touch', 3)
    fireEvent.pointerMove(source, { ...point('e4'), pointerId: 3, pointerType: 'touch' })
    fireEvent.pointerUp(source, { ...point('e3'), pointerId: 4, pointerType: 'touch' })
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.pointerUp(source, { ...point('e4'), pointerId: 3, pointerType: 'touch' })
    expect(onMove).toHaveBeenCalledExactlyOnceWith('e2e4')
  })

  it.each([
    ['castling', '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1', 'g1', 'e1g1'],
    ['en passant', '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5', 'd6', 'e5d6'],
    ['capture', '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4', 'd5', 'e4d5'],
  ])('supports a legal %s by dragging', (_name, fen, from, to, expected) => {
    const onMove = vi.fn()
    render(<ChessBoard fen={fen} interactive onMove={onMove} />)
    mockBoardRect()
    drag(from, to, 'touch')
    expect(onMove).toHaveBeenCalledExactlyOnceWith(expected)
  })

  it('does not let a pinned piece expose its king while dragging', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen="4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1" interactive onMove={onMove} />)
    mockBoardRect()
    drag('e2', 'd2')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('opens promotion choices after a drag and commits the chosen promotion once', () => {
    const onMove = vi.fn()
    render(<ChessBoard fen="4k3/P7/8/8/8/8/8/4K3 w - - 0 1" interactive onMove={onMove} />)
    mockBoardRect()
    const source = drag('a7', 'a8', 'touch')
    fireEvent.click(source, { detail: 1 })
    expect(screen.getByRole('dialog', { name: 'Choose a promotion piece' })).toBeTruthy()
    expect(onMove).not.toHaveBeenCalled()
    expect(document.querySelector('.chess-drag-preview')).toBeNull()
    expect(document.querySelectorAll('.is-draggable')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Promote to rook' }))
    expect(onMove).toHaveBeenCalledExactlyOnceWith('a7a8r')
  })
})
