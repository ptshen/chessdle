// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createGame, puzzles, type GameState } from '../lib/game';
import { getDailyRank, isRankingConfigured, rankableDailyGame, submitDailyScore, type DailyRank } from '../lib/ranking';
import { DailyRanking, useDailyRanking } from './DailyRanking';

vi.mock('../lib/ranking', () => ({
  getDailyRank: vi.fn(), submitDailyScore: vi.fn(),
  isRankingConfigured: vi.fn(), rankableDailyGame: vi.fn(),
}));

const today = '2026-10-18';
const rank: DailyRank = {
  day: today, scoringVersion: 3, score: 4.2, rank: 2,
  totalPlayers: 5, betterThanPercentile: 75, tiedPlayers: 1,
  distribution: null,
};

function completedGame(day = today): GameState {
  const game = createGame('daily', day);
  return { ...game, index: 6, finished: false, results: game.puzzleIds.map((id, index) => ({
    puzzleId: id, guess: 'White', answer: 'White', penalty: index === 0 ? rank.score : 0,
    evaluation: puzzles.find(puzzle => puzzle.id === id)!.evaluation,
  })) };
}

// Exercise browser-local date boundaries independently of the test machine's zone.
function mockDeviceOffset(minutes: number) {
  const shifted = (date: Date) => new Date(date.getTime() + minutes * 60_000);
  vi.spyOn(Date.prototype, 'getFullYear').mockImplementation(function (this: Date) { return shifted(this).getUTCFullYear(); });
  vi.spyOn(Date.prototype, 'getMonth').mockImplementation(function (this: Date) { return shifted(this).getUTCMonth(); });
  vi.spyOn(Date.prototype, 'getDate').mockImplementation(function (this: Date) { return shifted(this).getUTCDate(); });
}

function Harness({ game, visible = true }: { game: GameState; visible?: boolean }) {
  const ranking = useDailyRanking(game);
  return visible ? <DailyRanking {...ranking} /> : null;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 18, 12));
  vi.mocked(isRankingConfigured).mockReturnValue(true);
  vi.mocked(rankableDailyGame).mockImplementation(game => game.mode === 'daily' && game.results.length === 7);
  vi.mocked(submitDailyScore).mockResolvedValue(rank);
  vi.mocked(getDailyRank).mockResolvedValue(rank);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

