-- Run against a disposable local/test Supabase database after all migrations:
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/daily_scores.sql
-- Or, with Supabase CLI 2.121+ authenticated and linked to a TEST project:
-- DO_NOT_TRACK=1 supabase db query --linked --file supabase/tests/daily_scores.sql
-- All fixtures and helper functions roll back. Requires the postgres role.
begin;

create function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then
    raise exception 'Assertion failed: %', message;
  end if;
end;
$$;

create function pg_temp.expect_error(command text, expected_state text)
returns void language plpgsql as $$
declare
  actual_state text;
begin
  begin
    execute command;
  exception when others then
    get stacked diagnostics actual_state = returned_sqlstate;
    if actual_state = expected_state then return; end if;
    raise exception 'Expected SQLSTATE %, got % for %', expected_state, actual_state, command;
  end;
  raise exception 'Expected SQLSTATE %, command succeeded: %', expected_state, command;
end;
$$;

create function pg_temp.today()
returns date language sql as $$
  select (statement_timestamp() at time zone 'UTC')::date;
$$;

create function pg_temp.puzzles()
returns text[] language sql immutable as $$
  select array['__test_1', '__test_2', '__test_3', '__test_4', '__test_5', '__test_6', '__test_7']::text[];
$$;

create function pg_temp.other_puzzles()
returns text[] language sql immutable as $$
  select array['__other_1', '__other_2', '__other_3', '__other_4', '__other_5', '__other_6', '__other_7']::text[];
$$;

create function pg_temp.player(player_number integer)
returns void language plpgsql as $$
declare
  player_id text := '00000000-0000-4000-8000-' || lpad(player_number::text, 12, '0');
begin
  perform set_config('request.jwt.claim.sub', player_id, true);
  perform set_config('request.jwt.claims', json_build_object('sub', player_id, 'role', 'authenticated')::text, true);
end;
$$;

create function pg_temp.assert_distribution(result jsonb, expected jsonb)
returns void language plpgsql as $$
begin
  perform pg_temp.assert_true(result -> 'distribution' = expected,
    'histogram has the exact sorted, nonempty buckets and score bounds');
  perform pg_temp.assert_true((
    select sum((bin ->> 'count')::bigint)
    from jsonb_array_elements(result -> 'distribution' -> 'bins') as b(bin)
  ) = (result ->> 'total_players')::bigint, 'histogram counts equal the ranking population');
end;
$$;

-- Keep helpers callable when exercising the actual browser roles. PostgreSQL
-- normally permits access to this session's temporary schema across SET ROLE;
-- grant explicitly if the test database uses more restrictive schema ACLs.
do $$
declare temporary_schema text;
begin
  select nspname into temporary_schema from pg_namespace where oid = pg_my_temp_schema();
  if not has_schema_privilege('authenticated', pg_my_temp_schema(), 'USAGE')
    or not has_schema_privilege('anon', pg_my_temp_schema(), 'USAGE') then
    execute format('grant usage on schema %I to anon, authenticated', temporary_schema);
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text), pg_temp.expect_error(text, text),
  pg_temp.today(), pg_temp.puzzles(), pg_temp.other_puzzles(), pg_temp.player(integer),
  pg_temp.assert_distribution(jsonb, jsonb)
  to anon, authenticated;
select pg_temp.assert_true(
  has_schema_privilege('authenticated', pg_my_temp_schema(), 'USAGE')
  and has_schema_privilege('anon', pg_my_temp_schema(), 'USAGE'),
  'browser roles can access the test helpers before privilege tests run'
);

-- Fixed instants exercise the complete local-day submission window without
-- depending on the test runner's timezone or waiting for an actual midnight.
select pg_temp.assert_true(
  public.daily_challenge_window(date '2026-10-18') = tstzrange(
    timestamptz '2026-10-17 10:00:00+00', timestamptz '2026-10-19 12:00:00+00', '[)'
  ), 'a challenge date spans midnight UTC+14 through next midnight UTC-12');
