#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvRow, preparePositions } from './lib/puzzle-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const archiveArgument = args.indexOf('--archive');
if (archiveArgument < 0 || !args[archiveArgument + 1]) {
  throw new Error('Usage: node scripts/normalize-large-puzzles.mjs --archive /path/to/lichess_db_puzzle.csv.zst');
}
const source = {
  repository: 'khemssharma/Chess',
  commit: 'fb5075bb360ae26606e77fc703001472d6657d1e',
  path: 'prisma/lichess_db_puzzle.csv.zst',
  gitBlobSha: 'c801dc2abb9ef733c290afd12b3df87cbb0e2889',
  sourceUrl: 'https://github.com/khemssharma/Chess/blob/fb5075bb360ae26606e77fc703001472d6657d1e/prisma/lichess_db_puzzle.csv.zst',
  originalDatabase: 'https://database.lichess.org/#puzzles',
  license: 'CC0-1.0',
};
const archivePath = resolve(args[archiveArgument + 1]);
const archive = await readFile(archivePath);
const blobSha = createHash('sha1').update(`blob ${archive.length}\0`).update(archive).digest('hex');
if (blobSha !== source.gitBlobSha) throw new Error('Archive does not match the pinned GitHub source blob');

// This exact repository blob is a partial download. zstd can recover its complete
// prefix but exits with "premature end". Only the final unfinished CSV record is
// discarded; complete records must all parse and have legal solution sequences.
const decompressed = spawnSync('zstd', ['-dc', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (decompressed.error) throw decompressed.error;
if (decompressed.status !== 0 && !/premature end/.test(decompressed.stderr)) {
  throw new Error(`zstd failed: ${decompressed.stderr}`);
}
const lines = decompressed.stdout.split(/\r?\n/);
const headers = parseCsvRow(lines.shift());
const expectedHeaders = ['PuzzleId', 'FEN', 'Moves', 'Rating', 'RatingDeviation', 'Popularity',
  'NbPlays', 'Themes', 'GameUrl', 'OpeningTags'];
if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) throw new Error('Unexpected source CSV schema');
const records = [];
const ids = new Set();
let incompleteTrailingRows = 0;
for (let index = 0; index < lines.length; index++) {
  const line = lines[index];
  if (!line.trim()) continue;
  const values = parseCsvRow(line);
  if (values.length !== headers.length) {
    if (index !== lines.length - 1 || decompressed.status === 0) throw new Error(`Malformed CSV row ${index + 2}`);
    incompleteTrailingRows++;
    continue;
  }
  const record = Object.fromEntries(headers.map((key, column) => [key, values[column]]));
  if (ids.has(record.PuzzleId)) throw new Error(`Duplicate source ID ${record.PuzzleId}`);
  preparePositions(record);
  ids.add(record.PuzzleId);
  records.push(record);
}
const quote = (value = '') => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csv = [headers.join(','), ...records.map((record) => headers.map((key) => quote(record[key])).join(','))].join('\n') + '\n';
const eligible = records.filter((record) => Number(record.Rating) >= 1200);
const nonMate = eligible.filter((record) => !record.Themes.split(/\s+/).includes('mate'));
const counts = {
  uniqueSourceIds: records.length,
  validSolutions: records.length,
  validatedHistories: 0,
  incompleteTrailingRows,
  rated1200Plus: eligible.length,
  mediumNonMateSources: nonMate.filter((record) => Number(record.Rating) < 1800).length,
  hardNonMateSources: nonMate.filter((record) => Number(record.Rating) >= 1800).length,
  mateIn2: eligible.filter((record) => record.Themes.split(/\s+/).includes('mateIn2')).length,
  mateIn3: eligible.filter((record) => record.Themes.split(/\s+/).includes('mateIn3')).length,
  mateIn4: eligible.filter((record) => record.Themes.split(/\s+/).includes('mateIn4')).length,
};
const provenance = {
  ...source,
  archiveBytes: archive.length,
  archiveSha256: createHash('sha256').update(archive).digest('hex'),
  normalizedCsvSha256: createHash('sha256').update(csv).digest('hex'),
  normalization: 'Recover the complete CSV prefix from the pinned partial zstd archive; discard only the final incomplete row; require every retained complete solution to be legal. Source columns are preserved. No histories are available in this source.',
  counts,
};
await writeFile(resolve(root, 'scripts/data/lichess-large.csv'), csv);
await writeFile(resolve(root, 'scripts/data/lichess-large-game-histories.json'), '[]\n');
await writeFile(resolve(root, 'scripts/data/lichess-large-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(counts, null, 2));
