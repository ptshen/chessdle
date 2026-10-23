# Position data

Chessdle bundles verified positions from Lichess source games and their puzzle
solution branches. The original
64-position library remains unchanged in `src/data/puzzles.json`; new positions
are stored separately in `src/data/puzzles-expanded.json`. Source records and
available game histories are retained so every board, solution, rating, and
engine answer can be checked. No evaluation numbers were invented.

The expansion adds **1,939 positions**: 472 medium numerical positions, 972 hard
numerical positions (488 also eligible for best-move rounds), and 495 mate
positions. Combined with the originals, rounds 1/3 have 500 eligible positions,
rounds 2/4 have 1,000, rounds 5/6 have 500, and round 7 has 500. The best-move pool
is a subset of the hard numerical pool. There are 2,003 stored positions; three
legacy mate-in-one records are retained but not selected.

The expansion was selected from 12,395 distinct positions analyzed locally,
including 1,015 mates verified at both depths. The first 800 additions remain
unchanged; another 1,139 were appended to meet the minimum pool sizes. The
combined numerical pools split evenly across winning color and turn: medium
has 125 positions in each of the four combinations, and hard has 250 in each.
The playable mate pool contains 198 mate-in-2, 198 mate-in-3, and 104 mate-in-4
positions. There are 264 evaluation-only solution continuations. Across both
packs, source puzzle IDs, source games, and board positions are unique.

## Sources and license

