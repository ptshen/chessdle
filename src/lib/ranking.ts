import { SCORING_VERSION } from './scoring';
import { selectPuzzles, type GameState } from './game';

export interface ScoreDistribution {
  binWidth: number;
  minScore: number;
  maxScore: number;
  bins: { start: number; count: number }[];
}

export interface DailyRank {
  day: string;
  scoringVersion: number;
  score: number;
  rank: number;
  totalPlayers: number;
  betterThanPercentile: number | null;
  tiedPlayers: number;
  distribution: ScoreDistribution | null;
}

type ErrorCode = 'unavailable' | 'storage' | 'auth' | 'network' | 'invalid_response' | 'ineligible' | 'rejected';
export class RankingError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly retryable = true) {
    super(message);
    this.name = 'RankingError';
  }
}

interface Configuration { url: string; key: string; storageKey: string; }
interface Session { access_token: string; refresh_token: string; expires_at: number; user: { id: string }; }
interface SessionState { session?: Session; pending?: Promise<Session>; unpersisted?: boolean; }
const sessions = new Map<string, SessionState>();
const ROUND_LIMITS = [10, 10, 30, 30, 40, 40, 19];
const REQUEST_TIMEOUT = 12_000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function configuration(): Configuration | null {
  const rawUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!rawUrl || !key) return null;
  try {
    const url = new URL(rawUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || !/^\/*$/.test(url.pathname)) return null;
    if (!key.startsWith('sb_publishable_')) {
      // Old anon JWTs are public. Never send a service-role or secret key from a browser.
      const parts = key.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
      if (!object(payload) || payload.role !== 'anon') return null;
    } else if (key.length === 'sb_publishable_'.length) return null;
    return { url: url.origin, key, storageKey: `chessdle:supabase:${url.origin}:session` };
  } catch { return null; }
}

export const isRankingConfigured = () => configuration() !== null;

/** Only the current, shared daily board set belongs in the shared ranking. */
export function rankableDailyGame(game: GameState): boolean {
  if (game.mode !== 'daily' || game.scoringVersion !== SCORING_VERSION || game.index !== 6 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(game.date) || !Number.isFinite(Date.parse(game.date)) ||
    new Date(game.date).toISOString().slice(0, 10) !== game.date || game.id !== `chessdle-v1-${game.date}` ||
    !Array.isArray(game.puzzleIds) || game.puzzleIds.length !== 7 || !Array.isArray(game.results) || game.results.length !== 7) return false;
  const canonical = selectPuzzles(game.id);
  return game.puzzleIds.every((id, index) => id === canonical[index]) && game.results.every((result, index) =>
    result && result.puzzleId === canonical[index] && typeof result.penalty === 'number' &&
    Number.isFinite(result.penalty) && result.penalty >= 0 && result.penalty <= ROUND_LIMITS[index]);
}

function readSession(config: Configuration): Session | undefined {
  let raw: string | null;
  try { raw = localStorage.getItem(config.storageKey); }
  catch { throw new RankingError('storage', 'Enable browser storage to save your daily ranking.', false); }
  if (raw === null) return undefined;
  try { return parseSession(JSON.parse(raw)); }
  catch { throw new RankingError('auth', 'Your ranking session could not be restored. Your score is still saved on this device.', false); }
}

function parseSession(value: unknown): Session {
  if (!object(value) || typeof value.access_token !== 'string' || !value.access_token ||
    typeof value.refresh_token !== 'string' || !value.refresh_token || !object(value.user) ||
    typeof value.user.id !== 'string' || !value.user.id) throw new RankingError('invalid_response', 'Rankings returned an invalid response. Try again.');
  const expiresAt = typeof value.expires_at === 'number' ? value.expires_at :
    typeof value.expires_in === 'number' ? Math.floor(Date.now() / 1000) + value.expires_in : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new RankingError('invalid_response', 'Rankings returned an invalid response. Try again.');
  return { access_token: value.access_token, refresh_token: value.refresh_token, expires_at: expiresAt, user: { id: value.user.id } };
}

function persistSession(config: Configuration, session: Session) {
  try { localStorage.setItem(config.storageKey, JSON.stringify(session)); }
  catch { throw new RankingError('storage', 'Enable browser storage to save your daily ranking.', false); }
}

function ensureWritableStorage(config: Configuration) {
  const key = `${config.storageKey}:check`;
  try { localStorage.setItem(key, '1'); localStorage.removeItem(key); }
  catch { throw new RankingError('storage', 'Enable browser storage to save your daily ranking.', false); }
}

class HttpError extends Error { constructor(public status: number) { super('Ranking request failed'); } }
async function request(config: Configuration, path: string, body: unknown, token?: string): Promise<unknown> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: { apikey: config.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: abort.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) throw new HttpError(response.status);
    try { return await response.json(); }
    catch (error) {
      if (abort.signal.aborted) throw error;
      throw new RankingError('invalid_response', 'Rankings returned an invalid response. Try again.');
    }
  } catch (error) {
    if (error instanceof HttpError || error instanceof RankingError) throw error;
    throw new RankingError('network', 'Could not reach the rankings. Try again.');
  } finally { clearTimeout(timeout); }
}