describe('daily percentile', () => {
  it('only confirms a saved score after the server returns its ranking', async () => {
    let resolve!: (value: DailyRank) => void;
    vi.mocked(submitDailyScore).mockReturnValue(new Promise(done => { resolve = done; }));
    render(<Harness game={completedGame()} />);
    expect(screen.getByText('Saving your daily score…')).toBeTruthy();
    expect(screen.queryByText('✓ Saved')).toBeNull();
    await act(async () => resolve(rank));
    expect(screen.getByText('✓ Saved')).toBeTruthy();
  });

  it('plots the server’s first saved score and updates the distribution with the ranking', async () => {
    const savedRank: DailyRank = {
      ...rank, score: 8.5, rank: 4, betterThanPercentile: 25,
      distribution: { binWidth: 0.5, minScore: 0, maxScore: 12,
        bins: [0, 4, 6, 8.5, 12].map(start => ({ start, count: 1 })) },
    };
    vi.mocked(submitDailyScore).mockResolvedValue(savedRank);
    render(<Harness game={completedGame()} />);
    const chart = await screen.findByRole('img', { name: /Daily score distribution/ });
    expect(chart.querySelector('desc')?.textContent).toContain('5 players’ scores');
    expect(screen.getByText('You · 8.50')).toBeTruthy();
    expect(screen.queryByText('You · 4.20')).toBeNull();
    expect(screen.getByText('25%')).toBeTruthy();
    vi.mocked(getDailyRank).mockResolvedValue({ ...savedRank, totalPlayers: 6, betterThanPercentile: 40,
      distribution: { ...savedRank.distribution!, bins: [...savedRank.distribution!.bins.slice(0, -1), { start: 12, count: 2 }] },
    });
    fireEvent(window, new Event('focus'));
    await screen.findByText('40%');
    expect(screen.getByRole('img').querySelector('desc')?.textContent).toContain('6 players’ scores');
  });

  it('retains the confirmed percentile when the deployed database has no chart data yet', async () => {
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText('75%')).toBeTruthy();
    expect(screen.getByText('✓ Saved')).toBeTruthy();
    expect(screen.getByText('Score chart unavailable.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('submits all seven answers before opening results and does not resubmit on finishing', async () => {
    const game = completedGame();
    const view = render(<Harness game={game} visible={false} />);
    await waitFor(() => expect(submitDailyScore).toHaveBeenCalledExactlyOnceWith(game));
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<Harness game={{ ...game, finished: true }} />);
    expect(await screen.findByText(/Better than/)).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByText('#2 of 5 players · so far')).toBeTruthy();
    expect(screen.getByText('✓ Saved')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(1);
  });

  it('does not submit incomplete games, practice games, or games without configuration', () => {
    const game = completedGame();
    const view = render(<Harness game={{ ...game, results: game.results.slice(0, 6) }} />);
    view.rerender(<Harness game={{ ...game, mode: 'practice' }} />);
    vi.mocked(isRankingConfigured).mockReturnValue(false);
    view.rerender(<Harness game={game} />);
    expect(submitDailyScore).not.toHaveBeenCalled();
    expect(getDailyRank).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps migrated daily positions out of an incompatible comparison pool', () => {
    vi.mocked(rankableDailyGame).mockReturnValue(false);
    render(<Harness game={completedGame()} />);
    expect(screen.getByText('This earlier daily isn’t ranked.')).toBeTruthy();
    expect(submitDailyScore).not.toHaveBeenCalled();
  });

  it('shows a first-player normal estimate without inventing a percentile', async () => {
    vi.mocked(submitDailyScore).mockResolvedValue({ ...rank, rank: 1, totalPlayers: 1, betterThanPercentile: null,
      distribution: { binWidth: 0.5, minScore: rank.score, maxScore: rank.score, bins: [{ start: 4, count: 1 }] },
    });
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText('You’re the first to finish!')).toBeTruthy();
    expect(screen.getByText('#1 of 1 player · so far')).toBeTruthy();
    expect(screen.getByText('Normal estimate')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Daily score distribution/ })).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('shows tied ranks and preserves a zero percentile', async () => {
    vi.mocked(submitDailyScore).mockResolvedValue({ ...rank, rank: 1, tiedPlayers: 5, betterThanPercentile: 0,
      distribution: { binWidth: 0.5, minScore: rank.score, maxScore: rank.score, bins: [{ start: 4, count: 5 }] },
    });
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText('0%')).toBeTruthy();
    expect(screen.getByText('Tied #1 of 5 players · so far')).toBeTruthy();
    expect(screen.getByText('Normal estimate')).toBeTruthy();
  });

  it('identifies the immutable ranked score when another local result differs', async () => {
    vi.mocked(submitDailyScore).mockResolvedValue({ ...rank, score: 8.5 });
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText('Ranked score: 8.50 · first result')).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('keeps matching scores concise after rounding to displayed precision', async () => {
    const game = completedGame();
    game.results[0].penalty = 4.204;
    render(<Harness game={game} />);
    await screen.findByText('75%');
    expect(screen.queryByText(/Ranked score:/)).toBeNull();
  });

  it('retries a failed upload without blocking local results', async () => {
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Network offline'));
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText(/Your score is saved on this device/)).toBeTruthy();
    expect(screen.queryByText('✓ Saved')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('75%')).toBeTruthy();
    expect(screen.getByText('✓ Saved')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(2);
  });

  it('finishes an offline daily upload while practicing without showing its ranking there', async () => {
    let resolveUpload!: (value: DailyRank) => void;
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Network offline'))
      .mockReturnValueOnce(new Promise(resolve => { resolveUpload = resolve; }));
    const view = render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    view.rerender(<Harness game={createGame('practice', today)} />);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent(window, new Event('online'));
    expect(submitDailyScore).toHaveBeenCalledTimes(2);
    await act(async () => resolveUpload(rank));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent(window, new Event('focus'));
    expect(getDailyRank).not.toHaveBeenCalled();
    expect(submitDailyScore).toHaveBeenCalledTimes(2);
  });

  it('stops a background daily upload at local midnight while practice continues', async () => {
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Network offline'));
    vi.mocked(getDailyRank).mockResolvedValue(null);
    const view = render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    view.rerender(<Harness game={createGame('practice', today)} />);
    vi.setSystemTime(new Date(2026, 9, 19, 0, 0, 1));
    await act(async () => { fireEvent(window, new Event('online')); });
    expect(getDailyRank).toHaveBeenCalledTimes(1);
    fireEvent(window, new Event('focus'));
    expect(submitDailyScore).toHaveBeenCalledTimes(1);
    expect(getDailyRank).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('refreshes after other players finish and retains a marked stale rank on network failure', async () => {
    render(<Harness game={completedGame()} />);
    await screen.findByText('75%');
    vi.mocked(getDailyRank).mockResolvedValueOnce({ ...rank, totalPlayers: 9, betterThanPercentile: 87.5 });
    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('87.5%')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(1);
    vi.mocked(getDailyRank).mockRejectedValueOnce(new Error('Offline'));
    fireEvent(window, new Event('online'));
    expect(await screen.findByText(/Update unavailable/)).toBeTruthy();
    expect(screen.getByText('87.5%')).toBeTruthy();
    expect(screen.getByText('✓ Saved')).toBeTruthy();
  });

  it('reads an older daily without submitting it into today’s results', async () => {
    vi.setSystemTime(new Date(2026, 9, 19, 12));
    render(<Harness game={completedGame()} />);
    expect(await screen.findByText(/that day’s other players/)).toBeTruthy();
    expect(submitDailyScore).not.toHaveBeenCalled();
    expect(getDailyRank).toHaveBeenCalledTimes(1);
  });

  it('does not upload a late score after local midnight', async () => {
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Offline'));
    vi.mocked(getDailyRank).mockResolvedValue(null);
    render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    vi.setSystemTime(new Date(2026, 9, 19, 0, 0, 1));
    fireEvent(window, new Event('online'));
    expect(await screen.findByText('This daily’s submissions have closed.')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(1);
  });

  it('keeps uploads and today’s ranking open across UTC midnight on the same local day', async () => {
    mockDeviceOffset(-4 * 60);
    vi.setSystemTime(new Date('2026-10-18T23:59:59Z'));
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Offline'));
    render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    vi.setSystemTime(new Date('2026-10-19T00:00:01Z'));
    fireEvent(window, new Event('online'));
    expect(await screen.findByText('Today’s scores')).toBeTruthy();
    expect(screen.getByText('#2 of 5 players · so far')).toBeTruthy();
    expect(screen.getByText(/today’s other players/)).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(2);
    expect(getDailyRank).not.toHaveBeenCalled();
  });

  it('keeps an offline upload active during practice when UTC advances before local midnight', async () => {
    mockDeviceOffset(-4 * 60);
    vi.setSystemTime(new Date('2026-10-18T23:59:59Z'));
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Offline'));
    const view = render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    vi.setSystemTime(new Date('2026-10-19T00:00:01Z'));
    view.rerender(<Harness game={createGame('practice', today)} />);
    await act(async () => { fireEvent(window, new Event('online')); });
    expect(submitDailyScore).toHaveBeenCalledTimes(2);
    expect(getDailyRank).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uploads the new local day’s score when that calendar date is still tomorrow in UTC', async () => {
    mockDeviceOffset(10 * 60);
    vi.setSystemTime(new Date('2026-10-18T14:00:01Z'));
    const game = completedGame('2026-10-19');
    vi.mocked(submitDailyScore).mockResolvedValue({ ...rank, day: game.date });
    render(<Harness game={game} />);
    expect(await screen.findByText('Today’s scores')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledExactlyOnceWith(game);
    expect(getDailyRank).not.toHaveBeenCalled();
  });

  it('still fetches a saved previous-day score after local midnight without another submission', async () => {
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 59));
    vi.mocked(submitDailyScore).mockRejectedValueOnce(new Error('Offline'));
    render(<Harness game={completedGame()} />);
    await screen.findByText(/Your score is saved on this device/);
    vi.setSystemTime(new Date(2026, 9, 19, 0, 0, 1));
    fireEvent(window, new Event('online'));
    expect(await screen.findByText('Daily scores')).toBeTruthy();
    expect(screen.getByText('✓ Saved')).toBeTruthy();
    expect(screen.getByText('#2 of 5 players · 2026-10-18')).toBeTruthy();
    expect(submitDailyScore).toHaveBeenCalledTimes(1);
    expect(getDailyRank).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending daily upload out of the practice UI and stops after saving', async () => {
    let resolve!: (value: DailyRank) => void;
    vi.mocked(submitDailyScore).mockReturnValue(new Promise(done => { resolve = done; }));
    const game = completedGame();
    const view = render(<Harness game={game} />);
    view.rerender(<Harness game={{ ...game, mode: 'practice' }} />);
    await act(async () => resolve(rank));
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent(window, new Event('focus'));
    expect(getDailyRank).not.toHaveBeenCalled();
  });
});
