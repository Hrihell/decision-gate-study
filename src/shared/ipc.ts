// IPC 계약. 메인과 렌더러 양쪽이 **이 파일만** 참조한다 (docs/IPC_CONTRACT.md).
//
// 채널 이름을 문자열 리터럴로 양쪽에 따로 적지 않는다. 오타는 예외가 아니라
// 조용한 무응답으로 나타나서 디버깅이 오래 걸린다.
//
// 이 파일은 Node 전역(process)도 DOM 전역(window)도 쓰지 않는다. SDK 도 import 하지
// 않는다 — tsconfig.shared.json 이 `types: []` 로 격리한다.

import type { ActivityAnswer, ActivityQuestion, ActivityView } from './types/activity';
import type { AppState, ProjectEntry } from './types/appState';
import type {
  AuditFinding,
  AuditResult,
  AuditRunId,
  AuditScope,
  AuditSuppressPayload,
  AuditUnsuppressPayload,
  AuditWriteResult,
  SuppressedFinding,
} from './types/audit';
import type {
  GateAnswerPayload,
  GateAnswerResult,
  GateIdeaResult,
  GateListResult,
  GateProgressEvent,
  GateView,
  ProjectIdea,
} from './types/gates';
import type { HarnessPlan, PlanLoadResult, PlanWriteResult, TaskPatch } from './types/plan';

// ---------------------------------------------------------------------------
// 패턴 타입 — docs/IPC_CONTRACT.md 의 4가지 패턴
// ---------------------------------------------------------------------------
//
// 채널 상수는 런타임에는 그냥 문자열이다. 브랜드는 타입 수준에만 있다.
// 목적은 **잘못된 수단으로 채널을 쓰는 실수를 컴파일 타임에 잡는 것**이다.
// preload 의 내부 헬퍼들이 이 브랜드를 받으므로, 예를 들어 스트림 채널(패턴 2)을
// invoke 헬퍼에 넘기면 타입 오류가 난다.

/** 패턴 1 — 단방향 푸시 (R → M). 결과를 기다리지 않는다. 응답은 패턴 2로 온다. */
export type PushChannel<P> = string & {
  readonly __ipcPattern: 'push';
  readonly __ipcPayload: P;
};

/** 패턴 2 — 스트림 (M → R). `webContents.send`. invoke 는 스트리밍할 수 없다. */
export type EventChannel<P> = string & {
  readonly __ipcPattern: 'event';
  readonly __ipcPayload: P;
};

/** 패턴 3 — 제어 요청/응답 (R → M → R). `invoke`. */
export type InvokeChannel<P, R> = string & {
  readonly __ipcPattern: 'invoke';
  readonly __ipcPayload: P;
  readonly __ipcResult: R;
};

/** 패턴 4 채널의 방향. */
export type RoundTripDirection = 'request' | 'respond';

/**
 * 패턴 4 — 블로킹 왕복 (M → R → M).
 *
 * 메인이 SDK 콜백 안에서 멈춘 채 사람의 답을 기다린다. 방향이 둘이므로 채널도 둘이다
 * (`*:request` 와 `*:respond`). 방향을 타입에 넣어야 요청 채널에 응답을 보내거나
 * 그 반대로 하는 실수가 컴파일 타임에 잡힌다.
 */
export type RoundTripChannel<
  Q,
  A,
  // 기본값은 양쪽 방향 전부다. `RoundTripChannel<Q, A>` 로 쓰면 "왕복 채널 중 하나"를 뜻한다.
  D extends RoundTripDirection = RoundTripDirection,
> = string & {
  readonly __ipcPattern: 'roundTrip';
  readonly __ipcQuestion: Q;
  readonly __ipcAnswer: A;
  readonly __ipcDirection: D;
};

/** 패턴 4 의 M → R 방향. 렌더러는 구독만 한다. */
export type RoundTripRequestChannel<Q, A> = RoundTripChannel<Q, A, 'request'>;

/** 패턴 4 의 R → M 방향. 렌더러는 `send` 로 답을 돌려준다. */
export type RoundTripResponseChannel<Q, A> = RoundTripChannel<Q, A, 'respond'>;

// ---------------------------------------------------------------------------
// 페이로드 타입
// ---------------------------------------------------------------------------
//
// 아직 정의되지 않은 타입은 `unknown` 플레이스홀더로 둔다. 구조를 추측해서 적으면
// 실제 정의가 들어올 때 두 번 고쳐야 한다. 대응 표는 docs/DATA_SCHEMA.md 4절.

