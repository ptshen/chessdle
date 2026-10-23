import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsvRow, parseEngineInfo, preparePositions, prepareContinuationPositions, selectPack, sourceGameKey,
  positionKey, validateMatingLine, validateProvenance } from './puzzle-data.mjs';

const sampleRecord = {
  PuzzleId: 'sample', FEN: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  Moves: 'e2e4 e7e5', Rating: '1500', Themes: 'opening', GameUrl: 'https://lichess.org/example',
};
let fixtureNumber = 0;
function make(id, cp, mate = null, extra = {}) {
  const number = ++fixtureNumber;
  // Distinct board layouts, not merely distinct halfmove/fullmove counters.
  const encode = (bits) => bits.split('').map((bit) => bit === '1' ? 'P' : '1').join('')
    .replace(/1+/g, (empty) => String(empty.length));
  const bits = number.toString(2).padStart(16, '0');
  return {
    id, rawPuzzleId: id, rating: 1900, phase: 'after', themes: ['mateIn2'],
    gameUrl: `https://lichess.org/game${number}`,
    fen: `7k/8/8/8/${encode(bits.slice(0, 8))}/${encode(bits.slice(8))}/8/K7 b - - 0 1`,
    evaluation: { cp, mate }, ...extra,
  };
}
function makeStratum(id, winner, waiting, rating = 1900, extra = {}) {
  const turn = waiting ? (winner === 'w' ? 'b' : 'w') : winner;
  const position = make(id, winner === 'w' ? 200 : -200, null,
    { rating, phase: waiting || rating < 1800 ? 'before' : 'after', ...extra });
  position.fen = position.fen.replace(' b ', ` ${turn} `);
  return position;
}
function strata(positions) {
  const counts = { 'w-waiting': 0, 'w-to-move': 0, 'b-waiting': 0, 'b-to-move': 0 };
  for (const position of positions) {
    const winner = position.evaluation.cp > 0 ? 'w' : 'b';
    counts[`${winner}-${position.fen.split(' ')[1] === winner ? 'to-move' : 'waiting'}`]++;
  }
  return counts;
}

test('CSV parsing preserves FEN spaces, quoted commas, and escaped quotes', () => {
  assert.deepEqual(parseCsvRow('id,"fen with spaces","tag, tag","a ""quote""",'),
    ['id', 'fen with spaces', 'tag, tag', 'a "quote"', '']);
  assert.throws(() => parseCsvRow('id,"unfinished'), /Unclosed/);
});

