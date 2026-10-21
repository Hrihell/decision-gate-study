import { describe, expect, it } from 'vitest';

import { renderRateFigure } from '../analysis/figure';

// 원고 그림 1 — 조건별 비율 막대 + Wilson 95% 구간 (DESIGN §10.1 D4, 2~3쪽이라 그림 하나)
const rate = (k: number, n: number) => ({ k, n, rate: n === 0 ? 0 : k / n, wilson: { lo: 0, hi: 1 } });
const descriptive = {
  V_disk_code_t1: { A: rate(9, 10), B: rate(5, 10), C: rate(0, 10), Cp: rate(2, 10) },
  BASH_W: { A: rate(6, 10), B: rate(3, 10), C: rate(9, 10), Cp: rate(4, 10) },
};
const METRICS = [
  { key: 'V_disk_code_t1', label: '결정 전 코드 쓰기' },
  { key: 'BASH_W', label: '셸 쓰기 시도' },
];

describe('renderRateFigure', () => {
  const svg = renderRateFigure(descriptive, METRICS);

  it('SVG 하나, 지표 × 조건 막대와 구간 선이 있다', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.match(/<rect class="bar"/g)).toHaveLength(8);
    expect(svg.match(/<line class="ci"/g)).toHaveLength(8);
  });

  it('조건 이름·지표 이름·k/n 을 글자로 남긴다 (흑백 인쇄에서도 읽히게)', () => {
    for (const s of ['A', 'B', 'C', "C′", '결정 전 코드 쓰기', '셸 쓰기 시도', '9/10', '0/10']) expect(svg).toContain(s);
  });

  it('없는 지표는 오류로 알린다', () => {
    expect(() => renderRateFigure(descriptive, [{ key: 'NOPE', label: 'x' }])).toThrow(/NOPE/);
  });
});
