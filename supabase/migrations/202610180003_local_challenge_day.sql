-- Daily puzzles now change at midnight on each player's device. The date label
-- still identifies one shared challenge/cohort worldwide, not a rolling 24-hour
-- period. Keep all existing rows and first-result uniqueness exactly as stored.
--
-- A device's local calendar day is untrusted, just like its submitted penalties.
-- Allow only dates currently active somewhere from UTC+14 through UTC-12. This
-- bounded window accommodates every device timezone without trusting a supplied
-- offset or changing the existing RPC signatures. A modified client can choose
-- any date inside that window; this is not authoritative timezone/anti-cheat
-- validation. Archived results remain readable, and retries retain the first
-- score even after its submission window closes.
create function public.daily_challenge_window(p_day date)
returns tstzrange
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.tstzrange(
    (p_day::timestamp - interval '14 hours') at time zone 'UTC',
    ((p_day + 1)::timestamp + interval '12 hours') at time zone 'UTC',
    '[)'
  );
$$;

-- Only the SECURITY DEFINER RPCs and database owner may call this helper.
revoke all on function public.daily_challenge_window(date) from public, anon, authenticated, service_role;
comment on function public.daily_challenge_window(date) is 'Internal UTC window for a device-local challenge date: inclusive midnight at UTC+14 through exclusive next midnight at UTC-12. Independent of the database session timezone.';

create or replace function public.get_daily_rank(
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
  v_saved public.daily_scores%rowtype;
  v_result jsonb;
begin
  if v_player_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_day is null or not pg_catalog.isfinite(p_day) then
    raise exception 'A finite challenge date is required' using errcode = '22023';
  end if;
  if pg_catalog.statement_timestamp() < pg_catalog.lower(public.daily_challenge_window(p_day)) then
    raise exception 'Challenge day has not started in any supported timezone' using errcode = '22023';
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

  -- Materialize only the matching challenge once. Rank, ties, percentile, and
  -- chart counts therefore agree even while other players finish their games.
  with cohort as materialized (
    select score
    from public.daily_scores
    where day = p_day and scoring_version = p_scoring_version and puzzle_ids = p_puzzle_ids
  ), stats as (
    select
      pg_catalog.count(*) as total,
      pg_catalog.count(*) filter (where score < v_saved.score) as lower,
      pg_catalog.count(*) filter (where score > v_saved.score) as higher,
      pg_catalog.count(*) filter (where score = v_saved.score) as tied,
      pg_catalog.min(score) as minimum,
      pg_catalog.max(score) as maximum
    from cohort
  ), histogram as (
    select pg_catalog.floor(score * 2) / 2 as start, pg_catalog.count(*) as players
    from cohort
    group by 1
  )
  select pg_catalog.jsonb_build_object(
    'day', p_day,
    'scoring_version', p_scoring_version,
    'score', v_saved.score,
    'rank', stats.lower + 1,
    'total_players', stats.total,
    'better_than_percentile', case when stats.total > 1 then 100.0 * stats.higher / (stats.total - 1) else null end,
    'tied_players', stats.tied,
    'distribution', pg_catalog.jsonb_build_object(
      'bin_width', 0.5,
      'min_score', stats.minimum,
      'max_score', stats.maximum,
      'bins', (
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('start', start, 'count', players) order by start
        ), '[]'::jsonb)
        from histogram
      )
    )
  ) into v_result
  from stats;

  return v_result;
end;
$$;

create or replace function public.submit_daily_score(
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
  if not (pg_catalog.statement_timestamp() <@ public.daily_challenge_window(p_day)) then
    raise exception 'New scores require a challenge day current in a supported timezone' using errcode = '22023';
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

-- Restate caller permissions; no direct table access or new public RPC access.
revoke all on function public.get_daily_rank(date, integer, text[]) from public, anon, authenticated, service_role;
revoke all on function public.submit_daily_score(date, integer, text[], numeric[]) from public, anon, authenticated, service_role;
grant execute on function public.get_daily_rank(date, integer, text[]) to authenticated;
grant execute on function public.submit_daily_score(date, integer, text[], numeric[]) to authenticated;

comment on table public.daily_scores is 'Immutable first daily result per authenticated player and challenge date; new dates follow device-local calendars. Existing dates remain unchanged. Client-reported penalties, no public row access.';
comment on function public.get_daily_rank(date, integer, text[]) is 'Caller-only score and anonymous aggregates for the same challenge date, scoring version, and ordered puzzle challenge, including archived dates. Lower scores rank first; ties share rank. Percentile strictly counts other players beaten, null when alone. Half-point histogram buckets approximate the chart only; ranking uses exact scores.';
comment on function public.submit_daily_score(date, integer, text[], numeric[]) is 'Save the first result for a challenge date current in any timezone UTC+14 through UTC-12; retries return the immutable original, including archived dates. The client date and penalties are untrusted.';