test('Lichess setup move is applied exactly once and both phases retain provenance', () => {
  const [before, after] = preparePositions(sampleRecord);
  assert.equal(before.id, 'sample-before');
  assert.equal(before.phase, 'before');
  assert.equal(after.phase, 'after');
  assert.equal(after.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.deepEqual(after.solution, ['e7e5']);
  assert.equal(after.rawPuzzleId, 'sample');
});

test('continuation applies exactly the setup and first solution move while preserving full source provenance', () => {
  const record = { ...sampleRecord, Moves: 'e2e4 e7e5 g1f3' };
  const [, after] = preparePositions(record);
  const [continuation] = prepareContinuationPositions(record);
  assert.equal(continuation.id, 'sample-continuation');
  assert.equal(continuation.phase, 'continuation');
  assert.equal(continuation.fen, 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  assert.equal(continuation.positionOrigin, 'puzzle-continuation');
  assert.equal(continuation.sourceSolutionPly, 1);
  for (const key of ['rawPuzzleId', 'rating', 'themes', 'sourceUrl', 'gameUrl', 'initialFen', 'setupMove', 'solution']) {
    assert.deepEqual(continuation[key], after[key]);
  }
  assert.deepEqual(continuation.solution, ['e7e5', 'g1f3']);
  assert.throws(() => validateProvenance({ ...continuation, sourceSolutionPly: 2 }, continuation), /sourceSolutionPly/);
});

test('continuation validates the complete source solution and requires a first solving move', () => {
  assert.throws(() => prepareContinuationPositions({ ...sampleRecord, Moves: 'e2e4 e7e5 g1g5' }), /Invalid move/);
  assert.deepEqual(prepareContinuationPositions({ ...sampleRecord, Moves: 'e2e4' }), []);
});

test('continuations supply evaluation positions but cannot replace best-move or mate records', () => {
  const after = make('source-after', -200);
  const sameSourceContinuation = make('source-continuation', 200, null,
    { phase: 'continuation', rawPuzzleId: after.rawPuzzleId, gameUrl: after.gameUrl });
  const evaluation = make('other-continuation', 200, null, { phase: 'continuation' });
  const falseMate = make('continuation-mate', null, -2, { phase: 'continuation' });
  const trueMate = make('actual-mate', null, -2);
  const selected = selectPack([sameSourceContinuation, evaluation, falseMate, after, trueMate], 3,
    { mateLimit: 1, mediumLimit: 0, bestMoveLimit: 1 });
  assert.deepEqual(selected.map((position) => position.id).sort(), ['actual-mate', 'other-continuation', 'source-after']);
  assert.equal(new Set(selected.map((position) => position.rawPuzzleId)).size, 3);
});

test('centipawn and mate scores are converted from Black to White perspective', () => {
  const black = '8/8/8/8/8/8/8/8 b - - 0 1';
  assert.equal(parseEngineInfo('info depth 18 score cp 230 nodes 4 pv a7a6', black).cp, -230);
  assert.equal(parseEngineInfo('info depth 18 score mate 3 pv a7a6', black).mate, -3);
  assert.equal(parseEngineInfo('info depth 18 score mate -3 pv a7a6', black).mate, 3);
  assert.equal(parseEngineInfo('info depth 18 score cp 230 lowerbound pv a7a6', black), null);
});

test('selection excludes losing-side mates, theme disagreements, extreme scores, and duplicate sources', () => {
  const selected = selectPack([
    make('correct-mate', null, -2), make('losing-mate', null, 2), make('wrong-distance', null, -3),
    make('extreme', 900), make('close', 20), make('good', -230),
    make('good-before', 220, null, { rawPuzzleId: 'good', phase: 'before' }),
  ], 10);
  assert.deepEqual(selected.map(({ rawPuzzleId }) => rawPuzzleId), ['correct-mate', 'good']);
});

test('mate quota scales beyond eight and never admits mate-in-one into a new pack', () => {
  const mates = Array.from({ length: 35 }, (_, index) => make(`mate-${index}`, null, -2));
  const ones = Array.from({ length: 10 }, (_, index) => make(`one-${index}`, null, -1, { themes: ['mateIn1'] }));
  const selected = selectPack([...ones, ...mates], 120);
  assert.equal(selected.length, 24);
  assert.ok(selected.every((position) => Math.abs(position.evaluation.mate) === 2));
  assert.equal(selectPack(mates, 120, { mateLimit: 30 }).length, 30);
});

test('hard move quota reserves post-setup records before waiting-side alternatives consume them', () => {
  const hard = [];
  const medium = [];
  for (let index = 0; index < 30; index++) {
    const sign = index % 2 ? 1 : -1;
    const turn = sign === 1 ? 'w' : 'b';
    const after = make(`hard-${index}`, sign * 200);
    after.fen = after.fen.replace(' b ', ` ${turn} `);
    hard.push(make(`hard-${index}-before`, -sign * 200, null, {
      rawPuzzleId: after.rawPuzzleId, gameUrl: after.gameUrl, phase: 'before',
    }), after);
    medium.push(make(`medium-${index}`, sign * 200, null, { rating: 1500, phase: 'before' }));
  }
  const mates = Array.from({ length: 8 }, (_, index) => make(`mate-${index}`, null, -2));
  const selected = selectPack([...hard, ...medium, ...mates], 40, { mateLimit: 8, bestMoveLimit: 12 });
  const numerical = selected.filter((position) => position.evaluation.cp !== null);
  const hardSelected = numerical.filter((position) => position.rating >= 1800);
  assert.equal(selected.length, 40);
  assert.equal(hardSelected.length, 16);
  assert.equal(numerical.length - hardSelected.length, 16);
  assert.ok(hardSelected.filter((position) => position.phase === 'after').length >= 12);
  assert.ok(hardSelected.some((position) => position.phase === 'before'));
  assert.ok(hardSelected.filter((position) => position.evaluation.cp > 0).length >= 6);
  assert.ok(hardSelected.filter((position) => position.evaluation.cp < 0).length >= 6);
});

test('asymmetric medium quota leaves the remaining numerical slots for hard positions', () => {
  const medium = Array.from({ length: 30 }, (_, index) => make(`asymmetric-medium-${index}`, index % 2 ? 200 : -200, null, { rating: 1500 }));
  const hard = Array.from({ length: 30 }, (_, index) => make(`asymmetric-hard-${index}`, index % 2 ? 200 : -200));
  const mates = Array.from({ length: 8 }, (_, index) => make(`asymmetric-mate-${index}`, null, -2));
  const selected = selectPack([...medium, ...hard, ...mates], 40, { mateLimit: 8, mediumLimit: 8, bestMoveLimit: 12 });
  assert.equal(selected.filter((position) => position.evaluation.cp !== null && position.rating < 1800).length, 8);
  assert.equal(selected.filter((position) => position.evaluation.cp !== null && position.rating >= 1800).length, 24);
  assert.equal(selected.filter((position) => position.evaluation.mate !== null).length, 8);
  assert.throws(() => selectPack([], 40, { mateLimit: 8, mediumLimit: 33 }), /mediumLimit/);
});

test('appended positions balance the retained packs as well as their own reserved moves', () => {
  const retained = Array.from({ length: 8 }, (_, index) => {
    const sign = index % 2 ? 1 : -1;
    const position = make(`retained-moving-${index}`, sign * 200);
    position.fen = position.fen.replace(' b ', ` ${sign > 0 ? 'w' : 'b'} `);
    return position;
  });
  const candidates = [];
  for (let index = 0; index < 8; index++) {
    const sign = index % 2 ? 1 : -1;
    const moving = make(`append-moving-${index}`, sign * 200);
    moving.fen = moving.fen.replace(' b ', ` ${sign > 0 ? 'w' : 'b'} `);
    const waiting = make(`append-waiting-${index}`, sign * 200, null, { phase: 'before' });
    waiting.fen = waiting.fen.replace(' b ', ` ${sign > 0 ? 'b' : 'w'} `);
    candidates.push(moving, waiting);
  }
  const selected = selectPack(candidates, 4, { mateLimit: 0, mediumLimit: 0, bestMoveLimit: 0, exclude: retained });
  assert.equal(selected.length, 4);
  assert.ok(selected.every((position) => position.phase === 'before'));
  assert.equal(selected.filter((position) => position.evaluation.cp > 0).length, 2);
});

test('hard answer/turn balance includes reserved best-move positions in cumulative counts', () => {
  const positions = [];
  for (const rating of [1500, 1900]) for (const winner of ['w', 'b']) for (const waiting of [false, true]) {
    for (let index = 0; index < 30; index++) positions.push(makeStratum(`${rating}-${winner}-${waiting}-${index}`, winner, waiting, rating));
  }
  const selected = selectPack(positions, 80, { mateLimit: 0, bestMoveLimit: 20 });
  assert.equal(selected.length, 80);
  for (const rating of [1500, 1900]) {
    assert.deepEqual(strata(selected.filter((position) => position.rating === rating)),
      { 'w-waiting': 10, 'w-to-move': 10, 'b-waiting': 10, 'b-to-move': 10 });
  }
  assert.equal(selected.filter((position) => position.rating === 1900 && position.phase === 'after').length, 20);
});

test('move reservations preserve scarce waiting alternatives when inflexible sources can fill the quota', () => {
  const positions = [];
  for (let index = 0; index < 4; index++) {
    const winner = index % 2 ? 'w' : 'b';
    const after = makeStratum(`flexible-${index}`, winner, false);
    positions.push(after, makeStratum(`flexible-${index}-before`, winner, true, 1900,
      { rawPuzzleId: after.rawPuzzleId, gameUrl: after.gameUrl }));
    positions.push(makeStratum(`move-only-${index}`, winner, false));
  }
  for (let index = 0; index < 8; index++) positions.push(makeStratum(`medium-${index}`, index % 2 ? 'w' : 'b', index % 4 < 2, 1500));
  const selected = selectPack(positions, 16, { mateLimit: 0, bestMoveLimit: 4 });
  const hard = selected.filter((position) => position.rating === 1900);
  assert.equal(hard.length, 8);
  assert.equal(hard.filter((position) => position.id.startsWith('move-only-')).length, 4);
  assert.equal(hard.filter((position) => position.id.endsWith('-before')).length, 4);
  assert.deepEqual(strata(hard), { 'w-waiting': 2, 'w-to-move': 2, 'b-waiting': 2, 'b-to-move': 2 });
});

test('medium balance uses inflexible waiting sources before consuming a needed moving alternative', () => {
  const flexible = makeStratum('medium-flexible', 'w', true, 1500);
  const positions = [flexible,
    makeStratum('medium-flexible-moving', 'w', false, 1500, { rawPuzzleId: flexible.rawPuzzleId, gameUrl: flexible.gameUrl }),
    makeStratum('medium-waiting-only', 'w', true, 1500),
    makeStratum('medium-black-waiting', 'b', true, 1500), makeStratum('medium-black-moving', 'b', false, 1500),
  ];
  for (const winner of ['w', 'b']) for (const waiting of [false, true]) positions.push(makeStratum(`hard-${winner}-${waiting}`, winner, waiting));
  const selected = selectPack(positions, 8, { mateLimit: 0, bestMoveLimit: 2 });
  assert.deepEqual(strata(selected.filter((position) => position.rating < 1800)),
    { 'w-waiting': 1, 'w-to-move': 1, 'b-waiting': 1, 'b-to-move': 1 });
});

test('mate reservations preserve scarce numerical waiting variants when other mates are available', () => {
  const waiting = makeStratum('medium-waiting', 'w', true, 1500);
  const positions = [make('flexible-mate', null, -2, { rawPuzzleId: waiting.rawPuzzleId, gameUrl: waiting.gameUrl, rating: 1500 }),
    make('mate-only-one', null, -2), make('mate-only-two', null, -2), waiting,
    makeStratum('medium-white-moving', 'w', false, 1500),
    makeStratum('medium-black-waiting', 'b', true, 1500), makeStratum('medium-black-moving', 'b', false, 1500),
  ];
  for (const winner of ['w', 'b']) for (const turn of [false, true]) positions.push(makeStratum(`hard-${winner}-${turn}`, winner, turn));
  const selected = selectPack(positions, 10, { mateLimit: 2, bestMoveLimit: 2 });
  assert.equal(selected.length, 10);
  assert.deepEqual(selected.filter((position) => position.evaluation.mate !== null).map((position) => position.id), ['mate-only-one', 'mate-only-two']);
  assert.deepEqual(strata(selected.filter((position) => position.rating < 1800)),
    { 'w-waiting': 1, 'w-to-move': 1, 'b-waiting': 1, 'b-to-move': 1 });
});

test('pack excludes duplicate boards, source games, phases, and entries from previous packs', () => {
  const original = make('old', -200);
  const sameBoard = make('board-copy', -250, null, { fen: original.fen.replace(' 0 1', ' 9 99') });
  const sameGame = make('game-copy', -250, null, { gameUrl: `${original.gameUrl}/black#42` });
  const sameSource = make('old-before', 200, null, { rawPuzzleId: 'old', phase: 'before' });
  const fresh = make('fresh', -300);
  const freshSameGame = make('fresh-game-copy', -300, null, { gameUrl: `${fresh.gameUrl}#50` });
  const result = selectPack([original, sameBoard, sameGame, sameSource, fresh, freshSameGame], 20, { exclude: [original] });
  assert.deepEqual(result.map((position) => position.id), ['fresh']);
  assert.equal(positionKey(original), positionKey(sameBoard));
  assert.equal(sourceGameKey(original), sourceGameKey(sameGame));
});

test('provenance validation checks original setup, complete solution, themes, and source URL', () => {
  const [expected] = preparePositions(sampleRecord);
  validateProvenance({ ...expected, evaluation: { cp: 200 } }, expected);
  for (const field of ['initialFen', 'setupMove', 'solution', 'themes', 'sourceUrl', 'gameUrl', 'rating', 'rawPuzzleId']) {
    assert.throws(() => validateProvenance({ ...expected, [field]: 'tampered' }, expected), new RegExp(field));
  }
  assert.throws(() => validateProvenance(expected, null), /missing source/);
});

test('mate validation requires the full legal checking line and matching source theme', async () => {
  const data = JSON.parse(await readFile(new URL('../../src/data/puzzles.json', import.meta.url), 'utf8'));
  const mate = data.find((position) => Math.abs(position.evaluation.mate) === 2);
  validateMatingLine(mate);
  assert.throws(() => validateMatingLine({ ...mate, themes: ['mateIn3'] }), /theme/);
  assert.throws(() => validateMatingLine(mate, { ...mate.evaluation, pv: mate.evaluation.pv.slice(0, -1) }), /incomplete/);
  const one = data.find((position) => Math.abs(position.evaluation.mate) === 1);
  assert.throws(() => validateMatingLine(one), /ineligible/);
  validateMatingLine(one, one.evaluation, 1);
});

test('resuming a narrower import preserves all prior cache records and supports selection without engine', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-cache-test-'));
  try {
    const cache = join(directory, 'cache.json');
    const output = join(directory, 'pack.json');
    const dataPath = new URL('../../src/data/puzzles.json', import.meta.url);
    const data = JSON.parse(await readFile(dataPath, 'utf8'));
    await writeFile(cache, JSON.stringify(data));
    const csvPath = join(directory, 'input.csv');
    await writeFile(csvPath, 'PuzzleId,FEN,Moves,Rating,Themes,GameUrl\nlow,unused,unused,1000,unused,https://lichess.org/unused\n');
    const importer = new URL('../import-puzzles.mjs', import.meta.url);
    execFileSync(process.execPath, [importer.pathname, '--input', csvPath, '--cache', cache, '--output', output, '--max-rows', '1'], { stdio: 'pipe' });
    assert.equal(JSON.parse(await readFile(cache, 'utf8')).length, data.length);
    const pack = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(pack.length > 50);
    assert.ok(pack.every((position) => Math.abs(position.evaluation.mate) !== 1));
    execFileSync(process.execPath, [importer.pathname, '--input', csvPath, '--cache', cache, '--output', output, '--select-only', '--engine', '/missing/engine'], { stdio: 'pipe' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), pack);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cache-only workers succeed with an incomplete round mix and never overwrite the output pack', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-cache-worker-test-'));
  try {
    const cache = join(directory, 'cache.json');
    const output = join(directory, 'pack.json');
    const input = join(directory, 'input.csv');
    const data = JSON.parse(await readFile(new URL('../../src/data/puzzles.json', import.meta.url), 'utf8'));
    await writeFile(cache, JSON.stringify([data[0]]));
    await writeFile(output, 'retained output');
    await writeFile(input, 'PuzzleId,FEN,Moves,Rating,Themes,GameUrl\nlow,unused,unused,1000,unused,https://lichess.org/unused\n');
    const result = execFileSync(process.execPath, [new URL('../import-puzzles.mjs', import.meta.url).pathname,
      '--input', input, '--cache', cache, '--output', output, '--cache-only', '--engine', '/missing/engine'], { encoding: 'utf8' });
    assert.match(result, /Checkpointed 1 positions/);
    assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), [data[0]]);
    assert.equal(await readFile(output, 'utf8'), 'retained output');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('continuation-only import and source verification reconstruct the same solution branch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-continuation-test-'));
  try {
    const cache = join(directory, 'cache.json');
    const input = join(directory, 'input.csv');
    const engine = join(directory, 'fake-engine.mjs');
    await writeFile(input, `${Object.keys(sampleRecord).join(',')}\n${Object.values(sampleRecord).join(',')}\n`);
    await writeFile(engine, `
      import { createInterface } from 'node:readline';
      createInterface({input: process.stdin}).on('line', (line) => {
        if (line === 'uci') console.log('uciok');
        if (line === 'isready') console.log('readyok');
        if (line.startsWith('go ')) {
          console.log('info depth 18 score cp 75 pv g1f3');
          console.log('bestmove g1f3');
        }
        if (line === 'quit') process.exit(0);
      });
    `);
    execFileSync(process.execPath, [new URL('../import-puzzles.mjs', import.meta.url).pathname,
      '--input', input, '--cache', cache, '--cache-only', '--phases', 'continuation', '--engine', engine], { stdio: 'pipe' });
    const positions = JSON.parse(await readFile(cache, 'utf8'));
    assert.equal(positions.length, 1);
    assert.equal(positions[0].id, 'sample-continuation');
    const verify = () => execFileSync(process.execPath, [new URL('../verify-data.mjs', import.meta.url).pathname,
      '--data', cache, '--source', input], { encoding: 'utf8', stdio: 'pipe' });
    assert.match(verify(), /"total":1/);
    positions[0].sourceSolutionPly = 2;
    await writeFile(cache, JSON.stringify(positions));
    assert.throws(verify, /Missing matching source provenance/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a timed-out position restarts the engine and checkpoints the next result without losing prior work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-recovery-test-'));
  try {
    const cache = join(directory, 'cache.json');
    const output = join(directory, 'pack.json');
    const engine = join(directory, 'fake-engine.mjs');
    const marker = join(directory, 'failed-once');
    const data = JSON.parse(await readFile(new URL('../../src/data/puzzles.json', import.meta.url), 'utf8'));
    await writeFile(cache, JSON.stringify(data));
    const csv = join(directory, 'input.csv');
    await writeFile(csv, `${Object.keys(sampleRecord).join(',')}\n${Object.values(sampleRecord).join(',')}\n`);
    await writeFile(engine, `
      import { createInterface } from 'node:readline';
      import { existsSync, writeFileSync } from 'node:fs';
      createInterface({input: process.stdin}).on('line', (line) => {
        if (line === 'uci') console.log('uciok');
        if (line === 'isready') console.log('readyok');
        if (line.startsWith('go ')) {
          if (!existsSync(${JSON.stringify(marker)})) {
            writeFileSync(${JSON.stringify(marker)}, 'yes');
            return;
          }
          console.log('info depth 18 score cp 75 pv e2e4');
          console.log('bestmove e2e4');
        }
        if (line === 'quit') process.exit(0);
      });
    `);
    execFileSync(process.execPath, [new URL('../import-puzzles.mjs', import.meta.url).pathname,
      '--input', csv, '--cache', cache, '--output', output, '--phases', 'after,before',
      '--engine', engine, '--timeout-ms', '500'], { stdio: 'pipe' });
    const retained = JSON.parse(await readFile(cache, 'utf8'));
    assert.equal(retained.length, data.length + 1);
    for (const original of data) assert.ok(retained.some((position) => position.id === original.id));
    assert.equal(retained.find((position) => position.id === 'sample-before').evaluation.depth, 18);
    assert.ok(!retained.some((position) => position.id === 'sample'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('verification accepts original and updated source snapshots while matching complete provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-provenance-test-'));
  try {
    const root = new URL('../../', import.meta.url);
    const data = JSON.parse(await readFile(new URL('src/data/puzzles.json', root), 'utf8'));
    const rows = (await readFile(new URL('scripts/data/lichess-starter.csv', root), 'utf8')).trim().split('\n').map(parseCsvRow);
    const headers = rows.shift();
    const changed = [...rows.find((row) => row[headers.indexOf('PuzzleId')] === data[0].rawPuzzleId)];
    changed[headers.indexOf('Rating')] = String(Number(changed[headers.indexOf('Rating')]) + 20);
    const variant = join(directory, 'new-snapshot.csv');
    const quote = (field) => `"${field.replaceAll('"', '""')}"`;
    await writeFile(variant, `${headers.map(quote).join(',')}\n${changed.map(quote).join(',')}\n`);
    const result = execFileSync(process.execPath, [new URL('scripts/verify-data.mjs', root).pathname,
      '--data', new URL('src/data/puzzles.json', root).pathname,
      '--source', new URL('scripts/data/lichess-starter.csv', root).pathname,
      '--source', variant], { encoding: 'utf8' });
    assert.match(result, /"total":64/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