/** 최근 프로젝트 목록의 한 항목 (docs/DATA_SCHEMA.md 2.2절). */
export type ProjectRef = ProjectEntry;

// 값 목록은 배열 하나에서 파생한다 (src/shared/types/plan.ts 와 같은 관습).

/** 프로젝트를 열었을 때의 판정 (docs/SESSION.md 8.2절). */
export const PROJECT_DETECTION_KINDS = [
  'new',
  'existing',
  'ambiguous',
  'managed',
  'plan_invalid',
] as const;
export type ProjectDetectionKind = (typeof PROJECT_DETECTION_KINDS)[number];

/**
 * `project:open`·`project:openWithDialog` 이 거부된 이유 (docs/SESSION.md 8.1·8.2절).
 * `cancelled` 는 선택창을 닫았을 때만 나온다.
 */
export const OPEN_FAILURE_REASONS = [
  'invalid_payload',
  'not_found',
  'not_directory',
  'unsupported_path',
  'cancelled',
] as const;
export type OpenFailureReason = (typeof OPEN_FAILURE_REASONS)[number];

/**
 * `project:open`·`project:openWithDialog` 의 결과 (docs/SESSION.md 8.2절).
 *
 * `gatesEnabled` 기본값은 `existing` 이면 `false`, 그 외 `true` 다 (docs/ADR.md ADR-008).
 * `displayName` 은 루트의 마지막 경로 조각이다. **전체 경로를 담지 않는다** — 렌더러는 경로 문자열을 다루지 않는다.
 *
 * 화면이 바꿀 수 있는 토글(`ProjectPrefsPatch` 의 두 가지)은 **둘 다** 싣는다. 하나만 실으면
 * 사이드바의 점검 토글이 저장된 값을 모른 채 기본값으로 그려져, 껐던 점검이 켜진 것처럼 보인다
 * (phase 11 step 6). 나머지 `ProjectPrefs` 필드는 화면이 쓰지 않으므로 싣지 않는다.
 */
export type OpenResult =
  | {
      readonly ok: true;
      readonly displayName: string;
      readonly detection: ProjectDetectionKind;
      readonly gatesEnabled: boolean;
      readonly auditsEnabled: boolean;
    }
  | { readonly ok: false; readonly reason: OpenFailureReason };

/**
 * 열려 있는 프로젝트의 기기별 토글을 하나 바꾼다 (docs/DATA_SCHEMA.md 2.2절).
 *
 * **`Partial<ProjectPrefs>` 로 만들지 않는다.** 렌더러에서 온 객체는 런타임에 아무 모양이나
 * 된다 — 판별 유니온이면 핸들러의 검증이 단순해지고, 화면이 쓰지 않는 필드
 * (`mutedGateIds`·`bashWriteGateEnabled`·`fileCheckpointingEnabled`)가 실수로 지나갈 길이 없다.
 * 대상 프로젝트는 싣지 않는다 — 메인이 열려 있는 프로젝트를 안다.
 */
export type ProjectPrefsPatch =
  | { readonly kind: 'gatesEnabled'; readonly value: boolean }
  | { readonly kind: 'auditsEnabled'; readonly value: boolean };

/**
 * 토글·테마 쓰기의 결과.
 *
 * 거부를 **던지지 않는다** — 관문·계획·점검과 같은 관습이다. 렌더러가 사유로 분기한다
 * (docs/IPC_CONTRACT.md). 모양이 `AuditWriteResult` 와 같지만 별개로 둔다 — 한쪽이 사유를
 * 늘리면 다른 쪽이 따라가야 할 이유가 없다.
 */
export type PrefsWriteResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly reasonKo: string };

/** 앱 전체 UI 설정 (docs/DATA_SCHEMA.md 2.2절). 프로젝트별이 아니다. */
export type AppUiState = AppState['ui'];

/** 테마 이름. `AppState` 에서 파생한다 — 값 목록을 두 벌 적으면 어긋난다. */
export type ThemeName = AppUiState['theme'];

/** 계획 파일의 내용 (docs/DATA_SCHEMA.md 1.2절). */
export type Plan = HarnessPlan;

export type { PlanLoadResult, PlanWriteResult, TaskPatch };

