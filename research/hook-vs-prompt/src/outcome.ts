// 턴 결과 분류와 비용 집계.
// - 비용 (리뷰 M3): `total_cost_usd`·`modelUsage` 는 스트리밍 입력에서 **누적값**이다 (sdk.d.ts L5285-5295).
//   그래서 에피소드 비용은 **마지막** result 의 값이다. 턴 값을 더하지 않는다. `usage` 는 턴별·주 루프만이라 보조 지표로 합한다.
// - 종료 분류 (리뷰 M5): 행동 종료(max_turns·budget → 분석에 P0 로 넣는다)와 인프라 실패(재실행, 분석에서 뺀다)를 가른다.
//   성공 여부는 `is_error` 로만 판정한다 — subtype 으로 하지 않는다 (CLAUDE.md: 미인증이면 success + is_error true).

export type TurnClass = 'ok' | 'behavior_end' | 'infra';

export interface ResultLike {
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly total_cost_usd?: number;
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly modelUsage?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly api_error_status?: number | null;
  readonly terminal_reason?: string | null;
  readonly errors?: readonly string[];
  readonly result?: string;
}

const BEHAVIOR_SUBTYPES: ReadonlySet<string> = new Set(['error_max_turns', 'error_max_budget_usd']);
const BEHAVIOR_TERMINAL: ReadonlySet<string> = new Set(['max_turns', 'budget_exhausted']);
const LIMIT_TERMINAL: ReadonlySet<string> = new Set(['blocking_limit', 'rapid_refill_breaker']);
const LIMIT_TEXT = /usage limit|rate limit|limit reached|too many requests/i;
const AUTH_TEXT = /not logged in|please run \/login|invalid api key|authenticat|unauthori[sz]ed|oauth/i;

const textOf = (r: ResultLike): string => [r.result ?? '', ...(r.errors ?? [])].join('\n');

export function classifyTurn(r: ResultLike): { readonly cls: TurnClass; readonly reason: string } {
  if (r.is_error !== true) return { cls: 'ok', reason: 'ok' };
  if ((r.subtype !== undefined && BEHAVIOR_SUBTYPES.has(r.subtype)) || (r.terminal_reason != null && BEHAVIOR_TERMINAL.has(r.terminal_reason))) {
    return { cls: 'behavior_end', reason: r.subtype ?? String(r.terminal_reason) };
  }
  if (isUsageLimit(r)) return { cls: 'infra', reason: 'usage_limit' };
  if (isAuthFailure(r)) return { cls: 'infra', reason: 'auth' };
  if (r.api_error_status != null) return { cls: 'infra', reason: `api_${r.api_error_status}` };
  return { cls: 'infra', reason: `error_${r.subtype ?? 'unknown'}_${r.terminal_reason ?? 'none'}` };
}

/** 사용량 한도 — 걸리면 **실행 전체를 멈춘다** (M5). */
export function isUsageLimit(r: ResultLike): boolean {
  if (r.is_error !== true) return false;
  return r.api_error_status === 429 || (r.terminal_reason != null && LIMIT_TERMINAL.has(r.terminal_reason)) || LIMIT_TEXT.test(textOf(r));
}

export function isAuthFailure(r: ResultLike): boolean {
  if (r.is_error !== true) return false;
  return r.api_error_status === 401 || r.api_error_status === 403 || AUTH_TEXT.test(textOf(r));
}

export interface CostSummary {
  /** 마지막 result 의 누적값 (M3) */
  readonly costUsd: number;
  /** 1턴 result 의 값 — 턴별 분해용 */
  readonly costTurn1Usd: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCacheRead: number;
  readonly tokensCacheWrite: number;
  /** 보조: 턴별 `usage`(주 루프만) 의 합 */
  readonly mainLoopOutputTokensSum: number;
  /** 턴별 값의 합 — num_turns 는 턴 안의 왕복 수라 더해도 된다 (sdk.d.ts L5318) */
  readonly numTurnsSum: number;
  /** 턴별 duration_ms 의 합. 누적인지 턴별인지는 파일럿에서 확인 (RUNBOOK 관문 표) */
  readonly durationMsSum: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function summarizeCost(results: readonly ResultLike[]): CostSummary {
  const last = results.at(-1);
  const models = Object.values(last?.modelUsage ?? {});
  const sumModels = (key: string): number => models.reduce((acc, m) => acc + num(m[key]), 0);
  return {
    costUsd: num(last?.total_cost_usd),
    costTurn1Usd: results.length > 0 ? num(results[0]?.total_cost_usd) : null,
    tokensIn: sumModels('inputTokens'),
    tokensOut: sumModels('outputTokens'),
    tokensCacheRead: sumModels('cacheReadInputTokens'),
    tokensCacheWrite: sumModels('cacheCreationInputTokens'),
    mainLoopOutputTokensSum: results.reduce((acc, r) => acc + num(r.usage?.output_tokens), 0),
    numTurnsSum: results.reduce((acc, r) => acc + num(r.num_turns), 0),
    durationMsSum: results.reduce((acc, r) => acc + num(r.duration_ms), 0),
  };
}
