// 활동 기록 타입. 정의 원문은 docs/DATA_SCHEMA.md 5.2절, 결정은 ADR-031 이다 — 문서와 어긋나게 고치지 않는다.
//
// 이 파일은 메인과 렌더러 양쪽이 import 한다. SDK·ajv·node 내장을 쓰지 않는다.
// 코드 내용을 담지 않는다 — 파일은 경로·해시·시각만 (DATA_SCHEMA 5.1). 커밋되는 파일이다.

/** 파일 도구의 실행 뒤(즉시)인가, 턴 끝 폴더 훑기인가. 스키마 `enum` 이 이 배열을 그대로 쓴다. */
export const ACTIVITY_SOURCES = ['file_tool', 'scan'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** 작업마다 남기는 요청 수. 넘치면 오래된 것부터 버린다. */
export const ACTIVITY_REQUEST_LIMIT = 50;

/** `offPlan` 항목 수. 넘치면 오래된 것부터 버린다. */
export const ACTIVITY_OFF_PLAN_LIMIT = 200;

/** 요청 글 상한 — 코드 포인트로 센다 (ajv `maxLength` 와 같은 단위). */
export const ACTIVITY_REQUEST_TEXT_MAX_LENGTH = 500;

/** 작업 밖 대상으로 넘어간 횟수가 여기에 닿으면 "관련 있나요?" 를 묻는다 (DATA_SCHEMA 5.3). */
export const UNRELATED_ASK_THRESHOLD = 3;

export interface FileTouch {
  /** 프로젝트 루트 기준, 구분자 `/`. 루트 밖 경로는 싣지 않는다. */
  readonly path: string;
  /** 바뀐 뒤 내용의 SHA-256 hex. 지워졌으면 null. */
  readonly hash: string | null;
  /** ISO 8601 UTC. 같은 경로는 마지막 것 하나만 남긴다. */
  readonly at: string;
  readonly source: ActivitySource;
}

export interface ActivityRequest {
  /** 가린 사용자 요청. 500자에서 자른다. */
  readonly text: string;
  readonly at: string;
}

export interface TaskActivity {
  readonly taskId: string;
  readonly files: readonly FileTouch[];
  /** 최근 50개. */
  readonly requests: readonly ActivityRequest[];
}

export interface OffPlanEntry {
  /** 붙은 단계 (5.3). 모든 단계가 끝난 뒤의 수정이면 null — 계획 전체의 "계획 이후" 묶음. */
  readonly phaseId: string | null;
  readonly request: ActivityRequest;
  readonly files: readonly FileTouch[];
}

export interface Relatedness {
  /** 지금 따지는 작업. 작업을 시작하지 않았으면 null. */
  readonly taskId: string | null;
  /** 작업 밖 대상(파일)으로 넘어간 횟수. 3 이면 묻는다. */
  readonly unrelatedCount: number;
  /** 같은 파일만 연달아 고치면 세지 않는다 — 마지막으로 센 파일 묶음. 정렬·중복 제거해 둔다. */
  readonly lastUnrelatedPaths: readonly string[];
  /** 횟수가 마지막으로 0 이 된 시각 (ISO). [붙이기] 는 이 뒤의 `offPlan` 항목만 옮긴다. 처음엔 null. */
  readonly countingSince: string | null;
}

export interface ActivityFile {
  readonly schemaVersion: 1;
  readonly tasks: readonly TaskActivity[];
  /** 최근 200개. */
  readonly offPlan: readonly OffPlanEntry[];
  readonly relatedness: Relatedness;
}

/** 저장하지 않는다. 진행 중인 턴에서 파일 도구로 이미 바뀐 파일 — 어디에 붙을지는 턴이 끝나야 정해진다 (5.3). */
export interface CurrentTurn {
  /** 이 턴을 시작한 작업(`session:pushTurn` 의 `taskId`), 없으면 지금 따지는 작업(`relatedness.taskId`), 둘 다 없으면 null. */
  readonly provisionalTaskId: string | null;
  readonly files: readonly FileTouch[];
}

/** 렌더러로 가는 것. */
export type ActivityView = ActivityFile & {
  /** 이번 실행에서 폴더가 2만 개를 넘어 훑기를 건너뛰었다 (5.4). */
  readonly scanLimited: boolean;
  /** 활동 기록 파일을 읽을 수 없어 이번 실행 동안 기록을 멈췄다 (5.1). */
  readonly fileInvalid: boolean;
  readonly currentTurn: CurrentTurn | null;
};

/** 앱의 질문 "작업과 관련 있나요?" 의 답. [이 작업에 붙이기] / [따로 기록하기] (5.3). */
export const RELATEDNESS_CHOICES = ['attach', 'separate'] as const;
export type RelatednessChoice = (typeof RELATEDNESS_CHOICES)[number];

/** `activity:ask` — 관련 없는 수정이 문턱에 닿았다. 에이전트를 막지 않는다 (IPC_CONTRACT "활동"). */
export interface ActivityQuestion {
  readonly id: string;
  readonly taskId: string;
  /** 계획의 작업 제목. 작업이 계획에서 사라졌으면 id 를 그대로 싣는다. */
  readonly taskTitle: string;
  /** 횟수를 올린 최근 세 번의 파일. 루트 기준, 구분자 `/`. */
  readonly paths: readonly string[];
}

/** `activity:answer`. */
export interface ActivityAnswer {
  readonly id: string;
  readonly choice: RelatednessChoice;
}

/** 파일이 없을 때의 기록. */
export const EMPTY_ACTIVITY_FILE: ActivityFile = {
  schemaVersion: 1,
  tasks: [],
  offPlan: [],
  relatedness: { taskId: null, unrelatedCount: 0, lastUnrelatedPaths: [], countingSince: null },
};
