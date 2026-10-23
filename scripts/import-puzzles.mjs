#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRow, parseEngineInfo, preparePositions, prepareEarlierPositions, prepareContinuationPositions, selectPack,
  sourceGameKey, validateEvaluation, validateMatingLine, validateProvenance } from './lib/puzzle-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
if (args.includes('--help')) {
  console.log(`Usage: node scripts/import-puzzles.mjs [options]
  --input PATH           Decompressed Lichess CSV (default scripts/data/lichess-starter.csv)
  --output PATH          Output JSON (default src/data/puzzles.json)
  --depth N              Stockfish depth, at least 18 (default 18)
  --limit N              Maximum balanced output size (default 64)
  --mate-limit N         Mate-in-2/3/4 quota (default one fifth of --limit)
  --medium-limit N       Medium numerical quota (default half the non-mate slots)
  --best-move-limit N    Hard post-setup quota (default 75% of the hard quota)
  --max-rows N           Maximum CSV source records to inspect (default 500)
  --exclude PATH         Existing JSON pack to exclude; may be repeated
  --phases LIST          after,before,earlier,continuation (default after,before,earlier)
  --games PATH           Optional JSON game histories for earlier positions
  --engine PATH          Stockfish JavaScript entry point (default vendor/stockfish/cli.cjs)
  --cache PATH           Evaluated-position JSON cache, atomically checkpointed per position
  --timeout-ms N         Maximum duration of each search (default 120000)
  --select-only          Build the output from the cache without running the engine
  --cache-only           Evaluate/checkpoint positions without writing a complete pack

Remaining numerical slots are hard positions. Hard post-setup records are
reserved before earlier positions from the same source. Answer/turn balance
includes retained packs passed with --exclude, as well as new positions.
Only one position per source puzzle, source game, and board is selected.
Original packs passed with --exclude are never modified. A resumed cache keeps
all previous results, including positions outside this run's CSV/row limit.
Continuation is evaluation-only: the position after the first solution move.
Its game URL credits the original source; the solution branch may differ from
the moves actually played in that game.`);
  process.exit(0);
}

const input = resolve(option('input', resolve(root, 'scripts/data/lichess-starter.csv')));
const output = resolve(option('output', resolve(root, 'src/data/puzzles.json')));
const depth = Number(option('depth', '18'));
const limit = Number(option('limit', '64'));
const maxRows = Number(option('max-rows', '500'));
const timeoutMs = Number(option('timeout-ms', '120000'));
const mateLimit = Number(option('mate-limit', String(Math.max(2, Math.floor(limit / 5)))));
const mediumLimit = Number(option('medium-limit', String(Math.ceil((limit - Math.min(limit, mateLimit)) / 2))));
const bestMoveLimit = Number(option('best-move-limit', String(Math.ceil((limit - Math.min(limit, mateLimit) - mediumLimit) * 0.75))));
const cache = option('cache', null);
const phases = option('phases', 'after,before,earlier').split(',');
if (phases.some((phase) => !['after', 'before', 'earlier', 'continuation'].includes(phase))) throw new Error('Invalid --phases');
for (const [name, value] of Object.entries({ depth, limit, maxRows, timeoutMs, mateLimit, mediumLimit, bestMoveLimit })) {
  const minimum = ['mateLimit', 'mediumLimit', 'bestMoveLimit'].includes(name) ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) throw new Error(`Invalid ${name}: ${value}`);
}
if (depth < 18) throw new Error('Production positions require --depth >= 18');
if (mediumLimit > limit - Math.min(limit, mateLimit)) throw new Error('--medium-limit exceeds the numerical position quota');
const selectOnly = args.includes('--select-only');
const cacheOnly = args.includes('--cache-only');
if (selectOnly && !cache) throw new Error('--select-only requires --cache');
if (cacheOnly && !cache) throw new Error('--cache-only requires --cache');
if (cacheOnly && selectOnly) throw new Error('--cache-only and --select-only cannot be combined');
const gamesPath = option('games', input === resolve(root, 'scripts/data/lichess-starter.csv')
  ? resolve(root, 'scripts/data/lichess-game-histories.json') : null);
