import type { ScoreDistribution } from './ranking';

const MAX_SCORE = 179;
const ROOT_TWO_PI = Math.sqrt(2 * Math.PI);
const clamp = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

export const MIN_DISTRIBUTION_PLAYERS = 5;

export interface DistributionPlot {
  kind: 'density' | 'normal';
  domainMax: number;
  ticks: number[];
  bandwidth: number;
  points: { score: number; density: number }[];
  markerDensity: number;
  maxDensity: number;
}

function axis(maximum: number) {
  const target = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const fraction = target / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  const domainMax = Math.min(MAX_SCORE, Math.ceil(maximum / step) * step);
  const ticks = [0];
  for (let tick = step; tick < domainMax - step * 0.01; tick += step) ticks.push(Number(tick.toFixed(6)));
  // Keep the real upper boundary visible without crowding the preceding label.
  if (domainMax - ticks.at(-1)! < step * 0.6) ticks.pop();
  ticks.push(domainMax);
  return { domainMax, ticks };
}

// Normal CDF approximation, accurate to about 1e-7. It lets a normal estimate
// retain its shape while normalizing away impossible scores outside 0–179.
function normalCdf(value: number) {
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return (1 + Math.sign(value) * erf) / 2;
}

/** Use a fitted normal estimate until the real histogram supports a density curve. */
export function buildDistributionPlot(distribution: ScoreDistribution, score: number, totalPlayers: number): DistributionPlot {
  const weighted = distribution.bins.map(bin => ({
    // The exact range tightens the first and last buckets, including the 179-point cap.
    value: clamp(bin.start + distribution.binWidth / 2, distribution.minScore, distribution.maxScore),
    count: bin.count,
  }));
  const count = weighted.reduce((sum, bin) => sum + bin.count, 0);
  const mean = weighted.reduce((sum, bin) => sum + bin.value * bin.count, 0) / count;
  const variance = weighted.reduce((sum, bin) => sum + bin.count * (bin.value - mean) ** 2, 0) / count;
  const kind = totalPlayers < MIN_DISTRIBUTION_PLAYERS || distribution.minScore === distribution.maxScore ? 'normal' : 'density';
  // A sparse field has little evidence for its spread. The one-point minimum
  // standard deviation gives single or tied scores an explicitly estimated curve.
  const bandwidth = kind === 'normal'
    ? Math.max(1, Math.sqrt(count > 1 ? variance * count / (count - 1) : 0))
    : Math.max(distribution.binWidth, Math.min(20, 1.06 * Math.sqrt(variance) * count ** -0.2));
  const observedMax = Math.max(distribution.maxScore, score);
  const upperTail = kind === 'normal'
    ? Math.max(observedMax, mean + 3 * bandwidth)
    : observedMax + Math.max(0.75, bandwidth * 2.5, observedMax * 0.06);
  const { domainMax, ticks } = axis(Math.min(MAX_SCORE, Math.max(2, upperTail)));

  const gaussian = (distance: number) => Math.exp(-0.5 * (distance / bandwidth) ** 2);
  const normalMass = normalCdf((MAX_SCORE - mean) / bandwidth) - normalCdf(-mean / bandwidth);
  const density = kind === 'normal'
    ? (value: number) => gaussian(value - mean) / (bandwidth * ROOT_TWO_PI * normalMass)
    : (value: number) => weighted.reduce((sum, bin) => sum + bin.count * (
      gaussian(value - bin.value) + gaussian(value + bin.value) + gaussian(value - (2 * MAX_SCORE - bin.value))
    ), 0) / (count * bandwidth * ROOT_TWO_PI);
  // Reflect kernels at both legal score boundaries. The curve never extends to
  // impossible negative scores, and scores at zero retain their full weight.
  // Sparse normal estimates instead use truncation to preserve their bell shape.
  const samples = Math.max(180, Math.ceil(domainMax / bandwidth * 5));
  const points = Array.from({ length: samples + 1 }, (_, index) => {
    const value = domainMax * index / samples;
    return { score: value, density: density(value) };
  });
  const markerDensity = density(score);
  const maxDensity = Math.max(markerDensity, ...points.map(point => point.density));
  return { kind, domainMax, ticks, bandwidth, points, markerDensity, maxDensity };
}