select pg_temp.assert_true(
  not (timestamptz '2026-10-17 09:59:59.999999+00' <@ public.daily_challenge_window(date '2026-10-18'))
  and timestamptz '2026-10-17 10:00:00+00' <@ public.daily_challenge_window(date '2026-10-18')
  and timestamptz '2026-10-19 11:59:59.999999+00' <@ public.daily_challenge_window(date '2026-10-18')
  and not (timestamptz '2026-10-19 12:00:00+00' <@ public.daily_challenge_window(date '2026-10-18')),
  'the global local-day window includes its start and excludes its end');
select set_config('TimeZone', 'America/New_York', true);
select pg_temp.assert_true(
  public.daily_challenge_window(date '2026-11-01') = tstzrange(
    timestamptz '2026-10-31 10:00:00+00', timestamptz '2026-11-02 12:00:00+00', '[)'
  ), 'session timezone and daylight-saving transition do not shift the window');
select set_config('TimeZone', 'UTC', true);
select pg_temp.assert_true(not has_function_privilege(role_name, 'public.daily_challenge_window(date)', 'EXECUTE'),
  role_name || ' cannot call the internal challenge-date helper')
from unnest(array['anon', 'authenticated', 'service_role']) as r(role_name);

-- Abort rather than collide with an existing auth user, even on a test database.
select pg_temp.assert_true(not exists (
  select 1 from auth.users
  where id::text like '00000000-0000-4000-8000-%'
), 'fixture user IDs are unused');
insert into auth.users (id, aud, role)
select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'authenticated', 'authenticated'
from generate_series(1, 17) as fixture(n);

select pg_temp.assert_true((
  select relrowsecurity from pg_class where oid = 'public.daily_scores'::regclass
), 'RLS is enabled');
select pg_temp.assert_true(not has_table_privilege(role_name, 'public.daily_scores', privilege_name),
  role_name || ' has no direct ' || privilege_name || ' access')
from unnest(array['anon', 'authenticated']) as r(role_name)
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(privilege_name);
select pg_temp.assert_true(has_function_privilege('authenticated', signature, 'EXECUTE'), 'authenticated RPC access')
from unnest(array[
  'public.get_daily_rank(date,integer,text[])',
  'public.submit_daily_score(date,integer,text[],numeric[])'
]) as f(signature);
select pg_temp.assert_true(not has_function_privilege(role_name, signature, 'EXECUTE'), role_name || ' cannot execute RPC')
from unnest(array['anon', 'service_role']) as r(role_name)
cross join unnest(array[
  'public.get_daily_rank(date,integer,text[])',
  'public.submit_daily_score(date,integer,text[],numeric[])'
]) as f(signature);
select pg_temp.assert_true(prosecdef and exists (
  select 1 from unnest(proconfig) as c(setting) where setting in ('search_path=', 'search_path=""')
), 'RPC uses SECURITY DEFINER with empty search_path')
from pg_proc where oid in (
  'public.get_daily_rank(date,integer,text[])'::regprocedure,
  'public.submit_daily_score(date,integer,text[],numeric[])'::regprocedure
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}', true);
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles())', '28000');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[])', '28000');

select pg_temp.player(1);
select pg_temp.assert_true(public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) is null, 'no score before submission');
select pg_temp.expect_error('select public.get_daily_rank(null, 3, pg_temp.puzzles())', '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today() + 2, 3, pg_temp.puzzles())', '22023');
select pg_temp.expect_error($q$select public.get_daily_rank('infinity'::date, 3, pg_temp.puzzles())$q$, '22023');
select pg_temp.expect_error($q$select public.get_daily_rank('-infinity'::date, 3, pg_temp.puzzles())$q$, '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 2, pg_temp.puzzles())', '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), null, pg_temp.puzzles())', '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, null)', '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, array[]::text[])', '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3, array['a','b','c','d','e','f','f'])$q$, '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3, array['a','b','c','d','e','f',null])$q$, '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3, array['a','b','c','d','e','f','  '])$q$, '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3, array['a','b','c','d','e','f',repeat('x',81)])$q$, '22023');
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, array[pg_temp.puzzles()])', '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3, '[0:6]={a,b,c,d,e,f,g}'::text[])$q$, '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), null)', '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,0,0,0,0]::numeric[])', '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[array[0,0,0,0,0,0,0]]::numeric[])', '22023');
select pg_temp.expect_error($q$select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), '[0:6]={0,0,0,0,0,0,0}'::numeric[])$q$, '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[-1,0,0,0,0,0,0]::numeric[])', '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[null,0,0,0,0,0,0]::numeric[])', '22023');
select pg_temp.expect_error($q$select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array['NaN',0,0,0,0,0,0]::numeric[])$q$, '22023');
select pg_temp.expect_error($q$select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array['Infinity',0,0,0,0,0,0]::numeric[])$q$, '22023');
select pg_temp.expect_error($q$select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array['-Infinity',0,0,0,0,0,0]::numeric[])$q$, '22023');
do $$
declare
  maxima numeric[] := array[10,10,30,30,40,40,19];
  penalties numeric[];
