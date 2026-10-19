import { useEffect, useState } from 'react';
import { type GameState, totalScore, localDate } from '../lib/game';
import { getDailyRank, isRankingConfigured, rankableDailyGame, submitDailyScore, type DailyRank } from '../lib/ranking';
import { ScoreDistribution } from './ScoreDistribution';

type RankingState =
  | { status: 'hidden' | 'loading' | 'unranked' | 'closed' }
  | { status: 'ready'; rank: DailyRank; stale: boolean }
  | { status: 'error' };

const rankingKey = (game: GameState) => `${game.id}:${game.scoringVersion}:${game.puzzleIds.join(',')}`;

/** Submit on the seventh answer, even before the player opens their results. */
export function useDailyRanking(game: GameState) {
  const eligible = rankableDailyGame(game);
  const enabled = isRankingConfigured();
  const key = rankingKey(game);
  const [snapshot, setSnapshot] = useState<{ key: string; state: RankingState } | null>(null);
  const [retainedDaily, setRetainedDaily] = useState<GameState | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (eligible) setRetainedDaily(game);
  }, [eligible, game]);

  const retainedSaved = retainedDaily && snapshot?.key === rankingKey(retainedDaily) && snapshot.state.status === 'ready';
  // Keep an offline upload alive while the player practices. Stop background
  // work once it is saved or the device's current local day has ended.
  const target = eligible ? game : game.mode === 'practice' && retainedDaily?.date === localDate() && !retainedSaved ? retainedDaily : null;
  const targetKey = target ? rankingKey(target) : '';

  useEffect(() => {
    if (!enabled || !target) return;
    const daily = target;
    let active = true;
    let pending = false;
    let closed = false;
    let submitted = false;
    let lastRank: DailyRank | null = null;
    const update = (state: RankingState) => { if (active) setSnapshot({ key: targetKey, state }); };

    async function sync() {
      if (pending || !active || closed) return;
      pending = true;
      const currentDay = daily.date === localDate();
      try {
        // After local midnight only read a previously submitted result;
        // never submit it to the next day's pool.
        const rank = !submitted && currentDay
          ? await submitDailyScore(daily)
          : await getDailyRank(daily);
        if (!active) return;
        submitted = rank !== null;
        lastRank = rank;
        update(rank ? { status: 'ready', rank, stale: false } : { status: 'closed' });
      } catch {
        update(lastRank ? { status: 'ready', rank: lastRank, stale: true } : { status: 'error' });
      } finally {
        pending = false;
        if (!currentDay) closed = true;
      }
    }

    update({ status: 'loading' });
    void sync();
    const refresh = () => { if (document.visibilityState !== 'hidden') void sync(); };
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, targetKey, target?.date, target?.results, retry]);

  let state: RankingState;
  if (!enabled || game.mode !== 'daily' || game.results.length !== 7) state = { status: 'hidden' };
  else if (!eligible) state = { status: 'unranked' };
  else state = snapshot?.key === key ? snapshot.state : { status: 'loading' };
  return { state, currentScore: totalScore(game.results), refresh: () => setRetry(value => value + 1) };
}

export function DailyRanking({ state, currentScore, refresh }: ReturnType<typeof useDailyRanking>) {
  if (state.status === 'hidden') return null;
  const retry = <button type="button" className="text-button ranking-retry" onClick={refresh}>Retry</button>;
  let content;
  if (state.status === 'loading') content = <p>Saving your daily score…</p>;
  else if (state.status === 'error') content = <p>Ranking unavailable. Your score is saved on this device. {retry}</p>;
  else if (state.status === 'unranked') content = <p>This earlier daily isn’t ranked.</p>;
  else if (state.status === 'closed') content = <p>This daily’s submissions have closed.</p>;
  else if (state.status === 'ready') {
    const { rank } = state;
    const today = rank.day === localDate();
    // A single player has no comparison group; never fabricate a percentile.
    const percentile = rank.betterThanPercentile === null ? null
      : new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(rank.betterThanPercentile);
    content = <>
      <div className="ranking-header"><span>{today ? 'Today’s scores' : 'Daily scores'}</span><span className="ranking-saved" title="Your daily score is saved online">✓ Saved</span></div>
      <p className="ranking-headline">{percentile === null
        ? 'You’re the first to finish!'
        : <>Better than <strong>{percentile}%</strong> of {today ? 'today’s' : 'that day’s'} other players</>}</p>
      <p className="ranking-detail">{rank.tiedPlayers > 1 ? 'Tied ' : ''}#{rank.rank.toLocaleString()} of {rank.totalPlayers.toLocaleString()} {rank.totalPlayers === 1 ? 'player' : 'players'} · {today ? 'so far' : rank.day}</p>
      <ScoreDistribution distribution={rank.distribution} score={rank.score} totalPlayers={rank.totalPlayers} />
      {rank.score.toFixed(2) !== currentScore.toFixed(2) && <p className="ranking-detail">Ranked score: {rank.score.toFixed(2)} · first result</p>}
      {state.stale && <p className="ranking-detail">Update unavailable. {retry}</p>}
    </>;
  } else return null;
  return <div className="daily-ranking" role="status" aria-live="polite">{content}</div>;
}