Lichess releases its database under [CC0 1.0](https://database.lichess.org/#puzzles).
These public extracts retain that license. Each bundled position includes its
original puzzle ID and Lichess puzzle link; earlier game positions also link to
the precise source-game ply. Ratings describe the source snapshot, not live
Lichess ratings.

The original library comes from the 100-record sample in Marco Cognetta's
[Lichess Combined Puzzle-Game Database](https://github.com/mcognetta/lichess-combined-puzzle-game-db/blob/516cdb9944c5209ca94d5cc73b769b5d75215165/combined_puzzle_db_first_100.ndjson),
pinned to commit `516cdb9944c5209ca94d5cc73b769b5d75215165`. It contains a
September 2022 puzzle snapshot with complete source-game moves. Its puzzle
fields and histories are retained in `scripts/data/lichess-starter.csv` and
`scripts/data/lichess-game-histories.json`.

The first expansion sources are three additional unmodified CSV files:

| Retained file in `scripts/data/` | Source | Records |
| --- | --- | ---: |
| `puzzle_train.csv` | [Imec training split](https://github.com/imec-ailabs/Automatic-Prompt-Optimization-with-Chess/blob/58d2617d24217f595b5bf2d37ca6328e2e6ca370/data/puzzle_train.csv) | 559 |
| `puzzle_test.csv` | [Imec test split](https://github.com/imec-ailabs/Automatic-Prompt-Optimization-with-Chess/blob/58d2617d24217f595b5bf2d37ca6328e2e6ca370/data/puzzle_test.csv) | 559 |
| `lichess-1000.csv` | [ThakeeNathees's Lichess extract](https://github.com/ThakeeNathees/chess-puzzles/blob/7626064a428e18c172a02575fe8e225e6df4594a/res/lichess_db.csv) | 1,000 |

The Imec files are pinned to commit
`58d2617d24217f595b5bf2d37ca6328e2e6ca370`; their
[README](https://github.com/imec-ailabs/Automatic-Prompt-Optimization-with-Chess/blob/58d2617d24217f595b5bf2d37ca6328e2e6ca370/README.md)
explicitly identifies the puzzle data as CC0 1.0. They include game SAN and
stratify puzzles by rating, solution length, and mate/nonmate status. The
1,000-record extract is pinned to commit
`7626064a428e18c172a02575fe8e225e6df4594a`; its
[README](https://github.com/ThakeeNathees/chess-puzzles/blob/7626064a428e18c172a02575fe8e225e6df4594a/README.md)
identifies the Lichess database as its source. It has no CSV header or game SAN.

`scripts/normalize-expanded-puzzles.mjs` combines those files into
`scripts/data/lichess-expanded.csv`, preserving the standard Lichess columns and
preferring the Imec record if an ID appears twice. The current input has **2,118
unique source IDs**, with no duplicate IDs between these three files. All 2,118
supplied solution sequences pass legal-move validation.

The normalizer also writes
`scripts/data/lichess-expanded-game-histories.json`. Its **1,118 histories** are
parsed through chess.js and verified to end at the exact canonical CSV FEN.
They provide 4,408 earlier-position candidates. These are source/candidate
counts, not counts of shipped playable positions: rating limits, engine results,
deduplication, and pack quotas reduce the final library.

A larger source is retained as `scripts/data/lichess-large.csv`, containing
**9,962 unique records** with complete, legally validated solutions. It comes
from the [Lichess archive mirrored in khemssharma/Chess](https://github.com/khemssharma/Chess/blob/fb5075bb360ae26606e77fc703001472d6657d1e/prisma/lichess_db_puzzle.csv.zst),
pinned to commit `fb5075bb360ae26606e77fc703001472d6657d1e` and Git blob
`c801dc2abb9ef733c290afd12b3df87cbb0e2889`. The underlying puzzle records remain
Lichess CC0 data. This snapshot can overlap older extracts; pack selection
deduplicates source puzzles, games, and boards across all retained packs.

The upstream 550,319-byte archive is itself a partial zstd download. Its complete
decompressed CSV prefix is recoverable; exactly one unfinished trailing record
is discarded. `scripts/normalize-large-puzzles.mjs` first checks the archive's
Git blob SHA against the pinned source, then validates every retained record and
its entire solution. It does not infer or repair missing puzzle data. The
archive SHA-256, normalized CSV SHA-256, source URL, and extraction details are
recorded in `scripts/data/lichess-large-provenance.json`. No source-game histories
are supplied, so `scripts/data/lichess-large-game-histories.json` is an empty
array. The existing extracts continue to provide the earlier-game candidates.

Among this larger source's records rated at least 1200 are 2,494 medium and
2,684 hard nonmate puzzles, plus 516 mate-in-2, 209 mate-in-3, and 37 mate-in-4
puzzles. These are candidates before engine evaluation and exclusions, not
additional playable-position counts.

## Positions and difficulty

Lichess's CSV FEN is **before the opponent's setup move**. The importer validates
the full solution with chess.js, then applies the first UCI move exactly once to
produce the puzzle presented on Lichess. These records have `phase: "after"`;
only these are eligible for best-move and mate rounds.

Winning-side and numerical-evaluation rounds can also use the unmodified CSV
position (`-before` IDs) and positions reconstructed from the source game one,
three, five, or seven plies earlier (`-plyN` IDs, `positionOrigin: "earlier-game"`,
and `sourcePly`). Both have `phase: "before"`. Reconstructing the game must
reproduce the CSV position exactly before any earlier position is accepted.
This supplies boards where the winning side is waiting, so whose turn it is
does not reveal the answer.

Evaluation rounds can additionally use `phase: "continuation"` positions. These
replay the setup move followed by the solver's first move from the fully
validated Lichess solution. Their IDs are `<rawPuzzleId>-continuation`, with
`positionOrigin: "puzzle-continuation"` and `sourceSolutionPly: 1`. The resulting
board receives its own depth-18 engine evaluation. Continuations with a mate
score are excluded, and these positions are never eligible for best-move or
mate rounds.

A solution branch need not have been played in the original game. For a
continuation, `gameUrl` identifies the source game only; `sourceUrl`, the Lichess
puzzle link, is the authoritative source of the continuation. A continuation
competes with all other positions from that same source for a single library
slot. Generating more candidate phases does not allow the source to be counted
or selected multiple times.

Medium uses source puzzle ratings 1200–1799; hard uses ratings 1800 and above.
These are difficulty proxies: Lichess rates solving the tactical puzzle, not
estimating an evaluation, and earlier positions and continuations inherit the
source rating. Source themes likewise describe the original puzzle, not
necessarily an earlier position or continuation. Player results can be used to
calibrate difficulty later.

The importer keeps numerical evaluations between 0.50 and 8.00 pawns in absolute
value. It balances difficulty, winning color, and side to move while reserving
hard post-setup positions for the two best-move rounds. It selects only one
position per source puzzle, source game, and board, including exclusions from
previously published packs. New mate positions must agree with a Lichess
`mateIn2`, `mateIn3`, or `mateIn4` tag. The original pack's three mate-in-one
records remain preserved for compatibility but are ineligible for round seven.

## Daily selection and pack activation

`src/data/puzzle-packs.json` activates the expansion for daily puzzle dates on or
after **2026-10-23**, using the device's local calendar date. Earlier daily dates
continue selecting from the original library. Keeping that boundary and the
original pack unchanged preserves published puzzle sets and their corresponding
score cohorts. New practice games use the combined library immediately. Saved
games keep their recorded puzzle IDs, which remain available in the combined
lookup.

Within a round, the selector makes an equally weighted pseudorandom draw from
all eligible positions remaining after the day's earlier selections. A seed
based on the daily date makes the seven positions reproducible for that date.
A source puzzle cannot repeat within one game. There is no cross-day cooldown:
uniform draws may repeat across days; a larger eligible library reduces that
frequency. The balanced import process chooses the library's composition, while
the daily selector assigns equal weight to each eligible position in that library.

## Evaluation convention

Bundled answers use the vendored Stockfish 16 single-threaded WebAssembly engine
also used in the browser, with classical evaluation (`Use NNUE=false`), depth
18, Hash 32 MB, and MultiPV 1. Each search starts with `ucinewgame`. Mates are
searched again at depth 24 and retained only when both searches agree. The
engine build and source links are in `vendor/stockfish/package.json` and the
bundled engine notices.

`evaluation.cp` is in centipawns from White's perspective: `230` means +2.30,
and `-400` means -4.00. A mate evaluation has `cp: null`; `mate: 3` means White
can force mate in three moves, and `mate: -3` means Black can. UCI reports from
the side-to-move perspective, so the importer flips both kinds of scores for
Black-to-move positions. `bestMove` and `pv` use UCI coordinates, including a
promotion suffix where needed.

The importer requires at least depth 18. When a higher initial depth is
requested, mates receive another search at `max(initial depth + 4, 24)`.
`mateVerification` records both depths and the agreed distance. Validation also
requires a complete, legal principal variation ending in checkmate after
exactly `2 * N - 1` plies. Finite-depth evaluations can change at greater depth;
this checks the engine's shortest forced mate against the source theme and a
deeper search, rather than providing an exhaustive proof over every legal reply.

## Regeneration and validation

After installing the project's dependencies, regenerate normalized expansion
sources and run the source-data checks with:

```sh
node scripts/normalize-expanded-puzzles.mjs
node --test scripts/lib/puzzle-data.test.mjs
node scripts/verify-data.mjs
```

Regenerating the larger normalized CSV also requires the `zstd` executable and
the exact pinned archive linked above, downloaded outside the repository:

```sh
node scripts/normalize-large-puzzles.mjs \
  --archive /path/to/lichess_db_puzzle.csv.zst
```

That script verifies the archive hash, recovers and validates the complete
records, and rewrites the normalized CSV, empty histories file, and provenance
manifest. The retained CSV is already usable without downloading or decompressing
the archive again.

The verifier checks both bundled packs against all three source CSVs
(`lichess-starter.csv`, `lichess-expanded.csv`, and `lichess-large.csv`) and all
available histories. It checks exact provenance, unique source puzzles/games/
boards, legal engine moves and variations, minimum search depth, and complete
mating lines with matching verification metadata. `--data`, `--source`, and
`--games` can each be repeated to validate other packs and their source files.

To build a separate candidate pack from the retained expansion sources, for
example with a target of 300 positions:

```sh
node scripts/import-puzzles.mjs \
  --input scripts/data/lichess-expanded.csv \
  --games scripts/data/lichess-expanded-game-histories.json \
  --exclude src/data/puzzles.json \
  --output /tmp/chessdle-next-pack.json \
  --max-rows 2118 --limit 300 --mate-limit 60 --medium-limit 120 --best-move-limit 90 \
  --depth 18 --cache /tmp/chessdle-expanded-evaluations.json
```

The quota values in that example are adjustable targets, not a statement of the
checked-in pack's size. `--mate-limit` sets the mate quota, `--medium-limit` sets
the medium numerical quota, and the remaining slots are hard numerical positions.
`--best-move-limit` reserves hard post-setup numerical positions before other
positions from those sources are chosen. `--exclude` can be repeated to preserve
all previously published packs; answer and turn balance includes those retained
positions. Output is written atomically only when there are enough eligible
positions for all seven rounds.

The importer streams its input and stops at `--max-rows`; it need not load the
full multi-million-row official export. The default phases remain
`after,before,earlier`. Request `--phases continuation` to evaluate only the
verified solution continuations, or add `continuation` to a comma-separated list
of phases. For example, `--phases after,before,continuation` evaluates all three
candidate forms that can be reconstructed directly from a puzzle record.
`--games` accepts a JSON array of
`{ "rawPuzzleId": "…", "moves": "e4 e5 …" }` histories; histories are required
only for `earlier` candidates. Every phase receives a fresh engine evaluation
unless a matching position with a sufficient search depth already exists in the
cache.

`--cache` checkpoints each completed engine search atomically and reuses matching
positions at a sufficient depth. Cache entries outside a resumed run's current
row or phase limits are retained. `--cache-only`, together with `--cache`,
evaluates and checkpoints candidates without trying to produce a complete pack.
This supports evaluating a source or a category separately before final selection.
For example:

```sh
node scripts/import-puzzles.mjs \
  --input scripts/data/lichess-large.csv --max-rows 9962 \
  --phases after,before --depth 18 \
  --exclude src/data/puzzles.json --exclude src/data/puzzles-expanded.json \
  --cache /tmp/chessdle-large-evaluations.json --cache-only
```

`--select-only`, together with `--cache`,
rebuilds a pack from completed cached evaluations without running Stockfish;
pass the same exclusions and desired quotas. `--cache-only` and `--select-only`
cannot be combined. Do not share one writable cache between concurrent importer
processes. `--help` lists all options.

For a future refresh, download and decompress the
[official Lichess CSV](https://database.lichess.org/#puzzles), retain the exact
source snapshot, and provide it with `--input`. Retain matching game histories
when available and verify the resulting pack before adding it under a new
activation date. Do not overwrite a published pack or move its activation date.
