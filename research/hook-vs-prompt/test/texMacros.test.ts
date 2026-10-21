import { describe, expect, it } from 'vitest';

import { toTexMacros } from '../analysis/texMacros';

// 원고 숫자는 analysis.json 에서 자동으로 — 손으로 옮기다 틀리지 않게. \R{경로} 로 꺼내 쓴다.
describe('toTexMacros', () => {
  const tex = toTexMacros({
    descriptive: { V_disk_code_t1: { A: { k: 3, n: 3, rate: 1, wilson: { lo: 0.4385, hi: 1 } } } },
    primary: [{ id: 'H1', holmP: 0.0123, sameDirection: true, description: '압박 전' }],
  });

  it('정수는 그대로, 실수는 소수 셋째 자리 — 모든 수에 백분율(.pct), 비율 0·1 포함', () => {
    expect(tex).toContain('\\expandafter\\def\\csname R@descriptive.V_disk_code_t1.A.k\\endcsname{3}');
    expect(tex).toContain('\\csname R@descriptive.V_disk_code_t1.A.wilson.lo\\endcsname{0.439}');
    expect(tex).toContain('\\csname R@descriptive.V_disk_code_t1.A.wilson.lo.pct\\endcsname{44}');
    expect(tex).toContain('\\csname R@descriptive.V_disk_code_t1.A.rate.pct\\endcsname{100}');
  });

  it('p 값 표기(.pfmt): 0.001 미만은 <0.001, 나머지는 소수 셋째 자리', () => {
    const t = toTexMacros({ primary: [{ id: 'H1', holmP: 0.00002 }, { id: 'H2', holmP: 1 }, { id: 'H3', holmP: 0.0091 }] });
    expect(t).toContain('\\csname R@primary.H1.holmP.pfmt\\endcsname{$<$0.001}');
    expect(t).toContain('\\csname R@primary.H2.holmP.pfmt\\endcsname{1.000}');
    expect(t).toContain('\\csname R@primary.H3.holmP.pfmt\\endcsname{0.009}');
  });

  it('배열은 id 가 있으면 id 로 이름을 붙인다', () => {
    expect(tex).toContain('\\csname R@primary.H1.holmP\\endcsname{0.012}');
  });

  it('문자열·불리언은 내보내지 않는다 (원고에 쓸 숫자만)', () => {
    expect(tex).not.toContain('description');
    expect(tex).not.toContain('sameDirection');
  });

  it('없는 경로를 쓰면 컴파일에서 눈에 띄게 ?? 로 나오는 접근자를 정의한다', () => {
    expect(tex).toContain('\\newcommand{\\R}[1]{\\ifcsname R@#1\\endcsname\\csname R@#1\\endcsname\\else\\textbf{??\\detokenize{#1}??}\\fi}');
  });
});
