// 통계 함수 (DESIGN v2 §7). 외부 의존성 없이 TypeScript 로 — 테스트 명령 하나로 검증되게 (Python·scipy 미사용).
// 정확검정·정확 신뢰구간만 쓴다. 정규 근사는 검정력 **추정**에만 쓴다.

const Z95 = 1.959963984540054;

const logFactCache: number[] = [0];
const logFact = (n: number): number => {
  for (let i = logFactCache.length; i <= n; i += 1) logFactCache[i] = (logFactCache[i - 1] ?? 0) + Math.log(i);
  return logFactCache[n] ?? 0;
};
const logChoose = (n: number, k: number): number => logFact(n) - logFact(k) - logFact(n - k);

/** 2×2 표 [[a, b], [c, d]] 의 양측 Fisher 정확검정 p (관측 확률 이하인 표의 확률 합). */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const prob = (x: number): number => Math.exp(logChoose(r1, x) + logChoose(r2, c1 - x) - logChoose(n, c1));
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  const observed = prob(a);
  let p = 0;
  for (let x = lo; x <= hi; x += 1) {
    const px = prob(x);
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

export function wilson(k: number, n: number, z = Z95): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

const binomCdf = (k: number, n: number, p: number): number => {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let i = 0; i <= k; i += 1) s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, s);
};

const bisect = (f: (x: number) => number, lo: number, hi: number): number => {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200; i += 1) {
    const m = (a + b) / 2;
    if (f(m) > 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
};

/** Clopper–Pearson 정확 신뢰구간 (양측 1−alpha). */
export function clopperPearson(k: number, n: number, alpha = 0.05): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const lo = k === 0 ? 0 : bisect((p) => 1 - binomCdf(k - 1, n, p) - alpha / 2, 0, 1);
  const hi = k === n ? 1 : bisect((p) => alpha / 2 - binomCdf(k, n, p), 0, 1);
  return { lo, hi };
}

/** 0/n 의 단측 95% 정확 상한과 3의 법칙 근사. */
export function zeroUpperBound(n: number): { exact: number; ruleOfThree: number } {
  return { exact: n === 0 ? 1 : 1 - 0.05 ** (1 / n), ruleOfThree: n === 0 ? 1 : 3 / n };
}

/** 위험 차 p1−p2 와 Newcombe(Wilson 결합) 95% 신뢰구간. */
export function riskDifference(k1: number, n1: number, k2: number, n2: number): { rd: number; ci: Interval } {
  const p1 = n1 === 0 ? 0 : k1 / n1;
  const p2 = n2 === 0 ? 0 : k2 / n2;
  const w1 = wilson(k1, n1);
  const w2 = wilson(k2, n2);
  const rd = p1 - p2;
  return {
    rd,
    ci: {
      lo: rd - Math.sqrt((p1 - w1.lo) ** 2 + (w2.hi - p2) ** 2),
      hi: rd + Math.sqrt((w1.hi - p1) ** 2 + (p2 - w2.lo) ** 2),
    },
  };
}

/** Holm 보정 p (입력 순서를 유지해 돌려준다). */
export function holm(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

/** mulberry32 — 분석의 순열·부트스트랩 시드 고정. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BinaryObs {
  readonly stratum: string;
  /** true = 비교의 첫째 조건 */
  readonly first: boolean;
  readonly y: boolean;
}

/**
 * 과제 층화 순열 검정 (리뷰 S2 — 1차 검정). 과제 안에서만 조건 라벨을 섞는다.
 * 통계량은 CMH 분자: Σ_s (첫째 조건의 사건 수 − 기대값). 양측 p = (#{|T*| ≥ |T|} + 1)/(iters + 1).
 */
