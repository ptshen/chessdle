-- Browser clients submit seven round penalties; the database owns identity,
-- the UTC challenge date, the total, immutability, and ranking. Penalties are
-- still client-reported: this is not authoritative chess/anti-cheat validation.
create table public.daily_scores (
  player_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  scoring_version integer not null check (scoring_version > 0),
  puzzle_ids text[] not null check (
    pg_catalog.cardinality(puzzle_ids) = 7
    and pg_catalog.array_ndims(puzzle_ids) = 1
    and pg_catalog.array_lower(puzzle_ids, 1) = 1
    and pg_catalog.array_position(puzzle_ids, null) is null
  ),
  round_penalties numeric[] not null check (
    pg_catalog.cardinality(round_penalties) = 7
    and pg_catalog.array_ndims(round_penalties) = 1
    and pg_catalog.array_lower(round_penalties, 1) = 1
    and pg_catalog.array_position(round_penalties, null) is null
  ),
  score numeric(10, 2) not null check (score >= 0 and score <= 179),
  submitted_at timestamptz not null default pg_catalog.now(),
  primary key (player_id, day, scoring_version)
);

create index daily_scores_ranking_idx
  on public.daily_scores (day, scoring_version, puzzle_ids, score);

alter table public.daily_scores enable row level security;
-- No client policies or direct table access. Only the narrow RPCs below may
-- read/write rows; neither returns player identities or another player's score.
revoke all on table public.daily_scores from public, anon, authenticated;

create function public.get_daily_rank(
  p_day date,
  p_scoring_version integer,
  p_puzzle_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_player_id uuid := auth.uid();
  v_today date := (pg_catalog.statement_timestamp() at time zone 'UTC')::date;
  v_saved public.daily_scores%rowtype;
  v_total bigint;
  v_lower bigint;
  v_higher bigint;
  v_tied bigint;
begin
  if v_player_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_day is null or p_day > v_today then
    raise exception 'Challenge day must be today or earlier (UTC)' using errcode = '22023';
  end if;
  if p_scoring_version is distinct from 3 then
    raise exception 'Unsupported scoring version' using errcode = '22023';
  end if;
  if p_puzzle_ids is null
    or pg_catalog.cardinality(p_puzzle_ids) <> 7
    or pg_catalog.array_ndims(p_puzzle_ids) <> 1
    or pg_catalog.array_lower(p_puzzle_ids, 1) <> 1 then
    raise exception 'Exactly seven puzzle IDs are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_puzzle_ids) as p(id)
    where id is null or pg_catalog.btrim(id) = '' or pg_catalog.length(id) > 80
  ) or (select pg_catalog.count(distinct id) from pg_catalog.unnest(p_puzzle_ids) as p(id)) <> 7 then
    raise exception 'Puzzle IDs must be unique, nonempty, and at most 80 characters' using errcode = '22023';
  end if;

  select * into v_saved
  from public.daily_scores
  where player_id = v_player_id and day = p_day and scoring_version = p_scoring_version;
  if not found then
    return null;
  end if;
  if v_saved.puzzle_ids <> p_puzzle_ids then
    raise exception 'A score is already saved for a different challenge' using errcode = '22023';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where score < v_saved.score),
    pg_catalog.count(*) filter (where score > v_saved.score),
    pg_catalog.count(*) filter (where score = v_saved.score)
  into v_total, v_lower, v_higher, v_tied
  from public.daily_scores
  where day = p_day and scoring_version = p_scoring_version and puzzle_ids = p_puzzle_ids;

  return pg_catalog.jsonb_build_object(
    'day', p_day,
    'scoring_version', p_scoring_version,
    'score', v_saved.score,
    'rank', v_lower + 1,
    'total_players', v_total,
    'better_than_percentile', case when v_total > 1 then 100.0 * v_higher / (v_total - 1) else null end,
    'tied_players', v_tied
  );
end;
$$;

create function public.submit_daily_score(
  p_day date,
  p_scoring_version integer,
  p_puzzle_ids text[],
  p_round_penalties numeric[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_player_id uuid := auth.uid();
  v_today date := (pg_catalog.statement_timestamp() at time zone 'UTC')::date;
  v_maxima constant numeric[] := array[10, 10, 30, 30, 40, 40, 19]::numeric[];
  v_existing jsonb;
  v_penalties numeric[];
  v_score numeric;
begin
  if v_player_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_round_penalties is null
    or pg_catalog.cardinality(p_round_penalties) <> 7
    or pg_catalog.array_ndims(p_round_penalties) <> 1
    or pg_catalog.array_lower(p_round_penalties, 1) <> 1 then
    raise exception 'Exactly seven round penalties are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(p_round_penalties) with ordinality as p(penalty, round_index)
    where penalty is null
      or penalty::text in ('NaN', 'Infinity', '-Infinity')
      or penalty < 0
      or penalty > v_maxima[round_index::integer]
  ) then
    raise exception 'Round penalties must be finite, nonnegative, and within round limits' using errcode = '22023';
  end if;

  -- Also validates the date, scoring version, challenge, and any earlier row.
  -- Retrying a completed request returns its immutable original result.
  v_existing := public.get_daily_rank(p_day, p_scoring_version, p_puzzle_ids);
  if v_existing is not null then
    return v_existing;
  end if;
  if p_day <> v_today then
    raise exception 'New scores can only be submitted for today (UTC)' using errcode = '22023';
  end if;

  select pg_catalog.array_agg(pg_catalog.round(penalty, 4) order by round_index),
    pg_catalog.round(pg_catalog.sum(pg_catalog.round(penalty, 4)), 2)
  into v_penalties, v_score
  from pg_catalog.unnest(p_round_penalties) with ordinality as p(penalty, round_index);

  insert into public.daily_scores (player_id, day, scoring_version, puzzle_ids, round_penalties, score)
  values (v_player_id, p_day, p_scoring_version, p_puzzle_ids, v_penalties, v_score)
  on conflict (player_id, day, scoring_version) do nothing;

  -- A concurrent submission may have won. Re-read the stored score and reject
  -- a mismatched cohort instead of returning a rank for a different challenge.
  return public.get_daily_rank(p_day, p_scoring_version, p_puzzle_ids);
end;
$$;

revoke all on function public.get_daily_rank(date, integer, text[]) from public, anon, authenticated, service_role;
revoke all on function public.submit_daily_score(date, integer, text[], numeric[]) from public, anon, authenticated, service_role;
grant execute on function public.get_daily_rank(date, integer, text[]) to authenticated;
grant execute on function public.submit_daily_score(date, integer, text[], numeric[]) to authenticated;

comment on table public.daily_scores is 'Immutable first daily result per authenticated player and UTC date; client-reported penalties, no public row access.';
comment on function public.get_daily_rank(date, integer, text[]) is 'Caller-only score and anonymous aggregate rank within the same date, scoring version, and ordered seven-puzzle challenge. Lower scores rank first; ties share rank. Percentile is the percentage of other players strictly beaten, null when alone.';
