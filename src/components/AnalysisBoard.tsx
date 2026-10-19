import { useEffect, useMemo, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Play, RotateCcw, Undo2 } from 'lucide-react'
import { evaluatePosition, type EngineEvaluation } from '../lib/engine'
import { ChessBoard } from './ChessBoard'
import './AnalysisBoard.css'

export interface AnalysisBoardProps {
  initialFen: string
  initialEvaluation: EngineEvaluation
  playedMove?: string
}

type Analysis = {
  fen: string
  evaluation: EngineEvaluation | null
  loading: boolean
  error: boolean
}

function makePosition(initialFen: string, moves: string[]) {
  const position = new Chess(initialFen)
  for (const move of moves) position.move(move)
  return position
}

function startingMoves(initialFen: string, playedMove?: string) {
  if (!playedMove) return []
  try {
    new Chess(initialFen).move(playedMove)
    return [playedMove]
  } catch {
    return []
  }
}

function terminalEvaluation(chess: Chess): EngineEvaluation | null {
  if (chess.isCheckmate()) return {
    cp: null, mate: chess.turn() === 'w' ? -0 : 0, bestMove: '', pv: [], depth: 0,
  }
  if (chess.isDraw()) return { cp: 0, mate: null, bestMove: '', pv: [], depth: 0 }
  return null
}

function scoreText(evaluation: EngineEvaluation | null) {
  if (!evaluation) return '—'
  if (evaluation.mate !== null) {
    const blackWins = evaluation.mate < 0 || Object.is(evaluation.mate, -0)
    return `${blackWins ? '−' : '+'}M${Math.abs(evaluation.mate)}`
  }
  const score = (evaluation.cp ?? 0) / 100
  return `${score > 0 ? '+' : score < 0 ? '−' : ''}${Math.abs(score).toFixed(2)}`
}

function whiteShare(evaluation: EngineEvaluation | null) {
  if (!evaluation) return 50
  if (evaluation.mate !== null) return evaluation.mate < 0 || Object.is(evaluation.mate, -0) ? 0 : 100
  return 100 / (1 + Math.exp(-(evaluation.cp ?? 0) / 400))
}

/** A separate, disposable move history: exploring never changes a round's answer. */
export function AnalysisBoard(props: AnalysisBoardProps) {
  return <PositionAnalysis key={`${props.initialFen}:${props.playedMove ?? ''}`} {...props} />
}

export default AnalysisBoard

