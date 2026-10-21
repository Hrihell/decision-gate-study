import { describe, expect, it } from 'vitest';

import { clusterBootstrapRiskDiff, minDetectableDiff, robustSummary, type RobustEpisode } from '../analysis/robust';
import { approxPower } from '../analysis/stats';

// 모의 리뷰 패널 ② (2026-10-09): 과제 군집 bootstrap·검정력·H3a 조건부 — 사후 민감도 분석, 1차 검정을 바꾸지 않는다.

describe('clusterBootstrapRiskDiff', () => {
  it('과제째 다시 뽑아 위험 차(첫째 − 둘째)와 95% 백분위 구간을 낸다', () => {
    const clusters = Array.from({ length: 10 }, () => ({ first: [true, true, true], second: [false, true, false] }));
    const { rd, ci } = clusterBootstrapRiskDiff(clusters, 500, 1);
    expect(rd).toBeCloseTo(2 / 3);
    // 모든 과제가 같으면 다시 뽑아도 같다
    expect(ci.lo).toBeCloseTo(2 / 3);
    expect(ci.hi).toBeCloseTo(2 / 3);
  });

  it('과제마다 다르면 구간이 넓어지고 점추정을 감싼다', () => {
    const clusters = [
      ...Array.from({ length: 5 }, () => ({ first: [true, true, true], second: [true, true, true] })),
      ...Array.from({ length: 5 }, () => ({ first: [true, true, true], second: [false, false, false] })),
    ];
    const { rd, ci } = clusterBootstrapRiskDiff(clusters, 2000, 7);
    expect(rd).toBeCloseTo(0.5);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBeGreaterThan(0.5);
  });

  it('같은 시드면 같은 구간', () => {
    const clusters = [
      { first: [true, false], second: [false, false] },
      { first: [true, true], second: [true, false] },
      { first: [false, true], second: [false, false] },
    ];
    expect(clusterBootstrapRiskDiff(clusters, 300, 3)).toEqual(clusterBootstrapRiskDiff(clusters, 300, 3));
  });
});

const ep = (task: string, cond: string, v: boolean, pEnd: string, pT1: string): RobustEpisode => ({ task, cond, vT1: v, pEnd, pTurn1: pT1 });

describe('robustSummary', () => {
  const episodes: RobustEpisode[] = [
    ep('T1', 'A', true, 'P3', 'P3'),
    ep('T1', 'B', false, 'P1', 'P1'),
    ep('T1', 'C', false, 'P0', 'P0'),
    ep('T2', 'A', true, 'P2', 'P2'),
    ep('T2', 'B', true, 'P3', 'P3'),
    ep('T2', 'C', false, 'P1', 'P1'),
  ];

  it('H1 은 A 대 B 의 V_t1 위험 차를 과제 군집으로', () => {
    const r = robustSummary(episodes, 200, 1);
    expect(r.H1.rd).toBeCloseTo(0.5);
    expect(r.H1.k1).toBe(2);
    expect(r.H1.k2).toBe(1);
  });

  it('H3b 는 C 대 B 의 끝 P1 비율과 검정력(설계 효과 반영 전·후)', () => {
    const r = robustSummary(episodes, 200, 1);
    expect(r.H3b).toMatchObject({ kC: 1, nC: 2, kB: 1, nB: 2 });
    expect(r.H3b.power).toBeGreaterThanOrEqual(0);
    expect(r.H3b.power).toBeLessThanOrEqual(1);
    expect(r.H3b.powerDeff).toBeLessThanOrEqual(r.H3b.power + 1e-12);
    expect(r.H3b.mde === null || r.H3b.mde > 0).toBe(true);
  });

  it('H3a 조건부: 1턴에 디스크 변화가 없는(P0·P1) 에피소드 안에서 P0 비율', () => {
    const r = robustSummary(episodes, 200, 1);
    expect(r.H3aCondT1).toEqual({ C: { k: 1, n: 2 }, B: { k: 0, n: 1 } });
  });
});

describe('minDetectableDiff — 최소 검출 효과 (사후 검정력 대신, 2026-10-09 감사)', () => {
  it('기준 비율에서 목표 검정력에 처음 닿는 차이를 낸다 — 그 차이의 검정력은 목표 이상, 조금 작으면 미만', () => {
    const d = minDetectableDiff(4 / 30, 30) as number;
    expect(approxPower(4 / 30, 4 / 30 + d, 30)).toBeGreaterThanOrEqual(0.8 - 1e-6);
    expect(approxPower(4 / 30, 4 / 30 + d - 0.01, 30)).toBeLessThan(0.8);
  });

  it('유효 표본이 줄면(설계 효과) 검출 가능한 최소 차이가 커진다', () => {
    expect(minDetectableDiff(4 / 30, 30 / 1.5) as number).toBeGreaterThan(minDetectableDiff(4 / 30, 30) as number);
  });

  it('기준이 1 에 가까워 닿을 수 없으면 null', () => {
    expect(minDetectableDiff(0.99, 5)).toBeNull();
  });
});
