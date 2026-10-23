#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from '../vendor/chess.js/chess.js';
import { parseCsvRow, preparePositions, prepareEarlierPositions } from './lib/puzzle-data.mjs';

// These are pinned, unmodified CC0 Lichess extracts. Imec records take priority
// on duplicate puzzle IDs because they also include the source game's moves.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'scripts/data');
const columns = ['PuzzleId', 'FEN', 'Moves', 'Rating', 'RatingDeviation', 'Popularity',
  'NbPlays', 'Themes', 'GameUrl', 'OpeningTags'];
const sources = [
  { path: 'puzzle_train.csv', header: true },
  { path: 'puzzle_test.csv', header: true },
  { path: 'lichess-1000.csv', header: false },
];
const byId = new Map();
const histories = [];
let inputRows = 0;
let duplicateIds = 0;
let earlierPositions = 0;

for (const source of sources) {
  const lines = (await readFile(resolve(directory, source.path), 'utf8'))
    .replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const headers = source.header ? parseCsvRow(lines.shift()) : columns.slice(0, 9);
  for (const line of lines) {
    if (!line.trim()) continue;
    inputRows++;
    const values = parseCsvRow(line);
    if (values.length !== headers.length) throw new Error(`${source.path}: malformed CSV row`);
    const record = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
    if (byId.has(record.PuzzleId)) { duplicateIds++; continue; }
    const [initial] = preparePositions(record);
    if (record.GameSAN?.trim()) {
      const game = new Chess();
      game.loadPgn(record.GameSAN);
      if (game.fen() !== initial.fen) {
        throw new Error(`${record.PuzzleId}: GameSAN does not end at the source FEN`);
      }
      const history = { rawPuzzleId: record.PuzzleId, moves: game.history().join(' ') };
      earlierPositions += prepareEarlierPositions(record, history).length;
      histories.push(history);
    }
    byId.set(record.PuzzleId, record);
  }
}

const records = [...byId.values()].sort((a, b) => a.PuzzleId.localeCompare(b.PuzzleId));
histories.sort((a, b) => a.rawPuzzleId.localeCompare(b.rawPuzzleId));
const quote = (value = '') => /[",\r\n]/.test(value)
  ? `"${value.replaceAll('"', '""')}"` : value;
const csv = [columns.join(','), ...records.map((record) => columns.map((key) => quote(record[key])).join(','))].join('\n') + '\n';
await writeFile(resolve(directory, 'lichess-expanded.csv'), csv);
await writeFile(resolve(directory, 'lichess-expanded-game-histories.json'), JSON.stringify(histories, null, 2) + '\n');

const nonMate = (record) => !record.Themes.split(/\s+/).includes('mate');
const counts = {
  inputRows,
  uniqueSourceIds: records.length,
  duplicateIds,
  validSolutions: records.length,
  validatedHistories: histories.length,
  earlierPositions,
  rated1200Plus: records.filter((record) => Number(record.Rating) >= 1200).length,
  mediumNonMateSources: records.filter((record) => Number(record.Rating) >= 1200 && Number(record.Rating) < 1800 && nonMate(record)).length,
  hardNonMateSources: records.filter((record) => Number(record.Rating) >= 1800 && nonMate(record)).length,
  mateIn2To4Sources: records.filter((record) => Number(record.Rating) >= 1200 && /\bmateIn[234]\b/.test(record.Themes)).length,
};
console.log(JSON.stringify(counts, null, 2));
