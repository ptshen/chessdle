import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_REF = /^[a-z0-9]{20}$/;

export function checkConfiguration(env, linkedRef) {
  if (!PROJECT_REF.test(linkedRef)) {
    throw new Error('Link this checkout first: supabase link --project-ref YOUR_PROJECT_REF');
  }
  const rawUrl = env.VITE_SUPABASE_URL?.trim();
  const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!rawUrl || !key) {
    throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.');
  }
  let url;
  try { url = new URL(rawUrl); } catch {
    throw new Error('VITE_SUPABASE_URL must be the linked project’s HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) {
    throw new Error('VITE_SUPABASE_URL must be an HTTPS origin without credentials, paths, or query parameters.');
  }
  if (url.hostname !== `${linkedRef}.supabase.co`) {
    throw new Error('VITE_SUPABASE_URL does not match the linked project. Use its https://<project-ref>.supabase.co URL.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const parts = key.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.role !== 'anon' || (payload.ref && payload.ref !== linkedRef)) throw new Error();
    } catch {
      throw new Error('Use a public publishable key or legacy anon key. Secret and service-role keys must never be browser configuration.');
    }
  }
  if (key.includes('replace_me')) throw new Error('Replace the example publishable key with the linked project’s public key.');
  return { url: url.origin, key, projectRef: linkedRef };
}

export async function checkAnonymousAuth(config, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${config.url}/auth/v1/settings`, {
      method: 'GET', headers: { apikey: config.key }, redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Cannot reach Supabase Auth. Check your network and project status, then rerun this command from your terminal.');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? 'Supabase rejected the public key. Copy the publishable key from the same linked project.'
      : `Supabase Auth returned HTTP ${response.status}. Check the project status and URL.`);
  }
  let settings;
  try { settings = await response.json(); } catch {
    throw new Error('Supabase Auth returned an unexpected settings response.');
  }
  if (settings?.disable_signup === true) {
    throw new Error('Enable new user sign-ups in Supabase Authentication settings so anonymous players can save scores.');
  }
  if (settings?.external?.anonymous_users !== true) {
    throw new Error('Enable Anonymous Sign-Ins in Supabase Authentication settings (or apply supabase config push).');
  }
}

// These checks read PostgreSQL catalogs only. No players, scores, or auth users
// are created, and no private rows or key material are returned by the query.
export const CATALOG_QUERY = `
with targets as (
  select to_regclass('public.daily_scores') as scores,
    to_regprocedure('public.get_daily_rank(date,integer,text[])') as rank_rpc,
    to_regprocedure('public.submit_daily_score(date,integer,text[],numeric[])') as submit_rpc,
    to_regprocedure('public.daily_challenge_window(date)') as day_window
), checks as (
  select scores is not null as scores_table,
    coalesce((select relrowsecurity from pg_class where oid = scores), false) as row_security,
    scores is not null and not exists (
      select 1 from unnest(array['anon', 'authenticated']) as r(role_name)
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(privilege_name)
      where has_table_privilege(role_name, scores, privilege_name)
    ) as table_access_blocked,
    scores is not null and exists (
      select 1 from pg_constraint c where c.conrelid = scores and c.contype = 'p'
      and (select array_agg(a.attname::text order by k.ordinality)
        from unnest(c.conkey) with ordinality k(attnum, ordinality)
        join pg_attribute a on a.attrelid = scores and a.attnum = k.attnum
      ) = array['player_id','day','scoring_version']::text[]
    ) as unique_daily_result,
    rank_rpc is not null and submit_rpc is not null as ranking_functions,
    coalesce(pg_get_functiondef(rank_rpc) like '%''distribution''%'
      and pg_get_functiondef(rank_rpc) like '%''bin_width''%', false) as score_distribution,
    day_window is not null and coalesce(
      pg_get_functiondef(rank_rpc) like '%public.daily_challenge_window(p_day)%'
      and pg_get_functiondef(submit_rpc) like '%public.daily_challenge_window(p_day)%', false
    ) as local_challenge_days,
    day_window is not null and not exists (
      select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role_name)
      where has_function_privilege(role_name, day_window, 'EXECUTE')
    ) and exists (
      select 1 from pg_proc p where p.oid = day_window
      and p.provolatile = 'i' and p.proisstrict and not p.prosecdef
      and exists (
        select 1 from unnest(p.proconfig) c(setting) where setting in ('search_path=', 'search_path=""')
      )
    ) as day_window_security,
    rank_rpc is not null and submit_rpc is not null and not exists (
      select 1 from unnest(array[rank_rpc, submit_rpc]) f(oid)
      where not has_function_privilege('authenticated', f.oid, 'EXECUTE')
        or has_function_privilege('anon', f.oid, 'EXECUTE')
        or has_function_privilege('service_role', f.oid, 'EXECUTE')
    ) as function_permissions,
    rank_rpc is not null and submit_rpc is not null and not exists (
      select 1 from pg_proc p where p.oid in (rank_rpc, submit_rpc)
      and (not p.prosecdef or not exists (
        select 1 from unnest(p.proconfig) c(setting) where setting in ('search_path=', 'search_path=""')
      ))
    ) as function_security
  from targets
)
select to_jsonb(checks) as chessdle_checks from checks;
`;

export const DATABASE_CHECKS = {
  scores_table: 'daily_scores table',
  row_security: 'row-level security',
  table_access_blocked: 'private score table permissions',
  unique_daily_result: 'one result per player and day',
  ranking_functions: 'ranking and submission functions',
  score_distribution: 'score-distribution migration',
  local_challenge_days: 'device-local challenge-day migration',
  day_window_security: 'private challenge-day helper permissions',
  function_permissions: 'authenticated-only function permissions',
  function_security: 'function execution security',
};

export function parseDatabaseChecks(output) {
  let value;
  try {
    value = JSON.parse(output);
    if (value && !Array.isArray(value) && typeof value === 'object') {
      if (Array.isArray(value.rows)) value = value.rows;
      else if (Array.isArray(value.data)) value = value.data;
    }
    if (Array.isArray(value) && value.length === 1) value = value[0];
    value = value?.chessdle_checks;
    if (typeof value === 'string') value = JSON.parse(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(DATABASE_CHECKS).some((key) => typeof value[key] !== 'boolean')) throw new Error();
  } catch {
    throw new Error('Could not read Supabase CLI query output. Update the CLI and rerun check:supabase.');
  }
  return Object.fromEntries(Object.keys(DATABASE_CHECKS).map((key) => [key, value[key]]));
}

export function describeCliFailure(error) {
  const details = `${error?.message ?? ''}\n${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;
  if (error?.code === 'ENOENT') return 'Install Supabase CLI and make sure supabase is on PATH.';
  if (/access token|not logged|unauthorized|log in|login|keychain/i.test(details)) {
    return 'Supabase CLI could not authenticate. Run supabase login in your terminal, then rerun check:supabase there.';
  }
  if (error?.killed || /ENOTFOUND|ECONN|EAI_AGAIN|timed?\s*out|network|fetch failed/i.test(details)) {
    return 'Supabase CLI could not reach the linked database. Check your network/project status, then rerun check:supabase in your terminal.';
  }
  if (/unknown command|unknown flag|unrecognized/i.test(details)) return 'Update Supabase CLI to a version supporting db query --linked (2.121+).';
  return 'Supabase CLI database verification failed. Check that this checkout is linked and your CLI account can access the project.';
}

