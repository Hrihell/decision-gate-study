// 보안 점검 타입. 명세는 docs/AUDITS.md 4.6절(IPC 타입)·4.8·4.11절(phase 10 의 auditId)·5절(비밀 값을 담지 않는다),
// 결과 봉투·예외 처리 페이로드는 docs/IPC_CONTRACT.md "점검" 절이다.
//
// 이 파일은 메인과 렌더러 양쪽이 import 한다. SDK·ajv·node 내장을 쓰지 않는다.

/**
 * 점검 ①② 에 phase 10 의 둘을 더했다 — 인증 없는 API 라우트(AUDITS.md 4·4.8)와 열린 DB 규칙(4.11).
 * phase 20 의 점검 ④ 코드가 돌아가는가(4.12)가 마지막이다.
 * 순서를 섞지 않는다. 스키마 `enum`·페이로드 검증·정렬이 이 배열을 그대로 참조한다.
 */
export const AUDIT_IDS = [
  'secret-in-code',
  'dotenv-tracked',
  'unauthenticated-route',
  'open-db-rules',
  'code-check',
] as const;
export type AuditId = (typeof AUDIT_IDS)[number];

/** secretlint 의 `info` 는 `review` 로 옮긴다. 확신이 낮은 것을 `warning` 으로 올리지 않는다 (AUDITS.md 5절). */
export const AUDIT_SEVERITIES = ['error', 'warning', 'review'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * 한 건. **비밀 값을 담지 않는다** — 소스 내용·매치 문자열도 담지 않는다 (AUDITS.md 5절).
 * 계획 파일이나 로그로 새면 git 히스토리에 영구히 남는다. 다시 보려면 파일을 다시 읽는다.
 */
export interface AuditFinding {
  readonly auditId: AuditId;
  /** 예외 처리의 키. 같은 문제를 다시 만나면 같은 값이어야 한다 — 줄 번호를 넣지 않는다 (AUDITS.md 4.7). */
  readonly key: string;
  readonly severity: AuditSeverity;
  /** 프로젝트 루트 기준 상대 경로. 없으면 null (점검 ② 의 git 상태 등). */
  readonly filePath: string | null;
  /** 1 부터. 없으면 null. */
  readonly line: number | null;
  /** 화면에 그대로 띄우는 한국어. 앱이 소유한다 — secretlint 의 영어 메시지가 아니다. */
  readonly titleKo: string;
  readonly bodyKo: string;
  /** 규칙 id. 진단용이고 화면에 그대로 보여주지 않는다. */
  readonly ruleId: string | null;
}

/** 무엇을 훑나. */
export type AuditScope =
  | { readonly kind: 'project' }
  | { readonly kind: 'files'; readonly filePaths: readonly string[] };

/** 한 번의 실행. 늦게 온 결과를 버리는 데 쓴다. */
export type AuditRunId = string;

/** 넘긴 것. 지운 것이 아니다 — 화면이 접어서 보여주고 되돌릴 수 있어야 하므로 이유를 함께 싣는다. */
export interface SuppressedFinding {
  readonly finding: AuditFinding;
  readonly reasonKo: string;
}

/**
 * 한 번의 실행이 끝났다 (`audit:result`). 늦게 온 결과를 버리려면 runId 가 필요하다.
 *
 * `suppressed` 를 함께 싣는다 — 두 번 조회하게 만들면 화면이 두 결과를 짝지어야 하고, 늦게 온 응답이 어긋난다.
 */
export interface AuditResult {
  readonly runId: AuditRunId;
  /** 넘기지 않은 것만. */
  readonly findings: readonly AuditFinding[];
  readonly suppressed: readonly SuppressedFinding[];
  /** 훑은 파일 수. 화면이 "34개를 확인했어요" 를 말한다. */
  readonly scannedCount: number;
  /** 끝난 시각 (ISO). 화면의 "3분 전에 확인했어요" 가 이것을 쓴다. */
  readonly finishedAt: string;
  /**
   * **돌지 못한 점검.** 엔진이 죽거나 git 저장소가 아니어도 발견은 0건이다 —
   * 이것이 없으면 보안 기능이 조용히 실패하면서 "문제가 없어요" 가 된다.
   */
  readonly problems: readonly { readonly auditId: AuditId; readonly messageKo: string }[];
  /**
   * **돌릴 대상이 없어 돌리지 않은 점검** (AUDITS.md 4.5). `problems`(돌려야 했는데 못 돌았다)와 다르다 —
   * 라우트 파일도 규칙 파일도 없는 저장소를 "문제가 없어요" 로 뭉개지 않는다. 프로젝트 범위에서만 채운다 —
   * 파일 몇 개를 훑은 자동 실행에 라우트가 없다고 저장소에 없는 것은 아니다.
   */
  readonly notApplicable: readonly { readonly auditId: AuditId; readonly messageKo: string }[];
  /**
   * 1계층(AST)만 돌고 2계층(LLM) 판정을 받지 않은 의심 라우트 수 (AUDITS.md 4.9). 자동(silent) 실행에서만 0 보다 크다 —
   * 화면이 "확인이 필요한 API 가 N개 있어요. 점검을 눌러 주세요" 를 말한다. 의심은 발견이 아니다 — `findings` 에 없다.
   * 사용자 실행에서는 의심이 전부 판정되거나 발견으로 남으므로 0 이다.
   */
  readonly unverifiedRouteCount: number;
  /**
   * 무엇을 훑었나. 화면이 파일 범위 결과로 **그 파일들의 발견만** 갈아끼우는 데 쓴다 — 발견의 `filePath` 로는 대신할 수
   * 없다(고쳐서 0건이 된 파일은 어느 발견에도 나타나지 않는다). 파일 범위의 `filePaths` 는 점검들이 **확인을 마친**
   * 파일을 합친 것이고 발견의 `filePath` 와 같은 모양(루트 기준 상대)이다. 못 돈 점검의 파일은 싣지 않는다.
   */
  readonly scope: AuditScope;
}

/** 예외 처리 한 건 (AUDITS.md 4.7). `(auditId, key)` 가 식별자다. */
export interface AuditSuppression {
  readonly auditId: AuditId;
  /** `AuditFinding.key` 와 같은 값. */
  readonly key: string;
  /** 사용자가 적은 이유. 빈 문자열·공백뿐인 글을 허용하지 않는다 — 왜 넘겼는지가 남아야 한다. */
  readonly reasonKo: string;
  /** ISO 8601 UTC. 앱이 넣는다. */
  readonly suppressedAt: string;
}

/** `.harness/audit-suppressions.json`. 커밋한다 — 팀의 검토 결정이다 (AUDITS.md 4.7). */
export interface AuditSuppressionsFile {
  readonly schemaVersion: 1;
  readonly suppressions: readonly AuditSuppression[];
}

/**
 * 예외 이유의 길이 상한. ajv `maxLength` 는 **코드 포인트**를 센다 — 한글 한 자·이모지 하나가 1자다.
 * 스키마(`main/audit/schemas.ts`)·페이로드 검증(`payload.ts`)·렌더러의 이유 입력이 같은 값을 쓴다 —
 * 어긋나면 받은 이유를 기록하지 못한다. 렌더러의 `maxLength` 는 UTF-16 단위라 이보다 엄격할 뿐 넘지 않는다.
 */
export const AUDIT_REASON_MAX_LENGTH = 300;

/** `audit:suppress` — "일부러 그랬어요". `.harness/audit-suppressions.json` 에 남는다 (AUDITS.md 4.7). */
export type AuditSuppressPayload = {
  readonly auditId: AuditId;
  readonly key: string;
  readonly reasonKo: string;
};

/** `audit:unsuppress` — 넘긴 것을 되돌린다. */
export type AuditUnsuppressPayload = { readonly auditId: AuditId; readonly key: string };

/** 관문·계획과 같은 관습 — 실패를 던지지 않고 사유를 돌려준다. */
export type AuditWriteResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly reasonKo: string };
