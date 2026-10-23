# Chessdle

Seven chess positions to test your evaluation and calculation. A responsive
React + TypeScript app with a shared daily challenge, unlimited practice, and
Stockfish running in a browser Web Worker.

## Run

Requires Node.js 22.12+ (Node 24 LTS recommended).

```sh
npm ci
npm run dev
```

Open the URL Vite prints (normally http://localhost:5173). Playing works without
a backend. Shared daily rankings require the Supabase setup below. Dependencies
are already installed in the current workspace.

```sh
npm run build     # TypeScript checks and production output in dist/
npm run preview   # Serve the production build locally
npm test          # App, board, scoring, engine, selection, and storage tests
npm run test:data # Importer tests
node scripts/verify-data.mjs
```

Host `dist/` on a static web server. Serve `.wasm` as `application/wasm`.
The single-threaded engine needs no cross-origin isolation headers. The engine
assets are prepared automatically before development and production builds.
For a subdirectory deployment, configure Vite's `base` before building.

### Vercel hosting

`vercel.json` configures the Vite build (`npm ci`, `npm run build`, `dist`) and
the Stockfish WASM content type. `.vercelignore` excludes local environment and
tooling files while retaining the vendored libraries needed by the build.

The intended production address is `https://chessdle.ptshen.com`. Link this
directory to the intended Vercel account's `chessdle` project, then set
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the project's Production
and Preview environment settings using the public values from `.env.local`.
These values are needed during the build; the ignored local environment file
is not uploaded.

Deploy with `vercel --prod`, then associate the subdomain with
`vercel domains add chessdle.ptshen.com chessdle`. Inspect the domain in Vercel
for its exact required DNS record. At the authoritative DNS provider for
`ptshen.com`, add the `chessdle` CNAME with the target Vercel supplies. The apex
and `www` records continue serving the existing website. If Vercel requests
ownership verification, add its supplied TXT record as well. Check the final
HTTPS site and complete a daily game to verify both the engine and shared
ranking. Apply any pending Supabase migrations before validating chart data.

See [Vercel's domain setup](https://vercel.com/docs/domains/working-with-domains/add-a-domain).

## The seven rounds

| Round | Challenge | Difficulty | Error points |
| --- | --- | --- | --- |
| 1 | Pick White or Black as the winning side | Medium | 0 correct; absolute evaluation in pawns if incorrect |
| 2 | Pick the winning side | Hard | Same |
| 3 | Give a numerical evaluation | Medium | Absolute difference between guess and reference evaluation |
| 4 | Give a numerical evaluation | Hard | Same |
| 5 | Make the best legal move | Hard | Evaluation lost versus best play, in pawns |
| 6 | Make the best legal move | Hard | Same |
| 7 | Guess the minimum forced mate distance | Mate in 2–4 | Absolute difference between guess and mate distance |

The **lowest total wins**, with a perfect score of 0. Numerical evaluations use
White's perspective and pawn units: +2.30 favors White; −4.00 favors Black.
An incorrect winner guess adds 2.30 points for a +2.30 position, or 4.00 points
for a −4.00 position. Correct winner guesses add no points.
Inputs accept −20 to +20 pawns. Mate distance counts only the mating side's
moves against best defense, and the game identifies that side.

Rounds 5 and 6 run two searches from the original position at the same depth: the
unrestricted best continuation and a search restricted to the selected move.
This measures the evaluation after committing to that move without giving one
search an extra ply. Loss is calculated from the moving side's perspective and
clamped to zero when the selected move equals or exceeds the baseline. The
engine's best move always scores 0. For these rounds only, mate scores use ±20
pawns and ordinary scores are capped at the same values.

Scoring rules
are in `src/lib/scoring.ts`, and the round sequence is in `src/lib/game.ts`.

## Daily challenges and progress

The device's local calendar date seeds the daily seven deterministically, so
everyone playing the same date and version gets the same positions. A new
challenge starts at local midnight, including on daylight-saving transition
days. Practice uses independent random seeds. No source puzzle repeats within
a challenge.

Answers, current round, completion, and historical scores are saved in browser
local storage. Daily and practice progress are separate. Saved data is validated
before use; invalid data starts a fresh game. Finishing a daily challenge keeps
its results available rather than resetting it. Results can be copied without
revealing the positions or their answers.

Completion is saved with the seventh answer, so reopening the site returns to
results even if the player closed the final feedback before pressing Results.
Other tabs synchronize saved progress and cannot overwrite a completed daily
with an older attempt. Daily boards stay fixed throughout the local day; an open
tab loads the next daily at local midnight or when it becomes active again.
The clock is also rechecked each minute to catch device time or timezone changes.
Earlier games remain in dated storage and Statistics; a new day does not erase
their scores. Existing UTC-dated results keep their original dates during this
change, so an already-played date will still open its results. Browser
progress belongs to the current site address, so use `chessdle.ptshen.com`
consistently rather than switching between deployment URLs.

Saved round answers are migrated to absolute-error scoring when resumed. If an
older game already answered round 5 as an evaluation question, its first four
answers remain and play resumes at the new best-move round 5. Its position is
retained when suitable; otherwise only that position is replaced. Older
aggregate-only history remains in local storage but is excluded from current-rule
statistics because its original answers are unavailable.

The board supports click/tap, touch and mouse dragging, keyboard navigation, legal-move hints, castling,
en passant, and choice of promotion piece. The board automatically puts the
initial side to move at the bottom and keeps that orientation after a submitted
move, including previews and reviews. A checked king and its attackers receive
light red highlights. Engine answers remain hidden until submission. Choosing
View position opens an interactive analysis board; finished games offer the same
analysis when reviewing any round. A best-move arrow and a signed evaluation
bar to the board's right update as players explore legal moves. Positive scores
favor White regardless of orientation. Undo steps back through the variation;
Reset restores the original puzzle. Move rounds start from the submitted move,
and Undo or Reset allows comparison with the original position. Exploration
never alters the saved answer or score. Each result also links to its source.

## Supabase daily rankings

The seventh daily answer submits the seven round penalties to Postgres using a
persistent anonymous Supabase Auth session. No sign-up screen is needed. The
results screen shows the percentage of other finishers the player scored better
than, and a smooth score distribution with
their saved score marked. “✓ Saved” appears only after Supabase confirms the
stored result. Practice scores stay on the device.
Rankings refresh every minute while the page is visible, on return to the tab,
and when connectivity returns. Upload failures keep local progress intact and
offer a retry, including while the player continues in practice. Successful
duplicate uploads return the original stored score. If another attempt has a
different total, the result identifies which first score its ranking uses.

### Connect a project

From a terminal with your logged-in Supabase CLI and network access:

```sh
supabase projects list
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --dry-run
supabase db push
supabase config push
```

The initial migration is [supabase/migrations/202610180001_daily_scores.sql](supabase/migrations/202610180001_daily_scores.sql).
The chart adds [supabase/migrations/202610180002_score_distribution.sql](supabase/migrations/202610180002_score_distribution.sql).
Local-midnight support adds [supabase/migrations/202610180003_local_challenge_day.sql](supabase/migrations/202610180003_local_challenge_day.sql).
For an already connected project, run `supabase db push` before deploying the
updated browser app. The old database accepts only the UTC date and would reject
legitimate local-day submissions. Existing results and rankings are preserved.
The minimal [supabase/config.toml](supabase/config.toml) enables anonymous sign-ins;
you can also enable them under Authentication in the Supabase dashboard. Inspect
the config diff before applying it to an existing shared project.

Copy `.env.example` to `.env.local`, then set the project's URL and **publishable**
key from its Connect dialog/API settings. `VITE_SUPABASE_ANON_KEY` is also supported
for older public anon keys. Never put a secret/service-role key in a `VITE_`
variable. These public values must also be set in your hosting build environment.
Restart Vite or rebuild the site after changing them. Without configuration, the
game keeps working and hides the ranking panel.

The implementation uses Supabase's documented Auth and PostgREST endpoints with
`fetch`, including persistent session refresh and browser locks for concurrent
tabs. It needs no additional package or separately deployed application server.
See [anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous),
[API keys](https://supabase.com/docs/guides/getting-started/api-keys), and
[database functions](https://supabase.com/docs/guides/database/functions).

### Ranking rules and storage

- The first result per anonymous player, challenge date, and scoring version is final.
  The database derives identity from the authenticated session, validates seven
  bounded penalties, and computes the total. The browser stops new submissions
  at local midnight. The database allows a date while that calendar day is
  current anywhere from UTC+14 through UTC−12, so legitimate players ahead of
  or behind UTC can finish. This bounded window cannot verify a device's clock
  or timezone. Previously submitted scores remain readable for their original
  day; no rows are deleted or relabeled at midnight.
- Comparisons use the same date, scoring version, and ordered seven puzzles.
  “Today's scores” means that challenge date, not a rolling 24-hour window;
  yesterday's scores do not enter today's percentile or distribution.
  Migrated earlier games with different puzzles remain playable locally and are
  excluded from the current daily rankings.
- Totals round to two decimals, matching the displayed score. Lower scores rank
  higher. Equal scores share a competition rank (for example, 1, 2, 2, 4).
  Percentile is `100 × strictly worse other scores / number of other players`.
  Ties are not counted as beaten; a sole player sees a first-finisher message.
- The curve smooths aggregate half-point score buckets with a bounded Gaussian
  density estimate. The marked score and percentile use exact stored values;
  smoothing never changes the rank. Rank and chart data come from the same
  database snapshot. With fewer than five players, or when all recorded scores
  are identical, the chart shows a “Normal estimate” fitted to the available
  scores. It uses a minimum standard deviation of one point and clips the curve
  to the valid 0–179 score range. The normal curve is only a visual estimate;
  percentiles still come from actual results. With at least five varied scores,
  the chart automatically uses the smoothed observed distribution.
  An older backend can still save and
  rank scores, but shows “Score chart unavailable” until the migration is applied.
- The `daily_scores` table stores player ID, date, scoring version, puzzle IDs,
  round penalties, total, and submission time. Row-level security is enabled;
  browser roles cannot read or write rows directly. Authenticated RPCs return
  only the caller's result, aggregate ranks, and histogram counts, never other
  players' identities.
- Anonymous identity is tied to browser storage. Clearing storage or using a
  different browser/device creates another player. The server validates inputs
  but trusts browser-computed penalties; authoritative anti-cheat scoring and
  deduplication across devices are not implemented.

### Database verification

After connecting the project, check the deployed setup from your normal terminal:

```sh
npm run check:supabase
```

This checks the public configuration, anonymous sign-in setting, and deployed
ranking schema/access controls without creating players or submitting scores.
It requires network access and your logged-in Supabase CLI.

Use a development/test Supabase project after applying the migration:

```sh
npm run check:supabase -- --test-database
```

The transactional SQL suite checks permissions, ownership, immutable retries,
local-day submission windows, ties, percentile calculations, histogram counts and boundaries,
precision, and cohort isolation,
then rolls back all fixtures. It can also run using `psql` with `ON_ERROR_STOP=1`.
Run `npm run test:supabase` to test the check command itself offline.

## Mobile interface

The main screen is a single column: mode, score, round progress, question, board,
and answer controls. It has no introductory paragraphs or repeated instructions.
The board fills the available phone width, and primary controls have touch targets
of at least 44px. Evaluation entry uses a decimal keyboard plus a ± button, so
negative guesses do not depend on a phone keyboard offering a minus key. Help,
scoring details, and engine analysis are available on demand.

After each submission, an animated score card appears over a tinted board. It
shows the round's added points and correct answer, including the signed evaluation
in winner rounds. Players can continue or choose View position to dismiss the
overlay and analyze the board. The analysis view keeps the original perspective,
supports drag/tap and promotion, and shows the engine's best move with a Play
button. Its evaluation rail stays on the right on mobile. Reduced-motion
preferences disable the animations.

## Data and engine

The library contains **2,003 positions**, including **1,939 verified additions**
from Lichess puzzle extracts, source games, and validated solution continuations. The combined eligible
pools are:

| Rounds | Position pool | Original | Expanded total |
| --- | --- | ---: | ---: |
| 1 and 3 | Medium winning-side / numerical evaluation | 28 | 500 |
| 2 and 4 | Hard winning-side / numerical evaluation | 28 | 1,000 |
| 5 and 6 | Hard best move (a subset of the hard pool) | 12 | 500 |
| 7 | Mate in 2–4 | 5 | 500 |

Three original mate-in-one positions remain stored for compatibility but are
ineligible for play. Numerical positions are balanced equally by winning color
and whether the winning side is moving or waiting. Half of each difficulty pool
favors the side waiting to move. Answers use Stockfish depth 18; mate distances also agree at depth 24,
with legally verified checkmating lines.

The original pack remains unchanged. The expansion applies to daily dates from
**October 23, 2026**, preserving earlier daily layouts and ranking groups. New
practice games use it immediately. Existing saves keep their recorded positions.
Selection remains equally weighted within each eligible round pool, with no
source puzzle repeated within one game. Repeats across days remain possible.

Lichess's first setup move is applied before puzzle positions are shown.
Earlier game positions and positions after the first solver move of a verified
Lichess solution are included only for evaluation rounds. These continuations
receive their own engine evaluation and do not add duplicate source puzzles.
Difficulty uses the
historical source puzzle rating as a proxy and needs future calibration from
player performance. This curated library is reused across days and
practice; it is not the entire Lichess dataset. See [DATA.md](DATA.md) for source
links, provenance, verification details, limitations, and the CSV importer.

Stockfish 16's official single-threaded WASM is vendored in `vendor/stockfish`.
It runs classical evaluation (`Use NNUE=false`) so the app needs no neural
network download. Saved reference answers and browser move analysis use the
same build/settings. Engine jobs are serialized, reset between searches, and
have timeouts and retryable errors. Errors never manufacture a move score.

chess.js 1.0.0 is vendored in `vendor/chess.js`. Both libraries were retrieved
from their official source repositories because this development environment
could not reach the npm registry. Other dependencies use regular pinned npm
packages, with a portable lockfile.

## Project map

- `src/App.tsx`: complete game flow, input, feedback, results, and statistics.
- `src/components/ChessBoard.tsx`: accessible board and legal move interaction.
- `src/lib/game.ts`: daily selection, round definitions, persistence.
- `src/lib/engine.ts`: browser Worker/UCI adapter and queued engine analysis.
- `src/lib/scoring.ts`: pawn units, side normalization, absolute-error rules.
- `src/lib/ranking.ts`: Supabase anonymous sessions and daily score RPCs.
- `src/components/DailyRanking.tsx`: score synchronization and compact percentile display.
- `src/components/ScoreDistribution.tsx`: responsive score curve and saved-score marker.
- `src/lib/distribution.ts`: histogram smoothing and chart scale.
- `supabase/migrations/`: database schema, access control, and ranking functions.
- `scripts/import-puzzles.mjs`: validated Lichess CSV ingestion and evaluation.
- `scripts/verify-data.mjs`: provenance, legality, selection, and mate checks.

## Verification environment

The production build, DOM interaction tests, engine tests, and data checks run
without a network connection. The engine integration tests run the real WASM,
including the browser worker entrypoint in a VM. App tests use a deterministic
engine mock while independently verifying the real engine adapter.
Unit and UI tests ignore real `.env` files and use explicit mocked ranking
endpoints, so running them cannot register players or submit scores to a live
Supabase project. The App integration test covers automatic submission of the
seventh answer and ranking restoration using the same player after reload.

This workspace's sandbox blocks local network listeners and Chromium process
launch, so a live visual browser check could not be performed here. DOM tests
exercise the complete seven-round journey; they do not verify pixel rendering.

## Third-party notices

Lichess data is CC0. chess.js uses the BSD-2-Clause license (the notice is in its
vendored source). Stockfish is GPLv3; its license and exact upstream source/build
links are included in `vendor/stockfish/` and copied into `public/engine/` and
production builds. See those notices when redistributing the engine.