/**
 * 렌더러가 보는 인증 상태. `accountInfo()` 결과를 **가공한 것**이다.
 *
 * **신원 필드를 담지 않는다.** `email`·`organization` 은 메인 프로세스에만 있고
 * 렌더러 DOM 까지 가지 않는다 (docs/SECURITY.md). 메인 내부 표현은
 * `src/main/auth/decide.ts` 의 `AuthState` 이고, IPC 로 나갈 때 여기로 깎인다.
 *
 * 지금 UI 는 상태별 한 줄이라 표시할 식별자가 없다. 온보딩 화면이 "누구로
 * 로그인되어 있는지" 를 보여줘야 하면 그때 **마스킹된** 라벨 필드를 추가한다.
 */
export type AuthState =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'third_party'; readonly provider: string }
  | { readonly kind: 'unauthenticated' };

/** `session:message` 의 갈래 (docs/SESSION.md 2절). */
export const SESSION_MESSAGE_KINDS = [
  'assistant_text',
  'tool_use',
  'notice',
  'turn_end',
  'task_started',
  'task_finished',
] as const;

/**
 * 렌더러로 보내는 세션 메시지 (docs/SESSION.md 2절).
 *
 * SDK 의 `SDKMessage` 를 그대로 보내지 않고 메인이 화면에 필요한 모양으로 새로 만든다.
 * SDK 타입을 렌더러에 흘리면 SDK 변경이 UI 를 깬다 (docs/IPC_CONTRACT.md "페이로드 타입").
 * 비용·토큰·`uuid`·`session_id` 는 담지 않는다.
 */
export type SessionMessage =
  | { readonly kind: 'assistant_text'; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly toolName: string;
      readonly fromSubagent: boolean;
      /** phase 23. 프로젝트 루트 기준 경로 (`/`). 경로가 없는 도구·루트 밖이면 null. 가린 뒤 싣는다. */
      readonly targetPath: string | null;
      /** phase 23. 한 줄 요약 — Bash 명령 첫 줄, Glob·Grep 패턴. 120자에서 자른다. 가린 뒤 싣는다. 없으면 null. */
      readonly summary: string | null;
    }
  | {
      readonly kind: 'notice';
      readonly text: string;
      readonly level: 'info' | 'notice' | 'suggestion' | 'warning';
    }
  | { readonly kind: 'turn_end'; readonly isError: boolean }
  | { readonly kind: 'task_started'; readonly description: string }
  | { readonly kind: 'task_finished'; readonly status: 'completed' | 'failed' | 'stopped' };

/** `session:history` 가 돌려주는 한 줄의 갈래 (docs/SESSION.md 10절). */
export const RESTORED_MESSAGE_KINDS = ['user', 'assistant'] as const;

/**
 * 복원된 대화 한 줄 (docs/SESSION.md 10절). 지난 대화를 **읽기 전용**으로 그린다.
 *
 * `SessionMessage` 와 **다른 타입이다.** 그것은 실시간 스트림용이라 사용자 발화가 없고
 * (렌더러가 보낼 때 로컬로 붙인다), 이쪽은 지난 기록이라 사용자 발화가 있어야 한다.
 *
 * **도구 호출·알림을 담지 않는다.** 지난 기록에서 필요한 것은 "무엇을 했나" 가 아니라
 * "무엇을 말했나" 다 — 지난 도구 호출을 되살리면 어제 작업이 지금 도는 것처럼 보인다.
 */
export type RestoredMessage =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string };

/**
 * `session:history` 의 결과 (docs/SESSION.md 10.3·10.4절).
 *
 * 열려 있는 프로젝트의 것이다 — 페이로드가 없다. **렌더러는 세션 id 를 다루지 않는다**
 * (경로를 다루지 않는 것과 같은 이유).
 */
export type SessionHistory = {
  /** 시간 순. 마지막 50개 (docs/SESSION.md 10.3절). */
  readonly messages: readonly RestoredMessage[];
  /** 위쪽이 잘렸나. 화면이 한 줄로 알린다 — 조용히 자르지 않는다. */
  readonly truncated: boolean;
  /** 복원을 못 한 이유. 성공이면 null (docs/SESSION.md 10.4절). */
  readonly problemKo: string | null;
};

/** 권한을 묻는 이유 (docs/SESSION.md 4.2절). 관문 사유는 상수와 정확히 같을 때만 붙는다. */
export const PERMISSION_REASONS = ['gate_bash_write', 'gate_bash_unreadable', 'tool_permission'] as const;
export type PermissionReason = (typeof PERMISSION_REASONS)[number];

