import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, type Context } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('the bundled Stockfish WASM actually evaluates positions and detects forced mate', async () => {
  const path = fileURLToPath(new URL('../../', import.meta.url))
  const child = spawn(process.execPath, ['vendor/stockfish/cli.cjs'], { cwd: path, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let latestScore = ''
  let phase = 0
  const evaluations: string[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code && code !== 0) reject(new Error(`Stockfish exited with code ${code}`))
      })
      child.stderr.on('data', (chunk: Buffer) => reject(new Error(chunk.toString())))
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line === 'uciok') {
            child.stdin.write('setoption name Hash value 32\nposition startpos\ngo depth 8\n')
          }
          if (line.startsWith('info ') && /score (cp|mate)/.test(line)) latestScore = line
          if (line.startsWith('bestmove ')) {
            evaluations.push(latestScore)
            phase += 1
            if (phase === 1) child.stdin.write('ucinewgame\nposition fen 7k/5Q2/6K1/8/8/8/8/8 w - - 0 1\ngo depth 8\n')
            else resolve()
          }
        }
      })
      child.stdin.write('uci\n')
    })
    expect(evaluations[0]).toMatch(/score cp -?\d+/)
    expect(evaluations[1]).toMatch(/score mate 1\b/)
  } finally {
    child.kill()
  }
}, 15_000)

it('runs the actual browser entrypoint and service with locally supplied WASM', async () => {
  // This exercises the browser code path in a VM, including onmessage and
  // fetching WASM. It is a smoke test, not a substitute for browser UI testing.
  const root = fileURLToPath(new URL('../../', import.meta.url))
  class LocalWorker extends EventTarget {
    context: Context
    stopped = false
    constructor() {
      super()
      const globals: Record<string, unknown> = {
        console, WebAssembly, Uint8Array, ArrayBuffer, TextDecoder, performance,
        setTimeout, clearTimeout,
        XMLHttpRequest: class {},
        fetch: async (path: string) => new Response(
          readFileSync(`${root}/vendor/stockfish/src/${path.split('/').at(-1)}`),
          { headers: { 'Content-Type': 'application/wasm' } },
        ),
        location: { href: 'http://test.invalid/engine/stockfish.js', hash: '', origin: 'http://test.invalid', pathname: '/engine/stockfish.js' },
        onmessage: null,
        postMessage: (line: string) => {
          if (!this.stopped) this.dispatchEvent(new MessageEvent('message', { data: line }))
        },
        importScripts() {},
      }
      globals.self = globals
      this.context = createContext(globals)
      runInContext(readFileSync(`${root}/vendor/stockfish/src/stockfish-nnue-16-single.js`, 'utf8'), this.context)
    }
    postMessage(command: string) { this.context.onmessage({ data: command }) }
    terminate() { this.stopped = true }
  }
  vi.resetModules()
  vi.stubGlobal('Worker', LocalWorker)
  try {
    const { evaluatePosition } = await import('./engine')
    const result = await evaluatePosition('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', { depth: 8 })
    expect(result.mate).toBe(1)
    expect(result.bestMove).toMatch(/^[a-h][1-8][a-h][1-8]$/)
    expect(result.cp).toBeNull()
    expect(result.depth).toBe(8)
  } finally {
    vi.unstubAllGlobals()
  }
}, 15_000)