export function stratifiedPermutationTest(obs: readonly BinaryObs[], iters = 10_000, seed = 20261008): { stat: number; p: number } {
  const strata = new Map<string, BinaryObs[]>();
  for (const o of obs) strata.set(o.stratum, [...(strata.get(o.stratum) ?? []), o]);
  const statOf = (groups: readonly (readonly { first: boolean; y: boolean }[])[]): number =>
    groups.reduce((acc, g) => {
      const n = g.length;
      const nFirst = g.filter((o) => o.first).length;
      const events = g.filter((o) => o.y).length;
      const a = g.filter((o) => o.first && o.y).length;
      return acc + (n === 0 ? 0 : a - (nFirst * events) / n);
    }, 0);
  const groups = [...strata.values()];
  const observed = statOf(groups);
  if (groups.every((g) => g.every((o) => o.y) || g.every((o) => !o.y))) return { stat: observed, p: 1 };
  const r = rng(seed);
  let extreme = 0;
  for (let i = 0; i < iters; i += 1) {
    const permuted = groups.map((g) => {
      const labels = g.map((o) => o.first);
      for (let j = labels.length - 1; j > 0; j -= 1) {
        const k = Math.floor(r() * (j + 1));
        const tmp = labels[j] as boolean;
        labels[j] = labels[k] as boolean;
        labels[k] = tmp;
      }
      return g.map((o, j) => ({ first: labels[j] as boolean, y: o.y }));
    });
    if (Math.abs(statOf(permuted)) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  return { stat: observed, p: (extreme + 1) / (iters + 1) };
}

/** 이진 결과의 군집 내 상관 (ANOVA 추정량)과 설계 효과 1+(m̄−1)·ICC (리뷰 S2). */
export function iccBinary(clusters: readonly (readonly boolean[])[]): { icc: number; designEffect: number; meanSize: number } {
  const used = clusters.filter((c) => c.length > 0);
  const k = used.length;
  const N = used.reduce((a, c) => a + c.length, 0);
  if (k < 2 || N <= k) return { icc: 0, designEffect: 1, meanSize: k === 0 ? 0 : N / k };
  const mean = used.reduce((a, c) => a + c.filter(Boolean).length, 0) / N;
  const ssb = used.reduce((a, c) => a + c.length * (c.filter(Boolean).length / c.length - mean) ** 2, 0);
  const ssw = used.reduce((a, c) => {
    const pc = c.filter(Boolean).length / c.length;
    return a + c.reduce((s, y) => s + ((y ? 1 : 0) - pc) ** 2, 0);
  }, 0);
  const msb = ssb / (k - 1);
  const msw = ssw / (N - k);
  const m0 = (N - used.reduce((a, c) => a + c.length ** 2, 0) / N) / (k - 1);
  const denom = msb + (m0 - 1) * msw;
  const icc = denom === 0 ? 0 : Math.max(0, (msb - msw) / denom);
  const meanSize = N / k;
  return { icc, designEffect: 1 + (meanSize - 1) * icc, meanSize };
}

/** 두 비율 차이의 검정력 **추정** (정규 근사, 양측 α=0.05). 유효 표본은 n/설계효과. */
export function approxPower(p1: number, p2: number, nEffPerArm: number): number {
  if (nEffPerArm <= 0) return 0;
  const pbar = (p1 + p2) / 2;
  const se0 = Math.sqrt((2 * pbar * (1 - pbar)) / nEffPerArm);
  const se1 = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / nEffPerArm);
  if (se1 === 0) return 1;
  const z = (Math.abs(p1 - p2) - Z95 * se0) / se1;
  return normalCdf(z);
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** 과제 단위 군집 부트스트랩 — 중앙값 차(첫째 − 둘째)의 95% 백분위 구간. 보조 지표 (S2). */
export function clusterBootstrapMedianDiff(
  clusters: readonly { readonly first: readonly number[]; readonly second: readonly number[] }[],
  iters = 10_000,
  seed = 20261008,
): { diff: number; ci: Interval } {
  const all = (pick: 'first' | 'second', cs: typeof clusters): number[] => cs.flatMap((c) => [...c[pick]]);
  const diff = median(all('first', clusters)) - median(all('second', clusters));
  if (clusters.length === 0) return { diff: Number.NaN, ci: { lo: Number.NaN, hi: Number.NaN } };
  const r = rng(seed);
  const draws: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const sample = clusters.map(() => clusters[Math.floor(r() * clusters.length)] as (typeof clusters)[number]);
    const d = median(all('first', sample)) - median(all('second', sample));
    if (Number.isFinite(d)) draws.push(d);
  }
  draws.sort((a, b) => a - b);
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))] ?? Number.NaN;
  return { diff, ci: { lo: at(0.025), hi: at(0.975) } };
}
