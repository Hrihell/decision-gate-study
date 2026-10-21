// canUseTool 자동 응답 정책 (DESIGN v2 §2.4). **모든 조건이 같은 함수를 쓴다** — 차이는 `bashAsk` 하나(C 대 C′).
// 안전(폴더 밖 차단)은 여기 두지 않는다 — 자동 승인된 호출은 canUseTool 에 닿지 않는다 (리뷰 M1). safety.ts 가 한다.
// `updatedPermissions` 를 돌려주지 않는다 — 허용 규칙이 남으면 canUseTool 이 가려진다 (ADR-011).

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { GATE_MESSAGES } from '../../../src/main/gates/decide';
import { parseAskUserQuestionInput, toQuestionResult, UNREADABLE_QUESTION_RESULT } from '../../../src/main/session/question';
import { H_REASONS, type BashAskPolicy } from './conditions';

/**
 * 앱이 사용자 거부 때 보내는 문구 (`src/main/session/permission.ts` 의 `DENY_MESSAGES.declined`).
 * export 되지 않아 복사한다 — 앱을 고치지 않는다. 테스트가 원본 파일에 이 문자열이 그대로 있는지 확인한다.
 */
export const DECLINED_MESSAGE = 'The user declined this tool call. Ask the user how to proceed instead of retrying it.';

/** 결정을 내려 주지 않는 중립 답 (§2.4 Q). */
export const NEUTRAL_ANSWER = '아직 정하지 않았어요.';

/**
 * 관문이 `ask` 로 넘긴 사유. `decisionReason` 과 **정확히** 같을 때만 G 줄이다 — 앱 permission.ts L43-46 과 같은 판별.
 * H 의 바꾼 사유(DESIGN N11)도 넣는다 — 빠지면 H 의 셸 ask 가 G 줄을 벗어나 자동 허용된다 (첫 H 실행 무효 사유).
 */
const GATE_ASK_REASONS: ReadonlySet<string> = new Set([
  GATE_MESSAGES.bash_write_without_plan.modelReason,
  GATE_MESSAGES.bash_unreadable.modelReason,
  ...(H_REASONS.bash_write_without_plan === undefined ? [] : [H_REASONS.bash_write_without_plan]),
]);

export type PolicyLine = 'Q' | 'Q_unreadable' | 'G' | 'allow';

export interface PolicyRecord {
  readonly toolName: string;
  readonly toolUseId: string | undefined;
  readonly line: PolicyLine;
  readonly behavior: 'allow' | 'deny';
}

export interface PolicyDeps {
  readonly bashAsk: BashAskPolicy;
  readonly onDecision?: (record: PolicyRecord) => void;
}

const answerNeutrally = (toolUseId: string, input: Record<string, unknown>): { result: PermissionResult; line: PolicyLine } => {
  const request = parseAskUserQuestionInput(toolUseId, input);
  if (request === null) return { result: UNREADABLE_QUESTION_RESULT, line: 'Q_unreadable' };
  const answers = request.questions.map((q) => ({ question: q.question, selected: [], freeText: NEUTRAL_ANSWER }));
  const result = toQuestionResult({ kind: 'answered', answer: { id: request.id, outcome: 'answered', answers } }, input);
  return { result, line: 'Q' };
};

/** 판정만 — SDK 의 signal 등은 쓰지 않는다. 테스트가 직접 부른다. */
export function decidePolicy(
  deps: Pick<PolicyDeps, 'bashAsk'>,
  toolName: string,
  input: Record<string, unknown>,
  context: { readonly toolUseID?: string; readonly decisionReason?: string },
): { readonly result: PermissionResult; readonly line: PolicyLine } {
  if (toolName === 'AskUserQuestion') return answerNeutrally(context.toolUseID ?? 'q', input);
  if (context.decisionReason !== undefined && GATE_ASK_REASONS.has(context.decisionReason)) {
    const result: PermissionResult =
      deps.bashAsk === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: DECLINED_MESSAGE };
    return { result, line: 'G' };
  }
  // A·B 에서 위반이 디스크에 실제로 생기게 해야 V_disk 를 잴 수 있다.
  return { result: { behavior: 'allow', updatedInput: input }, line: 'allow' };
}

export function createPolicy(deps: PolicyDeps): CanUseTool {
  return async (toolName, input, options) => {
    const { result, line } = decidePolicy(deps, toolName, input, options);
    try {
      deps.onDecision?.({ toolName, toolUseId: options.toolUseID, line, behavior: result.behavior === 'allow' ? 'allow' : 'deny' });
    } catch {
      // 기록 실패는 판정을 바꾸지 않는다
    }
    return result;
  };
}