begin
  for i in 1..7 loop
    penalties := array_fill(0::numeric, array[7]);
    penalties[i] := maxima[i] + 0.001;
    perform pg_temp.expect_error(format(
      'select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), %L::numeric[])', penalties
    ), '22023');
  end loop;
end;
$$;

-- The first player is alone, so no percentile is asserted for a sample of one.
select pg_temp.assert_true(
  public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,10,0,0,0,0]::numeric[])
  = jsonb_build_object('day', pg_temp.today(), 'scoring_version', 3, 'score', 10,
    'rank', 1, 'total_players', 1, 'better_than_percentile', null, 'tied_players', 1,
    'distribution', '{"bin_width":0.5,"min_score":10,"max_score":10,"bins":[{"start":10,"count":1}]}'::jsonb),
  'sole player response contains only their score and aggregate statistics'
);
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[]) ->> 'score')::numeric = 10,
  'retry cannot replace the first score with a better score'
);
select pg_temp.assert_true(
  (public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) ->> 'total_players')::integer = 1,
  'retry does not create another participant'
);

select pg_temp.player(2);
select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,20,0,0,0,0]::numeric[]);
select pg_temp.player(3);
select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,10,0,0,0,0]::numeric[]);
select pg_temp.player(4);
select pg_temp.assert_true(
  public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[])
  = jsonb_build_object('day', pg_temp.today(), 'scoring_version', 3, 'score', 0,
    'rank', 1, 'total_players', 4, 'better_than_percentile', 100, 'tied_players', 1,
    'distribution', '{"bin_width":0.5,"min_score":0,"max_score":20,"bins":[{"start":0,"count":1},{"start":10,"count":2},{"start":20,"count":1}]}'::jsonb),
  'lowest penalty is first and beats all other players'
);
select pg_temp.player(1);
do $$
declare result jsonb := public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles());
begin
  perform pg_temp.assert_true((result ->> 'rank')::integer = 2, 'ties share competition rank');
  perform pg_temp.assert_true((result ->> 'tied_players')::integer = 2, 'tie count includes self');
  perform pg_temp.assert_true((result ->> 'total_players')::integer = 4, 'cohort contains four players');
  perform pg_temp.assert_true(abs((result ->> 'better_than_percentile')::numeric - 100.0 / 3) < 0.000001,
    'percentile counts only strictly worse scores and excludes self from denominator');
  perform pg_temp.assert_distribution(result,
    '{"bin_width":0.5,"min_score":0,"max_score":20,"bins":[{"start":0,"count":1},{"start":10,"count":2},{"start":20,"count":1}]}'::jsonb);
end;
$$;
select pg_temp.player(2);
select pg_temp.assert_true(
  (public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) ->> 'rank')::integer = 4
  and (public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) ->> 'better_than_percentile')::numeric = 0,
  'highest penalty ranks last and beats nobody'
);
select pg_temp.player(5);
select pg_temp.assert_true(public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) is null,
  'an unsubmitted player cannot read somebody else''s result');
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, pg_temp.other_puzzles(), array[0,0,1,0,0,0,0]::numeric[]) ->> 'total_players')::integer = 1,
  'different ordered puzzles form an isolated cohort'
);
select pg_temp.assert_distribution(public.get_daily_rank(pg_temp.today(), 3, pg_temp.other_puzzles()),
  '{"bin_width":0.5,"min_score":1,"max_score":1,"bins":[{"start":1,"count":1}]}'::jsonb);
