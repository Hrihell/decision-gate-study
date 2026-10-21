// 공통 옵션 조립 (DESIGN v2 §2.1). **순수** — SDK 는 타입만. 조건 간 차이는 `systemPrompt.append`·`hooks`·`canUseTool`
// 셋뿐이어야 한다 — optionsHash.ts 의 ALLOWED_DIFF 가 그것을 고정하고 테스트한다 (리뷰 M6).
// 앱의 `buildCodingOptions` 는 쓰지 않는다 — 차이 키가 코드에서 안 보이게 된다 (DESIGN §9.3).

import type { CanUseTool, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import { harnessDenyRule, isSupportedProjectRoot } from '../../../src/main/session/options';
import type { ConditionSpec } from './conditions';

export const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  /** 날짜 없는 id 다 (리뷰 S10) — 실제 모델은 system/init.model 로 기록한다. */
  sonnet: 'claude-sonnet-5-5',
} as const;

export const LIMITS = {
  maxTurns: 30,
  /** 리뷰 S8: 파일럿 p95 의 3배로 다시 잡는다. 그 전까지의 잠정값. */
  maxBudgetUsd: { haiku: 1.5, sonnet: 4.5 },
  episodeTimeoutMs: 8 * 60_000,
} as const;

/**
 * 네 조건 공통 기본 도구 집합 (SDK `tools`). 허용 목록으로 고정한다 — 파일럿에서 기본 집합에
 * SendMessage·Workflow·EnterPlanMode·ToolSearch·Task* 등이 열려 있었고, C 계열만 CLI 계획 모드로 들어가
 * 위반 감소가 hook 만의 효과가 아니게 됐다 (STATUS §6, DESIGN 변경 이력 N4). TaskOutput·TaskStop 은 배경 Bash 용.
 */
export const BASE_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion', 'TaskOutput', 'TaskStop'] as const;

/** 세 조건 공통으로 빼는 도구 (§2.1). Agent·Task 는 이름이 init.tools 와 hook 에서 달라 둘 다 넣는다. */
export const EXTRA_DISALLOWED = ['Skill', 'Agent', 'Task', 'WebFetch', 'WebSearch'] as const;

export interface ExperimentOptionsInput {
  readonly condition: ConditionSpec;
  readonly runDir: string;
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly hooks: Options['hooks'];
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly env: Readonly<Record<string, string>>;
  /** 셸 명령에서 숨길 인증 변수 이름 */
  readonly authKeys: readonly string[];
  /** CLI 를 프로세스 그룹으로 띄운다 (리뷰 M7). mock 에서는 없다. */
  readonly spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  readonly stderr?: (data: string) => void;
}

/** sandbox (리뷰 M1 — 필수). 자동 허용을 끈다: 켜면 Bash 가 canUseTool 을 건너뛰어 G 줄(C 대 C′)이 사라진다. */
/** osDenyWrite (E, DESIGN N9): 계획이 없는 동안 실행 폴더 쓰기를 OS 수준에서 거부 — 셸이 띄운 하위 프로세스(node -e 등)까지 */
export function buildSandbox(runDir: string, authKeys: readonly string[], osDenyWrite = false): NonNullable<Options['sandbox']> {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [runDir], ...(osDenyWrite ? { denyWrite: [runDir] } : {}), denyRead: ['~'] },
    ...(authKeys.length === 0 ? {} : { credentials: { envVars: authKeys.map((name) => ({ name, mode: 'deny' as const })) } }),
  };
}

export function buildExperimentOptions(input: ExperimentOptionsInput): Options {
  const { condition, runDir } = input;
  if (!isSupportedProjectRoot(runDir)) throw new Error('지원하지 않는 실행 폴더다');
  return {
    cwd: runDir,
    permissionMode: 'default',
    model: input.model,
    systemPrompt:
      condition.append === undefined
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: condition.append },
    settingSources: [],
    strictMcpConfig: true,
    tools: [...BASE_TOOLS],
    allowedTools: ['Read', 'Glob', 'Grep'],
    disallowedTools: [harnessDenyRule(runDir), ...EXTRA_DISALLOWED],
    canUseTool: input.canUseTool,
    hooks: input.hooks,
    maxTurns: LIMITS.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    persistSession: false,
    enableFileCheckpointing: false,
    env: { ...input.env },
    sandbox: buildSandbox(runDir, input.authKeys, condition.osDenyWrite),
    abortController: input.abortController,
    ...(input.spawnClaudeCodeProcess === undefined ? {} : { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
  };
}
