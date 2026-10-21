// Bash 명령 분류. 명세는 docs/GATES.md §6.4. **순수 모듈이다** — SDK·fs·electron 을 import 하지 않는다.
//
// 휴리스틱이다. 셸을 파싱하지 않고 인용부호를 해석하지 않는다 — `echo "x > y"` 도 쓰기로 본다.
// 정규식을 강화해서 완벽하게 만들려 하지 않는다 (ADR-010). 오탐·미탐 비용은 판정 쪽이 감당한다
// (§6.5 규칙 1·8). 도구 호출마다 도는 코드라 중첩 수량자를 쓰지 않는다.

export interface BashClassification {
  /** 파일을 만들거나 바꾸거나 지우는 것처럼 보인다. */
  readonly writesFiles: boolean;
  /** `.harness` 를 경로 조각으로 언급한다. */
  readonly touchesHarness: boolean;
}

/**
 * 명령 위치: 문자열 시작, 또는 줄바꿈·`;` `&&` `||` `|` `&` `(` `$(` `` ` `` 뒤 (공백 허용). `$(` 는 `(` 로 잡힌다.
 * 줄바꿈이 빠지면 여러 줄 명령의 둘째 줄부터 전부 놓친다.
 */
const COMMAND_POSITION = String.raw`(?:^|[\r\n;&|(\`])\s*`;

/** 명령 이름의 끝: 문자열 끝, 공백, 또는 연결·닫힘 기호. `teeth` 를 `tee` 로 보지 않는다. */
const WORD_END = String.raw`(?=$|[\s;&|)\`])`;

/**
 * 출력 리다이렉트 `>` `>>` 중 대상이 파일인 것. `&숫자` 와 `/dev/null`·`/dev/stdout`·`/dev/stderr` 는 제외한다.
 * 앞뒤 `>` 금지는 `>>` 를 `>` 로 되짚어 제외를 빠져나가는 것을 막는다.
 */
const FILE_REDIRECT = new RegExp(
  String.raw`(?<!>)>>?(?!>)\s*(?!&\d|/dev/(?:null|stdout|stderr)(?:$|[\s;&|)]))\S`,
);

/** heredoc `<<` `<<-`. here-string `<<<` 은 제외한다. */
const HEREDOC = /(?<!<)<<(?!<)/;

/** 명령 위치에서 파일을 만들거나 옮기거나 지우는 명령. */
const FILE_WRITING_COMMAND = new RegExp(
  `${COMMAND_POSITION}(?:tee|dd|cp|mv|install|touch|rm)${WORD_END}`,
);

/** `-i` 옵션이 붙은 `sed`. 같은 명령 조각 안에서만 찾는다. */
const SED_IN_PLACE = new RegExp(`${COMMAND_POSITION}sed\\s[^\\r\\n;&|]*?(?<=\\s)-i`);

/** 골격 생성: `npx create-…`, `npm create`, `npm init`, `yarn create`, `pnpm create`. */
const SCAFFOLD = new RegExp(
  `${COMMAND_POSITION}(?:npx\\s+create-|(?:npm|yarn|pnpm)\\s+create${WORD_END}|npm\\s+init${WORD_END})`,
);

/** 내려받기: `git clone`, `wget`. */
const DOWNLOAD_COMMAND = new RegExp(`${COMMAND_POSITION}(?:git\\s+clone|wget)${WORD_END}`);

/** `-o`·`-O`·`--output` 이 붙은 `curl`. 같은 명령 조각 안에서만 찾는다. */
const CURL_TO_FILE = new RegExp(`${COMMAND_POSITION}curl\\s[^\\r\\n;&|]*?(?<=\\s)(?:-[oO]|--output)`);

const WRITE_PATTERNS: readonly RegExp[] = [
  FILE_REDIRECT,
  HEREDOC,
  FILE_WRITING_COMMAND,
  SED_IN_PLACE,
  SCAFFOLD,
  DOWNLOAD_COMMAND,
  CURL_TO_FILE,
];

/**
 * 경로 조각으로서의 `.harness`. 앞뒤가 파일 이름 문자(영숫자·`_`·`.`·`-`)가 아니면 참이다.
 * 허용 목록이 아니라 금지 목록으로 경계를 정한다 — `>.harness` 처럼 공백 하나만 빼도 빠져나가지 않게.
 * 대소문자를 구분하지 않는다 — macOS 기본 파일시스템(APFS)에서 `.Harness` 는 같은 폴더다.
 */
const HARNESS_PATH_SEGMENT = /(?<![\w.-])\.harness(?![\w.-])/i;

export function classifyBash(command: string): BashClassification {
  return {
    writesFiles: WRITE_PATTERNS.some((pattern) => pattern.test(command)),
    touchesHarness: HARNESS_PATH_SEGMENT.test(command),
  };
}