/** `permission:request` 의 페이로드 (docs/SESSION.md 4.2절). */
export interface PermissionRequest {
  readonly id: string;
  readonly toolName: string;
  /** 한국어 한 줄. */
  readonly summaryKo: string;
  /** 대상: 파일 도구는 경로, Bash 는 명령(500자까지). 없으면 null. */
  readonly detail: string | null;
  readonly reason: PermissionReason;
  /** 권한 창의 "내용 보기". 없으면 null. */
  readonly preview: PermissionPreview | null;
}

/** 권한 미리보기의 갈래 (docs/SESSION.md 4.2절). */
export const PERMISSION_PREVIEW_KINDS = ['content', 'edit', 'command'] as const;
type PermissionPreviewKind = (typeof PERMISSION_PREVIEW_KINDS)[number];

/**
 * 권한 창에서 펼쳐 보는 내용 (docs/SESSION.md 4.2절).
 *
 * 문자열마다 4000 코드 포인트까지 담고, 하나라도 잘랐으면 `truncated: true` 다. 자른 끝에 `…` 를 붙이지 않는다.
 * 사용자 자신의 코드라 렌더러로 보내도 되지만 **로그에는 남기지 않는다** (docs/SECURITY.md).
 */
export type PermissionPreview =
  | {
      readonly kind: Extract<PermissionPreviewKind, 'content'>;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: Extract<PermissionPreviewKind, 'edit'>;
      readonly before: string;
      readonly after: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: Extract<PermissionPreviewKind, 'command'>;
      readonly text: string;
      readonly truncated: boolean;
    };

/** 사용자의 답 (docs/SESSION.md 4.3절). */
export const PERMISSION_DECISIONS = ['allow', 'deny'] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/**
 * `permission:respond` 의 페이로드 (docs/SESSION.md 4.3절).
 *
 * **"항상 허용" 을 담는 필드를 두지 않는다.** 허용 규칙으로 자동 승인된 호출은 남은 세션 동안
 * `canUseTool` 에 닿지 않아 권한 창이 조용히 사라진다 (docs/ADR.md ADR-011 2026-09-15 수정).
 */
export interface PermissionResponse {
  readonly id: string;
  readonly decision: PermissionDecision;
}

// 에이전트의 질문 (docs/SESSION.md 4.4, docs/ADR.md ADR-025). 권한과 같은 패턴, 다른 인스턴스다 —
// 타입도 채널도 권한과 합치지 않는다. 합치면 권한 창에 질문이 뜬다.

/** 한 요청에 담기는 질문 수. SDK 입력이 이 범위를 벗어나면 메인이 거부한다. */
export const QUESTION_COUNT_MIN = 1;
export const QUESTION_COUNT_MAX = 4;

/** 한 질문의 선택지 수. */
export const QUESTION_OPTION_COUNT_MIN = 2;
export const QUESTION_OPTION_COUNT_MAX = 4;

/** "직접 적기" 의 상한. 코드 포인트로 센다 — 모델에게 가는 글이다. */
export const QUESTION_FREE_TEXT_MAX_LENGTH = 500;

/** 선택지 하나. SDK 의 `preview` 는 싣지 않는다 — 그리지 않는다 (ADR-025). */
export interface AgentQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface AgentQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  /** `QUESTION_OPTION_COUNT_MIN`~`QUESTION_OPTION_COUNT_MAX` 개. */
  readonly options: readonly AgentQuestionOption[];
}

/** `question:request` 의 페이로드. */
export interface QuestionRequest {
  readonly id: string;
  /** `QUESTION_COUNT_MIN`~`QUESTION_COUNT_MAX` 개. */
  readonly questions: readonly AgentQuestion[];
}

/** 질문 하나에 대한 답. 메인이 요청과 대조해 다시 검사한다 — 렌더러 값은 믿지 않는다. */
export interface QuestionAnswer {
  /** 요청의 `question` 글자 그대로. */
  readonly question: string;
  /** 요청의 `label` 글자 그대로. */
  readonly selected: readonly string[];
  /** "직접 적기". 비어 있어도 된다. */
  readonly freeText: string;
}

/**
 * `question:respond` 의 페이로드.
 *
 * 권한 응답처럼 **허용 규칙을 담는 필드를 두지 않는다** (docs/ADR.md ADR-011).
 */