async function queryFile(root, projectRef, file, runner = execFileAsync) {
  if (!PROJECT_REF.test(projectRef)) throw new Error('A validated Supabase project ref is required for database verification.');
  try {
    // An explicit flag takes precedence over SUPABASE_PROJECT_ID and keeps the
    // CLI on the same project whose browser URL and public key were validated.
    const result = await runner('supabase', ['db', 'query', '--linked', '--project-ref', projectRef, '--file', file, '--output', 'json'], {
      cwd: root, env: { ...process.env, DO_NOT_TRACK: '1' }, timeout: 30_000,
      maxBuffer: 1_048_576, encoding: 'utf8',
    });
    return result.stdout;
  } catch (error) {
    // Do not print raw CLI output: it may include credentials or unrelated data.
    throw new Error(describeCliFailure(error));
  }
}

export async function checkDatabase(root, projectRef, runner) {
  const directory = await mkdtemp(join(tmpdir(), 'chessdle-check-'));
  try {
    const file = join(directory, 'read-only-check.sql');
    await writeFile(file, CATALOG_QUERY, { mode: 0o600 });
    const checks = parseDatabaseChecks(await queryFile(root, projectRef, file, runner));
    const failures = Object.entries(DATABASE_CHECKS).filter(([key]) => !checks[key]).map(([, label]) => label);
    if (failures.length) throw new Error(`Database checks failed: ${failures.join(', ')}. Apply the Chessdle migration with supabase db push; review any later permission changes.`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function testDatabase(root, projectRef, runner) {
  const file = join(root, 'supabase/tests/daily_scores.sql');
  // Keep the suite's explicit transaction/rollback contract visible here.
  const suite = await readFile(file, 'utf8');
  if (!/^begin;/m.test(suite) || !/^rollback;/m.test(suite)) throw new Error('Database test suite must wrap its fixtures in a rolled-back transaction.');
  const output = await queryFile(root, projectRef, file, runner);
  if (!output.includes('daily_scores SQL tests passed')) throw new Error('Database tests did not return their success marker. Run the SQL suite directly against your test project to inspect the failure.');
}