const games = gamesPath ? JSON.parse(await readFile(resolve(gamesPath), 'utf8')) : [];
const gamesById = new Map(games.map((game) => [game.rawPuzzleId, game]));
const excluded = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--exclude') excluded.push(...JSON.parse(await readFile(resolve(args[++index]), 'utf8')));
}
const excludedIds = new Set(excluded.map((position) => position.rawPuzzleId));
const excludedGames = new Set(excluded.map(sourceGameKey).filter(Boolean));
const enginePath = resolve(option('engine', resolve(root, 'vendor/stockfish/cli.cjs')));

// Each engine instance owns its response listeners. Replacing a timed-out
// process prevents its eventual bestmove from contaminating the next search.
class Stockfish {
  constructor() {
    this.listeners = new Set();
    this.error = null;
    this.stderr = '';
    this.process = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', (data) => { this.stderr = (this.stderr + data).slice(-4000); });
    const fail = (error) => {
      this.error ??= error;
      for (const listener of this.listeners) listener(null, this.error);
    };
    this.process.on('error', fail);
    this.process.on('exit', (code) => fail(new Error(`Stockfish exited (${code}). ${this.stderr}`)));
    this.process.stdin.on('error', fail);
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      for (const listener of this.listeners) listener(line, null);
    });
  }
  send(command) {
    if (!this.process.stdin.destroyed && this.process.stdin.writable) this.process.stdin.write(`${command}\n`);
  }
  waitFor(predicate) {
    return new Promise((resolvePromise, reject) => {
      if (this.error) return reject(this.error);
      const timer = setTimeout(() => { this.listeners.delete(onLine); reject(new Error('Stockfish timed out')); }, timeoutMs);
      const onLine = (line, error) => {
        if (error || predicate(line)) {
          clearTimeout(timer);
          this.listeners.delete(onLine);
          if (error) reject(error); else resolvePromise(line);
        }
      };
      this.listeners.add(onLine);
    });
  }
  async start() {
    const ready = this.waitFor((line) => line === 'uciok');
    this.send('uci');
    await ready;
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 32');
    this.send('setoption name MultiPV value 1');
    this.send('setoption name Use NNUE value false');
  }
  close() {
    this.send('quit');
    this.process.kill();
  }
  async evaluate(position, searchDepth) {
    let score = null;
    const onLine = (line) => { if (line) score = parseEngineInfo(line, position.fen) ?? score; };
    this.listeners.add(onLine);
    try {
      this.send('ucinewgame');
      const ready = this.waitFor((line) => line === 'readyok');
      this.send('isready');
      await ready;
      const done = this.waitFor((line) => line.startsWith('bestmove '));
      this.send(`position fen ${position.fen}`);
      this.send(`go depth ${searchDepth}`);
      const bestmove = await done;
      if (!score || score.depth < searchDepth) throw new Error(`${position.id}: incomplete engine search`);
      const evaluation = { ...score, bestMove: bestmove.split(' ')[1], engine: 'Stockfish 16, classical evaluation, single-threaded' };
      validateEvaluation(position, evaluation);
      return { ...position, evaluation };
    } finally {
      this.listeners.delete(onLine);
    }
  }
}

