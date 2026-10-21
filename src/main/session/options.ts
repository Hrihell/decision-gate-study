// 세션 옵션. 코딩 세션은 docs/SESSION.md 5절, 생성 세션은 9.1. **순수 모듈이다** — SDK 는 타입만 쓴다. `query` 를 부르지 않는다.
//
// 키 표에 없는 키를 넣지 않는다. 코딩 세션에는 특히:
// - `permissionMode` 는 `default` 로 고정한다. 자동 승인 모드는 `canUseTool` 을 가린다 (ADR-011, ARCHITECTURE 함정 5).
// - `env` 를 넣지 않는다. 이 값은 병합이 아니라 **교체**라 `{ ...process.env }` 를 빠뜨리면 `PATH` 가 사라진다 (함정 1).
// - `outputFormat` 을 넣지 않는다. 넣으면 모든 턴이 placeholder `tool_result` 로 끝난다 — 계획 세션과 합치지 않는다.

import type { CanUseTool, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';

import type { GenerationEffort } from '../../shared/types/gates';

/** 2층 규칙에서 글롭으로 해석되는 문자. 루트에 들어 있으면 보호 범위가 조용히 달라질 수 있다 (GATES §6.9). */
const GLOB_CHARS: ReadonlySet<string> = new Set(['*', '?', '[', ']', '{', '}']);

/** U+0000–U+001F. */
const FIRST_NON_CONTROL_CODE_POINT = 0x20;

const isControlChar = (ch: string): boolean => {
  const codePoint = ch.codePointAt(0);
  return codePoint !== undefined && codePoint < FIRST_NON_CONTROL_CODE_POINT;
};

/**
 * `/` 로 시작하고 글롭 문자·제어 문자를 담지 않으면 참.
 * `/` 로 시작하지 않는 경로(Windows 등)는 규칙 표기가 확인되지 않아 거짓이다.
 */
export function isSupportedProjectRoot(root: string): boolean {
  if (!root.startsWith('/')) return false;
  return !Array.from(root).some((ch) => GLOB_CHARS.has(ch) || isControlChar(ch));
}

/**
 * `.harness/` 쓰기를 모든 권한 모드에서 막는 2층 규칙 (ADR-010). 공식 표기 `//` + 루트의 앞 `/` 를 뗀 형태 (TESTING 실측 13).
 * `Edit(...)` 규칙이다 — `Write(...)` 가 아니다. 끝의 `/` 는 정리한다.
 *
 * 지원하지 않는 루트면 던진다 — 프로그래머 오류다. 호출자가 `isSupportedProjectRoot` 로 먼저 거른다.
 */
export function harnessDenyRule(root: string): string {
  if (!isSupportedProjectRoot(root)) {
    throw new Error('지원하지 않는 프로젝트 루트다 — isSupportedProjectRoot 로 먼저 거른다');
  }
  const trimmed = root.replace(/\/+$/, '');
  return `Edit(//${trimmed.slice(1)}/.harness/**)`;
}

export interface CodingOptionsInput {
  readonly projectRoot: string;
  readonly hooks: Options['hooks'];
  readonly canUseTool: CanUseTool;
  readonly harnessMcpServer: McpSdkServerConfigWithInstance;
  readonly abortController: AbortController;
  readonly pathToClaudeCodeExecutable: string | undefined;
  readonly stderr: (data: string) => void;
  /** 이어붙일 세션. 없으면 새 세션이다 (docs/SESSION.md 10.2). */
  readonly resumeSessionId?: string;
}

/**
 * 코딩 세션(장수명)의 `query()` 옵션. 배열은 호출마다 새로 만든다 — SDK 가 변경할 수 있다.
 * 지원하지 않는 루트면 던진다 (`harnessDenyRule` 과 같은 이유).
 *
 * **`continue` 를 넣지 않는다** — `resume` 과 상호 배타이고(`sdk.d.ts` L1467), 어느 세션을 잇는지는 우리가 정한다.
 */
export function buildCodingOptions(input: CodingOptionsInput): Options {
  const {
    projectRoot,
    hooks,
    canUseTool,
    harnessMcpServer,
    abortController,
    pathToClaudeCodeExecutable,
    stderr,
    resumeSessionId,
  } = input;
  return {
    cwd: projectRoot,
    permissionMode: 'default',
    // 생략하면 user + project + local 이 전부 로드된다 (ADR-012).
    settingSources: ['project'],
    // 읽기 도구와 진척 보고만 묻지 않는다. 허용된 도구는 `canUseTool` 에 닿지 않는다 — 쓰기 도구·Bash·와일드카드 금지.
    allowedTools: ['Read', 'Glob', 'Grep', 'mcp__harness__update_task'],
    // `Skill` 을 뺀다 (ADR-027 F7). 번들 스킬 호출은 내용 없는 권한 창("Skill 도구를 쓰려고 해요")으로 떠 초보자가
    // 판단할 수 없고, 번들 스킬에는 설정을 바꾸는 `update-config` 도 있다. 금지 쪽 변경이라 allowedTools 는 그대로다.
    disallowedTools: [harnessDenyRule(projectRoot), 'Skill'],
    hooks,
    canUseTool,
    mcpServers: { harness: harnessMcpServer },
    // 계정의 제3자 MCP 커넥터가 settingSources 와 무관하게 딸려 온다 — mcpServers 에 넘긴 것만 싣는다 (ADR-009 수정, TESTING 실측).
    strictMcpConfig: true,
    enableFileCheckpointing: true,
    abortController,
    // 키 자체를 두지 않는다 — `undefined` 값으로 두면 SDK 가 스스로 찾는 경로와 구별되지 않을 수 있다.
    ...(pathToClaudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable }),
    // 같은 이유로 키 자체를 두지 않는다. 새 세션과 "이어붙일 것이 없는 이어붙이기" 가 구별되어야 한다.
    ...(resumeSessionId === undefined ? {} : { resume: resumeSessionId }),
    stderr,
  };
}

