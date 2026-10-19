/** All scores use White's perspective, regardless of the side to move. */
export interface EngineEvaluation {
  cp: number | null
  mate: number | null
  bestMove: string
  depth: number
  pv: string[]
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'thinking' | 'error'

export interface EvaluationOptions {
  depth?: number
  /** UCI moves from the supplied FEN, for comparison at the same search depth. */
  searchMoves?: string[]
  /** Cancel an analysis without allowing its output into a subsequent search. */
  signal?: AbortSignal
  /** Exact, deepest-so-far iterations, with scores from White's perspective. */
  onUpdate?: (evaluation: EngineEvaluation) => void
}

const STARTUP_TIMEOUT_MS = 30_000
const SEARCH_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 2_000
let worker: Worker | null = null
let initializing: Promise<Worker> | null = null
let queue: Promise<unknown> = Promise.resolve()
let status: EngineStatus = 'idle'
const statusListeners = new Set<() => void>()

export function getEngineStatus(): EngineStatus {
  return status
}

export function subscribeEngineStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

function setStatus(next: EngineStatus) {
  if (status === next) return
  status = next
  statusListeners.forEach((listener) => listener())
}

function resetWorker(nextStatus: EngineStatus = 'error') {
  worker?.terminate()
  worker = null
  initializing = null
  setStatus(nextStatus)
}

function abortError(): DOMException {
  return new DOMException('Analysis canceled.', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Attach listeners before sending a command; a worker can reply immediately. */
function waitForLine(engine: Worker, expected: string, command: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const cleanup = () => {
      clearTimeout(timeout)
      engine.removeEventListener('message', onMessage)
      engine.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      if (event.data.split('\n').some((line: string) => line.trim() === expected)) {
        cleanup()
        resolve()
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error('Stockfish could not start. Check your connection and try again.'))
    }
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Stockfish took too long to start. Please try again.'))
    }, STARTUP_TIMEOUT_MS)
    engine.addEventListener('message', onMessage)
    engine.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      engine.postMessage(command)
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

async function getWorker(signal?: AbortSignal): Promise<Worker> {
  throwIfAborted(signal)
  if (initializing) return initializing
  setStatus('loading')
  initializing = (async () => {
    if (typeof Worker === 'undefined') {
      throw new Error('This browser does not support the chess engine. Try a current browser.')
    }
    // A classic worker is required by Stockfish's Emscripten wrapper. Its WASM
    // companion is copied alongside this file by scripts/copy-engine.mjs.
    const engine = new Worker(`${import.meta.env.BASE_URL}engine/stockfish.js`)
    worker = engine
    await waitForLine(engine, 'uciok', 'uci', signal)
    // Stockfish 16's vendored offline build uses classical evaluation. Modern
    // npm lite builds embed their network and ignore this unsupported option.
    engine.postMessage('setoption name Use NNUE value false')
    engine.postMessage('setoption name Hash value 32')
    engine.postMessage('setoption name MultiPV value 1')
    await waitForLine(engine, 'readyok', 'isready', signal)
    setStatus('ready')
    return engine
  })().catch((error: unknown) => {
    resetWorker(isAbortError(error) ? 'idle' : 'error')
    throw error
  })
  return initializing
}

function readInfo(line: string, whiteToMove: boolean): Omit<EngineEvaluation, 'bestMove'> | null {
  if (!line.startsWith('info ')) return null
  // Bound scores are not an exact evaluation and must never replace the last
  // completed iteration. MultiPV is fixed to one, but guard its index as well.
  if (/\b(?:lowerbound|upperbound)\b/.test(line)) return null
  const multipv = line.match(/\bmultipv (\d+)/)
  if (multipv && multipv[1] !== '1') return null
  const score = line.match(/\bscore (cp|mate) (-?\d+)/)
  const depth = line.match(/\bdepth (\d+)/)
  if (!score || !depth) return null
  const raw = Number(score[2])
  const sign = whiteToMove ? 1 : -1
  return {
    cp: score[1] === 'cp' ? raw * sign : null,
    // UCI mate 0 means the player to move is already checkmated. Signed zero
    // preserves the winning color for callers inspecting terminal positions.
    mate: score[1] === 'mate' ? (raw === 0 ? (whiteToMove ? -0 : 0) : raw * sign) : null,
    depth: Number(depth[1]),
    pv: line.match(/\bpv (.+)/)?.[1].trim().split(/\s+/) ?? [],
  }
}

async function search(fen: string, options: EvaluationOptions): Promise<EngineEvaluation> {
  throwIfAborted(options.signal)
  const depth = options.depth ?? 16
  if (!Number.isInteger(depth) || depth < 1 || depth > 30) {
    throw new Error('Search depth must be a whole number between 1 and 30.')
  }
  const fields = fen.trim().split(/\s+/)
  if (fields.length !== 6 || !['w', 'b'].includes(fields[1]) || /[\r\n]/.test(fen)) {
    throw new Error('The engine needs a complete chess position (FEN).')
  }
  if (options.searchMoves?.some((move) => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))) {
    throw new Error('The selected move is not in UCI notation.')
  }

  const engine = await getWorker(options.signal)
  let safeToReuse = true
  try {
    throwIfAborted(options.signal)
    // Start every search from an empty hash so daily answers do not depend on
    // which positions this browser happened to analyze beforehand.
    safeToReuse = false
    engine.postMessage('ucinewgame')
    engine.postMessage('setoption name Clear Hash')
    await waitForLine(engine, 'readyok', 'isready', options.signal)
    throwIfAborted(options.signal)
    setStatus('thinking')
    throwIfAborted(options.signal)
    const result = await new Promise<EngineEvaluation>((resolve, reject) => {
      let latest: Omit<EngineEvaluation, 'bestMove'> | null = null
      let canceled = false
      let settled = false
      const cleanup = () => {
        settled = true
        clearTimeout(timeout)
        engine.removeEventListener('message', onMessage)
        engine.removeEventListener('error', onError)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onMessage = (event: MessageEvent) => {
        if (settled || typeof event.data !== 'string') return
        for (const rawLine of event.data.split('\n')) {
          const line = rawLine.trim()
          const info = canceled ? null : readInfo(line, fields[1] === 'w')
          if (info && (!latest || info.depth >= latest.depth)) {
            latest = info
            // A consumer cannot change the evaluation retained for scoring.
            const update = { ...info, pv: [...info.pv], bestMove: info.pv[0] ?? '' }
            try { options.onUpdate?.(update) } catch { /* UI callbacks must not interrupt UCI cleanup. */ }
          }
          if (line.startsWith('bestmove ')) {
            safeToReuse = true
            cleanup()
            if (canceled) {
              reject(abortError())
              return
            }
            if (!latest) {
              reject(new Error('Stockfish returned no evaluation for this position. Please retry.'))
              return
            }
            const move = line.split(/\s+/)[1]
            resolve({ ...latest, bestMove: move === '(none)' || move === '0000' ? '' : move })
            return
          }
        }
      }
      const onError = () => {
        cleanup()
        reject(canceled ? abortError() : new Error('The chess engine stopped unexpectedly. Please try again.'))
      }
      const onAbort = () => {
        if (settled || canceled) return
        canceled = true
        clearTimeout(timeout)
        // A stopped UCI search ends in bestmove. Drain that response before
        // releasing the queue; otherwise it could finish the next position.
        timeout = setTimeout(() => {
          cleanup()
          reject(abortError())
        }, STOP_TIMEOUT_MS)
        try {
          engine.postMessage('stop')
        } catch {
          cleanup()
          reject(abortError())
        }
      }
      let timeout = setTimeout(() => {
        cleanup()
        reject(new Error('This position took too long to analyze. Please try again.'))
      }, SEARCH_TIMEOUT_MS)
      engine.addEventListener('message', onMessage)
      engine.addEventListener('error', onError)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        engine.postMessage(`position fen ${fen}`)
        const moves = options.searchMoves?.length ? ` searchmoves ${options.searchMoves.join(' ')}` : ''
        engine.postMessage(`go depth ${depth}${moves}`)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
    setStatus('ready')
    return result
  } catch (error) {
    // A timed-out worker must be killed, otherwise its delayed bestmove can be
    // mistaken for the result of a later position in the queue.
    if (isAbortError(error) && safeToReuse) setStatus('ready')
    else resetWorker(isAbortError(error) ? 'idle' : 'error')
    throw error
  }
}

/** Searches are serialized because one UCI engine can evaluate one position at a time. */
export function evaluatePosition(fen: string, options: EvaluationOptions = {}): Promise<EngineEvaluation> {
  if (options.signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const result = queue.then(() => search(fen, options))
    // The caller can leave immediately, while the queue waits for stop/drain.
    queue = result.catch(() => undefined)
    result.then(
      (evaluation) => { cleanup(); resolve(evaluation) },
      (error: unknown) => { cleanup(); reject(error) },
    )
  })
}
