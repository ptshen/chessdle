import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { checkAnonymousAuth, checkConfiguration, checkDatabase, testDatabase } from './lib/supabase-check.mjs';

const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--test-database')) {
  console.error('Usage: npm run check:supabase [-- --test-database]');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let config;
  let failures = 0;
  async function check(label, action) {
    try { await action(); console.log(`✓ ${label}`); }
    catch (error) { failures++; console.error(`✗ ${label}: ${error.message}`); }
  }

  await check('Public configuration and linked project', async () => {
    let linkedRef;
    try { linkedRef = (await readFile(new URL('../supabase/.temp/project-ref', import.meta.url), 'utf8')).trim(); }
    catch { throw new Error('Link this checkout first: supabase link --project-ref YOUR_PROJECT_REF'); }
    let env;
    try { env = loadEnv('production', root, 'VITE_'); }
    catch { throw new Error('Could not load Vite environment files. Check their syntax.'); }
    config = checkConfiguration(env, linkedRef);
  });

  if (config) {
    await Promise.all([
      check('Anonymous sign-ins and public API key', () => checkAnonymousAuth(config)),
      check('Deployed database, distribution, and permissions', () => checkDatabase(root, config.projectRef)),
    ]);
    if (args.includes('--test-database') && failures === 0) {
      console.log('Running the transactional database suite; fixtures are rolled back.');
      await check('Database integration tests', () => testDatabase(root, config.projectRef));
    }
  }
  if (failures) process.exitCode = 1;
  else console.log('Supabase is ready. Restart Vite or rebuild after changing environment values.');
}
