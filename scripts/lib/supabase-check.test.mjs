import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { checkAnonymousAuth, checkConfiguration, checkDatabase, DATABASE_CHECKS, describeCliFailure, parseDatabaseChecks, testDatabase } from './supabase-check.mjs';

const ref = 'abcdefghijklmnopqrst';
const env = { VITE_SUPABASE_URL: `https://${ref}.supabase.co`, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public_key' };
const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const checks = Object.fromEntries(Object.keys(DATABASE_CHECKS).map((key) => [key, true]));

test('configuration accepts public keys and normalizes the project URL', () => {
  assert.deepEqual(checkConfiguration({ ...env, VITE_SUPABASE_URL: `${env.VITE_SUPABASE_URL}/` }, ref), {
    url: env.VITE_SUPABASE_URL, key: env.VITE_SUPABASE_PUBLISHABLE_KEY, projectRef: ref,
  });
  assert.equal(checkConfiguration({ VITE_SUPABASE_URL: env.VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: jwt({ role: 'anon', ref }) }, ref).projectRef, ref);
});

test('configuration rejects privileged keys without exposing them', () => {
  for (const key of ['sb_secret_do_not_print', jwt({ role: 'service_role', ref }), jwt({ role: 'authenticated', ref }), 'malformed']) {
    assert.throws(() => checkConfiguration({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key }, ref), (error) => {
      assert.ok(!error.message.includes(key));
      assert.match(error.message, /public publishable key/);
      return true;
    });
  }
});

test('configuration prevents checking a different project from the site', () => {
  assert.throws(() => checkConfiguration(env, 'uvwxyzabcdefghijklmn'), /does not match/);
  assert.throws(() => checkConfiguration({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: 'another-project' }) }, ref), /public publishable key/);
});

test('configuration rejects missing values, unsafe URLs, and example keys', () => {
  assert.throws(() => checkConfiguration(env, ''), /Link this checkout/);
  assert.throws(() => checkConfiguration({}, ref), /Set VITE_SUPABASE_URL/);
  for (const url of ['not a url', `http://${ref}.supabase.co`, `https://user:password@${ref}.supabase.co`, `${env.VITE_SUPABASE_URL}/rest`, `${env.VITE_SUPABASE_URL}?key=secret`]) {
    assert.throws(() => checkConfiguration({ ...env, VITE_SUPABASE_URL: url }, ref), /HTTPS/);
  }
  assert.throws(() => checkConfiguration({ ...env, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_replace_me' }, ref), /Replace the example/);
});

test('auth verification is a public read and does not create a player', async () => {
  let calls = 0;
  await checkAnonymousAuth(checkConfiguration(env, ref), async (url, options) => {
    calls++;
    assert.equal(url, `${env.VITE_SUPABASE_URL}/auth/v1/settings`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.apikey, env.VITE_SUPABASE_PUBLISHABLE_KEY);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ external: { anonymous_users: true } }) };
  });
  assert.equal(calls, 1);
});

test('auth verification distinguishes disabled anonymous sign-ins and invalid keys', async () => {
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => ({ ok: true, json: async () => ({ external: { anonymous_users: false } }) })), /Enable Anonymous Sign-Ins/);
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => ({ ok: true, json: async () => ({ external: { anonymous: true } }) })), /Enable Anonymous Sign-Ins/);
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => ({ ok: false, status: 401 })), /rejected the public key/);
});

test('auth verification rejects disabled sign-ups even when anonymous auth is enabled', async () => {
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => ({ ok: true, json: async () => ({ external: { anonymous_users: true }, disable_signup: true }) })), /Enable new user sign-ups/);
});

test('auth verification suppresses network details and malformed response bodies', async () => {
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => { throw new Error('secret-response-content'); }), (error) => {
    assert.match(error.message, /Cannot reach/);
    assert.ok(!error.message.includes('secret-response-content'));
    return true;
  });
  await assert.rejects(checkAnonymousAuth(checkConfiguration(env, ref), async () => ({ ok: true, json: async () => { throw new Error('secret-response'); } })), /unexpected settings response/);
});

for (const [name, output] of Object.entries({
  array: [{ chessdle_checks: checks }],
  rows: { rows: [{ chessdle_checks: checks }] },
  data: { data: [{ chessdle_checks: checks }] },
  single: { chessdle_checks: checks },
  encoded: [{ chessdle_checks: JSON.stringify(checks) }],
})) {
  test(`catalog parser accepts ${name} JSON output`, () => {
    assert.deepEqual(parseDatabaseChecks(JSON.stringify(output)), checks);
  });
}

test('catalog parser fails closed and excludes unknown fields', () => {
  for (const output of ['credentials accidentally printed', '{}', '[]', JSON.stringify([{ chessdle_checks: { ...checks, row_security: 'true' } }]), JSON.stringify([{ chessdle_checks: checks }, { chessdle_checks: checks }])]) {
    assert.throws(() => parseDatabaseChecks(output), /Could not read Supabase CLI/);
  }
  assert.deepEqual(parseDatabaseChecks(JSON.stringify([{ chessdle_checks: { ...checks, unrelated: 'private' } }])), checks);
});

