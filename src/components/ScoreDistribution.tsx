import { useId, useMemo } from 'react';
import type { ScoreDistribution as Distribution } from '../lib/ranking';
import { buildDistributionPlot } from '../lib/distribution';
import './ScoreDistribution.css';

interface Props { distribution: Distribution | null; score: number; totalPlayers: number; }
const LEFT = 20;
const RIGHT = 340;
const TOP = 42;
const BASELINE = 138;
const formatTick = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value);

export function ScoreDistribution({ distribution, score, totalPlayers }: Props) {
  const id = useId();
  const plot = useMemo(() => distribution ? buildDistributionPlot(distribution, score, totalPlayers) : null, [distribution, score, totalPlayers]);
  if (!distribution || !plot) return <p className="score-distribution-unavailable">Score chart unavailable.</p>;

  const x = (value: number) => LEFT + value / plot.domainMax * (RIGHT - LEFT);
  const y = (density: number) => BASELINE - density / plot.maxDensity * (BASELINE - TOP);
  const markerX = x(score);
  const markerY = y(plot.markerDensity);
  const line = plot.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.score).toFixed(2)},${y(point.density).toFixed(2)}`).join(' ');
  const labelX = Math.min(RIGHT - 52, Math.max(LEFT + 52, markerX));
  const recordedScores = `${totalPlayers.toLocaleString()} ${totalPlayers === 1 ? 'player’s score' : 'players’ scores'}, from ${distribution.minScore.toFixed(2)} to ${distribution.maxScore.toFixed(2)} points.`;
  const description = plot.kind === 'normal'
    ? `Normal estimate based on ${recordedScores} A minimum spread is assumed while results are sparse or identical. Rankings use actual scores.`
    : `Smoothed distribution of ${recordedScores}`;

  return <figure className="score-distribution">
    <svg viewBox="0 0 360 170" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>Daily score distribution</title>
      <desc id={`${id}-description`}>{description} Your ranked score is {score.toFixed(2)} points. Lower scores are better.</desc>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#668e70" stopOpacity=".3" />
          <stop offset="100%" stopColor="#668e70" stopOpacity=".025" />
        </linearGradient>
        <clipPath id={`${id}-clip`}><rect x={LEFT - 2} y={TOP - 2} width={RIGHT - LEFT + 4} height={BASELINE - TOP + 4} /></clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <path className="score-distribution-area" d={`${line} L${RIGHT},${BASELINE} L${LEFT},${BASELINE} Z`} fill={`url(#${id}-fill)`} />
        <path className="score-distribution-curve" d={line} />
      </g>
      <line className="score-distribution-axis" x1={LEFT} y1={BASELINE} x2={RIGHT} y2={BASELINE} />
      {plot.ticks.map(tick => <g key={tick}>
        <line className="score-distribution-axis" x1={x(tick)} y1={BASELINE} x2={x(tick)} y2={BASELINE + 4} />
        <text className="score-distribution-tick" x={x(tick)} y={BASELINE + 19} textAnchor="middle">{formatTick(tick)}</text>
      </g>)}
      <line className="score-distribution-marker-line" x1={markerX} y1={31} x2={markerX} y2={BASELINE} />
      <circle className="score-distribution-marker" cx={markerX} cy={markerY} r={4.5} />
      <rect className="score-distribution-label-bg" x={labelX - 52} y={7} width={104} height={24} rx={12} />
      <text className="score-distribution-label" x={labelX} y={23} textAnchor="middle">You · {score.toFixed(2)}</text>
    </svg>
    <figcaption>
      <span>← Lower score is better</span>
      <span>{plot.kind === 'normal' ? 'Normal estimate' : 'Smoothed · points'}</span>
    </figcaption>
  </figure>;
}
