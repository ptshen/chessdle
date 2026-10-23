import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Chess } from 'chess.js'
import type { Color, PieceSymbol, Square } from 'chess.js'
import { getCheckHighlights } from '../lib/check'
import { ChessPiece } from './ChessPiece'
import './ChessBoard.css'

export type ChessBoardProps = {
  fen: string
  flipped?: boolean
  interactive?: boolean
  selectedMove?: string | null
  onMove?: (uci: string) => void
  onHistoryNavigate?: (direction: 'undo' | 'redo') => void
  lastMove?: string | null
  bestMove?: string | null
}

const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
}
const PROMOTIONS: PieceSymbol[] = ['q', 'r', 'b', 'n']
const DRAG_THRESHOLD = 6

type PieceDrag = {
  pointerId: number
  from: Square
  piece: { type: PieceSymbol; color: Color }
  startX: number
  startY: number
  active: boolean
  source: HTMLButtonElement
}

type DragPreview = {
  from: Square
  piece: PieceDrag['piece']
  x: number
  y: number
  size: number
  over: Square | null
}

export function ChessBoard({
  fen,
  flipped,
  interactive = false,
  selectedMove,
  onMove,
  onHistoryNavigate,
  lastMove,
  bestMove,
}: ChessBoardProps) {
  const chess = useMemo(() => new Chess(fen), [fen])
  const check = useMemo(() => getCheckHighlights(chess), [chess])
  const suggestedMove = useMemo(() => {
    if (!bestMove || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestMove)) return null
    return chess.moves({ square: bestMove.slice(0, 2) as Square, verbose: true })
      .find((move) => `${move.from}${move.to}${move.promotion || ''}` === bestMove) ?? null
  }, [chess, bestMove])
  const arrowId = useId()
  const boardRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<PieceDrag | null>(null)
  const suppressClickRef = useRef(false)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<{ from: Square; to: Square; color: Color } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const blackAtBottom = flipped ?? chess.turn() === 'b'
  const files = blackAtBottom ? 'hgfedcba' : 'abcdefgh'
  const ranks = blackAtBottom ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1]
  const legalMoves = selectedSquare ? chess.moves({ square: selectedSquare, verbose: true }) : []
  const destinations = new Set(legalMoves.map((move) => move.to))
  const highlight = selectedMove || lastMove
  const lastSquares = highlight ? [highlight.slice(0, 2), highlight.slice(2, 4)] : []
  const turnName = chess.turn() === 'w' ? 'White' : 'Black'
  const checkDescription = check.king ? ` ${turnName} king on ${check.king} is in check from ${check.attackers.join(', ')}.` : ''
  const suggestionDescription = suggestedMove ? ` Best move: ${suggestedMove.from} to ${suggestedMove.to}${suggestedMove.promotion ? `, promote to ${PIECE_NAMES[suggestedMove.promotion]}` : ''}.` : ''
  const arrow = suggestedMove ? {
    x1: files.indexOf(suggestedMove.from[0]) + .5,
    y1: ranks.indexOf(Number(suggestedMove.from[1])) + .5,
    x2: files.indexOf(suggestedMove.to[0]) + .5,
    y2: ranks.indexOf(Number(suggestedMove.to[1])) + .5,
  } : null
  const positionDescription = chess.board().flat().filter((piece) => piece !== null)
    .map((piece) => `${piece.color === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[piece.type]} on ${piece.square}`)
    .join(', ')

  useEffect(() => {
    clearDrag()
    setSelectedSquare(null)
    setPromotion(null)
    setAnnouncement('')
  }, [fen, interactive, blackAtBottom])

  useEffect(() => {
    if (promotion) boardRef.current?.querySelector<HTMLButtonElement>('.chess-promotion-choice')?.focus()
  }, [promotion])

  function chooseMove(from: Square, to: Square, promotionPiece?: PieceSymbol) {
    setSelectedSquare(null)
    setPromotion(null)
    setAnnouncement(`Move selected: ${from} to ${to}${promotionPiece ? `, promote to ${PIECE_NAMES[promotionPiece]}` : ''}.`)
    onMove?.(`${from}${to}${promotionPiece || ''}`)
    boardRef.current?.querySelector<HTMLButtonElement>(`[data-square="${to}"]`)?.focus()
  }

  // Clicks and drags share legal-move validation, including castling, en passant,
  // pinned pieces, and promotion. The board position only changes in the parent.
  function tryMove(from: Square, to: Square) {
    if (!interactive || promotion) return false
    const move = chess.moves({ square: from, verbose: true }).find((candidate) => candidate.to === to)
    if (!move) return false
    if (move.promotion) {
      setSelectedSquare(from)
      setPromotion({ from, to, color: chess.turn() })
    } else {
      chooseMove(from, to)
    }
    return true
  }

  function selectSquare(square: Square) {
    if (!interactive || promotion) return
    const piece = chess.get(square)
    if (selectedSquare && destinations.has(square)) {
      tryMove(selectedSquare, square)
      return
    }
    if (square === selectedSquare) {
      setSelectedSquare(null)
      setAnnouncement('Selection cleared.')
    } else if (piece?.color === chess.turn()) {
      setSelectedSquare(square)
      const moves = chess.moves({ square, verbose: true })
      const targets = [...new Set(moves.map((move) => move.to))]
      setAnnouncement(`${turnName} ${PIECE_NAMES[piece.type]} selected on ${square}. ${targets.length ? `Legal destinations: ${targets.join(', ')}.` : 'No legal moves.'}`)
    } else {
      setSelectedSquare(null)
      setAnnouncement(`Select a ${turnName.toLowerCase()} piece to move.`)
    }
  }

  function squareAtPoint(clientX: number, clientY: number) {
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height || clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null
    const column = Math.floor((clientX - rect.left) / rect.width * 8)
    const row = Math.floor((clientY - rect.top) / rect.height * 8)
    return `${files[column]}${ranks[row]}` as Square
  }

  function clearDrag() {
    const drag = dragRef.current
    dragRef.current = null
    setDragPreview(null)
    if (drag?.source.hasPointerCapture?.(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId)
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>, square: Square) {
    // Reset an unconsumed post-drag click before the next real gesture.
    if (!dragRef.current) suppressClickRef.current = false
    if (!interactive || promotion || dragRef.current || event.button !== 0 || event.isPrimary === false) return
    const piece = chess.get(square)
    if (piece?.color !== chess.turn()) return
    dragRef.current = {
      pointerId: event.pointerId,
      from: square,
      piece,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      source: event.currentTarget,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return
    const rect = gridRef.current?.getBoundingClientRect()
    if (!rect) return
    if (!drag.active) {
      drag.active = true
      setSelectedSquare(drag.from)
      setAnnouncement(`Dragging ${turnName.toLowerCase()} ${PIECE_NAMES[drag.piece.type]} from ${drag.from}. Drop on a legal destination.`)
    }
    event.preventDefault()
    setDragPreview({
      from: drag.from,
      piece: drag.piece,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      size: rect.width / 8,
      over: squareAtPoint(event.clientX, event.clientY),
    })
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const moved = drag.active || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= DRAG_THRESHOLD
    clearDrag()
    if (!moved) return // A tap keeps the normal click-to-select behavior.
    event.preventDefault()
    suppressClickRef.current = true
    const destination = squareAtPoint(event.clientX, event.clientY)
    if (!destination || !tryMove(drag.from, destination)) {
      setSelectedSquare(null)
      setAnnouncement('Move cancelled. Select a piece to try again.')
    }
  }

  function cancelPointerDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressClickRef.current = drag.active
    clearDrag()
    setSelectedSquare(null)
    setAnnouncement('Move cancelled.')
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!interactive) return
    if (onHistoryNavigate && !promotion && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && !event.nativeEvent.isComposing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      suppressClickRef.current = dragRef.current?.active ?? false
      clearDrag()
      setSelectedSquare(null)
      onHistoryNavigate(event.key === 'ArrowLeft' ? 'undo' : 'redo')
    } else if (event.key === 'Escape') {
      suppressClickRef.current = dragRef.current?.active ?? false
      clearDrag()
      setSelectedSquare(null)
      setAnnouncement('Selection cleared.')
    }
  }

  return (
    <div className={`chess-board-shell${interactive ? ' is-interactive' : ''}`} ref={boardRef}>
      <div
        className="chess-board"
        ref={gridRef}
        role={interactive ? 'grid' : 'img'}
        aria-label={interactive ? `Chess board. ${turnName} to move.${checkDescription}${suggestionDescription}${onHistoryNavigate ? ' Left and Right arrow keys undo and redo analysis moves.' : ''} Drag a piece, or use Tab to navigate squares and Enter to select a piece and its destination.` : `Chess position. ${turnName} to move.${checkDescription}${suggestionDescription} ${positionDescription}.`}
        aria-rowcount={interactive ? 8 : undefined}
        aria-colcount={interactive ? 8 : undefined}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelPointerDrag}
        onLostPointerCapture={cancelPointerDrag}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          // Browsers may synthesize a click on the captured source after a drop.
          // Keyboard clicks have detail 0 and should always remain available.
          if (suppressClickRef.current && event.detail !== 0) {
            suppressClickRef.current = false
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        {ranks.map((rank, row) => (
          <div className="chess-board-row" role={interactive ? 'row' : undefined} key={rank}>
            {[...files].map((file, column) => {
              const square = `${file}${rank}` as Square
              const piece = chess.get(square)
              const isLight = (file.charCodeAt(0) - 97 + rank) % 2 === 0
              const isSelected = selectedSquare === square
              const isDestination = destinations.has(square)
              const isLastMove = lastSquares.includes(square)
              const isInCheck = check.king === square
              const isChecker = check.attackers.includes(square)
              const isDraggable = interactive && !promotion && piece?.color === chess.turn()
              const pieceLabel = piece ? `${piece.color === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[piece.type]}` : 'empty'
              return (
                <button
                  type="button"
                  className={[
                    'chess-square', isLight ? 'is-light' : 'is-dark',
                    isSelected ? 'is-selected' : '', isLastMove ? 'is-last-move' : '',
                    isDestination ? 'is-destination' : '', piece ? 'has-piece' : '',
                    isInCheck ? 'is-in-check' : '', isChecker ? 'is-checker' : '',
                    isDraggable ? 'is-draggable' : '', dragPreview?.from === square ? 'is-dragging' : '',
                    isDestination && dragPreview?.over === square ? 'is-drag-over' : '',
                  ].filter(Boolean).join(' ')}
                  key={square}
                  data-square={square}
                  role={interactive ? 'gridcell' : undefined}
                  aria-rowindex={interactive ? row + 1 : undefined}
                  aria-colindex={interactive ? column + 1 : undefined}
                  aria-selected={interactive ? isSelected : undefined}
                  aria-label={`${square}, ${pieceLabel}${isInCheck ? ', in check' : ''}${isChecker ? ', checking piece' : ''}${isDestination ? ', legal destination' : ''}`}
                  tabIndex={interactive && !promotion ? 0 : -1}
                  disabled={!interactive}
                  onClick={() => selectSquare(square)}
                  onPointerDown={(event) => handlePointerDown(event, square)}
                  onKeyDown={handleKeyDown}
                >
                  {column === 0 && <span className="chess-coordinate chess-rank" aria-hidden="true">{rank}</span>}
                  {row === 7 && <span className="chess-coordinate chess-file" aria-hidden="true">{file}</span>}
                  {piece && <ChessPiece type={piece.type} color={piece.color} className="chess-piece" />}
                  {isDestination && <span className="chess-move-hint" aria-hidden="true" />}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {arrow && (
        <svg className="chess-best-move" viewBox="0 0 8 8" aria-hidden="true" focusable="false">
          <defs>
            <marker id={arrowId} markerWidth=".8" markerHeight=".8" refX=".6" refY=".4" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M 0 0 L .6 .4 L 0 .8 Z" fill="currentColor" />
            </marker>
          </defs>
          <line {...arrow} stroke="currentColor" strokeWidth=".16" strokeLinecap="round" markerEnd={`url(#${arrowId})`} />
        </svg>
      )}
      {dragPreview && (
        <div className="chess-drag-preview" aria-hidden="true" style={{ left: dragPreview.x, top: dragPreview.y, width: dragPreview.size, height: dragPreview.size }}>
          <ChessPiece type={dragPreview.piece.type} color={dragPreview.piece.color} className="chess-piece" />
        </div>
      )}
      {promotion && (
        <div className="chess-promotion-backdrop" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            const source = promotion.from
            setPromotion(null)
            boardRef.current?.querySelector<HTMLButtonElement>(`[data-square="${source}"]`)?.focus()
          } else if (event.key === 'Tab') {
            const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button')
            const first = buttons[0]
            const last = buttons[buttons.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}>
          <div className="chess-promotion" role="dialog" aria-modal="true" aria-label="Choose a promotion piece">
            <p>Promote your pawn</p>
            <div className="chess-promotion-options">
              {PROMOTIONS.map((type) => (
                <button
                  className="chess-promotion-choice"
                  type="button"
                  key={type}
                  aria-label={`Promote to ${PIECE_NAMES[type]}`}
                  onClick={() => chooseMove(promotion.from, promotion.to, type)}
                >
                  <ChessPiece type={type} color={promotion.color} />
                  <span>{PIECE_NAMES[type]}</span>
                </button>
              ))}
            </div>
            <button type="button" className="chess-promotion-cancel" onClick={() => {
              const source = promotion.from
              setPromotion(null)
              boardRef.current?.querySelector<HTMLButtonElement>(`[data-square="${source}"]`)?.focus()
            }}>Cancel</button>
          </div>
        </div>
      )}
      <span className="chess-board-announcement" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  )
}

export default ChessBoard