test('CLI failures remain actionable without echoing output', () => {
  assert.match(describeCliFailure({ code: 'ENOENT' }), /Install Supabase CLI/);
  assert.match(describeCliFailure({ stderr: 'Access token not provided: secret' }), /supabase login/);
  assert.match(describeCliFailure({ killed: true }), /could not reach/);
  assert.match(describeCliFailure({ stderr: 'Unknown command: secret' }), /Update Supabase CLI/);
  assert.ok(!describeCliFailure({ stderr: 'sensitive SQL or token' }).includes('sensitive'));
});

test('database verification reads catalogs, uses no shell or key arguments, and removes its temporary file', async () => {
  let file;
  await checkDatabase(process.cwd(), ref, async (command, args, options) => {
    assert.equal(command, 'supabase');
    assert.deepEqual(args.slice(0, 6), ['db', 'query', '--linked', '--project-ref', ref, '--file']);
    file = args[6];
    assert.deepEqual(args.slice(7), ['--output', 'json']);
    assert.ok(args.every((argument) => !argument.includes(env.VITE_SUPABASE_PUBLISHABLE_KEY)));
    assert.equal(options.env.DO_NOT_TRACK, '1');
    assert.equal(options.timeout, 30_000);
    assert.equal(options.shell, undefined);
    const sql = await readFile(file, 'utf8');
    assert.doesNotMatch(sql, /\b(insert|update|delete|create|alter|grant|revoke)\s+(into|table|function|on|public\.)/i);
    assert.doesNotMatch(sql, /from\s+(public\.daily_scores|auth\.users)/i);
    assert.match(sql, /pg_get_functiondef\(rank_rpc\).*distribution/);
    assert.match(sql, /pg_get_functiondef\(rank_rpc\).*bin_width/);
    assert.match(sql, /to_regprocedure\('public\.daily_challenge_window\(date\)'\)/);
    assert.match(sql, /pg_get_functiondef\(rank_rpc\).*daily_challenge_window/);
    assert.match(sql, /pg_get_functiondef\(submit_rpc\).*daily_challenge_window/);
    assert.match(sql, /has_function_privilege\(role_name, day_window, 'EXECUTE'\)/);
    return { stdout: JSON.stringify([{ chessdle_checks: checks }]) };
  });
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('failed database protections are reported instead of passing or dumping result data', async () => {
  await assert.rejects(checkDatabase(process.cwd(), ref, async () => ({ stdout: JSON.stringify([{ chessdle_checks: { ...checks, row_security: false, unrelated: 'secret' } }]) })), (error) => {
    assert.match(error.message, /row-level security/);
    assert.match(error.message, /supabase db push/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
});

test('database verification reports an old ranking schema as a missing distribution migration', async () => {
  await assert.rejects(checkDatabase(process.cwd(), ref, async () => ({
    stdout: JSON.stringify([{ chessdle_checks: { ...checks, score_distribution: false } }]),
  })), (error) => {
    assert.match(error.message, /score-distribution migration/);
    assert.match(error.message, /supabase db push/);
    return true;
  });
});

test('database verification reports an old UTC schema or an exposed day-window helper', async () => {
  for (const key of ['local_challenge_days', 'day_window_security']) {
    await assert.rejects(checkDatabase(process.cwd(), ref, async () => ({
      stdout: JSON.stringify([{ chessdle_checks: { ...checks, [key]: false } }]),
    })), (error) => {
      assert.ok(error.message.includes(DATABASE_CHECKS[key]));
      assert.match(error.message, /supabase db push/);
      return true;
    });
  }
});

test('both database commands explicitly target the validated project even with an environment override', async () => {
  const previous = process.env.SUPABASE_PROJECT_ID;
  process.env.SUPABASE_PROJECT_ID = 'uvwxyzabcdefghijklmn';
  const seen = [];
  try {
    const runner = async (_command, args) => {
      assert.equal(args[args.indexOf('--project-ref') + 1], ref);
      seen.push(args);
      return { stdout: args[args.indexOf('--file') + 1].endsWith('daily_scores.sql')
        ? 'daily_scores SQL tests passed'
        : JSON.stringify([{ chessdle_checks: checks }]) };
    };
    await checkDatabase(process.cwd(), ref, runner);
    await testDatabase(process.cwd(), ref, runner);
    assert.equal(seen.length, 2);
  } finally {
    if (previous === undefined) delete process.env.SUPABASE_PROJECT_ID;
    else process.env.SUPABASE_PROJECT_ID = previous;
  }
});

test('database commands reject missing or invalid project refs before invoking the CLI', async () => {
  let calls = 0;
  const runner = async () => { calls++; return { stdout: '' }; };
  for (const projectRef of [undefined, '', '--other-project', 'not-a-project-ref']) {
    await assert.rejects(checkDatabase(process.cwd(), projectRef, runner), /validated Supabase project ref/);
    await assert.rejects(testDatabase(process.cwd(), projectRef, runner), /validated Supabase project ref/);
  }
  assert.equal(calls, 0);
});
