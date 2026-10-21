// 관문 판정. 명세는 docs/GATES.md §6.5. **순수 모듈이다** — SDK·fs·electron·log 를 import 하지 않는다.
//
// 판정 표 9줄을 위에서부터 처음 맞는 줄로 적용한다. `permission_mode`·`agent_id` 는 입력이 아니다 —
// 서브에이전트나 `bypassPermissions` 에서 판정이 달라지면 관문에 구멍이 난다.
// 결과를 캐시하지 않는다. 계획 상태와 토글은 호출마다 바뀔 수 있다.

import path from 'node:path';

import type { PlanLoadResult } from '../../shared/types/plan';
import { classifyBash } from './bashCommand';
import { readBashCommand, readTargetPath } from './toolInputs';

export type PlanState = PlanLoadResult['kind'];

export interface GateContext {
  readonly toolName: string;
  /** hook 이 받은 그대로. 여기서 6.3 함수로 읽는다 — 깨진 입력도 이 함수의 테스트 대상이다. */
  readonly toolInput: unknown;
  /** PreToolUseHookInput.cwd — 상대 경로의 기준 */
  readonly cwd: string;
  readonly projectRoot: string;
  readonly planState: PlanState;
  readonly gatesEnabled: boolean;
  readonly bashWriteGateEnabled: boolean;
}

export const GATE_RULES = [
  'harness_write',
  'plan_missing',
  'plan_invalid',
  'bash_unreadable',
  'bash_write_without_plan',
  'internal_error',
] as const;
export type GateRule = (typeof GATE_RULES)[number];

export type GateVerdict =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'deny' | 'ask';
      readonly rule: GateRule;
      readonly modelReason: string;
      readonly userMessage: string;
      /**
       * `{명령}` 자리를 채운 규칙일 때만 — 자르기 전 원래 명령. 어댑터가 이것을 가린 뒤 `renderCommandMessage` 로 다시 채운다
       * (SECURITY "비밀 값 가리기"). 판정에는 쓰지 않는다.
       */
      readonly command?: string;
    };

/** 사용자 메시지의 자리표시자. 모델 사유에는 자리표시자가 없다. */
const PATH_SLOT = '{경로}';
const COMMAND_SLOT = '{명령}';

/**
 * §6.5 메시지 표 원문. `modelReason` 은 모델이 읽는 영어 지시문, `userMessage` 는 앱 UI 가 보이는 한국어다.
 * 문구를 바꾸려면 문서부터 고친다.
 */
export const GATE_MESSAGES: Readonly<Record<GateRule, { readonly modelReason: string; readonly userMessage: string }>> = {
  harness_write: {
    modelReason:
      'BLOCKED by the project harness: shell commands that write inside .harness/ are not allowed. Only the application writes those files. Read them with the Read tool and report progress with mcp__harness__update_task.',
    userMessage: `에이전트가 셸 명령으로 계획 폴더(.harness)를 고치려 해서 막았어요: ${COMMAND_SLOT}`,
  },
  plan_missing: {
    modelReason:
      'BLOCKED by the project harness: there is no plan yet, so files cannot be created or edited. Tell the user to finish the open decisions in the app. The application writes the plan and this block lifts automatically. Do not try to create the plan file yourself.',
    userMessage: `계획이 아직 없어 파일 작성을 막았어요 (${PATH_SLOT})`,
  },
  plan_invalid: {
    modelReason:
      'BLOCKED by the project harness: the plan file could not be read as a valid plan, so files cannot be created or edited. Stop and tell the user the plan file needs attention in the app. Do not try to fix the plan file yourself.',
    userMessage: `계획 파일을 읽을 수 없어 파일 작성을 막았어요 (${PATH_SLOT}). 앱에서 계획 상태를 확인해 주세요`,
  },
  bash_unreadable: {
    modelReason: 'The harness could not read this shell command. Proceed only if the user approves.',
    userMessage: '에이전트가 실행하려는 명령을 읽지 못했어요. 실행해도 되는지 확인해 주세요',
  },
  bash_write_without_plan: {
    modelReason:
      'This shell command appears to write files, and there is no valid plan yet. Prefer telling the user to finish the open decisions in the app first. Proceed only if the user approves.',
    userMessage: `계획이 없는 상태에서 파일을 만드는 것 같은 명령이에요: ${COMMAND_SLOT}`,
  },
  internal_error: {
    modelReason:
      'BLOCKED by the project harness: the gate check failed internally. Do not retry this tool call. Tell the user the harness reported an error.',
    userMessage: '관문 검사 중 오류가 나서 이번 작업을 막았어요. 앱을 다시 시작해 보세요',
  },
};

/** 어댑터가 판정 자체에 실패했을 때 쓴다 (§6.6). decideGate 는 이 규칙을 돌려주지 않는다. */
export const INTERNAL_ERROR_VERDICT: GateVerdict = {
  kind: 'deny',
  rule: 'internal_error',
  ...GATE_MESSAGES.internal_error,
};

const ALLOW: GateVerdict = { kind: 'allow' };

