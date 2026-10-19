-- Extend the existing caller-only rank response with an anonymous histogram.
-- Half-point buckets are for an approximate chart only; rank and percentile
-- continue to use the exact stored score. All aggregates share one snapshot.
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
  v_today date := (pg_catalog.statement_timestamp() at time zone 'UTC')::date;
  v_saved public.daily_scores%rowtype;
  v_result jsonb;
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

-- CREATE OR REPLACE preserves the original ACL; restate the intended access
-- explicitly so only authenticated players can call this aggregate endpoint.
revoke all on function public.get_daily_rank(date, integer, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_daily_rank(date, integer, text[]) to authenticated;

comment on function public.get_daily_rank(date, integer, text[]) is 'Caller-only score and anonymous aggregates for the same date, scoring version, and ordered puzzle challenge. Lower scores rank first; ties share rank. Percentile strictly counts other players beaten, null when alone. Half-point histogram buckets approximate the chart only; ranking uses exact scores.';