export type QuestionResponse =
  | {
      readonly id: string;
      readonly outcome: 'answered';
      readonly answers: readonly QuestionAnswer[];
    }
  | { readonly id: string; readonly outcome: 'dismissed' };

/** `question:closed` 의 페이로드. 시한·세션 종료·중단으로 메인이 끝낸 질문이다. */
export type QuestionClosedEvent = { readonly id: string };

export type {
  GateAnswerPayload,
  GateAnswerResult,
  GateIdeaResult,
  GateListResult,
  GateProgressEvent,
  GateView,
  ProjectIdea,
};

// 점검 타입의 정의는 docs/AUDITS.md 4.6절. `AuditFinding` 은 비밀 값을 담지 않는다.
export type {
  AuditFinding,
  AuditResult,
  AuditRunId,
  AuditScope,
  AuditSuppressPayload,
  AuditUnsuppressPayload,
  AuditWriteResult,
  SuppressedFinding,
};

// 활동 기록 타입의 정의는 docs/DATA_SCHEMA.md 5.2절. 코드 내용을 담지 않는다 — 경로·해시·시각만.
export type { ActivityAnswer, ActivityQuestion, ActivityView };

/**
 * UI 가 진행 표시를 그리기 위한 세션 상태 (docs/IPC_CONTRACT.md).
 * `awaiting_answer` 는 질문 대기가 있고 권한 대기가 없을 때다 (docs/SESSION.md 4.4).
 */
export type SessionState =
  | 'idle'
  | 'thinking'
  | 'using_tool'
  | 'awaiting_permission'
  | 'awaiting_answer'
  | 'error';

export type ProjectPathPayload = { readonly path: string };
/**
 * `taskId` (phase 23): 계획의 작업을 시작한 턴에만 싣는다. 메인은 계획에 있는 작업 id 인지 확인하고, 아니면 `taskId` 만 버린다
 * (docs/IPC_CONTRACT.md "세션").
 */
export type SessionTurnPayload = { readonly text: string; readonly taskId?: string };
export type AuditRunPayload = { readonly scope: AuditScope };
/**
 * 점검 진행. `done`·`total` 은 점검 ①(훑기)의 파일 수, `judgingRouteCount` 는 지금 LLM 이 판정하고 있는 라우트 수다
 * (판정 전·후·자동 실행·라우트 없음이면 0). 갈래가 함께 돌므로 알림마다 세 값을 모두 싣는다 — 받는 쪽은 덮어 쓰면 된다.
 */
export type AuditProgressEvent = {
  readonly runId: AuditRunId;
  readonly done: number;
  readonly total: number;
  readonly judgingRouteCount: number;
};

// ---------------------------------------------------------------------------
// 채널 상수
// ---------------------------------------------------------------------------
//
// docs/IPC_CONTRACT.md 의 채널 표를 그대로 옮긴 것이다. 양쪽이 어긋나면
// src/shared/ipc.test.ts 가 실패한다.

