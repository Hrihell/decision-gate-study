// 실험 안전 hook (DESIGN v2 §2.4a, 리뷰 M1). **세 조건 공통**이다 — 판정 함수가 조건마다 같으므로 교란이 아니다.
//
// 왜 `PreToolUse` 인가: 자동 승인된 호출(allowedTools 의 Read/Glob/Grep, CLI 가 스스로 허용하는 읽기 전용 Bash)은
// `canUseTool` 에 닿지 않는다 (CLAUDE.md, docs/TESTING.md L392). 그러면 무인 실행에서 사용자 홈이 읽히고 로그에 남는다.
// hook 은 모든 도구 호출 앞에서 돈다.
//
// 금지 목록 방식이고 **과잉 차단을 감수한다** — 조건 간 같으므로 결과를 기울이지 않는다. 셸을 파싱하지 않는다.
// 실행 중 스크립트가 내부에서 홈을 여는 것은 정적으로 다 잡을 수 없다 → sandbox(옵션)와 전용 macOS 계정이 다음 층이다.
//
// 콜백은 reject 하지 않는다. 판정 중 예외는 거부로 바꾼다 (fail-closed).

import path from 'node:path';

import type { HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export const SAFETY_RULES = [
  'unreadable_input',
  'cwd_outside',
  'path_outside',
  'bash_home_ref',
  'bash_abs_outside',
  'bash_parent_dir',
  'bash_env_dump',
  'bash_privileged',
  'script_home_ref',
  'internal_error',
] as const;
export type SafetyRule = (typeof SAFETY_RULES)[number];

export type SafetyVerdict = { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly rule: SafetyRule };

/** 모델이 읽는 거부 사유. 규칙과 무관하게 하나다 — 어떤 규칙에 걸렸는지 알려 주면 우회를 돕는다. 조건 간 같다. */
export const SAFETY_MODEL_REASON =
  'BLOCKED by the experiment safety guard: this tool call reaches outside the project folder or exposes the environment. Work only inside the current project folder.';

export interface SafetyContext {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** PreToolUseHookInput.cwd — 상대 경로의 기준 (CLAUDE.md: `input.cwd` 기준으로 해석) */
  readonly cwd: string;
  /** 실행 폴더의 realpath */
  readonly runDir: string;
  /** 실행 폴더 안 스크립트의 내용. 없거나 못 읽으면 undefined. 테스트가 주입한다. */
  readonly readFileText: (absolutePath: string) => string | undefined;
  /**
   * 심볼릭 링크를 따라간 실제 경로 (`realpath.ts`). 글자로는 폴더 안이어도 링크가 밖을 가리키면 밖이다.
   * 없으면(순수 판정 테스트) 글자 판정만 한다. 못 풀면 undefined.
   */
  readonly realPathOf?: (absolutePath: string) => string | undefined;
}

const ALLOW: SafetyVerdict = { kind: 'allow' };
const deny = (rule: SafetyRule): SafetyVerdict => ({ kind: 'deny', rule });

// ---------------------------------------------------------------- 경로

/** macOS 의 `/var`·`/tmp`·`/etc` 는 `/private/…` 의 심볼릭 링크다. 양쪽을 같은 모양으로 맞춘다. */
const PRIVATE_ALIASES: readonly string[] = ['/var', '/tmp', '/etc'];
const canonical = (p: string): string => {
  const normalized = path.normalize(p);
  const alias = PRIVATE_ALIASES.find((a) => normalized === a || normalized.startsWith(`${a}/`));
  return alias === undefined ? normalized : `/private${normalized}`;
};

/** `child` 가 `root` 이거나 그 아래인가. 이름만 겹치는 형제(`/run` 과 `/run-other`)는 밖이다. */
const isInsideOrEqual = (root: string, child: string): boolean => {
  const relative = path.relative(canonical(root), canonical(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** 홈을 가리키는 표기. `~` 로 시작하는 경로는 path.resolve 가 풀지 못하므로 따로 본다. */
const startsWithTilde = (p: string): boolean => p === '~' || p.startsWith('~/') || /^~[\w.-]/.test(p);

const pathIsOutside = (ctx: SafetyContext, raw: string): boolean => {
  if (startsWithTilde(raw.trim())) return true;
  const absolute = path.resolve(ctx.cwd, raw);
  if (!isInsideOrEqual(ctx.runDir, absolute)) return true;
  // 폴더 안 심볼릭 링크로 밖을 읽거나 쓰는 길 (리뷰 뒤 코디네이터 검증에서 찾음). sandbox 는 Bash 에만 걸린다
  const real = ctx.realPathOf?.(absolute);
  return real !== undefined && !isInsideOrEqual(ctx.runDir, real);
};

/** 글롭 문자열에서 글롭 앞의 고정 경로. `..` 조각이 있으면 탈출로 본다. */
const globEscapes = (ctx: SafetyContext, glob: string): boolean => {
  if (glob.split(/[\\/]/).includes('..')) return true;
  const fixed = glob.split(/[*?[{]/)[0] ?? '';
  if (fixed === '') return false;
  return pathIsOutside(ctx, fixed);
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (input: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** 경로 키가 있는 도구. 키를 도구와 무관하게 섞어 읽지 않는다 (NotebookEdit 는 `notebook_path` — CLAUDE.md). */
const PATH_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Read', ['file_path']],
  ['Write', ['file_path']],
  ['Edit', ['file_path']],
  ['MultiEdit', ['file_path']],
  ['NotebookEdit', ['notebook_path']],
  ['NotebookRead', ['notebook_path']],
  ['LS', ['path']],
  ['Glob', ['path']],
  ['Grep', ['path']],
]);

/** 글롭으로 해석되는 키. */
const GLOB_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Glob', ['pattern']],
  ['Grep', ['glob']],
]);

/** 경로가 없는 도구. 그대로 허용한다. */
const PATHLESS_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'TodoWrite',
  'ExitPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
]);

const decideFileTool = (ctx: SafetyContext, input: Readonly<Record<string, unknown>>): SafetyVerdict => {
  for (const key of PATH_KEYS.get(ctx.toolName) ?? []) {
    const value = readString(input, key);
    if (value !== undefined && pathIsOutside(ctx, value)) return deny('path_outside');
  }
  for (const key of GLOB_KEYS.get(ctx.toolName) ?? []) {
    const value = readString(input, key);
    if (value !== undefined && globEscapes(ctx, value)) return deny('path_outside');
  }
  return ALLOW;
};

/** 모르는 도구: 문자열 값 전부를 홈·절대 경로 기준으로 훑는다. 실패하면 거부. */
const decideUnknownTool = (ctx: SafetyContext, input: Readonly<Record<string, unknown>>): SafetyVerdict => {
  const strings = Object.values(input).filter((v): v is string => typeof v === 'string');
  for (const value of strings) {
    if (HOME_REFERENCE.test(value) || HOME_API.test(value)) return deny('path_outside');
    if (value.startsWith('/') && !isInsideOrEqual(ctx.runDir, value)) return deny('path_outside');
  }
  return ALLOW;
};

// ---------------------------------------------------------------- Bash

/** 앞 경계: 문자열 시작이나 공백·인용·연결·대입 기호. `a~b`·`HEAD~1` 의 `~` 는 경계가 아니다. */
const B = String.raw`(?:^|[\s'"=:<>(|;&\`,])`;
/** 명령 위치 (앱 bashCommand.ts 와 같은 정의). */
const CMD = String.raw`(?:^|[\r\n;&|(\`])\s*`;
const WORD_END = String.raw`(?=$|[\s;&|)\`])`;

/**
 * `~`, `~/x`, `~user`, `$HOME`, `${HOME}`, `/Users/`, `/Volumes/`, `/home/`, `$TMPDIR`, `$OLDPWD`.
 * 절대 경로 표기에는 앞이 이름 문자가 아니어야 한다 — `app/home/page.tsx`·`https://x.com/home/` 는 홈이 아니고 `file:///Users/…` 는 홈이다.
 */
const HOME_REFERENCE = new RegExp(
  String.raw`${B}~(?:$|[\s/'"<>|;&\`)]|[\w.-])|\$\{?(?:HOME|TMPDIR|OLDPWD|USERPROFILE)\b|(?<![\w.-])/(?:Users|Volumes|home)(?:/|$|[\s'"])`,
);
/** 코드 안에서 홈을 여는 API. `node -e`·`python -c` 와 생성 스크립트 내용 둘 다에 쓴다. */
const HOME_API =
  /homedir\s*\(|expanduser|Path\.home\s*\(|process\.env\.HOME\b|process\.env\[\s*['"]HOME|getenv\(\s*['"]HOME|environ\[\s*['"]HOME|environ\.get\(\s*['"]HOME|\$HOME\b|\$\{HOME\}/;

/** 환경 전체를 내보내는 명령·코드. 인증 변수 이름 참조도 막는다 (리뷰 M2). */
const ENV_DUMP = new RegExp(
  [
    String.raw`${CMD}(?:printenv|compgen\s+-v)${WORD_END}`,
    String.raw`${CMD}env(?=\s*(?:$|[|;&>)]))`,
    String.raw`${CMD}set(?=\s*(?:$|[|;&>)]))`,
    String.raw`${CMD}(?:export|declare)\s+-[px]\b`,
    String.raw`\$\{?(?:ANTHROPIC|CLAUDE)\w*`,
    String.raw`process\.env(?!\s*(?:\.\w|\[))`,
    String.raw`os\.environ(?!\s*(?:\[|\.get))`,
    String.raw`/proc/self/environ`,
  ].join('|'),
);

/** 권한 상승·전역 변경·외부 전송·다른 앱 실행. */
const PRIVILEGED = new RegExp(
  [
    String.raw`${CMD}(?:sudo|su|doas|open|osascript|launchctl|crontab|security|ssh|scp|sftp|rsync|diskutil|chflags|pkill|killall|brew)${WORD_END}`,
    String.raw`${CMD}kill${WORD_END}(?!\s+%)`,
    String.raw`${CMD}defaults\s+write\b`,
    String.raw`${CMD}git\s+(?:push|config\s+--global|config\s+--system)\b`,
    String.raw`${CMD}(?:npm|pnpm|yarn)\b[^\r\n;&|]*(?:\s-g\b|\s--global\b|\sglobal\s)`,
    String.raw`${CMD}pip3?\b[^\r\n;&|]*\s--user\b`,
    String.raw`(?:curl|wget)\b[^\r\n;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?)\b`,
  ].join('|'),
);

/** `..` 경로 조각, 인자 없는 `cd`, `cd -`, `pushd`/`popd`. `{1..3}`·`[...a]` 는 경계가 아니라 통과한다. */
const PARENT_DIR = new RegExp(
  [
    String.raw`${B}\.\.(?:$|[\s/'"<>|;&\`)])`,
    String.raw`/\.\.(?:$|[\s/'"<>|;&\`)])`,
    String.raw`${CMD}cd(?=\s*(?:$|[;&|)]))`,
    String.raw`${CMD}cd\s+-(?=\s*(?:$|[;&|)]))`,
    String.raw`${CMD}(?:pushd|popd)${WORD_END}`,
  ].join('|'),
);

/**
 * 절대 경로 후보. `//` 로 시작하는 것(URL 의 `https://`)은 건너뛴다 — 홈 표기는 HOME_REFERENCE 가 따로 잡는다.
 * 앞 경계에서 `<` 를 뺀다 — HTML 닫는 태그(`</h1>`)를 경로로 읽지 않게.
 */
const ABSOLUTE_PATH = new RegExp(String.raw`(?:^|[\s'"=:>(|;&\`,])(/(?!/)[^\s'"<>|;&\`),]*)`, 'g');

/**
 * heredoc 본문. 절대 경로 검사에서만 지운다 — 본문은 파일 **내용**이고(`<a href="/about">`) 경로 인자가 아니다.
 * 홈 표기·홈 API 검사는 본문까지 본다: 홈을 여는 스크립트를 쓰는 것도 막는다.
 */
const HEREDOC_BODY = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
const stripHeredocBodies = (command: string): string => command.replace(HEREDOC_BODY, (m) => m.split('\n')[0] ?? '');

/** 폴더 밖이지만 허용하는 절대 경로 — 출력 버리기와 시스템 실행 파일 위치. 읽기만 한다. */
const ABSOLUTE_ALLOW_EXACT: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/usr/bin/env',
]);
const ABSOLUTE_ALLOW_PREFIX: readonly string[] = ['/usr/bin/', '/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];

const hasOutsideAbsolutePath = (ctx: SafetyContext, command: string): boolean => {
  for (const match of stripHeredocBodies(command).matchAll(ABSOLUTE_PATH)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    if (ABSOLUTE_ALLOW_EXACT.has(candidate)) continue;
    if (ABSOLUTE_ALLOW_PREFIX.some((prefix) => candidate.startsWith(prefix))) continue;
    if (!isInsideOrEqual(ctx.runDir, candidate)) return true;
  }
  return false;
};

/** 인터프리터로 파일을 실행하는 자리. 첫 비옵션 인자를 스크립트로 본다. */
const SCRIPT_RUN = new RegExp(
  String.raw`${CMD}(?:node|python3?|bash|sh|zsh|ruby|perl|bun|tsx|ts-node|deno\s+run)\s+(?:-[\w-]+\s+)*([^\s;&|'"]+)|${CMD}\./([^\s;&|'"]+)`,
  'g',
);

/** 실행 폴더 안 스크립트가 홈을 여는가. 못 읽으면 판단하지 않는다 (실행할 것이 없다). */
const runsHomeScript = (ctx: SafetyContext, command: string): boolean => {
  for (const match of command.matchAll(SCRIPT_RUN)) {
    const file = match[1] ?? match[2];
    if (file === undefined) continue;
    const absolute = path.resolve(ctx.cwd, file);
    if (!isInsideOrEqual(ctx.runDir, absolute)) continue; // 밖이면 다른 규칙이 잡는다
    const text = ctx.readFileText(absolute);
    if (text !== undefined && (HOME_API.test(text) || HOME_REFERENCE.test(text))) return true;
  }
  return false;
};

const decideBash = (ctx: SafetyContext, input: Readonly<Record<string, unknown>>): SafetyVerdict => {
  const command = readString(input, 'command');
  if (command === undefined) return deny('unreadable_input');
  if (ENV_DUMP.test(command)) return deny('bash_env_dump');
  if (HOME_REFERENCE.test(command) || HOME_API.test(command)) return deny('bash_home_ref');
  if (PRIVILEGED.test(command)) return deny('bash_privileged');
  if (PARENT_DIR.test(command)) return deny('bash_parent_dir');
  if (hasOutsideAbsolutePath(ctx, command)) return deny('bash_abs_outside');
  if (runsHomeScript(ctx, command)) return deny('script_home_ref');
  return ALLOW;
};

// ---------------------------------------------------------------- 판정

/** 전함수가 아니다 — 입력 getter 가 던질 수 있다. 어댑터가 예외를 거부로 바꾼다. */
export function decideSafety(ctx: SafetyContext): SafetyVerdict {
  if (!isInsideOrEqual(ctx.runDir, ctx.cwd)) return deny('cwd_outside');
  if (PATHLESS_TOOLS.has(ctx.toolName)) return ALLOW;
  if (!isPlainObject(ctx.toolInput)) return deny('unreadable_input');
  if (ctx.toolName === 'Bash') return decideBash(ctx, ctx.toolInput);
  if (PATH_KEYS.has(ctx.toolName)) return decideFileTool(ctx, ctx.toolInput);
  return decideUnknownTool(ctx, ctx.toolInput);
}

export interface SafetyHookDeps {
  readonly runDir: string;
  readonly readFileText: (absolutePath: string) => string | undefined;
  readonly realPathOf?: (absolutePath: string) => string | undefined;
  /** 판정 기록. 던져도 판정에 영향이 없다. */
  readonly onVerdict?: (record: { toolUseId: string | undefined; kind: 'deny'; rule: SafetyRule }) => void;
}

const DENY_OUTPUT: HookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: SAFETY_MODEL_REASON,
  },
};

/** 초 단위 (sdk.d.ts HookCallbackMatcher.timeout). 앱 관문 hook 과 같은 값. */
const SAFETY_HOOK_TIMEOUT_SECONDS = 5;

export function createSafetyHooks(deps: SafetyHookDeps): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const report = (toolUseId: string | undefined, rule: SafetyRule): void => {
    try {
      deps.onVerdict?.({ toolUseId, kind: 'deny', rule });
    } catch {
      // 기록 실패는 판정을 바꾸지 않는다
    }
  };

  const safetyHook: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    let verdict: SafetyVerdict;
    try {
      verdict = decideSafety({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        runDir: deps.runDir,
        readFileText: deps.readFileText,
        ...(deps.realPathOf === undefined ? {} : { realPathOf: deps.realPathOf }),
      });
    } catch {
      verdict = deny('internal_error');
    }
    if (verdict.kind === 'allow') return {};
    report(toolUseId ?? input.tool_use_id, verdict.rule);
    return DENY_OUTPUT;
  };

  // matcher 없음 = 모든 도구.
  return { PreToolUse: [{ hooks: [safetyHook], timeout: SAFETY_HOOK_TIMEOUT_SECONDS }] };
}
