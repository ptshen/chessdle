import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, puzzles, type GameState } from './game';
import expandedPuzzleData from '../data/puzzles-expanded.json';

const URL = 'https://chessdle-test.supabase.co';
const KEY = 'sb_publishable_public-test-key';
const STORAGE_KEY = `chessdle:supabase:${URL}:session`;
const DAY = '2026-10-18';
const NOW = Date.parse(`${DAY}T12:00:00Z`);
let ranking: typeof import('./ranking');
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const session = (overrides = {}) => ({ access_token: 'access-one', refresh_token: 'refresh-one', expires_at: NOW / 1000 + 3600, user: { id: 'player-one' }, ...overrides });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const rank = (overrides = {}) => ({ day: DAY, scoring_version: 3, score: 21, rank: 2, total_players: 4, better_than_percentile: 66.67, tied_players: 1, ...overrides });
const distribution = (overrides = {}) => ({ bin_width: 0.5, min_score: 5.1, max_score: 30.49,
  bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 2 }], ...overrides });

function completedGame(date = DAY): GameState {
  const game = createGame('daily', date);
  return { ...game, index: 6, results: game.puzzleIds.map((puzzleId, index) => ({ puzzleId,
    penalty: index, guess: '1', answer: '1', evaluation: puzzles.find(puzzle => puzzle.id === puzzleId)!.evaluation,
  })) };
}
function mockSignedIn() { localStorage.setItem(STORAGE_KEY, JSON.stringify(session())); }
function requests() { return fetchMock.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(init!.body as string), headers: init!.headers })); }

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('VITE_SUPABASE_URL', URL);
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', KEY);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  });
  vi.stubGlobal('navigator', {});
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  ranking = await import('./ranking');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('ranking configuration and eligibility', () => {
  it('accepts a public publishable key and legacy anon JWT', () => {
    expect(ranking.isRankingConfigured()).toBe(true);
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', `header.${btoa(JSON.stringify({ role: 'anon' }))}.signature`);
    expect(ranking.isRankingConfigured()).toBe(true);
  });

  it.each([
    ['', KEY], ['invalid', KEY], ['http://example.com', KEY], [`${URL}/other`, KEY], [`${URL}?secret=x`, KEY],
    ['https://user:password@example.com', KEY], [URL, ''], [URL, 'sb_secret_do-not-expose'],
    [URL, `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`],
  ])('rejects unavailable or unsafe configuration without making requests (%s)', async (url, key) => {
    vi.stubEnv('VITE_SUPABASE_URL', url);
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', key);
    expect(ranking.isRankingConfigured()).toBe(false);
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'unavailable', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports the local Supabase development URL', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321/');
    expect(ranking.isRankingConfigured()).toBe(true);
  });

  it('accepts the last submitted answer before the finish screen and persisted earlier daily games', () => {
    const game = completedGame();
    expect(game.finished).toBe(false);
    expect(ranking.rankableDailyGame(game)).toBe(true);
    vi.setSystemTime(NOW + 86_400_000);
    expect(ranking.rankableDailyGame(game)).toBe(true);
  });

  it.each([
    ['2026-10-18', ['00Lyc-ply81', '005xu', '002O7', '00Knu-before', '00LBF', '00FHO', '000Zo']],
    ['2026-10-21', ['00DkJ-ply40', '00FHO', '00IpT-ply36', '001xO', '002rd', '00MHi', '00LRq']],
    ['2026-10-22', ['002VP', '00FF5-ply32', '002O7', '00IFk-ply24', '00Kd8', '00LBF', '00NUc']],
  ] as const)('keeps the original ranking cohort for %s after the library expands', (date, ids) => {
    vi.setSystemTime(Date.parse('2026-10-24T12:00:00Z'));
    const game = completedGame(date);
    expect(game.puzzleIds).toEqual(ids);
    expect(ranking.rankableDailyGame(game)).toBe(true);
  });

  it('accepts the expanded daily cohort and rejects reordered expanded positions', () => {
    const game = completedGame('2026-10-23');
    const expandedIds = new Set(expandedPuzzleData.map(puzzle => puzzle.id));
    expect(game.puzzleIds.some(id => expandedIds.has(id))).toBe(true);
    expect(ranking.rankableDailyGame(game)).toBe(true);
    const reordered = [...game.puzzleIds];
    [reordered[0], reordered[2]] = [reordered[2], reordered[0]];
    expect(ranking.rankableDailyGame({ ...game, puzzleIds: reordered,
      results: game.results.map((result, index) => ({ ...result, puzzleId: reordered[index] })),
    })).toBe(false);
  });

  it('excludes practice, incomplete, older-scoring and migrated noncanonical daily games', async () => {
    const game = completedGame();
    const invalid: GameState[] = [
      { ...game, mode: 'practice' }, { ...game, index: 5 }, { ...game, results: game.results.slice(0, 6) },
      { ...game, scoringVersion: 2 }, { ...game, id: 'different-id' }, { ...game, date: '2026-02-30' },
      { ...game, puzzleIds: [...game.puzzleIds.slice(1), game.puzzleIds[0]] },
      { ...game, results: game.results.map((result, index) => index ? result : { ...result, puzzleId: 'wrong' }) },
    ];
    for (const candidate of invalid) {
      expect(ranking.rankableDailyGame(candidate)).toBe(false);
      await expect(ranking.submitDailyScore(candidate)).rejects.toMatchObject({ code: 'ineligible' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces finite, nonnegative per-round limits before submitting', () => {
    const game = completedGame();
    for (const [index, limit] of [10, 10, 30, 30, 40, 40, 19].entries()) {
      for (const penalty of [-1, NaN, Infinity, limit + 0.01]) {
        expect(ranking.rankableDailyGame({ ...game, results: game.results.map((result, round) => round === index ? { ...result, penalty } : result) })).toBe(false);
      }
    }
  });
});

describe('score and percentile RPCs', () => {
  it('persists an anonymous identity and sends the seven penalties using its access token', async () => {
    fetchMock.mockResolvedValueOnce(response(session())).mockResolvedValueOnce(response(rank()));
    const game = completedGame();
    await expect(ranking.submitDailyScore(game)).resolves.toEqual({ day: DAY, scoringVersion: 3, score: 21,
      rank: 2, totalPlayers: 4, betterThanPercentile: 66.67, tiedPlayers: 1, distribution: null });
    const [signup, submit] = requests();
    expect(signup).toEqual({ url: `${URL}/auth/v1/signup`, body: { data: {} }, headers: { apikey: KEY, 'Content-Type': 'application/json' } });
    expect(submit).toEqual({ url: `${URL}/rest/v1/rpc/submit_daily_score`, body: {
      p_day: DAY, p_scoring_version: 3, p_puzzle_ids: game.puzzleIds, p_round_penalties: [0, 1, 2, 3, 4, 5, 6],
    }, headers: { apikey: KEY, 'Content-Type': 'application/json', Authorization: 'Bearer access-one' } });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(session());
  });

  it('reads a previous result without resubmitting any penalties and allows no existing score', async () => {
    mockSignedIn();
    fetchMock.mockResolvedValueOnce(response(null)).mockResolvedValueOnce(response(rank()));
    await expect(ranking.getDailyRank(completedGame())).resolves.toBeNull();
    expect(requests()[0].body).toEqual({ p_day: DAY, p_scoring_version: 3, p_puzzle_ids: completedGame().puzzleIds });
    expect(requests()[0].url).toBe(`${URL}/rest/v1/rpc/get_daily_rank`);
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ rank: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('represents the first player and equal-score ties without inventing a percentile', async () => {
    mockSignedIn();
    fetchMock.mockResolvedValueOnce(response(rank({ rank: 1, total_players: 1, better_than_percentile: null })))
      .mockResolvedValueOnce(response(rank({ rank: 1, tied_players: 4, better_than_percentile: 0 })));
    await expect(ranking.submitDailyScore(completedGame())).resolves.toMatchObject({ rank: 1, betterThanPercentile: null });
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ tiedPlayers: 4, betterThanPercentile: 0 });
  });

  it.each([
    null, {}, rank({ day: '2026-10-17' }), rank({ scoring_version: 2 }), rank({ score: -1 }),
    rank({ score: '21' }), rank({ rank: 5 }), rank({ tied_players: 4 }), rank({ better_than_percentile: null }),
    rank({ better_than_percentile: 101 }), rank({ total_players: 1, rank: 1, better_than_percentile: 100 }),
    rank({ total_players: Number.MAX_SAFE_INTEGER + 1 }),
    rank({ rank: Number.MAX_SAFE_INTEGER + 1, total_players: Number.MAX_SAFE_INTEGER + 1 }),
    rank({ tied_players: Number.MAX_SAFE_INTEGER + 1, total_players: Number.MAX_SAFE_INTEGER + 1 }),
  ])('rejects malformed ranking responses (%j)', async value => {
    mockSignedIn();
    fetchMock.mockResolvedValue(response(value));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('daily score distribution', () => {
  beforeEach(() => mockSignedIn());

  it('converts the aggregate histogram without exposing individual scores', async () => {
    fetchMock.mockResolvedValueOnce(response(rank({ distribution: distribution() })));
    await expect(ranking.submitDailyScore(completedGame())).resolves.toMatchObject({ score: 21, rank: 2,
      distribution: { binWidth: 0.5, minScore: 5.1, maxScore: 30.49,
        bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 2 }] } });
  });

  it.each([0, 21.49, 179])('accepts the only player at score %s without inventing competitors', async score => {
    const start = Math.floor(score * 2) / 2;
    fetchMock.mockResolvedValueOnce(response(rank({ score, rank: 1, total_players: 1, better_than_percentile: null,
      distribution: distribution({ min_score: score, max_score: score, bins: [{ start, count: 1 }] }) })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ betterThanPercentile: null,
      distribution: { minScore: score, maxScore: score, bins: [{ start, count: 1 }] } });
  });

  it('retains an all-tied distribution and its exact player count', async () => {
    fetchMock.mockResolvedValueOnce(response(rank({ rank: 1, tied_players: 4, better_than_percentile: 0,
      distribution: distribution({ min_score: 21, max_score: 21, bins: [{ start: 21, count: 4 }] }) })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ tiedPlayers: 4,
      distribution: { minScore: 21, maxScore: 21, bins: [{ start: 21, count: 4 }] } });
  });

  it('allows different scores within the player’s bucket to affect the precise rank', async () => {
    fetchMock.mockResolvedValueOnce(response(rank({ score: 21.2, rank: 3, total_players: 5, better_than_percentile: 50,
      distribution: distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 3 }, { start: 30, count: 1 }] }) })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ rank: 3,
      distribution: { bins: [{ start: 5, count: 1 }, { start: 21, count: 3 }, { start: 30, count: 1 }] } });
  });

  it('accepts all 359 possible buckets, including the maximum score', async () => {
    const bins = Array.from({ length: 359 }, (_, index) => ({ start: index / 2, count: 1 }));
    fetchMock.mockResolvedValueOnce(response(rank({ score: 179, rank: 359, total_players: 359, better_than_percentile: 0,
      distribution: distribution({ min_score: 0, max_score: 179, bins }) })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ distribution: { bins } });
  });

  it.each([undefined, null])('keeps confirmed ranks available when the deployed backend has no histogram (%s)', async value => {
    fetchMock.mockResolvedValueOnce(response(rank({ distribution: value })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ rank: 2, totalPlayers: 4, distribution: null });
  });

  it.each([
    {}, [], 'histogram',
    distribution({ bin_width: 1 }), distribution({ bin_width: '0.5' }),
    distribution({ min_score: -0.1 }), distribution({ max_score: 179.01 }),
    distribution({ min_score: '5.1' }), distribution({ max_score: null }),
    distribution({ min_score: 31 }), distribution({ min_score: 22 }), distribution({ max_score: 20 }),
    distribution({ min_score: 4.99 }), distribution({ max_score: 30.5 }),
    distribution({ bins: [] }), distribution({ bins: {} }), distribution({ bins: [null] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 30, count: 3 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 0 }, { start: 30, count: 3 }] }),
    distribution({ bins: [{ start: 5, count: 1.5 }, { start: 21, count: 1 }, { start: 30, count: 1.5 }] }),
    distribution({ bins: [{ start: 5, count: -1 }, { start: 21, count: 1 }, { start: 30, count: 4 }] }),
    distribution({ bins: [{ start: 5, count: '1' }, { start: 21, count: 1 }, { start: 30, count: 2 }] }),
    distribution({ bins: [{ start: 5, count: Number.MAX_SAFE_INTEGER + 1 }, { start: 21, count: 1 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 1 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 3 }] }),
    distribution({ bins: [{ start: -0.5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 2 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 179.5, count: 2 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21.1, count: 1 }, { start: 30, count: 2 }] }),
    distribution({ bins: [{ start: '5', count: 1 }, { start: 21, count: 1 }, { start: 30, count: 2 }] }),
    distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 21, count: 1 }, { start: 30, count: 1 }] }),
    distribution({ bins: [{ start: 21, count: 1 }, { start: 5, count: 1 }, { start: 30, count: 2 }] }),
    distribution({ bins: [{ start: 5, count: 2 }, { start: 21, count: 1 }, { start: 30, count: 1 }] }),
    distribution({ min_score: 21, bins: [{ start: 21, count: 1 }, { start: 30, count: 3 }] }),
  ])('ignores malformed distributions while preserving the confirmed score (%j)', async value => {
    fetchMock.mockResolvedValueOnce(response(rank({ distribution: value })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ score: 21, rank: 2,
      betterThanPercentile: 66.67, distribution: null });
  });

  it('rejects a bucket that cannot hold the reported tied players', async () => {
    fetchMock.mockResolvedValueOnce(response(rank({ tied_players: 2, better_than_percentile: 33.33,
      distribution: distribution() })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ tiedPlayers: 2, distribution: null });
  });

  it('rejects aggregate overflow without losing a valid ranking', async () => {
    fetchMock.mockResolvedValueOnce(response(rank({ total_players: Number.MAX_SAFE_INTEGER,
      distribution: distribution({ bins: [{ start: 5, count: 1 }, { start: 21, count: 1 }, { start: 30, count: Number.MAX_SAFE_INTEGER }] }) })));
    await expect(ranking.getDailyRank(completedGame())).resolves.toMatchObject({ totalPlayers: Number.MAX_SAFE_INTEGER, distribution: null });
  });
});