/**
 * 세션이 사용자 저장소를 읽는가.
 * - `none`: 관문 선택지·계획 생성. 프롬프트가 폴더 내용을 요구하지 않아 실측에서 도구가 한 번도 쓰이지 않았다 (TESTING "생성 시간 실측")
 * - `read`: 점검 ③ 2계층. 라우트 파일과 그 import 를 Read·Glob·Grep 으로 읽고 판정한다 (AUDITS 4절)
 */
export type StructuredProjectAccess = 'none' | 'read';

export interface StructuredOptionsInput {
  readonly projectRoot: string;
  readonly schema: object;
  readonly model: string;
  readonly maxTurns: number;
  /** 필수다. 빠지면 SDK 기본값(high)으로 돌아 대기가 다시 길어진다 (GATES 3절). */
  readonly effort: GenerationEffort;
  readonly projectAccess: StructuredProjectAccess;
  readonly abortController: AbortController;
  readonly pathToClaudeCodeExecutable: string | undefined;
}

/** 읽기 도구. `read` 세션만 연다. 배열은 호출마다 새로 만든다 — SDK 가 변경할 수 있다. */
const readToolOptions = (projectAccess: StructuredProjectAccess): Pick<Options, 'tools' | 'allowedTools'> =>
  projectAccess === 'none'
    ? // 기본 도구 정의를 요청에서 뺀다 — 입력 토큰이 약 1/5 로 준다. StructuredOutput 은 그대로 동작한다 (TESTING 실측).
      { tools: [], allowedTools: [] }
    : // `tools` 키를 두지 않는다 — 실측하지 않은 세션의 도구 목록을 바꾸지 않는다.
      { allowedTools: ['Read', 'Glob', 'Grep'] };

/**
 * 생성 세션(일회성)의 `query()` 옵션. 명세는 docs/SESSION.md 9.1. `buildCodingOptions` 와 합치지 않는다.
 *
 * `canUseTool`·`hooks` 를 넣지 않는다 — 이 세션은 사용자에게 묻지 않고, 쓰기 도구가 목록에서 이미 사라져 지킬 것이 없다.
 * `enableFileCheckpointing` 도 없다 — 쓰지 않으니 되돌릴 것이 없다. 프롬프트는 옵션이 아니라 스트리밍 입력으로 간다.
 *
 * `mcpServers` 도 넘기지 않는다 (ADR-009 재수정, 2026-09-16 보안 검토). 막을 층이 없는 세션에 도구를 실지 않는다 —
 * `strictMcpConfig: true` 만 두면 계정의 제3자 커넥터도, 우리 도구도 아예 안 실린다.
 */
export function buildStructuredOptions(input: StructuredOptionsInput): Options {
  const { projectRoot, schema, model, maxTurns, effort, projectAccess, abortController, pathToClaudeCodeExecutable } =
    input;
  return {
    cwd: projectRoot,
    // **보안 수단이 아니다** (ADR-009). plan 모드의 편집은 막히지 않고 canUseTool 로 라우팅된다 (ARCHITECTURE 강제 표).
    // `planModeInstructions` 가 이 모드에서만 적용되기 때문에 두는 통로다. 차단은 아래 disallowedTools 가 한다.
    permissionMode: 'plan',
    // 생성은 프로젝트 설정을 읽을 이유가 없다 — 코딩 세션(['project'])과 다르다.
    settingSources: [],
    ...readToolOptions(projectAccess),
    // 도구 정의 자체가 요청에서 제거된다 — 권한 흐름 전에 일어나 어떤 모드·규칙도 뒤집지 못한다 (ADR-009, TESTING 실측).
    // `tools: []` 도 쓰기 도구를 빼지만 비우지 않는다 — ADR-009 1층은 "쓰기 도구가 요청에 없다" 는 **보장**이다.
    // 한 옵션의 동작에만 기대지 않는다. `read` 세션에서는 이것이 유일한 층이다.
    disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash'],
    // mcpServers 를 넘기지 않으므로 MCP 도구가 하나도 실리지 않는다 — 제3자 커넥터도, 우리 것도 (ADR-009 재수정).
    strictMcpConfig: true,
    // SDK 타입이 Record 를 요구한다. 스키마는 호출자의 JSON Schema 상수를 그대로 넘긴다.
    outputFormat: { type: 'json_schema', schema: schema as Record<string, unknown> },
    model,
    maxTurns,
    // 대기 시간을 정하는 값이다 — 관문 선택지 high 55~83초, low 19~26초 (TESTING "생성 시간 실측").
    effort,
    abortController,
    ...(pathToClaudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable }),
  };
}
