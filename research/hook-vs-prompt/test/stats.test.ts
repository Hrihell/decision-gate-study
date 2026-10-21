import { describe, expect, it } from 'vitest';

import {
  clopperPearson,
  fisherExact,
  holm,
  iccBinary,
  riskDifference,
  stratifiedPermutationTest,
  wilson,
  zeroUpperBound,
} from '../analysis/stats';

describe('통계 함수 — 알려진 값', () => {
  it('Fisher 양측: [[3,1],[1,3]] ≈ 0.486, [[10,0],[0,10]] ≈ 1.08e-5', () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
    expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.0825e-5, 8);
    expect(fisherExact(0, 5, 0, 5)).toBe(1);
  });

  it('Wilson 95%: 0/50 상한 ≈ 0.0713, 5/10 ≈ 0.237–0.763', () => {
    expect(wilson(0, 50).hi).toBeCloseTo(0.0713, 3);
    const w = wilson(5, 10);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
  });

  it('Clopper–Pearson: 0/10 상한 ≈ 0.3085, 5/10 ≈ 0.187–0.813', () => {
    expect(clopperPearson(0, 10).hi).toBeCloseTo(0.3085, 3);
    const cp = clopperPearson(5, 10);
    expect(cp.lo).toBeCloseTo(0.1871, 3);
    expect(cp.hi).toBeCloseTo(0.8129, 3);
  });

  it('0/50 상한: 3의 법칙 0.06, 정확 단측 ≈ 0.0582', () => {
    expect(zeroUpperBound(50).ruleOfThree).toBeCloseTo(0.06, 6);
    expect(zeroUpperBound(50).exact).toBeCloseTo(0.0582, 3);
  });

  it('Holm: 순서를 유지하고 단조', () => {
    expect(holm([0.01, 0.04, 0.03, 0.2])).toEqual([0.04, 0.09, 0.09, 0.2]);
  });

  it('Newcombe 위험 차: 0.5 − 0.2 의 구간이 0.3 을 감싼다', () => {
    const { rd, ci } = riskDifference(25, 50, 10, 50);
    expect(rd).toBeCloseTo(0.3, 6);
    expect(ci.lo).toBeLessThan(0.3);
    expect(ci.hi).toBeGreaterThan(0.3);
    expect(ci.lo).toBeGreaterThan(0.1);
  });

  it('층화 순열 검정: 모든 과제에서 차이가 크면 작은 p, 차이가 없으면 1', () => {
    const strong = ['T1', 'T2', 'T3', 'T4', 'T5'].flatMap((s) => [
      ...Array.from({ length: 5 }, () => ({ stratum: s, first: true, y: true })),
      ...Array.from({ length: 5 }, () => ({ stratum: s, first: false, y: false })),
    ]);
    expect(stratifiedPermutationTest(strong, 2000, 1).p).toBeLessThan(0.01);
    const none = strong.map((o) => ({ ...o, y: true }));
    expect(stratifiedPermutationTest(none, 2000, 1).p).toBe(1);
  });

  it('ICC: 과제 안에서 결과가 완전히 같으면 1, 섞이면 0 근처', () => {
    expect(iccBinary([[true, true, true], [false, false, false]]).icc).toBeCloseTo(1, 6);
    expect(iccBinary([[true, false, true, false], [true, false, true, false]]).icc).toBe(0);
  });
});