let existing = [];
if (cache) {
  try { existing = JSON.parse(await readFile(resolve(cache), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const cachedById = new Map(existing.map((position) => [position.id, position]));
async function checkpoint(position) {
  if (position) cachedById.set(position.id, position);
  if (!cache) return;
  const path = resolve(cache);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify([...cachedById.values()], null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
let engine = null;
async function evaluate(position, searchDepth = depth) {
  try {
    if (!engine) { engine = new Stockfish(); await engine.start(); }
    return await engine.evaluate(position, searchDepth);
  } catch (error) { engine?.close(); engine = null; throw error; }
}

let rows = 0;
let skipped = 0;
const rejected = new Set();
try {
  if (!selectOnly) {
    console.log(`Reading ${input} at depth ${depth}; phases ${phases.join(',')}.`);
    let headers = null;
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const fields = parseCsvRow(line.replace(/^\uFEFF/, ''));
      if (!headers) {
        headers = fields;
        for (const required of ['PuzzleId', 'FEN', 'Moves', 'Rating', 'Themes', 'GameUrl']) {
          if (!headers.includes(required)) throw new Error(`Missing CSV column: ${required}`);
        }
        continue;
      }
      if (++rows > maxRows) break;
      const record = Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
      if (Number(record.Rating) < 1200 || excludedIds.has(record.PuzzleId)) continue;
      let positions;
      try {
        if (excludedGames.has(sourceGameKey({ gameUrl: record.GameUrl }))) continue;
        const prepared = preparePositions(record);
        positions = phases.flatMap((phase) => {
          if (phase === 'continuation') return prepareContinuationPositions(record);
          if (phase !== 'earlier') return prepared.filter((position) => position.phase === phase);
          try { return prepareEarlierPositions(record, gamesById.get(record.PuzzleId)); }
          catch (error) {
            console.warn(`Skipping earlier positions for ${record.PuzzleId}: ${error.message}`);
            skipped++;
            return [];
          }
        });
      } catch (error) { console.warn(`Skipping ${record.PuzzleId}: ${error.message}`); skipped++; continue; }
      for (const position of positions) {
        try {
          const cached = cachedById.get(position.id);
          let result;
          if (cached?.fen === position.fen && cached.evaluation.depth >= depth) {
            validateProvenance(cached, position);
            validateEvaluation(cached, cached.evaluation);
            result = cached;
          } else {
            result = await evaluate(position);
            await checkpoint(result);
          }
          if (position.phase === 'after' && result.evaluation.mate !== null) {
            validateMatingLine(position, result.evaluation);
            if (!result.mateVerification || result.mateVerification.verifiedDepth < Math.max(depth + 4, 24)) {
              const initialDepth = result.evaluation.depth;
              const verifiedDepth = Math.max(depth + 4, initialDepth + 4, 24);
              const deeper = await evaluate(position, verifiedDepth);
              if (deeper.evaluation.mate !== result.evaluation.mate) throw new Error('initial and deeper searches disagree on mate');
              validateMatingLine(position, deeper.evaluation);
              result = { ...deeper, mateVerification: { initialDepth, verifiedDepth, mate: deeper.evaluation.mate } };
              await checkpoint(result);
            }
          }
          console.log(`${result.id}: ${result.evaluation.cp ?? `mate ${result.evaluation.mate}`} (depth ${result.evaluation.depth})`);
        } catch (error) {
          console.warn(`Skipping ${position.id}: ${error.message}`);
          skipped++;
          rejected.add(position.id);
          // An invalid or unstable mate is retained for diagnosis, but only
          // fully verified mates below are eligible for the output.
        }
      }
    }
  }
  if (cacheOnly) {
    await checkpoint();
    console.log(`Checkpointed ${cachedById.size} positions to ${resolve(cache)} (${skipped} skipped); no output pack written.`);
  } else {
    const candidates = [...cachedById.values()].filter((position) => {
      if (rejected.has(position.id) || position.evaluation.depth < depth) return false;
      try { validateEvaluation(position, position.evaluation); } catch { return false; }
      if (position.evaluation.mate === null) return true;
      if (!position.mateVerification || position.mateVerification.initialDepth < 18
        || position.mateVerification.verifiedDepth < 24
        || position.mateVerification.verifiedDepth <= position.mateVerification.initialDepth
        || position.mateVerification.mate !== position.evaluation.mate) return false;
      try { validateMatingLine(position); return true; } catch { return false; }
    });
    const pack = selectPack(candidates, limit, { mateLimit, mediumLimit, bestMoveLimit, exclude: excluded });
    const medium = pack.filter((position) => position.rating < 1800 && position.evaluation.cp !== null).length;
    const hard = pack.filter((position) => position.rating >= 1800 && position.evaluation.cp !== null).length;
    const bestMove = pack.filter((position) => position.rating >= 1800 && position.phase === 'after' && position.evaluation.cp !== null).length;
    const mate = pack.filter((position) => position.evaluation.mate !== null).length;
    if (medium < 2 || hard < 3 || bestMove < 2 || mate < 1) {
      throw new Error(`Insufficient eligible positions: ${JSON.stringify({ medium, hard, bestMove, mate })}. Increase --max-rows.`);
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(`${output}.tmp`, `${JSON.stringify(pack, null, 2)}\n`);
    await rename(`${output}.tmp`, output);
    console.log(`Wrote ${pack.length} positions to ${output}: ${JSON.stringify({ medium, hard, bestMove, mate, skipped })}`);
  }
} finally {
  engine?.close();
}