const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit']);

/** 사용자 메시지에 보이는 명령의 최대 길이. 넘으면 잘라서 `…` 를 붙인다. */
const MAX_COMMAND_DISPLAY_LENGTH = 120;

const LINE_BREAK = /\r\n|\n|\r/g;

/** `{명령}`: 줄바꿈을 공백으로 바꾸고, 120자를 넘으면 앞 120자 + `…`. 코드 포인트 단위로 센다. */
const formatCommand = (command: string): string => {
  const chars = Array.from(command.replace(LINE_BREAK, ' '));
  if (chars.length <= MAX_COMMAND_DISPLAY_LENGTH) return chars.join('');
  return `${chars.slice(0, MAX_COMMAND_DISPLAY_LENGTH).join('')}…`;
};

/**
 * `{경로}`: 대상을 못 읽었으면 도구 이름. 상대 대상은 `cwd` 기준으로 해석한다 — `projectRoot` 가 아니다.
 * `projectRoot` 안이면 루트 기준 상대 경로(`/` 구분), 밖이면 절대 경로.
 * `path.relative` 로 판정하므로 이름만 겹치는 형제 디렉터리(`/app` 과 `/app-old`)는 밖이다.
 */
const formatTarget = (ctx: GateContext): string => {
  const target = readTargetPath(ctx.toolName, ctx.toolInput);
  if (target === undefined) return ctx.toolName;
  const absolute = path.resolve(ctx.cwd, target);
  const relative = path.relative(path.resolve(ctx.projectRoot), absolute);
  const isInside =
    relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return isInside ? relative.split(path.sep).join('/') : absolute;
};

/** 자리표시자를 값으로 바꾼다. 치환 함수를 쓴다 — 명령·경로의 `$&` 같은 패턴이 해석되지 않게. */
const fill = (template: string, slot: string, value: string): string => template.replace(slot, () => value);

/** 명령을 가리지 못했을 때 `{명령}` 자리에 넣는 글. 원문을 내보내지 않는다 (fail-closed). */
export const COMMAND_UNAVAILABLE_TEXT = '(명령을 표시하지 못했어요)';

/**
 * `{명령}` 자리가 있는 규칙의 사용자 메시지. 명령을 줄바꿈 정리·120자 자르기 한 뒤 채운다.
 * 어댑터는 **가린 명령**을 넘긴다 — 잘린 키는 가리기 규칙에 걸리지 않으므로 자르기 전에 가려야 한다.
 * 자리가 없는 규칙이면 템플릿 그대로다.
 */
export function renderCommandMessage(rule: GateRule, command: string): string {
  return fill(GATE_MESSAGES[rule].userMessage, COMMAND_SLOT, formatCommand(command));
}

const verdict = (kind: 'deny' | 'ask', rule: GateRule, slot?: { key: string; value: string }): GateVerdict => {
  const { modelReason, userMessage } = GATE_MESSAGES[rule];
  return {
    kind,
    rule,
    modelReason,
    userMessage: slot === undefined ? userMessage : fill(userMessage, slot.key, slot.value),
  };
};

const commandVerdict = (kind: 'deny' | 'ask', rule: GateRule, command: string): GateVerdict => ({
  kind,
  rule,
  modelReason: GATE_MESSAGES[rule].modelReason,
  userMessage: renderCommandMessage(rule, command),
  command,
});

/** 전함수다. 어떤 입력에도 던지지 않는다. */
export function decideGate(ctx: GateContext): GateVerdict {
  const isBash = ctx.toolName === 'Bash';
  const command = isBash ? readBashCommand(ctx.toolInput) : undefined;
  const bashClass = command === undefined ? undefined : classifyBash(command);

  // 1. 토글·계획 상태와 무관하다 — 관문을 꺼도 계획 파일을 에이전트에게 넘기지 않는다.
  if (command !== undefined && bashClass?.writesFiles === true && bashClass.touchesHarness) {
    return commandVerdict('deny', 'harness_write', command);
  }
  // 2.
  if (!ctx.gatesEnabled) return ALLOW;
  // 3.
  if (ctx.planState === 'ok') return ALLOW;
  // 4·5. 대상 경로를 보지 않는다 — 경로는 메시지 표시용이다.
  if (FILE_TOOLS.has(ctx.toolName)) {
    const rule = ctx.planState === 'missing' ? 'plan_missing' : 'plan_invalid';
    return verdict('deny', rule, { key: PATH_SLOT, value: formatTarget(ctx) });
  }
  if (!isBash) return ALLOW; // 9. 다른 도구
  // 6.
  if (!ctx.bashWriteGateEnabled) return ALLOW;
  // 7. `invalid` 는 `missing` 과 같게 다룬다 (7·8).
  if (command === undefined) return verdict('ask', 'bash_unreadable');
  // 8.
  if (bashClass?.writesFiles === true) {
    return commandVerdict('ask', 'bash_write_without_plan', command);
  }
  // 9. 쓰기 아닌 Bash
  return ALLOW;
}
