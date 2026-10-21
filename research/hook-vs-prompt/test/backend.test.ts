import { describe, expect, it } from 'vitest';

import { assertLiveAllowed, LIVE_CONFIRM_ENV, LIVE_CONFIRM_VALUE, LiveNotAllowedError, resolveBackendChoice } from '../src/backends/backend';
import { buildSchedule, episodeKey, keyOfLogFile, remainingBlocks } from '../src/schedule';

describe('실제 Claude 호출 경로는 기본 꺼짐', () => {
  it('backend 를 안 주면 mock', () => {
    expect(resolveBackendChoice(undefined, { live: false }, {})).toBe('mock');
    expect(resolveBackendChoice(undefined, { live: true }, { [LIVE_CONFIRM_ENV]: LIVE_CONFIRM_VALUE })).toBe('mock');
  });

  it('live 는 --live 와 확인 환경변수가 둘 다 있어야 한다', () => {
    expect(() => resolveBackendChoice('live', { live: false }, { [LIVE_CONFIRM_ENV]: LIVE_CONFIRM_VALUE })).toThrow(LiveNotAllowedError);
    expect(() => resolveBackendChoice('live', { live: true }, {})).toThrow(LiveNotAllowedError);
    expect(() => resolveBackendChoice('live', { live: true }, { [LIVE_CONFIRM_ENV]: 'yes' })).toThrow(LiveNotAllowedError);
    expect(resolveBackendChoice('live', { live: true }, { [LIVE_CONFIRM_ENV]: LIVE_CONFIRM_VALUE })).toBe('live');
  });

  it('테스트 환경에서는 확인 환경변수가 비어 있다 (vitest.config.ts)', () => {
    expect(() => assertLiveAllowed({ live: true }, process.env)).toThrow(LiveNotAllowedError);
  });

  it('모르는 백엔드는 거부', () => {
    expect(() => resolveBackendChoice('real', { live: true }, {})).toThrow();
  });
});

describe('블록 계획 (DESIGN §6.1·§6.3)', () => {
  const tasks = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10'];

  it('파일럿 12, 본 실행 150, 민감도 30 — 블록 안에 조건이 연달아', () => {
    const pilot = buildSchedule('pilot', tasks, 1);
    expect(pilot.flat()).toHaveLength(12);
    expect(pilot.every((b) => new Set(b.map((e) => e.task)).size === 1 && b.length === 4)).toBe(true);
    expect(buildSchedule('main', tasks, 1).flat()).toHaveLength(150);
    expect(buildSchedule('sens', tasks, 1).flat()).toHaveLength(30);
    // KSC 마감(10/12)에 맞춘 축소 본 실행 (DESIGN 변경 이력 N5): 10과제 × 반복 3 = 블록 30, 블록마다 네 조건
    const ksc = buildSchedule('ksc', tasks, 1);
    expect(ksc).toHaveLength(30);
    expect(ksc.flat()).toHaveLength(120);
    expect(ksc.every((b) => [...b.map((e) => e.cond)].sort().join() === 'A,B,C,Cp')).toBe(true);
  });

  it('sonnet15 (DESIGN N8): 네 조건 각 15회 — 과제 10개 1회 + 시드로 고른 과제 5개 2회째', () => {
    const s = buildSchedule('sonnet15', tasks, 1);
    expect(s).toHaveLength(15);
    expect(s.flat()).toHaveLength(60);
    expect(s.every((b) => [...b.map((e) => e.cond)].sort().join() === 'A,B,C,Cp')).toBe(true);
    const rep2 = s.filter((b) => b[0]?.rep === 2).map((b) => b[0]?.task).sort();
    expect(rep2).toHaveLength(5);
    expect(new Set(s.map((b) => b[0]?.task)).size).toBe(10);
    expect(buildSchedule('sonnet15', tasks, 1).filter((b) => b[0]?.rep === 2).map((b) => b[0]?.task).sort()).toEqual(rep2);
    expect(s.flat().every((e) => e.blockName === 'sonnet15')).toBe(true);
  });

  it('재개 (N8): 끝난 에피소드 키를 빼고 남은 것만 같은 순서로 — 비어 버린 블록은 없앤다', () => {
    const s = buildSchedule('sonnet15', tasks, 1);
    const first = s[0] ?? [];
    const done = new Set([...first.map(episodeKey), episodeKey(s[1]?.[0] ?? first[0]!)]);
    const rest = remainingBlocks(s, done);
    expect(rest).toHaveLength(14);
    expect(rest.flat()).toHaveLength(60 - 5);
    expect(rest[0]?.map(episodeKey)).toEqual(s[1]?.slice(1).map(episodeKey));
  });

  it('로그 파일 이름에서 키를 읽는다 — 끝 6자리 무작위는 무시', () => {
    expect(keyOfLogFile('sonnet15-5-T06-Cp-1-988c95.jsonl')).toBe('sonnet15-5-T06-Cp-1');
    expect(keyOfLogFile('notes.txt')).toBeNull();
    const ep = buildSchedule('sonnet15', tasks, 1)[0]![0]!;
    expect(keyOfLogFile(`${ep.runId}.jsonl`)).toBe(episodeKey(ep));
  });

  it('E 블록 (DESIGN N9): 선행 검증 2, 본 실행 30', () => {
    expect(buildSchedule('e_probe', tasks, 1).flat().map((e) => `${e.task}${e.cond}`).sort()).toEqual(['T03E', 'T05E']);
    expect(buildSchedule('e', tasks, 1).flat()).toHaveLength(30);
  });

  it('같은 시드면 같은 순서, runId 는 매번 고유', () => {
    const order = (s: number) => buildSchedule('main', tasks, s).flat().map((e) => `${e.task}${e.cond}${e.rep}`);
    expect(order(7)).toEqual(order(7));
    expect(order(7)).not.toEqual(order(8));
    const ids = buildSchedule('main', tasks, 7).flat().map((e) => e.runId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