export const CH = {
  // 프로젝트
  PROJECT_LIST: 'project:list' as InvokeChannel<void, readonly ProjectRef[]>,
  PROJECT_OPEN: 'project:open' as InvokeChannel<ProjectPathPayload, OpenResult>,
  // 선택창은 메인이 띄운다 — 렌더러가 경로 문자열을 만들지 않는다.
  PROJECT_OPEN_WITH_DIALOG: 'project:openWithDialog' as InvokeChannel<void, OpenResult>,
  // 열려 있는 프로젝트의 토글. 한 번에 하나만 바꾼다 (ProjectPrefsPatch 주석 참조).
  PROJECT_SET_PREFS: 'project:setPrefs' as InvokeChannel<ProjectPrefsPatch, PrefsWriteResult>,
  // 최근 목록에서 지운다. 페이로드는 `ProjectEntry.id` — 저장소의 파일은 건드리지 않는다.
  PROJECT_FORGET: 'project:forget' as InvokeChannel<string, void>,

  // 앱 설정 — 프로젝트별이 아니라 앱 전체다 (docs/DATA_SCHEMA.md 2.2절 `ui`)
  APP_GET_UI: 'app:getUi' as InvokeChannel<void, AppUiState>,
  APP_SET_THEME: 'app:setTheme' as InvokeChannel<ThemeName, PrefsWriteResult>,
  // 소개를 봤다. 페이로드가 없다 — 거짓으로 되돌리는 채널을 두지 않는다 (docs/ADR.md ADR-024).
  APP_SET_INTRO_SEEN: 'app:setIntroSeen' as InvokeChannel<void, PrefsWriteResult>,

  // 인증
  AUTH_PROBE: 'auth:probe' as InvokeChannel<void, AuthState>,
  // "다시 확인" — 캐시를 버리고 다시 잰다. `auth:probe` 는 캐시를 그대로 쓴다.
  AUTH_REFRESH: 'auth:refresh' as InvokeChannel<void, AuthState>,

  // 계획 — 렌더러는 계획 파일을 직접 쓰지 않는다 (docs/ADR.md ADR-009)
  PLAN_GET: 'plan:get' as InvokeChannel<void, PlanLoadResult>,
  PLAN_CHANGED: 'plan:changed' as EventChannel<Plan>,
  PLAN_UPDATE_TASK: 'plan:updateTask' as InvokeChannel<TaskPatch, PlanWriteResult>,

  // 세션
  SESSION_PUSH_TURN: 'session:pushTurn' as PushChannel<SessionTurnPayload>,
  SESSION_MESSAGE: 'session:message' as EventChannel<SessionMessage>,
  SESSION_STATE: 'session:state' as EventChannel<SessionState>,
  SESSION_INTERRUPT: 'session:interrupt' as InvokeChannel<void, void>,
  // 열려 있는 프로젝트의 지난 대화. 페이로드가 없다 — 렌더러가 세션 id 를 다루지 않는다 (docs/SESSION.md 10절).
  SESSION_HISTORY: 'session:history' as InvokeChannel<void, SessionHistory>,
  // session:setMode 는 없다 — 코딩 세션은 default 고정이다 (docs/ADR.md ADR-011 2026-09-15 수정).

  // 권한 — 패턴 4
  PERMISSION_REQUEST: 'permission:request' as RoundTripRequestChannel<
    PermissionRequest,
    PermissionResponse
  >,
  PERMISSION_RESPOND: 'permission:respond' as RoundTripResponseChannel<
    PermissionRequest,
    PermissionResponse
  >,

  // 질문 — 패턴 4. 권한과 같은 패턴, 다른 인스턴스다 (docs/ADR.md ADR-025).
  QUESTION_REQUEST: 'question:request' as RoundTripRequestChannel<QuestionRequest, QuestionResponse>,
  QUESTION_RESPOND: 'question:respond' as RoundTripResponseChannel<QuestionRequest, QuestionResponse>,
  // 메인이 끝낸 질문을 알린다 (패턴 2). 권한 창은 닫힌 요청을 모른 채 남는다 — 같은 결함을 되풀이하지 않는다.
  QUESTION_CLOSED: 'question:closed' as EventChannel<QuestionClosedEvent>,

  // 관문 — 왕복이 아니다. 앱이 관문을 열므로 메인이 막혀 기다리는 쪽이 없다 (docs/GATES.md 2.3).
  // plan:changed 와 같은 모양: 메인이 진실을 들고, 바뀌면 알리고, 렌더러가 다시 읽는다.
  GATE_LIST: 'gate:list' as InvokeChannel<void, GateListResult>,
  // 결과를 돌려준다 — 거부 사유를 던지면 렌더러가 문자열을 파싱해야 한다 (docs/GATES.md 2.3).
  GATE_ANSWER: 'gate:answer' as InvokeChannel<GateAnswerPayload, GateAnswerResult>,
  GATE_SET_IDEA: 'gate:setIdea' as InvokeChannel<ProjectIdea, GateIdeaResult>,
  // `PROJECT_SET_PREFS` 의 `gatesEnabled` 와 같은 값이다 — 핸들러도 한 곳이다 (`ipc/project.ts`, ADR-023 2026-09-21 개정).
  GATE_SET_ENABLED: 'gate:setEnabled' as InvokeChannel<boolean, void>,
  GATE_RETRY: 'gate:retry' as InvokeChannel<void, void>,
  // 예외: 진행은 디스크에 남지 않는 일시적 신호라 페이로드에 싣는다 (docs/GATES.md 2.3).
  GATE_PROGRESS: 'gate:progress' as EventChannel<GateProgressEvent>,
  GATE_CHANGED: 'gate:changed' as EventChannel<void>,

  // 점검
  AUDIT_RUN: 'audit:run' as InvokeChannel<AuditRunPayload, AuditRunId>,
  AUDIT_PROGRESS: 'audit:progress' as EventChannel<AuditProgressEvent>,
  // 발견 배열이 아니라 봉투다 — runId·넘긴 것·못 돈 점검을 함께 싣는다.
  AUDIT_RESULT: 'audit:result' as EventChannel<AuditResult>,
  // 결과를 돌려준다 — 관문·계획과 같은 관습이다.
  AUDIT_SUPPRESS: 'audit:suppress' as InvokeChannel<AuditSuppressPayload, AuditWriteResult>,
  AUDIT_UNSUPPRESS: 'audit:unsuppress' as InvokeChannel<AuditUnsuppressPayload, AuditWriteResult>,

  // 활동 — 계획과 같은 모양이다. 메인이 기록을 쥐고, 바뀌면 보기 전체를 싣는다 (docs/DATA_SCHEMA.md 5절).
  ACTIVITY_GET: 'activity:get' as InvokeChannel<void, ActivityView>,
  ACTIVITY_CHANGED: 'activity:changed' as EventChannel<ActivityView>,
  // 앱의 질문 "작업과 관련 있나요?" — 왕복(4)이 아니다. 에이전트를 막지 않고, 답이 없어도 세션은 계속된다.
  ACTIVITY_ASK: 'activity:ask' as EventChannel<ActivityQuestion>,
  ACTIVITY_ANSWER: 'activity:answer' as PushChannel<ActivityAnswer>,
} as const;