select pg_temp.player(1);
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, pg_temp.other_puzzles())', '22023');
select pg_temp.expect_error($q$select public.get_daily_rank(pg_temp.today(), 3,
  array['__test_2','__test_1','__test_3','__test_4','__test_5','__test_6','__test_7'])$q$, '22023');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.other_puzzles(), array[0,0,0,0,0,0,0]::numeric[])', '22023');
select pg_temp.assert_true(
  (public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) ->> 'total_players')::integer = 4,
  'different-cohort scores and rejected resubmissions do not affect the original cohort'
);

-- A device's date can differ from UTC. The RPC validates the global date window,
-- not the database session timezone, and keeps dates as distinct cohorts.
select set_config('TimeZone', case when extract(hour from statement_timestamp() at time zone 'UTC') < 12
  then 'Etc/GMT+12' else 'Pacific/Kiritimati' end, true);
select pg_temp.assert_true(statement_timestamp()::date <> pg_temp.today(), 'test timezone differs from UTC date');
select pg_temp.player(6);
select pg_temp.assert_true(
  (public.submit_daily_score(statement_timestamp()::date, 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[]) ->> 'day')::date = statement_timestamp()::date,
  'a currently active local date is accepted even when it differs from UTC');
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, pg_temp.other_puzzles(), array[0,0,2,0,0,0,0]::numeric[]) ->> 'day')::date = pg_temp.today(),
  'server session timezone does not restrict which active challenge date is accepted'
);
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today() + 2, 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[])', '22023');

-- Both ends of the supported timezone range can submit their own local date
-- at the same real instant. Keep these players in a separate puzzle cohort.
select set_config('TimeZone', 'Pacific/Kiritimati', true);
select pg_temp.player(16);
select pg_temp.assert_true(
  (public.submit_daily_score(statement_timestamp()::date, 3, pg_temp.other_puzzles(), array[0,0,1,0,0,0,0]::numeric[]) ->> 'day')::date = statement_timestamp()::date,
  'UTC+14 local date is accepted');
select set_config('TimeZone', 'Etc/GMT+12', true);
select pg_temp.player(17);
select pg_temp.assert_true(
  (public.submit_daily_score(statement_timestamp()::date, 3, pg_temp.other_puzzles(), array[0,0,1,0,0,0,0]::numeric[]) ->> 'day')::date = statement_timestamp()::date,
  'UTC-12 local date is accepted');
select set_config('TimeZone', 'UTC', true);

-- Dates two UTC days ago are outside every timezone's current window.
-- Historical/version fixtures require the owner. Browser RPCs cannot insert them.
reset role;
insert into public.daily_scores (player_id, day, scoring_version, puzzle_ids, round_penalties, score)
values
  ('00000000-0000-4000-8000-000000000001', pg_temp.today() - 2, 3, pg_temp.puzzles(), array[0,0,7,0,0,0,0], 7),
  ('00000000-0000-4000-8000-000000000007', pg_temp.today(), 2, pg_temp.puzzles(), array[0,0,0,0,0,0,0], 0);
set local role authenticated;
select pg_temp.player(1);
select pg_temp.assert_true(
  (public.get_daily_rank(pg_temp.today() - 2, 3, pg_temp.puzzles()) ->> 'score')::numeric = 7,
  'existing past daily result remains readable'
);
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today() - 2, 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[]) ->> 'score')::numeric = 7,
  'late retry returns the original past score'
);
select pg_temp.assert_true(
  (public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()) ->> 'total_players')::integer = 4,
  'different day and scoring version are excluded from current ranking'
);
select pg_temp.assert_distribution(public.get_daily_rank(pg_temp.today() - 2, 3, pg_temp.puzzles()),
  '{"bin_width":0.5,"min_score":7,"max_score":7,"bins":[{"start":7,"count":1}]}'::jsonb);
select pg_temp.assert_distribution(public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()),
  '{"bin_width":0.5,"min_score":0,"max_score":20,"bins":[{"start":0,"count":1},{"start":10,"count":2},{"start":20,"count":1}]}'::jsonb);
select pg_temp.player(7);
select pg_temp.assert_true(public.get_daily_rank(pg_temp.today() - 2, 3, pg_temp.puzzles()) is null, 'no fabricated past result');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today() - 2, 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[])', '22023');

