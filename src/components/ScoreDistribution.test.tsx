// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ScoreDistribution as Distribution } from '../lib/ranking';
import { buildDistributionPlot } from '../lib/distribution';
import { ScoreDistribution } from './ScoreDistribution';

const distribution: Distribution = {
  binWidth: 0.5, minScore: 0, maxScore: 14.99,
  bins: [{ start: 0, count: 1 }, { start: 4, count: 4 }, { start: 8, count: 3 }, { start: 14.5, count: 1 }],
};

afterEach(cleanup);

describe('score distribution chart', () => {
  it('renders a compact, accessible smooth chart using real player counts and range', () => {
    const { container } = render(<ScoreDistribution distribution={distribution} score={4.2} totalPlayers={9} />);
    const chart = screen.getByRole('img', { name: /Daily score distribution/ });
    expect(chart.getAttribute('viewBox')).toBe('0 0 360 170');
    expect(chart.querySelector('desc')?.textContent).toContain('9 players’ scores, from 0.00 to 14.99 points');
    expect(chart.querySelector('desc')?.textContent).toContain('Your ranked score is 4.20 points. Lower scores are better.');
    const curve = container.querySelector('.score-distribution-curve')!;
    expect(curve.getAttribute('d')).toMatch(/^M/);
    expect(curve.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector('.score-distribution-area')).toBeTruthy();
    expect(screen.getByText('Smoothed · points')).toBeTruthy();
  });

  it('marks the exact ranked score instead of the bucket midpoint', () => {
    const { container } = render(<ScoreDistribution distribution={distribution} score={4.2} totalPlayers={9} />);
    const plot = buildDistributionPlot(distribution, 4.2, 9);
    expect(Number(container.querySelector('.score-distribution-marker')?.getAttribute('cx')))
      .toBeCloseTo(20 + 4.2 / plot.domainMax * 320, 8);
    expect(screen.getByText('You · 4.20')).toBeTruthy();
  });

  it.each([0, 179])('keeps the score marker and label inside the chart at %i points', score => {
    const data: Distribution = { binWidth: 0.5, minScore: 0, maxScore: 179,
      bins: [{ start: 0, count: 1 }, { start: 179, count: 1 }] };
    const { container } = render(<ScoreDistribution distribution={data} score={score} totalPlayers={2} />);
    const markerX = Number(container.querySelector('.score-distribution-marker')?.getAttribute('cx'));
    expect(markerX).toBe(score === 0 ? 20 : 340);
    const labelX = Number(container.querySelector('.score-distribution-label-bg')?.getAttribute('x'));
    expect(labelX).toBeGreaterThanOrEqual(20);
    expect(labelX + 104).toBeLessThanOrEqual(340);
    expect(container.querySelector('.score-distribution-curve')?.getAttribute('d')).not.toMatch(/NaN|Infinity/);
  });

  it('draws a labeled normal estimate for a single player', () => {
    const { container } = render(<ScoreDistribution distribution={{ binWidth: 0.5, minScore: 4.2, maxScore: 4.2,
      bins: [{ start: 4, count: 1 }] }} score={4.2} totalPlayers={1} />);
    expect(screen.getByText('Normal estimate')).toBeTruthy();
    const curve = container.querySelector('.score-distribution-curve');
    expect(curve?.getAttribute('d')).toMatch(/^M/);
    expect(curve?.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector('.score-distribution-marker')).toBeTruthy();
    expect(screen.getByText('You · 4.20')).toBeTruthy();
    expect(screen.getByRole('img').querySelector('desc')?.textContent).toContain('Normal estimate based on 1 player’s score');
    expect(screen.getByRole('img').querySelector('desc')?.textContent).toContain('Rankings use actual scores.');
  });

  it('uses a normal estimate when all recorded scores are tied', () => {
    const { container } = render(<ScoreDistribution distribution={{ binWidth: 0.5, minScore: 0, maxScore: 0,
      bins: [{ start: 0, count: 80 }] }} score={0} totalPlayers={80} />);
    expect(screen.getByText('Normal estimate')).toBeTruthy();
    expect(container.querySelector('.score-distribution-curve')?.getAttribute('d')).toMatch(/^M/);
    expect(screen.getByRole('img').querySelector('desc')?.textContent).toContain('80 players’ scores, from 0.00 to 0.00 points');
  });

  it('labels sparse results as a normal estimate', () => {
    render(<ScoreDistribution distribution={{ binWidth: 0.5, minScore: 4, maxScore: 8,
      bins: [{ start: 4, count: 1 }, { start: 8, count: 1 }] }} score={4} totalPlayers={2} />);
    expect(screen.getByText('Normal estimate')).toBeTruthy();
  });

  it('switches from a normal estimate to the observed distribution when more players finish', () => {
    const sparse: Distribution = { binWidth: 0.5, minScore: 2, maxScore: 8,
      bins: [2, 4, 6, 8].map(start => ({ start, count: 1 })) };
    const view = render(<ScoreDistribution distribution={sparse} score={4} totalPlayers={4} />);
    expect(screen.getByText('Normal estimate')).toBeTruthy();
    const oldPath = view.container.querySelector('.score-distribution-curve')?.getAttribute('d');
    view.rerender(<ScoreDistribution distribution={{ ...sparse, maxScore: 10,
      bins: [...sparse.bins, { start: 10, count: 1 }] }} score={4} totalPlayers={5} />);
    expect(screen.queryByText('Normal estimate')).toBeNull();
    expect(screen.getByText('Smoothed · points')).toBeTruthy();
    expect(view.container.querySelector('.score-distribution-curve')?.getAttribute('d')).not.toBe(oldPath);
    expect(screen.getByText('You · 4.00')).toBeTruthy();
  });

  it('handles an older backend without fabricating chart data', () => {
    render(<ScoreDistribution distribution={null} score={4.2} totalPlayers={9} />);
    expect(screen.getByText('Score chart unavailable.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('uses unique SVG resources when more than one chart is displayed', () => {
    const { container } = render(<><ScoreDistribution distribution={distribution} score={4.2} totalPlayers={9} />
      <ScoreDistribution distribution={distribution} score={8} totalPlayers={9} /></>);
    const gradientIds = [...container.querySelectorAll('linearGradient')].map(gradient => gradient.id);
    expect(new Set(gradientIds).size).toBe(2);
    container.querySelectorAll('.score-distribution-area').forEach((area, index) =>
      expect(area.getAttribute('fill')).toBe(`url(#${gradientIds[index]})`));
  });
});