function PositionAnalysis({ initialFen, initialEvaluation, playedMove }: AnalysisBoardProps) {
  const [moves, setMoves] = useState(() => startingMoves(initialFen, playedMove))
  const [retry, setRetry] = useState(0)
  const original = useMemo(() => new Chess(initialFen), [initialFen])
  const chess = useMemo(() => makePosition(initialFen, moves), [initialFen, moves])
  const fen = chess.fen()
  const flipped = original.turn() === 'b'
  const terminal = useMemo(() => terminalEvaluation(chess), [chess])
  const cache = useRef(new Map([[original.fen(), initialEvaluation]]))
  const [analysis, setAnalysis] = useState<Analysis>(() => ({
    fen, evaluation: terminal ?? cache.current.get(fen) ?? null,
    loading: !terminal && !cache.current.has(fen), error: false,
  }))

  useEffect(() => {
    const cached = terminal ?? cache.current.get(fen)
    if (cached) {
      setAnalysis({ fen, evaluation: cached, loading: false, error: false })
      return
    }
    const controller = new AbortController()
    setAnalysis({ fen, evaluation: null, loading: true, error: false })
    evaluatePosition(fen, {
      depth: 14,
      signal: controller.signal,
      onUpdate: evaluation => {
        if (!controller.signal.aborted) setAnalysis({ fen, evaluation, loading: true, error: false })
      },
    }).then(evaluation => {
      if (controller.signal.aborted) return
      cache.current.set(fen, evaluation)
      // Keep the starting answer and a modest number of explored positions.
      if (cache.current.size > 32) {
        const oldest = [...cache.current.keys()].find(key => key !== original.fen())
        if (oldest) cache.current.delete(oldest)
      }
      setAnalysis({ fen, evaluation, loading: false, error: false })
    }).catch(() => {
      if (!controller.signal.aborted) setAnalysis({ fen, evaluation: null, loading: false, error: true })
    })
    return () => controller.abort()
  }, [fen, terminal, retry, original])

  // A changed board must never render the preceding position's score or arrow,
  // even for the render before its analysis effect starts.
  const evaluation = terminal ?? (analysis.fen === fen ? analysis.evaluation : cache.current.get(fen) ?? null)
  const error = !terminal && analysis.fen === fen && analysis.error
  const loading = !terminal && !error && (analysis.fen !== fen ? !cache.current.has(fen) : analysis.loading)
  const best = !terminal && evaluation?.bestMove
    ? chess.moves({ verbose: true }).find(move => `${move.from}${move.to}${move.promotion ?? ''}` === evaluation.bestMove)
    : undefined
  const side = chess.turn() === 'w' ? 'White' : 'Black'
  const positionStatus = chess.isCheckmate() ? `${side === 'White' ? 'Black' : 'White'} wins · Checkmate`
    : chess.isStalemate() ? 'Draw · Stalemate'
      : chess.isThreefoldRepetition() ? 'Draw · Repetition'
        : chess.isInsufficientMaterial() ? 'Draw · Insufficient material'
          : chess.isDraw() ? 'Draw · 50-move rule'
            : `${side} to move`
  const score = scoreText(evaluation)

  function playMove(uci: string) {
    if (terminal) return
    // Validate without mutating the history used for the current render.
    try {
      makePosition(initialFen, moves).move(uci)
      setMoves([...moves, uci])
    } catch {
      // An obsolete button or cancelled gesture must not alter the position.
    }
  }

  return <section className="position-analysis" aria-label="Position analysis" tabIndex={-1}>
    <div className="board-meta">
      <span className="side-to-move">
        {!terminal && <i className={`side-dot ${chess.turn()}`} aria-hidden="true" />}
        {positionStatus}
        {!terminal && chess.isCheck() && <span className="check-tag">Check</span>}
      </span>
      <span>Explore</span>
    </div>
    <div className="analysis-board-layout">
      <ChessBoard fen={fen} flipped={flipped} interactive={!terminal} onMove={playMove}
        lastMove={moves.at(-1)} bestMove={best ? evaluation!.bestMove : undefined} />
      <div className={`analysis-eval-rail${loading ? ' is-thinking' : ''}`} role="img"
        aria-label={evaluation ? `Evaluation ${score}, White's perspective` : error ? 'Evaluation unavailable' : 'Evaluating position'}
        title="White's perspective: + favors White, − favors Black.">
        <span className="analysis-eval-number">{score}</span>
        <div className={`analysis-eval-track${flipped ? ' white-at-top' : ''}`} aria-hidden="true">
          <div className="analysis-eval-white" style={{ height: `${whiteShare(evaluation)}%` }} />
        </div>
      </div>
    </div>
    <div className="analysis-move-bar">
      <div className="analysis-best" aria-live="polite" aria-atomic="true">
        {terminal ? <span>Game over</span>
          : error ? <span>Analysis unavailable</span>
            : best ? <><span>Best</span> <strong>{best.san}</strong></>
              : <span>Analyzing…</span>}
        {loading && best && <span className="analysis-thinking" aria-label="Analyzing">···</span>}
      </div>
      {error
        ? <button className="analysis-action" type="button" onClick={() => setRetry(value => value + 1)}>Retry analysis</button>
        : <button className="analysis-action analysis-play" type="button" disabled={!best} aria-label="Play best move"
          onClick={() => best && playMove(`${best.from}${best.to}${best.promotion ?? ''}`)}><Play size={15} aria-hidden="true" />Play best</button>}
    </div>
    <div className="analysis-history-controls">
      <button className="analysis-action" type="button" disabled={!moves.length} aria-label="Undo analysis move" onClick={() => setMoves(value => value.slice(0, -1))}>
        <Undo2 size={16} aria-hidden="true" />Undo
      </button>
      <button className="analysis-action" type="button" disabled={!moves.length} aria-label="Reset analysis position" onClick={() => setMoves([])}>
        <RotateCcw size={15} aria-hidden="true" />Reset
      </button>
    </div>
  </section>
}
