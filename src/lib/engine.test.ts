import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WHITE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const BLACK_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

class MockWorker extends EventTarget {
  static instances: MockWorker[] = []
  static respondToUci = true
  static respondToReady = true
  commands: string[] = []
  terminated = false
  constructor() {
    super()
    MockWorker.instances.push(this)
  }
  postMessage(command: string) {
    this.commands.push(command)
    if (command === 'uci' && MockWorker.respondToUci) queueMicrotask(() => this.emit('uciok'))
    if (command === 'isready' && MockWorker.respondToReady) queueMicrotask(() => this.emit('readyok'))
  }
  emit(line: string) {
    this.dispatchEvent(new MessageEvent('message', { data: line }))
  }
  terminate() {
    this.terminated = true
  }
}

async function flush() {
  for (let iteration = 0; iteration < 20; iteration += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.resetModules()
  MockWorker.instances = []
  MockWorker.respondToUci = true
  MockWorker.respondToReady = true
  vi.stubGlobal('Worker', MockWorker)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('browser UCI engine', () => {
  it('normalizes centipawns to White and ignores bound scores', async () => {
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const pending = evaluatePosition(BLACK_FEN, { depth: 18 })
    await flush()
    const worker = MockWorker.instances[0]
    expect(getEngineStatus()).toBe('thinking')
    worker.emit('info depth 18 score cp 240 pv g8f6 b1c3')
    worker.emit('info depth 19 score cp 500 lowerbound pv a7a5')
    worker.emit('bestmove g8f6 ponder b1c3')
    await expect(pending).resolves.toEqual({ cp: -240, mate: null, depth: 18, bestMove: 'g8f6', pv: ['g8f6', 'b1c3'] })
    expect(getEngineStatus()).toBe('ready')
    expect(worker.commands).toContain('setoption name Clear Hash')
  })

  it('normalizes signed mate distance and supports restricted root searches', async () => {
    const { evaluatePosition } = await import('./engine')
    const pending = evaluatePosition(BLACK_FEN, { depth: 18, searchMoves: ['g8f6'] })
    await flush()
    const worker = MockWorker.instances[0]
    expect(worker.commands.at(-1)).toBe('go depth 18 searchmoves g8f6')
    worker.emit('info depth 18 score mate 3 pv g8f6\nbestmove g8f6')
    expect((await pending).mate).toBe(-3)
  })

  it('serializes two positions so engine output cannot cross between requests', async () => {
    const { evaluatePosition } = await import('./engine')
    const first = evaluatePosition(WHITE_FEN)
    const second = evaluatePosition(BLACK_FEN)
    await flush()
    const worker = MockWorker.instances[0]
    expect(worker.commands.filter((line) => line.startsWith('go '))).toHaveLength(1)
    worker.emit('info depth 16 score cp 40 pv e2e4\nbestmove e2e4')
    expect((await first).cp).toBe(40)
    await flush()
    expect(worker.commands.filter((line) => line.startsWith('go '))).toHaveLength(2)
    worker.emit('info depth 16 score cp 30 pv e7e5\nbestmove e7e5')
    expect((await second).cp).toBe(-30)
    expect(MockWorker.instances).toHaveLength(1)
  })

  it('discards a crashed worker and allows the next queued search to retry', async () => {
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const failed = evaluatePosition(WHITE_FEN)
    const rejection = expect(failed).rejects.toThrow('stopped unexpectedly')
    await flush()
    MockWorker.instances[0].dispatchEvent(new Event('error'))
    await rejection
    expect(getEngineStatus()).toBe('error')
    expect(MockWorker.instances[0].terminated).toBe(true)
    const retry = evaluatePosition(WHITE_FEN)
    await flush()
    MockWorker.instances[1].emit('info depth 16 score cp 25 pv d2d4\nbestmove d2d4')
    expect((await retry).cp).toBe(25)
  })

  it('terminates stalled searches so late results cannot contaminate a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { evaluatePosition } = await import('./engine')
    const pending = evaluatePosition(WHITE_FEN)
    const rejection = expect(pending).rejects.toThrow('too long to analyze')
    await flush()
    await vi.advanceTimersByTimeAsync(90_001)
    await rejection
    expect(MockWorker.instances[0].terminated).toBe(true)
  })

  it('rejects invalid depth, FEN commands, and malformed moves before starting', async () => {
    const { evaluatePosition } = await import('./engine')
    await expect(evaluatePosition(WHITE_FEN, { depth: 0 })).rejects.toThrow('depth')
    await expect(evaluatePosition(`${WHITE_FEN}\nquit`)).rejects.toThrow('FEN')
    await expect(evaluatePosition(WHITE_FEN, { searchMoves: ['e2e4\nquit'] })).rejects.toThrow('UCI')
    expect(MockWorker.instances).toHaveLength(0)
  })

  it('streams exact iterations in White perspective with the current principal move', async () => {
    const { evaluatePosition } = await import('./engine')
    const onUpdate = vi.fn()
    const pending = evaluatePosition(BLACK_FEN, { depth: 14, onUpdate })
    await flush()
    const worker = MockWorker.instances[0]
    worker.emit('info depth 10 score cp 230 pv g8f6 b1c3')
    expect(onUpdate).toHaveBeenLastCalledWith({ cp: -230, mate: null, depth: 10, bestMove: 'g8f6', pv: ['g8f6', 'b1c3'] })
    worker.emit('info depth 11 score cp 700 lowerbound pv a7a5\ninfo depth 11 score cp 500 upperbound pv a7a5\ninfo depth 11 multipv 2 score cp 900 pv a7a5\ninfo depth 9 score cp 800 pv a7a5')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    worker.emit('info depth 14 score mate 3 pv g8f6')
    expect(onUpdate).toHaveBeenLastCalledWith({ cp: null, mate: -3, depth: 14, bestMove: 'g8f6', pv: ['g8f6'] })
    // A UI mutating its snapshot cannot mutate the eventual scoring result.
    onUpdate.mock.calls[1][0].pv.push('a7a5')
    worker.emit('bestmove g8f6')
    await expect(pending).resolves.toEqual({ cp: null, mate: -3, depth: 14, bestMove: 'g8f6', pv: ['g8f6'] })
    worker.emit('info depth 15 score cp 600 pv a7a5')
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })

  it('rejects an already canceled request without starting the engine', async () => {
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const controller = new AbortController()
    controller.abort()
    await expect(evaluatePosition(WHITE_FEN, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(MockWorker.instances).toHaveLength(0)
    expect(getEngineStatus()).toBe('idle')
  })

  it('cancels queued work immediately and skips it when its turn arrives', async () => {
    const { evaluatePosition } = await import('./engine')
    const controller = new AbortController()
    const first = evaluatePosition(WHITE_FEN)
    const canceled = evaluatePosition(BLACK_FEN, { signal: controller.signal })
    const rejection = expect(canceled).rejects.toMatchObject({ name: 'AbortError' })
    const last = evaluatePosition(BLACK_FEN, { depth: 12 })
    await flush()
    controller.abort()
    await rejection
    const worker = MockWorker.instances[0]
    expect(worker.commands.filter((line) => line.startsWith('go '))).toEqual(['go depth 16'])
    worker.emit('info depth 16 score cp 40 pv e2e4\nbestmove e2e4')
    await first
    await flush()
    expect(worker.commands.filter((line) => line.startsWith('go '))).toEqual(['go depth 16', 'go depth 12'])
    worker.emit('info depth 12 score cp 20 pv e7e5\nbestmove e7e5')
    expect((await last).cp).toBe(-20)
  })

  it('drains a stopped analysis before reusing its worker for scoring', async () => {
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const controller = new AbortController()
    const onUpdate = vi.fn()
    const analysis = evaluatePosition(WHITE_FEN, { depth: 14, signal: controller.signal, onUpdate })
    const rejection = expect(analysis).rejects.toMatchObject({ name: 'AbortError' })
    const scoring = evaluatePosition(BLACK_FEN)
    await flush()
    const worker = MockWorker.instances[0]
    worker.emit('info depth 7 score cp 40 pv e2e4')
    controller.abort()
    await rejection
    expect(worker.commands.at(-1)).toBe('stop')
    worker.emit('info depth 9 score cp 200 pv d2d4')
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(worker.commands.filter((line) => line.startsWith('go '))).toHaveLength(1)
    worker.emit('bestmove d2d4')
    await flush()
    expect(worker.terminated).toBe(false)
    expect(MockWorker.instances).toHaveLength(1)
    expect(worker.commands.filter((line) => line === 'setoption name Clear Hash')).toHaveLength(2)
    expect(worker.commands.at(-1)).toBe('go depth 16')
    worker.emit('info depth 16 score cp 20 pv e7e5\nbestmove e7e5')
    expect((await scoring).cp).toBe(-20)
    expect(getEngineStatus()).toBe('ready')
  })

  it('stops progress callbacks immediately when canceled from an update in a batched message', async () => {
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const controller = new AbortController()
    const onUpdate = vi.fn(() => controller.abort())
    const analysis = evaluatePosition(WHITE_FEN, { signal: controller.signal, onUpdate })
    const rejection = expect(analysis).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const worker = MockWorker.instances[0]
    worker.emit('info depth 8 score cp 40 pv e2e4\ninfo depth 9 score cp 50 pv d2d4\nbestmove d2d4')
    await rejection
    await flush()
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(worker.terminated).toBe(false)
    expect(getEngineStatus()).toBe('ready')
  })

  it('cleans up cancellation during the fresh-hash readiness check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    const first = evaluatePosition(WHITE_FEN)
    await flush()
    const worker = MockWorker.instances[0]
    worker.emit('info depth 16 score cp 40 pv e2e4\nbestmove e2e4')
    await first
    MockWorker.respondToReady = false
    const controller = new AbortController()
    const analysis = evaluatePosition(BLACK_FEN, { signal: controller.signal })
    const rejection = expect(analysis).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(worker.commands.at(-1)).toBe('isready')
    controller.abort()
    await rejection
    await flush()
    expect(worker.terminated).toBe(true)
    expect(getEngineStatus()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['uci', 'ready'] as const)('cancels the %s startup handshake and clears its listeners and timer', async (handshake) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { evaluatePosition, getEngineStatus } = await import('./engine')
    MockWorker.respondToUci = handshake !== 'uci'
    MockWorker.respondToReady = handshake !== 'ready'
    const controller = new AbortController()
    const pending = evaluatePosition(WHITE_FEN, { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    const worker = MockWorker.instances[0]
    const removeListener = vi.spyOn(worker, 'removeEventListener')
    controller.abort()
    await rejection
    await flush()
    expect(worker.terminated).toBe(true)
    expect(getEngineStatus()).toBe('idle')
    expect(removeListener.mock.calls.map(([type]) => type)).toEqual(['message', 'error'])
    expect(vi.getTimerCount()).toBe(0)
    MockWorker.respondToUci = true
    MockWorker.respondToReady = true
    const retry = evaluatePosition(BLACK_FEN)
    await flush()
    worker.emit('uciok\nreadyok\ninfo depth 16 score cp 900 pv a7a5\nbestmove a7a5')
    MockWorker.instances[1].emit('info depth 16 score cp 25 pv e7e5\nbestmove e7e5')
    expect((await retry).cp).toBe(-25)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces an engine that does not finish stopping without reporting an analysis error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { evaluatePosition, getEngineStatus, subscribeEngineStatus } = await import('./engine')
    const statuses: string[] = []
    const unsubscribe = subscribeEngineStatus(() => statuses.push(getEngineStatus()))
    const controller = new AbortController()
    const analysis = evaluatePosition(WHITE_FEN, { signal: controller.signal })
    const rejection = expect(analysis).rejects.toMatchObject({ name: 'AbortError' })
    const scoring = evaluatePosition(BLACK_FEN)
    await flush()
    const oldWorker = MockWorker.instances[0]
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(2_001)
    expect(oldWorker.terminated).toBe(true)
    expect(statuses).not.toContain('error')
    oldWorker.emit('info depth 16 score cp 900 pv a7a5\nbestmove a7a5')
    MockWorker.instances[1].emit('info depth 16 score cp 10 pv e7e5\nbestmove e7e5')
    expect((await scoring).cp).toBe(-10)
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
  })
})