async function withSessionLock<T>(config: Configuration, action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);
    try { return await navigator.locks.request(config.storageKey, { signal: abort.signal }, action); }
    catch (error) {
      if (abort.signal.aborted && !(error instanceof RankingError)) throw new RankingError('network', 'Rankings are busy. Try again.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  return action();
}

async function sessionFor(config: Configuration, rejectedToken?: string): Promise<Session> {
  let state = sessions.get(config.storageKey);
  if (!state) { state = {}; sessions.set(config.storageKey, state); }
  if (state.pending) {
    const session = await state.pending;
    if (!rejectedToken || session.access_token !== rejectedToken) return session;
    return sessionFor(config, rejectedToken);
  }
  const current = state;
  const pending = withSessionLock(config, async () => {
    let saved = readSession(config);
    if (current.unpersisted && current.session) {
      // Retain a rotated refresh token if storage briefly failed after refresh.
      persistSession(config, current.session);
      saved = current.session;
      current.unpersisted = false;
    }
    const previous = saved ?? current.session;
    if (previous && previous.expires_at * 1000 > Date.now() + 30_000 && previous.access_token !== rejectedToken) {
      if (!saved) persistSession(config, previous);
      current.session = previous;
      return previous;
    }
    // Storage must work before creating an identity, so reloads cannot create extra players.
    ensureWritableStorage(config);
    let response: unknown;
    try {
      response = previous
        ? await request(config, '/auth/v1/token?grant_type=refresh_token', { refresh_token: previous.refresh_token })
        : await request(config, '/auth/v1/signup', { data: {} });
    } catch (error) {
      if (error instanceof HttpError) {
        if (previous && [400, 401, 403].includes(error.status)) throw new RankingError('auth', 'Your ranking session has expired. Your score is still saved on this device.', false);
        throw new RankingError('unavailable', 'Ranking sign-in is unavailable. Try again later.');
      }
      throw error;
    }
    const session = parseSession(response);
    // A refresh must retain the original player even if a backend response is unexpected.
    if (previous && previous.user.id !== session.user.id) throw new RankingError('auth', 'Your ranking session could not be restored.', false);
    current.session = session;
    current.unpersisted = true;
    persistSession(config, session);
    current.unpersisted = false;
    return session;
  });
  current.pending = pending;
  try { return await pending; }
  finally { if (current.pending === pending) current.pending = undefined; }
}

function parseDistribution(value: unknown, rank: Omit<DailyRank, 'distribution'>): ScoreDistribution | null {
  // Older deployments still provide a valid ranking without distribution data.
  // A malformed histogram must not hide a confirmed score or fabricate a curve.
  if (!object(value) || value.bin_width !== 0.5 ||
    typeof value.min_score !== 'number' || !Number.isFinite(value.min_score) || value.min_score < 0 ||
    typeof value.max_score !== 'number' || !Number.isFinite(value.max_score) || value.max_score > 179 ||
    value.min_score > value.max_score || rank.score < value.min_score || rank.score > value.max_score ||
    !Array.isArray(value.bins) || value.bins.length < 1 || value.bins.length > 359) return null;

  const bins: ScoreDistribution['bins'] = [];
  const playerBucket = Math.floor(rank.score * 2) / 2;
  let total = 0;
  let previous = -1;
  let playersBelowBucket = 0;
  let playersInBucket = 0;
  for (const bin of value.bins) {
    if (!object(bin) || typeof bin.start !== 'number' || !Number.isFinite(bin.start) ||
      bin.start < 0 || bin.start > 179 || bin.start <= previous || !Number.isInteger(bin.start * 2) ||
      typeof bin.count !== 'number' || !Number.isSafeInteger(bin.count) || bin.count <= 0 ||
      bin.count > rank.totalPlayers - total) return null;
    bins.push({ start: bin.start, count: bin.count });
    previous = bin.start;
    total += bin.count;
    if (bin.start < playerBucket) playersBelowBucket += bin.count;
    if (bin.start === playerBucket) playersInBucket = bin.count;
  }
  if (total !== rank.totalPlayers ||
    bins[0].start !== Math.floor(value.min_score * 2) / 2 ||
    bins[bins.length - 1].start !== Math.floor(value.max_score * 2) / 2 ||
    playersInBucket < rank.tiedPlayers || playersBelowBucket > rank.rank - 1 ||
    rank.rank - 1 - playersBelowBucket > playersInBucket - rank.tiedPlayers) return null;
  return { binWidth: value.bin_width, minScore: value.min_score, maxScore: value.max_score, bins };
}

function parseRank(value: unknown, game: GameState): DailyRank {
  const invalid = () => new RankingError('invalid_response', 'Rankings returned an invalid response. Try again.');
  if (!object(value) || value.day !== game.date || value.scoring_version !== SCORING_VERSION ||
    typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 179 ||
    !Number.isSafeInteger(value.rank) || Number(value.rank) < 1 ||
    !Number.isSafeInteger(value.total_players) || Number(value.total_players) < Number(value.rank) ||
    !Number.isSafeInteger(value.tied_players) || Number(value.tied_players) < 1 ||
    Number(value.tied_players) > Number(value.total_players) - Number(value.rank) + 1) throw invalid();
  const percentile = value.better_than_percentile;
  if (value.total_players === 1 ? percentile !== null :
    typeof percentile !== 'number' || !Number.isFinite(percentile) || percentile < 0 || percentile > 100) throw invalid();
  const rank = { day: value.day as string, scoringVersion: value.scoring_version as number, score: value.score,
    rank: value.rank as number, totalPlayers: value.total_players as number,
    betterThanPercentile: percentile as number | null, tiedPlayers: value.tied_players as number };
  return { ...rank, distribution: parseDistribution(value.distribution, rank) };
}

async function dailyRank(game: GameState, submit: boolean): Promise<DailyRank | null> {
  const config = configuration();
  if (!config) throw new RankingError('unavailable', 'Rankings are not configured.', false);
  if (!rankableDailyGame(game)) throw new RankingError('ineligible', 'This game is not eligible for the daily ranking.', false);
  const body = { p_day: game.date, p_scoring_version: SCORING_VERSION, p_puzzle_ids: game.puzzleIds,
    ...(submit ? { p_round_penalties: game.results.map(result => result.penalty) } : {}) };
  const path = `/rest/v1/rpc/${submit ? 'submit_daily_score' : 'get_daily_rank'}`;
  let session = await sessionFor(config);
  let response: unknown;
  try {
    try { response = await request(config, path, body, session.access_token); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      session = await sessionFor(config, session.access_token);
      response = await request(config, path, body, session.access_token);
    }
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) throw new RankingError('auth', 'Your ranking session could not be restored.', false);
      throw new RankingError(error.status >= 500 ? 'network' : 'rejected', 'Could not update your daily ranking. Try again.', error.status >= 500 || error.status === 429);
    }
    throw error;
  }
  if (response === null && !submit) return null;
  return parseRank(response, game);
}

export async function submitDailyScore(game: GameState): Promise<DailyRank> {
  return await dailyRank(game, true) as DailyRank;
}
export const getDailyRank = (game: GameState): Promise<DailyRank | null> => dailyRank(game, false);
