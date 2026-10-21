// 서브프로세스 환경 (리뷰 M2). 사용자 셸의 환경 전체를 넘기지 않는다 — 토큰류가 도구 결과로 로그에 남을 수 있다.
// CLAUDE.md 의 "`options.env` 는 펼친다" 규칙은 지킨다: 정리한 객체를 펼쳐 새로 만든다 (교체이므로 PATH 를 빠뜨리지 않는다).

/** 실행에 필요한 것. 값은 로그에 남기지 않는다 — run_meta 에는 키 이름만. */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TERM',
];

/** 인증에 쓰일 수 있는 것. 있으면 넘기되 sandbox 의 `credentials.envVars` 로 셸 명령에서는 숨긴다. */
export const AUTH_ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export interface ScrubbedEnv {
  readonly env: Readonly<Record<string, string>>;
  /** 넘긴 인증 변수 이름 (값 아님) */
  readonly authKeys: readonly string[];
}

export function scrubEnv(source: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>>): ScrubbedEnv {
  const pick = (keys: readonly string[]): [string, string][] =>
    keys.flatMap((k) => {
      const v = source[k];
      return v === undefined || v === '' ? [] : [[k, v]];
    });
  const auth = pick(AUTH_ENV_KEYS);
  return {
    env: { ...Object.fromEntries(pick(ENV_ALLOWLIST)), ...Object.fromEntries(auth), ...extra },
    authKeys: auth.map(([k]) => k),
  };
}
