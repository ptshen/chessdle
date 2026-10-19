import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRow, parseEngineInfo, preparePositions, selectPack } from './puzzle-data.mjs';

test('CSV parsing preserves FEN spaces, quoted commas, and escaped quotes', () => {
  assert.deepEqual(parseCsvRow('id,"fen with spaces","tag, tag","a ""quote""",'),
    ['id', 'fen with spaces', 'tag, tag', 'a "quote"', '']);
  assert.throws(() => parseCsvRow('id,"unfinished'), /Unclosed/);
});

test('Lichess setup move is applied exactly once and both phases retain provenance', () => {
  const [before, after] = preparePositions({
    PuzzleId: 'sample', FEN: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    Moves: 'e2e4 e7e5', Rating: '1500', Themes: 'opening', GameUrl: 'https://lichess.org/example',
  });
  assert.equal(before.id, 'sample-before');
  assert.equal(before.phase, 'before');
  assert.equal(after.phase, 'after');
  assert.equal(after.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.deepEqual(after.solution, ['e7e5']);
  assert.equal(after.rawPuzzleId, 'sample');
});

test('centipawn and mate scores are converted from Black to White perspective', () => {
  const black = '8/8/8/8/8/8/8/8 b - - 0 1';
  assert.equal(parseEngineInfo('info depth 18 score cp 230 nodes 4 pv a7a6', black).cp, -230);
  assert.equal(parseEngineInfo('info depth 18 score mate 3 pv a7a6', black).mate, -3);
  assert.equal(parseEngineInfo('info depth 18 score mate -3 pv a7a6', black).mate, 3);
  assert.equal(parseEngineInfo('info depth 18 score cp 230 lowerbound pv a7a6', black), null);
});

test('selection excludes losing-side mates, theme disagreements, extreme scores, and duplicate source puzzles', () => {
  const make = (id, cp, mate = null, extra = {}) => ({
    id, rawPuzzleId: id, rating: 1900, phase: 'after', themes: ['mateIn2'],
    fen: '8/8/8/8/8/8/8/8 b - - 0 1', evaluation: { cp, mate }, ...extra,
  });
  const selected = selectPack([
    make('correct-mate', null, -2), make('losing-mate', null, 2), make('wrong-distance', null, -3),
    make('extreme', 900), make('close', 20), make('good', -230),
    make('good-before', 220, null, { rawPuzzleId: 'good', phase: 'before' }),
  ], 10);
  assert.deepEqual(selected.map(({ rawPuzzleId }) => rawPuzzleId), ['correct-mate', 'good']);
});