-- Normalize each penalty to four decimals, then sum and round the displayed total.
select pg_temp.player(8);
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
    array[0.00494,0.00005,0,0,0,0,0]::numeric[]) ->> 'score')::numeric = 0.01,
  'normalization to four decimals happens before summation'
);
select pg_temp.player(9);
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
    array[0.00494,0.00494,0,0,0,0,0]::numeric[]) ->> 'score')::numeric = 0.01,
  'only the total is rounded to two decimals'
);
select pg_temp.assert_true(
  public.get_daily_rank(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'])
  = jsonb_build_object('day', pg_temp.today(), 'scoring_version', 3, 'score', 0.01,
    'rank', 1, 'total_players', 2, 'better_than_percentile', 0, 'tied_players', 2,
    'distribution', '{"bin_width":0.5,"min_score":0.01,"max_score":0.01,"bins":[{"start":0,"count":2}]}'::jsonb),
  'equal displayed totals tie, and all tied players beat zero percent'
);
select pg_temp.player(11);
select pg_temp.assert_true(
  (public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[10,10,30,30,40,40,19]::numeric[]) ->> 'score')::numeric = 179,
  'each round maximum is accepted'
);
select pg_temp.assert_distribution(public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles()),
  '{"bin_width":0.5,"min_score":0,"max_score":179,"bins":[{"start":0,"count":1},{"start":10,"count":2},{"start":20,"count":1},{"start":179,"count":1}]}'::jsonb);

-- Buckets round down, including exact half-point boundaries. The histogram
-- merges nearby scores, but ranking must still distinguish the stored totals.
select pg_temp.player(12);
select public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
  array[0,0,0.49,0,0,0,0]::numeric[]);
select pg_temp.player(13);
select public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
  array[0,0,0.5,0,0,0,0]::numeric[]);
select pg_temp.player(14);
select public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
  array[0,0,10.49,0,0,0,0]::numeric[]);
select pg_temp.player(15);
select public.submit_daily_score(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7'],
  array[0,0,10.5,0,0,0,0]::numeric[]);
select pg_temp.player(12);
do $$
declare result jsonb := public.get_daily_rank(pg_temp.today(), 3, array['p1','p2','p3','p4','p5','p6','p7']);
begin
  perform pg_temp.assert_distribution(result,
    '{"bin_width":0.5,"min_score":0.01,"max_score":10.5,"bins":[{"start":0,"count":3},{"start":0.5,"count":1},{"start":10,"count":1},{"start":10.5,"count":1}]}'::jsonb);
  perform pg_temp.assert_true((result ->> 'rank')::integer = 3
    and (result ->> 'tied_players')::integer = 1
    and (result ->> 'better_than_percentile')::numeric = 60,
    'rank and percentile use exact scores even when nearby scores share a histogram bucket');
end;
$$;

-- Exercise privileges with the real browser roles, not just catalog inspection.
select pg_temp.expect_error('select public.daily_challenge_window(pg_temp.today())', '42501');
select pg_temp.expect_error('select * from public.daily_scores', '42501');
select pg_temp.expect_error('insert into public.daily_scores default values', '42501');
select pg_temp.expect_error('update public.daily_scores set score = 0', '42501');
select pg_temp.expect_error('delete from public.daily_scores', '42501');
select pg_temp.expect_error('truncate public.daily_scores', '42501');
reset role;
set local role anon;
select pg_temp.expect_error('select public.get_daily_rank(pg_temp.today(), 3, pg_temp.puzzles())', '42501');
select pg_temp.expect_error('select public.submit_daily_score(pg_temp.today(), 3, pg_temp.puzzles(), array[0,0,0,0,0,0,0]::numeric[])', '42501');
select pg_temp.expect_error('select * from public.daily_scores', '42501');
reset role;
select pg_temp.assert_true((select round_penalties from public.daily_scores
  where player_id = '00000000-0000-4000-8000-000000000008' and day = pg_temp.today() and scoring_version = 3
) = array[0.0049,0.0001,0,0,0,0,0]::numeric[], 'stored penalties have canonical precision');
select pg_temp.assert_true((select count(*) from public.daily_scores
  where player_id = '00000000-0000-4000-8000-000000000001' and day = pg_temp.today() and scoring_version = 3
) = 1, 'first submission remains the only row');

rollback;
select 'daily_scores SQL tests passed' as result;
