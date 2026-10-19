import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Chess } from '../vendor/chess.js/chess.js';
import { parseCsvRow, preparePositions, prepareEarlierPositions, playUci, validateEvaluation } from './lib/puzzle-data.mjs';

const root = new URL('../', import.meta.url);
const data = JSON.parse(await readFile(new URL('src/data/puzzles.json', root), 'utf8'));
const histories = JSON.parse(await readFile(new URL('scripts/data/lichess-game-histories.json', root), 'utf8'));
const games = new Map(histories.map((game) => [game.rawPuzzleId, game]));
const rows = (await readFile(new URL('scripts/data/lichess-starter.csv', root), 'utf8')).trim().split('\n').map(parseCsvRow);
const headers = rows.shift();
const source = new Map();
for (const row of rows) {
  const record = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  for (const position of [...preparePositions(record), ...prepareEarlierPositions(record, games.get(record.PuzzleId))]) {
    source.set(position.id, position);
  }
}

const ids = new Set();
const rawIds = new Set();
let mates = 0;
let waitingWinner = 0;
for (const position of data) {
  assert.ok(!ids.has(position.id), `Duplicate position ${position.id}`);
  assert.ok(!rawIds.has(position.rawPuzzleId), `Duplicate source puzzle ${position.rawPuzzleId}`);
  ids.add(position.id);
  rawIds.add(position.rawPuzzleId);
  const expected = source.get(position.id);
  assert.ok(expected, `Missing source record ${position.id}`);
  assert.equal(position.fen, expected.fen, `Source FEN mismatch ${position.id}`);
  assert.equal(position.rating, expected.rating, `Rating mismatch ${position.id}`);
  assert.ok(position.evaluation.depth >= 18, `Insufficient depth ${position.id}`);
  validateEvaluation(position, position.evaluation);
  if (position.evaluation.mate !== null) {
    mates++;
    assert.equal(position.phase, 'after');
    const matingColor = position.evaluation.mate > 0 ? 'w' : 'b';
    assert.equal(position.fen.split(' ')[1], matingColor, `Wrong side to mate ${position.id}`);
    const n = Math.abs(position.evaluation.mate);
    assert.ok(position.mateVerification?.verifiedDepth >= 24, `Mate not verified at greater depth ${position.id}`);
    assert.equal(position.mateVerification.mate, position.evaluation.mate);
    assert.ok(position.themes.includes(`mateIn${n}`), `Engine disagrees with Lichess mate tag ${position.id}`);
    assert.equal(position.evaluation.pv.length, 2 * n - 1, `Incomplete mating line ${position.id}`);
    const chess = new Chess(position.fen);
    for (const move of position.evaluation.pv) playUci(chess, move);
    assert.ok(chess.isCheckmate(), `Mating line does not end in checkmate ${position.id}`);
  } else {
    assert.ok(Math.abs(position.evaluation.cp) >= 50 && Math.abs(position.evaluation.cp) <= 800);
    const winner = position.evaluation.cp > 0 ? 'w' : 'b';
    if (winner !== position.fen.split(' ')[1]) waitingWinner++;
  }
}
console.log(`Verified ${data.length} source positions, legal best moves/PVs, ${mates} complete mating lines, and ${waitingWinner} positions where the winning side is waiting.`);
