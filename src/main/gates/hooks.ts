// 관문 hook 어댑터. 명세는 docs/GATES.md §6.6. 판정은 decide.ts 가 하고, 여기는 SDK 모양으로 옮기기만 한다.
// 단 알림의 `{명령}` 은 판정 뒤에 가려서 다시 채운다 — 판정은 건드리지 않는다 (docs/SECURITY.md "비밀 값 가리기").
//
// SDK 는 **타입만** import 한다 — 런타임 값을 끌어오면 메인 번들에 SDK 가 딸려 온다.
// 로깅은 하지 않는다 (로거가 electron 을 import 한다). 거부 기록은 phase 04 에서 콜백을 감싸 붙인다.
//
// 콜백은 reject 하지 않는다. hook 실패 시 SDK 가 도구 호출을 막는지 통과시키는지 확인되지 않았다
// (docs/TESTING.md 재검증 표 12) — 실패를 판정으로 바꿔 그 질문을 피한다.

import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_PROJECT_PREFS, type ProjectPrefs } from '../../shared/types/appState';
import {
  COMMAND_UNAVAILABLE_TEXT,
  decideGate,
  INTERNAL_ERROR_VERDICT,
  renderCommandMessage,
  type GateVerdict,
  type PlanState,
} from './decide';

export type GatePrefs = Pick<ProjectPrefs, 'gatesEnabled' | 'bashWriteGateEnabled'>;

export interface GateHookDeps {
  readonly projectRoot: string;
  /** 도구 호출마다 부른다. 연결은 phase 04: `async () => (await planStore.read(root)).kind` */
  readonly loadPlanState: () => Promise<PlanState>;
  /** 도구 호출마다 부른다 — 토글이 세션 재시작 없이 반영된다. */
  readonly getPrefs: () => GatePrefs;
  /**
   * 관문 알림의 `{명령}` 자리에 넣기 전에 에이전트의 Bash 명령을 가린다 (SECURITY "비밀 값 가리기"). null 이면 가리기 실패.
   * 없으면 원래 명령을 그대로 넣는다 — 테스트·다른 호출자용.
   */
  readonly maskText?: (text: string) => Promise<string | null>;
}

/** §6.1 — 판정이 `tool_name` 을 다시 확인하므로 정확성이 CLI 의 matcher 해석에 의존하지 않는다. */
const FILE_TOOLS_MATCHER = 'Write|Edit|NotebookEdit';
const BASH_MATCHER = 'Bash';

/** 초 단위다 (sdk.d.ts HookCallbackMatcher.timeout). */
const GATE_HOOK_TIMEOUT_SECONDS = 5;

/**
 * allow 는 `{}` — 의견 없음이다. hook 의 `'allow'` 는 deny/ask 규칙을 건너뛰지 않고 쓸 이유도 없다.
 * `continue` 를 넣지 않는다 — 턴은 이어지고 이 도구 호출만 거부된다.
 */
const toHookOutput = (verdict: GateVerdict): HookJSONOutput => {
  if (verdict.kind === 'allow') return {};
  return {
    systemMessage: verdict.userMessage,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.kind,
      permissionDecisionReason: verdict.modelReason,
    },
  };
};

/** 토글을 못 읽으면 기본값(관문 켜짐)으로 판정한다. */
const readPrefs = (deps: GateHookDeps): GatePrefs => {
  try {
    const { gatesEnabled, bashWriteGateEnabled } = deps.getPrefs();
    return { gatesEnabled, bashWriteGateEnabled };
  } catch {
    const { gatesEnabled, bashWriteGateEnabled } = DEFAULT_PROJECT_PREFS;
    return { gatesEnabled, bashWriteGateEnabled };
  }
};

/** 가리기가 null 이거나 던지면 null. 던지지 않는다 — 콜백이 reject 하면 관문이 열린다. */
const maskOrNull = async (maskText: (text: string) => Promise<string | null>, text: string): Promise<string | null> => {
  try {
    return await maskText(text);
  } catch {
    return null;
  }
};

/**
 * `{명령}` 자리가 있는 판정이면 원래 명령을 **먼저 가리고** 그다음 자른다 — 잘린 키는 가리기 규칙에 걸리지 않는다.
 * 가리기가 실패하면 명령 자리를 비운다. 판정(`kind`)과 `modelReason` 은 그대로다 — 모델은 자기 명령을 이미 안다.
 */
const withMaskedCommand = async (verdict: GateVerdict, deps: GateHookDeps): Promise<GateVerdict> => {
  if (verdict.kind === 'allow' || verdict.command === undefined || deps.maskText === undefined) return verdict;
  const masked = await maskOrNull(deps.maskText, verdict.command);
  return { ...verdict, userMessage: renderCommandMessage(verdict.rule, masked ?? COMMAND_UNAVAILABLE_TEXT) };
};

/** 계획 상태를 못 읽으면 `invalid` 로 판정한다 — 파일 도구는 막히고 Bash 는 `ask`. */
const readPlanState = async (deps: GateHookDeps): Promise<PlanState> => {
  try {
    return await deps.loadPlanState();
  } catch {
    return 'invalid';
  }
};

export function createGateHooks(deps: GateHookDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const gateHook: HookCallback = async (input) => {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const prefs = readPrefs(deps);
      const planState = await readPlanState(deps);
      const verdict = decideGate({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        projectRoot: deps.projectRoot,
        planState,
        gatesEnabled: prefs.gatesEnabled,
        bashWriteGateEnabled: prefs.bashWriteGateEnabled,
      });
      return toHookOutput(await withMaskedCommand(verdict, deps));
    } catch {
      // decideGate 는 전함수지만 입력 객체의 getter 는 던질 수 있다.
      return toHookOutput(INTERNAL_ERROR_VERDICT);
    }
  };

  return {
    PreToolUse: [
      { matcher: FILE_TOOLS_MATCHER, hooks: [gateHook], timeout: GATE_HOOK_TIMEOUT_SECONDS },
      { matcher: BASH_MATCHER, hooks: [gateHook], timeout: GATE_HOOK_TIMEOUT_SECONDS },
    ],
  };
}
