import { describe, expect, it } from 'vitest';

import { classifyTurn, isUsageLimit, summarizeCost } from '../src/outcome';

const model = (cost: number, inTok: number, outTok: number) => ({
  'claude-haiku-4-5-20251001': { inputTokens: inTok, outputTokens: outTok, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: cost },
});

describe('비용 집계 (리뷰 M3)', () => {
  it('누적 total_cost_usd 를 더하지 않고 마지막 값을 쓴다: 0.10 → 0.15 이면 0.15', () => {
    const s = summarizeCost([
      { total_cost_usd: 0.1, modelUsage: model(0.1, 100, 20), usage: { output_tokens: 20 }, num_turns: 4, duration_ms: 1000 },
      { total_cost_usd: 0.15, modelUsage: model(0.15, 160, 35), usage: { output_tokens: 15 }, num_turns: 3, duration_ms: 700 },
    ]);
    expect(s.costUsd).toBe(0.15);
    expect(s.costTurn1Usd).toBe(0.1);
    expect(s.tokensIn).toBe(160);
    expect(s.tokensOut).toBe(35);
    expect(s.mainLoopOutputTokensSum).toBe(35);
    expect(s.numTurnsSum).toBe(7);
  });

  it('result 가 없으면 0 이고 1턴 값은 null', () => {
    expect(summarizeCost([])).toMatchObject({ costUsd: 0, costTurn1Usd: null });
  });
});

describe('종료 분류 (리뷰 M5)', () => {
  it.each([
    [{ is_error: false, subtype: 'success' }, 'ok'],
    [{ is_error: true, subtype: 'error_max_turns' }, 'behavior_end'],
    [{ is_error: true, subtype: 'error_max_budget_usd' }, 'behavior_end'],
    [{ is_error: true, subtype: 'error_during_execution', terminal_reason: 'budget_exhausted' }, 'behavior_end'],
    [{ is_error: true, subtype: 'success', api_error_status: 529 }, 'infra'],
    [{ is_error: true, subtype: 'error_during_execution', terminal_reason: 'api_error' }, 'infra'],
    [{ is_error: true, subtype: 'success', result: 'Not logged in · Please run /login' }, 'infra'],
  ] as const)('%j → %s', (result, expected) => {
    expect(classifyTurn(result).cls).toBe(expected);
  });

  it('subtype success 여도 is_error 가 참이면 성공이 아니다 (CLAUDE.md)', () => {
    expect(classifyTurn({ is_error: true, subtype: 'success', result: 'Invalid API key' })).toEqual({ cls: 'infra', reason: 'auth' });
  });

  it('사용량 한도는 실행 전체 중단 신호다', () => {
    expect(isUsageLimit({ is_error: true, api_error_status: 429 })).toBe(true);
    expect(isUsageLimit({ is_error: true, terminal_reason: 'blocking_limit' })).toBe(true);
    expect(isUsageLimit({ is_error: true, result: 'Claude usage limit reached' })).toBe(true);
    expect(isUsageLimit({ is_error: false, result: 'usage limit' })).toBe(false);
    expect(isUsageLimit({ is_error: true, api_error_status: 529, result: 'API Error: 529 overloaded' })).toBe(false);
  });
});
