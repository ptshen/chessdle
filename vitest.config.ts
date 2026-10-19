import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Real project credentials must never enter an automated test run.
  envDir: false,
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    env: {
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
    },
  },
});
