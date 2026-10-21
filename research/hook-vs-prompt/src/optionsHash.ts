// optionsHash (리뷰 M6). 실행마다 다른 값(runDir)을 `<RUN_DIR>` 로 바꾸고, 함수는 등록한 id 로, hook 은
// `{event, matcher, timeout, callbacks}` 목록으로 직렬화해 해시한다. env 는 **키만** 넣는다 (값은 로그·해시 어디에도 없다 — M2).
// 조건 쌍마다 허용된 차이 키 집합을 ALLOWED_DIFF 로 고정한다.

import { createHash } from 'node:crypto';

import type { ConditionId } from './conditions';

const FN_IDS = new WeakMap<object, string>();

/** 함수에 안정된 id 를 붙인다. 같은 역할이면 조건이 달라도 같은 id 여야 한다. 반환값은 같은 함수다. */
export function labelFn<F extends object>(fn: F, id: string): F {
  FN_IDS.set(fn, id);
  return fn;
}

export const RUN_DIR_TOKEN = '<RUN_DIR>';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const describeValue = (value: unknown, runDir: string, key: string): Json => {
  if (value === undefined) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.split(runDir).join(RUN_DIR_TOKEN);
  if (typeof value === 'function') return `fn:${FN_IDS.get(value) ?? 'unlabeled'}`;
  if (value instanceof AbortController) return 'AbortController';
  if (Array.isArray(value)) return value.map((v, i) => describeValue(v, runDir, `${key}[${i}]`));
  if (typeof value === 'object') {
    // env 는 키 이름만 (값을 남기지 않는다)
    if (key === 'env') return Object.keys(value).sort();
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, describeValue(v, runDir, k)] as const);
    return Object.fromEntries(entries);
  }
  return `unsupported:${typeof value}`;
};

/** 로그(run_meta.options)와 해시의 입력. 함수·비밀 값이 없다. */
export function describeOptions(options: object, runDir: string): Json {
  return describeValue(options, runDir, '');
}

export function hashOptions(description: Json): string {
  return createHash('sha256').update(JSON.stringify(description)).digest('hex');
}

/** 잎 경로 → 값 */
const flatten = (value: Json, prefix: string, out: Map<string, string>): void => {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    if (entries.length === 0) out.set(prefix, JSON.stringify(value));
    for (const [k, v] of entries) flatten(v, prefix === '' ? k : `${prefix}.${k}`, out);
    return;
  }
  out.set(prefix, JSON.stringify(value));
};

/** 두 옵션 설명에서 다른 키를 **앞 두 조각**으로 묶어 돌려준다 (예: `hooks.PreToolUse`, `systemPrompt.append`). */
export function diffKeys(a: Json, b: Json): string[] {
  const fa = new Map<string, string>();
  const fb = new Map<string, string>();
  flatten(a, '', fa);
  flatten(b, '', fb);
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  const differing = [...keys].filter((k) => fa.get(k) !== fb.get(k));
  return [...new Set(differing.map((k) => k.split('.').slice(0, 2).join('.')))].sort();
}

/** 조건 쌍의 허용된 차이 — DESIGN v2 §2.2 표와 같다. 키는 정렬한 쌍 `X|Y`. */
export const ALLOWED_DIFF: Readonly<Record<string, readonly string[]>> = {
  'A|B': ['systemPrompt.append'],
  'A|C': ['hooks.PreToolUse'],
  'B|C': ['hooks.PreToolUse', 'systemPrompt.append'],
  'C|Cp': ['canUseTool'],
  'A|Cp': ['canUseTool', 'hooks.PreToolUse'],
  'B|Cp': ['canUseTool', 'hooks.PreToolUse', 'systemPrompt.append'],
  'C|D': ['systemPrompt.append'],
  'B|D': ['hooks.PreToolUse'],
  'A|D': ['hooks.PreToolUse', 'systemPrompt.append'],
  'Cp|D': ['canUseTool', 'systemPrompt.append'],
  // E = C′ + sandbox 실행 폴더 쓰기 거부 (DESIGN N9)
  'Cp|E': ['sandbox.filesystem'],
  'C|E': ['canUseTool', 'sandbox.filesystem'],
  'A|E': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem'],
  'B|E': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem', 'systemPrompt.append'],
  'D|E': ['canUseTool', 'sandbox.filesystem', 'systemPrompt.append'],
  // F = E + 멈추고 보고하라 지시 (DESIGN N10)
  'E|F': ['systemPrompt.append'],
  'Cp|F': ['sandbox.filesystem', 'systemPrompt.append'],
  'C|F': ['canUseTool', 'sandbox.filesystem', 'systemPrompt.append'],
  'A|F': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem', 'systemPrompt.append'],
  'B|F': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem', 'systemPrompt.append'],
  'D|F': ['canUseTool', 'sandbox.filesystem', 'systemPrompt.append'],
  // H = C + 거부 사유 문구 교체 (DESIGN N11). 래퍼 콜백 id 만 달라 C|H 는 A|C 와 같은 키 — 문구 차이는 rewriteGateReason 테스트가 고정
  'C|H': ['hooks.PreToolUse'],
  'A|H': ['hooks.PreToolUse'],
  'B|H': ['hooks.PreToolUse', 'systemPrompt.append'],
  'Cp|H': ['canUseTool', 'hooks.PreToolUse'],
  'D|H': ['hooks.PreToolUse', 'systemPrompt.append'],
  'E|H': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem'],
  'F|H': ['canUseTool', 'hooks.PreToolUse', 'sandbox.filesystem', 'systemPrompt.append'],
};

export const pairKey = (x: ConditionId, y: ConditionId): string => [x, y].sort().join('|');

/** 실제 차이가 허용된 차이와 정확히 같은가. 파일럿 관문 6.5-3 이 이 함수를 쓴다. */
export function checkConditionDiff(x: ConditionId, y: ConditionId, a: Json, b: Json): { ok: boolean; actual: string[]; allowed: readonly string[] } {
  const allowed = x === y ? [] : (ALLOWED_DIFF[pairKey(x, y)] ?? []);
  const actual = diffKeys(a, b);
  return { ok: JSON.stringify(actual) === JSON.stringify([...allowed].sort()), actual, allowed };
}