// ---------------------------------------------------------------------------
// 렌더러 노출 표면
// ---------------------------------------------------------------------------

/**
 * `on*` 이 돌려주는 해제 함수.
 *
 * React `useEffect` 에서 반드시 호출한다. 하지 않으면 창을 오래 열어둘 때
 * 리스너가 누적된다 — 데스크탑 앱에서 실제로 메모리 문제가 된다.
 */
export type Unsubscribe = () => void;

/**
 * `contextBridge` 가 `window.api` 로 노출하는 표면.
 *
 * 위 채널 표와 1:1 대응한다. **범용 `invoke(channel, payload)` 가 없다** —
 * 열면 렌더러가 임의 채널을 호출할 수 있고 `contextIsolation` 이 무의미해진다
 * (docs/SECURITY.md).
 *
 * 이 인터페이스가 계약이다. preload 가 이것을 구현하고, 렌더러는
 * src/renderer/api.d.ts 를 통해 이 타입으로 `window.api` 를 본다.
 */
export interface VibeApi {
  readonly project: {
    list(): Promise<readonly ProjectRef[]>;
    open(payload: ProjectPathPayload): Promise<OpenResult>;
    /** 메인이 폴더 선택창을 띄운다. 닫으면 `{ ok: false, reason: 'cancelled' }`. */
    openWithDialog(): Promise<OpenResult>;
    /** 열려 있는 프로젝트의 토글을 하나 바꾼다. 열린 프로젝트가 없으면 `rejected`. */
    setPrefs(patch: ProjectPrefsPatch): Promise<PrefsWriteResult>;
    /** 최근 목록에서 지운다. `ProjectEntry.id`. 디스크의 프로젝트는 지우지 않는다. */
    forget(projectId: string): Promise<void>;
  };
  readonly app: {
    /** 앱 전체 UI 설정. 창이 뜰 때 한 번 읽는다. */
    getUi(): Promise<AppUiState>;
    setTheme(theme: ThemeName): Promise<PrefsWriteResult>;
    /** 소개를 봤다고 저장한다. 거부돼도 화면은 소개를 닫는다 — 다음 실행에 한 번 더 뜰 뿐이다. */
    setIntroSeen(): Promise<PrefsWriteResult>;
  };
  readonly auth: {
    /** 캐시된 결과. 창을 열 때마다 서브프로세스를 띄우지 않는다. */
    probe(): Promise<AuthState>;
    /** 캐시를 버리고 다시 잰다. 사용자가 "다시 확인" 을 누를 때만 쓴다. */
    refresh(): Promise<AuthState>;
  };
  readonly plan: {
    get(): Promise<PlanLoadResult>;
    updateTask(patch: TaskPatch): Promise<PlanWriteResult>;
    onChanged(listener: (plan: Plan) => void): Unsubscribe;
  };
  readonly session: {
    /**
     * 프롬프트 큐에 넣기만 한다. 모델의 응답은 `onMessage` 로 흘러온다.
     * 돌려주는 프라미스는 **큐 적재 성공 여부**일 뿐이다 — 응답을 기다리는 것이 아니다.
     */
    pushTurn(payload: SessionTurnPayload): Promise<void>;
    interrupt(): Promise<void>;
    /**
     * 열려 있는 프로젝트의 지난 대화. 프로젝트를 열 때 한 번 읽는다 (docs/SESSION.md 10.2절).
     *
     * 로컬 파일 읽기라 **토큰이 들지 않는다** — 모델의 맥락 재개는 사용자가 다음 메시지를
     * 보낼 때 일어난다. 결과는 읽기 전용이다: 그것으로 관문·계획 상태를 바꾸지 않는다.
     */
    history(): Promise<SessionHistory>;
    onMessage(listener: (message: SessionMessage) => void): Unsubscribe;
    onState(listener: (state: SessionState) => void): Unsubscribe;
  };
  readonly permission: {
    onRequest(listener: (request: PermissionRequest) => void): Unsubscribe;
    respond(response: PermissionResponse): void;
  };
  readonly question: {
    onRequest(listener: (request: QuestionRequest) => void): Unsubscribe;
    respond(response: QuestionResponse): void;
    /** 메인이 끝낸 질문의 id. 렌더러는 그 질문을 섹션에서 치운다. */
    onClosed(listener: (event: QuestionClosedEvent) => void): Unsubscribe;
  };
  readonly gate: {
    list(): Promise<GateListResult>;
    answer(payload: GateAnswerPayload): Promise<GateAnswerResult>;
    /** 아이디어를 기록한다. 답변이 하나라도 있으면 거부된다 (docs/GATES.md 2.2 "아이디어"). */
    setIdea(idea: ProjectIdea): Promise<GateIdeaResult>;
    /**
     * 관문 토글 (docs/ADR.md ADR-023 2026-09-21 개정).
     *
     * `setPrefs({ kind: 'gatesEnabled' })` 와 **같은 함수**로 간다 — 열린 프로젝트의 토글을 바꾸고,
     * 기기별 상태 파일에 저장하고, 조율기에 알린다. 쓰기 차단 hook 이 곧바로 그 값을 본다.
     * 거부를 돌려줄 자리가 없다 — 사유가 필요하면 `project.setPrefs` 를 쓴다.
     */
    setEnabled(enabled: boolean): Promise<void>;
    /** 실패한 생성을 다시 시도한다. */
    retry(): Promise<void>;
    /** 관문 상태가 바뀌었다는 알림뿐이다. 상태는 `list()` 로 다시 읽는다. */
    onChanged(listener: () => void): Unsubscribe;
    /** 생성 진행 단계. 일시적 신호라 다시 읽을 것이 없다. */
    onProgress(listener: (progress: GateProgressEvent) => void): Unsubscribe;
  };
  readonly audit: {
    run(payload: AuditRunPayload): Promise<AuditRunId>;
    onProgress(listener: (progress: AuditProgressEvent) => void): Unsubscribe;
    onResult(listener: (result: AuditResult) => void): Unsubscribe;
    /** "일부러 그랬어요". 이유가 빈 문자열이면 거부된다 (docs/AUDITS.md 4.7). */
    suppress(payload: AuditSuppressPayload): Promise<AuditWriteResult>;
    unsuppress(payload: AuditUnsuppressPayload): Promise<AuditWriteResult>;
  };
  readonly activity: {
    /** 열린 프로젝트의 활동 기록과 진행 중인 턴. 열린 프로젝트가 없으면 reject — `plan.get` 과 같다. */
    get(): Promise<ActivityView>;
    /** 파일 도구가 파일을 쓸 때마다·턴이 끝날 때마다 온다. 열린 프로젝트의 것만 온다. */
    onChanged(listener: (view: ActivityView) => void): Unsubscribe;
    /** 관련 없는 수정이 3번 이어졌다. 메인은 질문을 하나만 열어 둔다. */
    onAsk(listener: (question: ActivityQuestion) => void): Unsubscribe;
    /** 앱의 질문에 답한다. 모르는·이미 답한 id 는 메인이 버린다. 프라미스는 적재 결과일 뿐이다. */
    answer(answer: ActivityAnswer): Promise<void>;
  };
}