describe('anonymous session stability', () => {
  it('shares one signup between simultaneous submit/read requests', async () => {
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockImplementation(async () => response(rank()));
    const first = ranking.submitDailyScore(completedGame());
    const second = ranking.getDailyRank(completedGame());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(response(session()));
    await Promise.all([first, second]);
    expect(requests().filter(request => request.url === `${URL}/auth/v1/signup`)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('restores the same identity after a module reload without another signup', async () => {
    fetchMock.mockResolvedValueOnce(response(session())).mockImplementation(async () => response(rank()));
    await ranking.submitDailyScore(completedGame());
    vi.resetModules();
    ranking = await import('./ranking');
    await ranking.getDailyRank(completedGame());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requests()[2].headers).toMatchObject({ Authorization: 'Bearer access-one' });
  });

  it('refreshes an expired session once while requests arrive together', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expires_at: NOW / 1000 - 1 })));
    fetchMock.mockResolvedValueOnce(response(session({ access_token: 'access-two', refresh_token: 'refresh-two' })))
      .mockImplementation(async () => response(rank()));
    await Promise.all([ranking.submitDailyScore(completedGame()), ranking.getDailyRank(completedGame())]);
    expect(requests()[0]).toMatchObject({ url: `${URL}/auth/v1/token?grant_type=refresh_token`, body: { refresh_token: 'refresh-one' } });
    expect(requests().slice(1).every(request => (request.headers as Record<string, string>).Authorization === 'Bearer access-two')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers from a rejected access token through refresh, without replacing the player', async () => {
    mockSignedIn();
    fetchMock.mockResolvedValueOnce(response({ secret: 'raw backend error' }, 401))
      .mockResolvedValueOnce(response(session({ access_token: 'access-two', refresh_token: 'refresh-two' })))
      .mockResolvedValueOnce(response(rank()));
    await expect(ranking.submitDailyScore(completedGame())).resolves.toMatchObject({ score: 21 });
    expect(requests().map(request => request.url)).toEqual([
      `${URL}/rest/v1/rpc/submit_daily_score`, `${URL}/auth/v1/token?grant_type=refresh_token`, `${URL}/rest/v1/rpc/submit_daily_score`,
    ]);
    expect(requests()[2].headers).toMatchObject({ Authorization: 'Bearer access-two' });
  });

  it('shares the refresh when simultaneous requests both receive 401', async () => {
    mockSignedIn();
    let rpcCount = 0;
    fetchMock.mockImplementation(async url => {
      if (String(url).includes('/token?')) return response(session({ access_token: 'access-two', refresh_token: 'refresh-two' }));
      return ++rpcCount <= 2 ? response({}, 401) : response(rank());
    });
    await Promise.all([ranking.submitDailyScore(completedGame()), ranking.getDailyRank(completedGame())]);
    expect(requests().filter(request => String(request.url).includes('/token?'))).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('accepts expires_in from signup and persists an absolute expiration', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...session(), expires_at: undefined, expires_in: 3600 }))
      .mockResolvedValueOnce(response(rank()));
    await ranking.submitDailyScore(completedGame());
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).expires_at).toBe(NOW / 1000 + 3600);
  });

  it('never creates another player when an existing refresh token is rejected', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expires_at: NOW / 1000 - 1 })));
    fetchMock.mockImplementation(async () => response({ message: 'refresh-one private diagnostic' }, 400));
    for (let i = 0; i < 2; i++) await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'auth', retryable: false });
    expect(requests().every(request => String(request.url).includes('/token?'))).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).user.id).toBe('player-one');
  });

  it('treats rate-limited refreshes as retryable without replacing the session', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expires_at: NOW / 1000 - 1 })));
    fetchMock.mockResolvedValueOnce(response({}, 429));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'unavailable', retryable: true });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).refresh_token).toBe('refresh-one');
  });

  it('does not replace corrupt saved sessions with a fresh anonymous player', async () => {
    localStorage.setItem(STORAGE_KEY, '{invalid');
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a refresh that changes the player identity', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expires_at: NOW / 1000 - 1 })));
    fetchMock.mockResolvedValueOnce(response(session({ user: { id: 'wrong-player' } })));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'auth' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).user.id).toBe('player-one');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires working storage before signup', async () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('Quota exceeded'); });
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'storage' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains a rotated token when saving it temporarily fails', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session({ expires_at: NOW / 1000 - 1 })));
    const persist = vi.mocked(localStorage.setItem).getMockImplementation()!;
    let fail = true;
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key === STORAGE_KEY && fail) { fail = false; throw new Error('Storage unavailable'); }
      persist(key, value);
    });
    fetchMock.mockResolvedValueOnce(response(session({ access_token: 'access-two', refresh_token: 'refresh-two' })))
      .mockResolvedValueOnce(response(rank()));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'storage' });
    await ranking.submitDailyScore(completedGame());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests()[1].headers).toMatchObject({ Authorization: 'Bearer access-two' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).refresh_token).toBe('refresh-two');
  });

  it('uses a project-scoped Web Lock and adopts a session another tab created', async () => {
    const lock = vi.fn(async (_name, _options, action) => {
      mockSignedIn();
      return action();
    });
    vi.stubGlobal('navigator', { locks: { request: lock } });
    fetchMock.mockResolvedValueOnce(response(rank()));
    await ranking.submitDailyScore(completedGame());
    expect(lock).toHaveBeenCalledWith(STORAGE_KEY, expect.objectContaining({ signal: expect.any(AbortSignal) }), expect.any(Function));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests()[0].url).toContain('submit_daily_score');
  });
});

describe('network failures', () => {
  it('aborts a stalled request and allows a retry with the same identity', async () => {
    mockSignedIn();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })).mockResolvedValueOnce(response(rank()));
    const pending = expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'network', retryable: true });
    await vi.advanceTimersByTimeAsync(12_001);
    await pending;
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    await expect(ranking.submitDailyScore(completedGame())).resolves.toMatchObject({ score: 21 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles offline errors without exposing raw diagnostics', async () => {
    mockSignedIn();
    fetchMock.mockRejectedValue(new Error('access-one secret URL diagnostics'));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'network', message: 'Could not reach the rankings. Try again.' });
  });

  it('handles invalid JSON and server errors with safe, retryable messages', async () => {
    mockSignedIn();
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
      .mockResolvedValueOnce(response({ message: 'private SQL diagnostic' }, 503));
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(ranking.submitDailyScore(completedGame())).rejects.toMatchObject({ code: 'network', retryable: true, message: 'Could not update your daily ranking. Try again.' });
  });
});
