import { describe, expect, it } from 'vitest';

import type { Backend } from '../src/backends/backend';
import { B_APPEND } from '../src/conditions';
import { assistantTexts, judgeProbe, PROBE_EXPECTED, PROBES, tapBackend } from '../src/probe';

// 관문 6.5-6: B 의 systemPrompt.append 가 실제로 모델 문맥에 들어갔는가 — 첫 문장을 그대로 말하게 해 확인
describe('probe 판정', () => {
  it('기대 문장은 B 지시문 Project rule 단락의 첫 문장이다 — 지시문이 바뀌면 여기서 깨진다', () => {
    const body = B_APPEND.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))[0] ?? '';
    expect(body.startsWith(PROBE_EXPECTED)).toBe(true);
  });

  it('공백·대소문자·따옴표가 달라도 문장을 그대로 옮겼으면 일치', () => {
    expect(judgeProbe([`첫 문장은 "this project  has no plan yet." 입니다`])).toBe(true);
    expect(judgeProbe(['없음'])).toBe(false);
    expect(judgeProbe(['This project has a plan.'])).toBe(false);
  });
});

describe('assistantTexts', () => {
  it('assistant 메시지의 text 블록만 꺼낸다', () => {
    expect(assistantTexts({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] } })).toEqual(['a', 'b']);
    expect(assistantTexts({ type: 'user', message: { content: [{ type: 'text', text: 'x' }] } })).toEqual([]);
  });
});

describe('tapBackend', () => {
  it('메시지를 그대로 흘리면서 엿본다', async () => {
    const inner: Backend = {
      name: 'mock',
      start: () => ({
        initializationResult: async () => ({ hooks_applied: true }),
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
          yield { type: 'result' };
        },
      }),
    };
    const seen: unknown[] = [];
    const tapped = tapBackend(inner, (m) => seen.push(m));
    const handle = tapped.start({ prompt: (async function* () {})(), options: {} });
    expect(await handle.initializationResult()).toEqual({ hooks_applied: true });
    const out: unknown[] = [];
    for await (const m of handle) out.push(m);
    expect(out).toHaveLength(2);
    expect(seen).toEqual(out);
  });
});

describe('TMPDIR 안내 확인 질의 (DESIGN N10 b)', () => {
  it('기대 문자열은 CLI sandbox 시스템 프롬프트의 그 문장이고, 질의는 원문 인용 또는 없음을 요구한다', () => {
    expect(PROBES.tmpdir.expected).toBe('TMPDIR is automatically set to the correct sandbox-writable directory');
    expect(PROBES.tmpdir.prompt).toMatch(/TMPDIR/);
    expect(PROBES.tmpdir.prompt).toMatch(/없음/);
    expect(PROBES.project.expected).toBe(PROBE_EXPECTED);
  });

  it('판정은 질의별 기대 문자열로 — 따옴표·대소문자·공백 차이는 무시', () => {
    expect(judgeProbe(['"TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode."'], PROBES.tmpdir.expected)).toBe(true);
    expect(judgeProbe(['없음'], PROBES.tmpdir.expected)).toBe(false);
    expect(judgeProbe(['This project has no plan yet.'])).toBe(true);
  });
});
