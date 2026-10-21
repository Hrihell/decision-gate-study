// 모의 리뷰 패널 ② (2026-10-09) — 사후 민감도 분석. 사전 등록 1차 검정·Holm 을 바꾸지 않는다.
// (1) H1 위험 차의 과제 군집 bootstrap 구간, (2) H3b 검정력(설계 효과 반영 전·후), (3) H3a 를 1턴 디스크 변화 없음 안으로 한정한 P0 비율.

import { approxPower, iccBinary, rng, type Interval } from './stats';

export interface RobustEpisode {
  readonly task: string;
  readonly cond: string;
  /** 1턴 뒤 결정 전 코드 쓰기 (V_disk_code_t1) */
  readonly vT1: boolean;
  /** 끝 진행 등급 P0~P3 (N7 기계 등급) */
  readonly pEnd: string;
  /** 1턴 진행 등급 (1턴 디스크 기준) */
  readonly pTurn1: string;
}

const rate = (ys: readonly boolean[]): number => (ys.length === 0 ? Number.NaN : ys.filter(Boolean).length / ys.length);

/** 과제 단위 군집 부트스트랩 — 위험 차(첫째 − 둘째)와 95% 백분위 구간. 과제를 통째로 복원 추출한다. */
export function clusterBootstrapRiskDiff(
  clusters: readonly { readonly first: readonly boolean[]; readonly second: readonly boolean[] }[],
  iters = 10_000,
  seed = 20261009,
): { rd: number; ci: Interval } {
  const rdOf = (cs: typeof clusters): number => rate(cs.flatMap((c) => [...c.first])) - rate(cs.flatMap((c) => [...c.second]));
  const rd = rdOf(clusters);
  if (clusters.length === 0) return { rd: Number.NaN, ci: { lo: Number.NaN, hi: Number.NaN } };
  const r = rng(seed);
  const draws: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    const sample = clusters.map(() => clusters[Math.floor(r() * clusters.length)] as (typeof clusters)[number]);
    const d = rdOf(sample);
    if (Number.isFinite(d)) draws.push(d);
  }
  draws.sort((a, b) => a - b);
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))] ?? Number.NaN;
  return { rd, ci: { lo: at(0.025), hi: at(0.975) } };
}

/**
 * 최소 검출 효과: 기준 비율 `p1` 에서 위로 몇 이상 차이 나야 목표 검정력(기본 0.8, 양측 α 0.05 정규 근사)에 닿는가.
 * 관찰 효과로 계산한 사후 검정력은 p 값과 일대일이라 새 정보가 없다 — 그 대신 쓴다 (2026-10-09 감사). 닿을 수 없으면 null.
 */
export function minDetectableDiff(p1: number, nEffPerArm: number, power = 0.8): number | null {
  if (approxPower(p1, 1, nEffPerArm) < power) return null;
  let lo = 0;
  let hi = 1 - p1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (approxPower(p1, p1 + mid, nEffPerArm) >= power) hi = mid;
    else lo = mid;
  }
  return hi;
}

const tasksOf = (eps: readonly RobustEpisode[]): string[] => [...new Set(eps.map((e) => e.task))].sort();

/** 조건 둘의 결과를 과제별 군집으로 묶는다 */
const clustersFor = (eps: readonly RobustEpisode[], first: string, second: string, y: (e: RobustEpisode) => boolean) =>
  tasksOf(eps).map((t) => ({
    first: eps.filter((e) => e.task === t && e.cond === first).map(y),
    second: eps.filter((e) => e.task === t && e.cond === second).map(y),
  }));

const kn = (ys: readonly boolean[]): { k: number; n: number } => ({ k: ys.filter(Boolean).length, n: ys.length });

export function robustSummary(episodes: readonly RobustEpisode[], iters = 10_000, seed = 20261009) {
  const of = (cond: string) => episodes.filter((e) => e.cond === cond);

  // (1) H1: V_t1 A 대 B
  const h1Clusters = clustersFor(episodes, 'A', 'B', (e) => e.vT1);
  const h1 = clusterBootstrapRiskDiff(h1Clusters, iters, seed);
  const h1Icc = iccBinary(h1Clusters.map((c) => c.second));

  // (2) H3b: 끝 P1, C 대 B — 관찰 비율에서의 검정력. 설계 효과는 두 팔 중 큰 ICC 로 (보수적)
  const p1 = (e: RobustEpisode): boolean => e.pEnd === 'P1';
  const yC = of('C').map(p1);
  const yB = of('B').map(p1);
  const h3Clusters = clustersFor(episodes, 'C', 'B', p1);
  const iccC = iccBinary(h3Clusters.map((c) => c.first));
  const iccB = iccBinary(h3Clusters.map((c) => c.second));
  const deff = Math.max(iccC.designEffect, iccB.designEffect);
  const nPerArm = Math.min(yC.length, yB.length);
  const power = approxPower(rate(yC), rate(yB), nPerArm);
  const powerDeff = approxPower(rate(yC), rate(yB), nPerArm / deff);
  // B(기준)에서 검출 가능한 최소 차이 — 설계 효과 반영 전·후
  const mde = minDetectableDiff(rate(yB), nPerArm);
  const mdeDeff = minDetectableDiff(rate(yB), nPerArm / deff);

  // (3) H3a 조건부: 1턴 디스크 변화가 없는 에피소드(1턴 등급 P0·P1) 안에서 P0 비율
  const noDiskT1 = (cond: string) => of(cond).filter((e) => e.pTurn1 === 'P0' || e.pTurn1 === 'P1');
  return {
    exploratory: true as const,
    H1: { k1: kn(of('A').map((e) => e.vT1)).k, n1: of('A').length, k2: kn(of('B').map((e) => e.vT1)).k, n2: of('B').length, rd: h1.rd, clusterCI: h1.ci, iccB: h1Icc.icc, tasks: h1Clusters.length },
    H3b: { kC: kn(yC).k, nC: yC.length, kB: kn(yB).k, nB: yB.length, power, powerDeff, designEffect: deff, mde, mdeDeff },
    H3aCondT1: { C: kn(noDiskT1('C').map((e) => e.pTurn1 === 'P0')), B: kn(noDiskT1('B').map((e) => e.pTurn1 === 'P0')) },
  };
}
