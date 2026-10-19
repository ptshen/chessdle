# Position data

`src/data/puzzles.json` is a small, reproducible starter library derived from real
Lichess games. The CSV records are preserved in
`scripts/data/lichess-starter.csv`; their game histories are preserved in
`scripts/data/lichess-game-histories.json`. No evaluation numbers were invented.

The source is the 100-record sample in Marco Cognetta's
[Lichess Combined Puzzle-Game Database](https://github.com/mcognetta/lichess-combined-puzzle-game-db/blob/516cdb9944c5209ca94d5cc73b769b5d75215165/combined_puzzle_db_first_100.ndjson),
pinned to commit `516cdb9944c5209ca94d5cc73b769b5d75215165`. That sample contains
a September 2022 snapshot of the Lichess puzzle database and complete source-game
moves. Puzzle ratings are the ratings in that snapshot, not live ratings.
Only puzzle fields and game moves are retained here.

Lichess releases its database under
[CC0](https://database.lichess.org/#puzzles); the combined dataset retains that
license. Every position includes the original puzzle ID and a Lichess puzzle
link; earlier game positions also link to their precise game ply.

## Positions and difficulty

Lichess's CSV FEN is **before the opponent's setup move**. The importer validates
the full solution with chess.js, then applies the first UCI move exactly once to
produce a playable puzzle. These records have `phase: "after"`; only these are
eligible for best-move and mate rounds.

Evaluation rounds also include the unmodified CSV position (`-before` IDs) and
positions reconstructed from the source game one, three, five, or seven plies
earlier (`-plyN` IDs, `positionOrigin: "earlier-game"`, and `sourcePly`). Both have
`phase: "before"`. Reconstructing the full game must reproduce the CSV position
exactly before any earlier position is accepted. This provides positions where
the winning side is waiting; using tactical puzzle positions alone would reveal
the answer simply by showing whose turn it is.

Medium uses source puzzle ratings 1200–1799; hard uses ratings 1800 and above.
These are **difficulty proxies**: Lichess rates solving a tactical puzzle, not
estimating an evaluation, and earlier game positions inherit that proxy. A
production library should calibrate evaluation difficulty using actual player
results. Source puzzle themes describe the original puzzle, not necessarily an
earlier game position.

The importer keeps centipawn evaluations between 0.50 and 8.00 pawns in absolute
value and balances difficulty, winning color, and side to move. It selects only
one position per source puzzle. Mate puzzles must match a Lichess `mateInN` tag,
with N between 1 and 4; the game uses N of at least 2 for its last round.

## Evaluation convention

All bundled answers were calculated using the same vendored Stockfish 16
single-threaded WebAssembly engine used in the browser, with classical evaluation
(`Use NNUE=false`), depth 18, Hash 32 MB, and MultiPV 1. Mates are searched again
at depth 24 and retained only when their distance agrees at both depths. Each
search starts with `ucinewgame`. The engine version/build and source links are in
`vendor/stockfish/package.json` and the bundled engine notices.

`evaluation.cp` is in centipawns **from White's perspective**: `230` means +2.30,
and `-400` means -4.00. A mate evaluation has `cp: null`; `mate: 3` means White
can force mate in three moves, and `mate: -3` means Black can. UCI reports from
the side-to-move perspective, so the importer flips both kinds of scores for
Black-to-move positions. `bestMove` and `pv` use UCI coordinates, including a
promotion suffix where needed.

Finite-depth engine scores are estimates and can change at greater depth or with
a different engine/evaluator. The mate answer is the engine's shortest forced
mate at depths 18 and 24, corroborated by the Lichess theme; verification also checks
that its full principal variation legally ends in checkmate at the stated
distance. This is not a tablebase or an exhaustive proof over every legal reply.

## Regeneration and validation

After installing the project's dependencies:

```sh
node scripts/import-puzzles.mjs --cache /tmp/chessdle-evaluations.json
node --test scripts/lib/puzzle-data.test.mjs
node scripts/verify-data.mjs
```

The optional cache avoids repeating complete searches. Output is written
atomically only after there are enough eligible positions for all seven rounds.
To expand from a newer [official CSV](https://database.lichess.org/#puzzles),
download and decompress it separately, then run:

```sh
node scripts/import-puzzles.mjs --input /path/to/lichess_db_puzzle.csv --max-rows 1000 --limit 80
```

The importer streams the input and stops at `--max-rows`; it does not load the
full multi-million-row export into memory. `--games` accepts an optional JSON
array of `{ "rawPuzzleId": "…", "moves": "e4 e5 …" }` game histories to add
earlier positions from another export. Without those histories, a newly imported
library retains the tactical dataset's side-to-move bias. `--help` lists all
options. The checked-in data verifier is for the checked-in starter sources;
new exports need their matching source records retained for provenance checks.
