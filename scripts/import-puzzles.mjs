#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRow, parseEngineInfo, preparePositions, prepareEarlierPositions, selectPack, validateEvaluation } from './lib/puzzle-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
if (args.includes('--help')) {
  console.log(`Usage: node scripts/import-puzzles.mjs [options]
  --input PATH      Lichess CSV; defaults to scripts/data/lichess-starter.csv
  --output PATH     Output JSON; defaults to src/data/puzzles.json
  --depth N         Stockfish search depth (default 18)
  --limit N         Maximum positions in the balanced output (default 64)
  --max-rows N      Maximum CSV source records to inspect (default 500)
  --games PATH      Optional JSON game histories for earlier evaluation positions
  --engine PATH    Stockfish JavaScript entry point; autodetected by default
  --cache PATH     Optional evaluated-position JSON cache for incremental runs

The input CSV must be decompressed first, e.g. with zstd -d lichess_db_puzzle.csv.zst.
Both the raw position and the position after the first UCI move are evaluated.
Only post-setup positions can be used for best-move and forced-mate rounds.`);
  process.exit(0);
}

const input = resolve(option('input', resolve(root, 'scripts/data/lichess-starter.csv')));
const output = resolve(option('output', resolve(root, 'src/data/puzzles.json')));
const depth = Number(option('depth', '18'));
const limit = Number(option('limit', '64'));
const maxRows = Number(option('max-rows', '500'));
const cache = option('cache', null);
const gamesPath = option('games', input === resolve(root, 'scripts/data/lichess-starter.csv')
  ? resolve(root, 'scripts/data/lichess-game-histories.json') : null);
const games = gamesPath ? JSON.parse(await readFile(resolve(gamesPath), 'utf8')) : [];
const gamesById = new Map(games.map((game) => [game.rawPuzzleId, game]));
for (const [name, value] of Object.entries({ depth, limit, maxRows })) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}: ${value}`);
}
const enginePath = option('engine', resolve(root, 'vendor/stockfish/cli.cjs'));
const engine = spawn(process.execPath, [resolve(enginePath)], { stdio: ['pipe', 'pipe', 'pipe'] });
const listeners = new Set();
let engineError = null;
let stderr = '';
engine.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
engine.on('error', (error) => {
  engineError = error;
  for (const listener of listeners) listener(null, error);
});
engine.on('exit', (code) => {
  engineError ??= new Error(`Stockfish exited (${code}). ${stderr}`);
  for (const listener of listeners) listener(null, engineError);
});
createInterface({ input: engine.stdout }).on('line', (line) => {
  for (const listener of listeners) listener(line, null);
});

function send(command) {
  if (!engine.stdin.destroyed && engine.stdin.writable) engine.stdin.write(`${command}\n`);
}
function waitFor(predicate, timeout = 120_000) {
  return new Promise((resolvePromise, reject) => {
    if (engineError) return reject(engineError);
    const timer = setTimeout(() => { listeners.delete(onLine); reject(new Error('Stockfish timed out')); }, timeout);
    function onLine(line, error) {
      if (error || predicate(line)) {
        clearTimeout(timer);
        listeners.delete(onLine);
        if (error) reject(error); else resolvePromise(line);
      }
    }
    listeners.add(onLine);
  });
}

async function evaluate(position, searchDepth = depth) {
  let score = null;
  const onLine = (line) => {
    if (line) score = parseEngineInfo(line, position.fen) ?? score;
  };
  listeners.add(onLine);
  try {
    send('ucinewgame');
    const ready = waitFor((line) => line === 'readyok');
    send('isready');
    await ready;
    const done = waitFor((line) => line.startsWith('bestmove '));
    send(`position fen ${position.fen}`);
    send(`go depth ${searchDepth}`);
    const bestmove = await done;
    if (!score || score.depth < searchDepth) throw new Error(`${position.id}: incomplete engine search`);
    const evaluation = { ...score, bestMove: bestmove.split(' ')[1], engine: 'Stockfish 16, classical evaluation, single-threaded' };
    validateEvaluation(position, evaluation);
    return { ...position, evaluation };
  } finally {
    listeners.delete(onLine);
  }
}

try {
  const uci = waitFor((line) => line === 'uciok');
  send('uci');
  await uci;
  console.log(`Stockfish ready; reading ${input} at depth ${depth}.`);
  send('setoption name Threads value 1');
  send('setoption name Hash value 32');
  send('setoption name MultiPV value 1');
  send('setoption name Use NNUE value false');
  let headers = null;
  let rows = 0;
  let skipped = 0;
  const evaluated = [];
  let existing = [];
  if (cache) {
    try { existing = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(cache), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cachedById = new Map(existing.map((position) => [position.id, position]));
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
    if (Number(record.Rating) < 1200) continue;
    let positions;
    try { positions = [...preparePositions(record), ...prepareEarlierPositions(record, gamesById.get(record.PuzzleId))]; }
    catch (error) { console.warn(`Skipping ${record.PuzzleId}: ${error.message}`); skipped++; continue; }
    for (const position of positions) {
      const cached = cachedById.get(position.id);
      let result = cached?.fen === position.fen && cached.evaluation.depth >= depth
        ? cached : await evaluate(position);
      if (position.phase === 'after' && result.evaluation.mate !== null && !result.mateVerification) {
        const verifiedDepth = Math.max(depth + 4, 24);
        const deeper = await evaluate(position, verifiedDepth);
        if (deeper.evaluation.mate !== result.evaluation.mate) {
          console.warn(`Skipping unstable mate ${position.id}: depth ${depth} and ${verifiedDepth} disagree.`);
          continue;
        }
        result = { ...deeper, mateVerification: { initialDepth: depth, verifiedDepth, mate: deeper.evaluation.mate } };
      }
      evaluated.push(result);
      console.log(`${result.id}: ${result.evaluation.cp ?? `mate ${result.evaluation.mate}`} (depth ${result.evaluation.depth})`);
    }
    if (cache) await writeFile(resolve(cache), `${JSON.stringify(evaluated, null, 2)}\n`);
  }
  const pack = selectPack(evaluated, limit);
  const medium = pack.filter((position) => position.rating < 1800 && position.evaluation.cp !== null).length;
  const hard = pack.filter((position) => position.rating >= 1800 && position.evaluation.cp !== null).length;
  const bestMove = pack.filter((position) => position.rating >= 1800 && position.phase === 'after' && position.evaluation.cp !== null).length;
  const mate = pack.filter((position) => position.evaluation.mate !== null).length;
  if (medium < 2 || hard < 3 || bestMove < 1 || mate < 1) {
    throw new Error(`Insufficient eligible positions: ${JSON.stringify({ medium, hard, bestMove, mate })}. Increase --max-rows.`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(pack, null, 2)}\n`);
  await rename(`${output}.tmp`, output);
  console.log(`Wrote ${pack.length} positions to ${output}: ${JSON.stringify({ medium, hard, bestMove, mate, skipped })}`);
} finally {
  send('quit');
  engine.kill();
}
