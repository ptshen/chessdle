import { describe, expect, it } from 'vitest';
import { buildDistributionPlot, MIN_DISTRIBUTION_PLAYERS } from './distribution';
import type { ScoreDistribution } from './ranking';

function histogram(scores: number[]): ScoreDistribution {
  const counts = new Map<number, number>();
  scores.forEach(score => { const start = Math.floor(score * 2) / 2; counts.set(start, (counts.get(start) ?? 0) + 1); });
  return { binWidth: 0.5, minScore: Math.min(...scores), maxScore: Math.max(...scores),
    bins: [...counts].sort(([a], [b]) => a - b).map(([start, count]) => ({ start, count })) };
}

function areaUnderCurve(plot: ReturnType<typeof buildDistributionPlot>) {
  return plot.points.slice(1).reduce((sum, point, index) =>
    sum + (point.score - plot.points[index].score) * (point.density + plot.points[index].density) / 2, 0);
}

describe('score distribution density', () => {
  it('keeps a low-scoring field readable while preserving zero and every observed tail', () => {
    const compact = buildDistributionPlot(histogram([0, 1, 2, 2.5, 3]), 2.1, 5);
    expect(compact.points[0].score).toBe(0);
    expect(compact.domainMax).toBeGreaterThanOrEqual(3);
    expect(compact.domainMax).toBeLessThan(15);
    const outlier = buildDistributionPlot(histogram([0, 1, 2, 2.5, 178.9]), 2.1, 5);
    expect(outlier.domainMax).toBe(179);
    expect(outlier.ticks.at(-1)).toBe(179);
  });

  it('estimates weighted density from the real bucket counts', () => {
    const data: ScoreDistribution = { binWidth: 0.5, minScore: 2, maxScore: 8,
      bins: [{ start: 2, count: 90 }, { start: 8, count: 10 }] };
    const low = buildDistributionPlot(data, 2.25, 100);
    const high = buildDistributionPlot(data, 8, 100);
    expect(low.markerDensity).toBeGreaterThan(high.markerDensity * 5);
    expect(low.points).toEqual(high.points);
  });

  it.each([0, 179])('keeps density at the %i-point boundary on legal scores with approximately unit mass', boundary => {
    const data: ScoreDistribution = { binWidth: 0.5, minScore: 0, maxScore: 179,
      bins: [{ start: 0, count: boundary === 0 ? 990 : 10 }, { start: 179, count: boundary === 179 ? 990 : 10 }] };
    const plot = buildDistributionPlot(data, boundary, 1000);
    expect(plot.kind).toBe('density');
    expect(areaUnderCurve(plot)).toBeCloseTo(1, 3);
    expect(plot.markerDensity).toBeGreaterThan(0);
    expect(plot.points.every(point => point.score >= 0 && point.score <= 179 && Number.isFinite(point.density))).toBe(true);
  });

  it('keeps nearby but distinct scores in a single bucket finite', () => {
    const plot = buildDistributionPlot(histogram([4.2, 4.3, 4.3, 4.3, 4.3]), 4.2, 5);
    expect(plot.kind).toBe('density');
    expect(plot.bandwidth).toBe(0.5);
    expect(plot.maxDensity).toBeGreaterThan(0);
    expect(plot.points.every(point => Number.isFinite(point.density))).toBe(true);
  });

  it.each([[0], [179], [4.2, 4.2, 4.2], [4.2, 4.2, 4.2, 4.2, 4.2, 4.2]])('uses a normal estimate when all scores are %j', (...scores) => {
    const plot = buildDistributionPlot(histogram(scores), scores[0], scores.length);
    expect(plot.kind).toBe('normal');
    expect(plot.bandwidth).toBe(1);
    expect(plot.points.length).toBeGreaterThan(0);
    expect(plot.domainMax).toBeGreaterThanOrEqual(scores[0]);
    expect(plot.markerDensity).toBeGreaterThan(0);
    expect(plot.maxDensity).toBeGreaterThan(0);
    // The visible domain includes at least three standard deviations of the
    // upper tail; the small remaining tail still belongs to the fitted model.
    expect(areaUnderCurve(plot)).toBeCloseTo(1, 2);
    expect(plot.points.every(point => point.score >= 0 && point.score <= 179 && Number.isFinite(point.density))).toBe(true);
  });

  it('switches from a normal estimate to the observed density at five varied results', () => {
    expect(MIN_DISTRIBUTION_PLAYERS).toBe(5);
    const earlyScores = [0, 1, 2, 3];
    expect(buildDistributionPlot(histogram(earlyScores), 1, earlyScores.length).kind).toBe('normal');
    const enoughScores = [...earlyScores, 4];
    expect(buildDistributionPlot(histogram(enoughScores), 1, enoughScores.length).kind).toBe('density');
  });

  it('fits a symmetric bell to sparse weighted scores with sample standard deviation', () => {
    const data = histogram([4.25, 4.25, 4.25, 8.25]);
    const center = buildDistributionPlot(data, 5.25, 4);
    const left = buildDistributionPlot(data, 4.25, 4);
    const right = buildDistributionPlot(data, 6.25, 4);
    expect(center.kind).toBe('normal');
    expect(center.bandwidth).toBe(2);
    expect(center.markerDensity).toBeGreaterThan(left.markerDensity);
    expect(left.markerDensity).toBeCloseTo(right.markerDensity, 10);
    expect(left.markerDensity / center.markerDensity).toBeCloseTo(Math.exp(-0.5 * (1 / 2) ** 2), 10);
    expect(center.domainMax).toBeGreaterThanOrEqual(5.25 + 3 * center.bandwidth);
    expect(areaUnderCurve(center)).toBeCloseTo(1, 3);
  });

  it('floors uncertain or tiny observed spread at one point', () => {
    const plot = buildDistributionPlot(histogram([4.2, 4.3]), 4.2, 2);
    expect(plot.kind).toBe('normal');
    expect(plot.bandwidth).toBe(1);
    expect(plot.markerDensity).toBeGreaterThan(0);
  });

  it('normalizes a sparse normal estimate spanning both legal score boundaries', () => {
    const plot = buildDistributionPlot(histogram([0, 179]), 179, 2);
    expect(plot.kind).toBe('normal');
    expect(plot.domainMax).toBe(179);
    expect(plot.bandwidth).toBeGreaterThan(100);
    expect(areaUnderCurve(plot)).toBeCloseTo(1, 4);
    expect(plot.markerDensity).toBeGreaterThan(0);
    expect(plot.points.every(point => Number.isFinite(point.density))).toBe(true);
  });

  it('includes the exact ranked score even if it is outside the returned range', () => {
    const plot = buildDistributionPlot(histogram([1, 2, 3]), 20.01, 3);
    expect(plot.domainMax).toBeGreaterThanOrEqual(20.01);
    expect(Number.isFinite(plot.markerDensity)).toBe(true);
  });
});
