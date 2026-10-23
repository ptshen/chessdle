import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRow, preparePositions, prepareEarlierPositions, prepareContinuationPositions, positionKey, sourceGameKey,
  validateEvaluation, validateMatingLine, validateProvenance } from './lib/puzzle-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/verify-data.mjs [--data PACK.json] [--source SOURCE.csv] [--games HISTORIES.json]
Each option can be repeated. With no options, verifies both bundled puzzle packs,
both Lichess source CSV files, and available game histories. The original pack
retains its legacy mate-in-one records; new packs require mate-in-two or longer.`);
  process.exit(0);
}
async function paths(name, defaults) {
  const explicit = args.flatMap((arg, index) => arg === `--${name}` ? [resolve(args[index + 1])] : []);
  if (explicit.length) return explicit;
  const present = [];
  for (const path of defaults) {
    const absolute = resolve(root, path);
    try { await access(absolute); present.push(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return present;
}
const dataPaths = await paths('data', ['src/data/puzzles.json', 'src/data/puzzles-expanded.json']);
const sourcePaths = await paths('source', ['scripts/data/lichess-starter.csv', 'scripts/data/lichess-expanded.csv', 'scripts/data/lichess-large.csv']);
const historyPaths = await paths('games', ['scripts/data/lichess-game-histories.json', 'scripts/data/lichess-expanded-game-histories.json', 'scripts/data/lichess-large-game-histories.json']);
assert.ok(dataPaths.length, 'No puzzle packs found');
assert.ok(sourcePaths.length, 'No source CSV found');
const games = new Map();
for (const path of historyPaths) {
  for (const game of JSON.parse(await readFile(path, 'utf8'))) {
    if (!games.has(game.rawPuzzleId)) games.set(game.rawPuzzleId, []);
    games.get(game.rawPuzzleId).push(game);
  }
}
const source = new Map();
for (const path of sourcePaths) {
  const rows = (await readFile(path, 'utf8')).trim().split(/\r?\n/).map(parseCsvRow);
  const headers = rows.shift();
  for (const row of rows) {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    const positions = [...preparePositions(record), ...prepareContinuationPositions(record)];
    for (const history of games.get(record.PuzzleId) ?? []) {
      // Ratings and even source continuations can change between database
      // snapshots. A history only applies to the snapshot whose FEN it reaches.
      try { positions.push(...prepareEarlierPositions(record, history)); }
      catch { /* A required earlier position will fail the exact lookup below. */ }
    }
    for (const position of positions) {
      if (!source.has(position.id)) source.set(position.id, []);
      source.get(position.id).push(position);
    }
  }
}

const ids = new Set();
const rawIds = new Set();
const fens = new Set();
const gameIds = new Set();
const counts = { total: 0, medium: 0, hard: 0, bestMove: 0, mate: 0, waitingWinner: 0 };
for (const path of dataPaths) {
  const legacy = path === resolve(root, 'src/data/puzzles.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  for (const position of data) {
    counts.total++;
    assert.ok(!ids.has(position.id), `Duplicate position ${position.id}`);
    assert.ok(!rawIds.has(position.rawPuzzleId), `Duplicate source puzzle ${position.rawPuzzleId}`);
    assert.ok(!fens.has(positionKey(position)), `Duplicate board ${position.id}`);
    assert.ok(!gameIds.has(sourceGameKey(position)), `Duplicate source game ${position.id}`);
    ids.add(position.id);
    rawIds.add(position.rawPuzzleId);
    fens.add(positionKey(position));
    gameIds.add(sourceGameKey(position));
    const provenanceMatches = (source.get(position.id) ?? []).some((expected) => {
      try { validateProvenance(position, expected); return true; } catch { return false; }
    });
    assert.ok(provenanceMatches, `Missing matching source provenance ${position.id}`);
    assert.ok(position.evaluation.depth >= 18, `Insufficient depth ${position.id}`);
    validateEvaluation(position, position.evaluation);
    if (position.evaluation.mate !== null) {
      validateMatingLine(position, position.evaluation, legacy ? 1 : 2);
      assert.ok(position.mateVerification?.initialDepth >= 18, `Mate initial search too shallow ${position.id}`);
      assert.ok(position.mateVerification?.verifiedDepth >= 24, `Mate not verified at greater depth ${position.id}`);
      assert.ok(position.mateVerification.verifiedDepth > position.mateVerification.initialDepth, `Mate needs two different depths ${position.id}`);
      assert.equal(position.evaluation.depth, position.mateVerification.verifiedDepth, `Mate verification depth mismatch ${position.id}`);
      assert.equal(position.mateVerification.mate, position.evaluation.mate);
      if (Math.abs(position.evaluation.mate) >= 2) counts.mate++;
    } else {
      assert.ok(Math.abs(position.evaluation.cp) >= 50 && Math.abs(position.evaluation.cp) <= 800);
      const winner = position.evaluation.cp > 0 ? 'w' : 'b';
      if (winner !== position.fen.split(' ')[1]) counts.waitingWinner++;
      if (position.rating < 1800) counts.medium++;
      else {
        counts.hard++;
        if (position.phase === 'after') counts.bestMove++;
      }
    }
  }
}
console.log(`Verified source provenance, unique source puzzles/games/boards, depth-18+ legal best moves/PVs, and complete double-checked mating lines: ${JSON.stringify(counts)}.`);
