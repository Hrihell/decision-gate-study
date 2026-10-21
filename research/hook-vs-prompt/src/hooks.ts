// 조건별 hook 조립. PreToolUse 순서: safety → 관찰 → (관문 조건만) 관문.
// 관문은 앱의 `createGateHooks` 를 **고치지 않고** 쓰고, 판정 기록을 위해 콜백만 감싼다 — 앱 SESSION §7 래퍼와 같은 방식.
// `createGateHooks` 출력에는 rule 이 없으므로 modelReason → rule 역매핑으로 얻는다 (리뷰 S7).

import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';

import { GATE_MESSAGES, type GateRule } from '../../../src/main/gates/decide';
import { createGateHooks } from '../../../src/main/gates/hooks';
import { createPlanStore } from '../../../src/main/plan/store';
import { H_REASONS, type ConditionSpec } from './conditions';
import type { Recorder } from './log';
import { createObserveHooks } from './observe';
import { labelFn } from './optionsHash';
import { realPathOf } from './realpath';
import { createSafetyHooks } from './safety';

type HookMap = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** modelReason → rule. 문구가 모두 달라야 한다 (테스트가 고정). */
export const GATE_RULE_BY_REASON: ReadonlyMap<string, GateRule> = new Map(
  (Object.entries(GATE_MESSAGES) as [GateRule, { modelReason: string }][]).map(([rule, m]) => [m.modelReason, rule]),
);

const readDecision = (out: HookJSONOutput): { kind: 'allow' | 'deny' | 'ask'; reason: string | undefined } => {
  const specific = 'hookSpecificOutput' in out ? out.hookSpecificOutput : undefined;
  if (specific === undefined || specific.hookEventName !== 'PreToolUse' || specific.permissionDecision === undefined) {
    return { kind: 'allow', reason: undefined };
  }
  const kind = specific.permissionDecision === 'deny' || specific.permissionDecision === 'ask' ? specific.permissionDecision : 'allow';
  return { kind, reason: specific.permissionDecisionReason };
};

/** H (DESIGN N11): 원래 판정의 사유만 H_REASONS 로 바꾼 새 출력. 바꿀 규칙이 아니면 그대로 돌려준다. */
export function rewriteGateReason(out: HookJSONOutput, rule: GateRule | null): HookJSONOutput {
  const replacement = rule === null ? undefined : H_REASONS[rule];
  if (replacement === undefined || !('hookSpecificOutput' in out)) return out;
  const specific = out.hookSpecificOutput;
  if (specific === undefined || specific.hookEventName !== 'PreToolUse') return out;
  return { ...out, hookSpecificOutput: { ...specific, permissionDecisionReason: replacement } };
}

/**
 * 관문 콜백을 감싸 gate_verdict 를 남긴다. 감싼 쪽도 reject 하지 않는다.
 * 기록은 **원래 사유**로 한다 — H 의 문구 교체는 기록 뒤에 한다 (바꾼 문구로는 rule 을 되찾을 수 없다).
 */
const wrapGate = (cb: HookCallback, recorder: Recorder, id: string, reasons: ConditionSpec['gateReasons']): HookCallback =>
  labelFn<HookCallback>(async (input, toolUseId, options) => {
    const out = await cb(input, toolUseId, options);
    let rule: GateRule | null = null;
    try {
      const { kind, reason } = readDecision(out);
      rule = reason === undefined ? null : (GATE_RULE_BY_REASON.get(reason) ?? null);
      recorder.write({
        type: 'gate_verdict',
        toolUseId: toolUseId ?? (input.hook_event_name === 'PreToolUse' ? input.tool_use_id : undefined),
        kind,
        rule: reason === undefined ? null : (rule ?? 'unknown'),
      });
    } catch {
      // 기록 실패는 판정을 바꾸지 않는다
    }
    return reasons === 'conversation' ? rewriteGateReason(out, rule) : out;
  }, id);

export interface HookDeps {
  readonly condition: ConditionSpec;
  readonly runDir: string;
  readonly recorder: Recorder;
  readonly turn: () => number;
  readonly readFileText: (absolutePath: string) => string | undefined;
}

export function buildHooks(deps: HookDeps): NonNullable<Options['hooks']> {
  const { recorder } = deps;
  const safety = createSafetyHooks({
    runDir: deps.runDir,
    readFileText: deps.readFileText,
    realPathOf,
    onVerdict: (v) => recorder.write({ type: 'safety_verdict', ...v }),
  });
  for (const m of safety.PreToolUse ?? []) m.hooks.forEach((h) => labelFn(h, 'safety'));
  const observe = createObserveHooks({ recorder, runDir: deps.runDir, turn: deps.turn });

  const gate: HookMap = deps.condition.gate
    ? createGateHooks({
        projectRoot: deps.runDir,
        // 실제 계획 저장소 — 셸로 위조한 계획이 스키마를 통과해야 열린다 (DESIGN §2.6)
        loadPlanState: async () => (await createPlanStore().read(deps.runDir)).kind,
        getPrefs: () => ({ gatesEnabled: true, bashWriteGateEnabled: true }),
      })
    : {};
  const gateMatchers = (gate.PreToolUse ?? []).map((m, i) => ({
    ...m,
    hooks: m.hooks.map((h) =>
      // 다른 id — 해시가 C 와 H 를 가르게 (ALLOWED_DIFF C|H = hooks.PreToolUse)
      deps.condition.gateReasons === 'conversation'
        ? wrapGate(h, recorder, `gate.conversation.${m.matcher ?? i}`, 'conversation')
        : wrapGate(h, recorder, `gate.${m.matcher ?? i}`, 'app'),
    ),
  }));

  return {
    PreToolUse: [...(safety.PreToolUse ?? []), ...(observe.PreToolUse ?? []), ...gateMatchers],
    PostToolUse: [...(observe.PostToolUse ?? [])],
    PostToolUseFailure: [...(observe.PostToolUseFailure ?? [])],
  };
}
