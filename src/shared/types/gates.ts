// 결정 관문 타입. 정의 원문은 docs/GATES.md 4절·4.2절이다 — 문서와 어긋나게 고치지 않는다.
//
// SDK 를 import 하지 않는다. src/shared/ 는 렌더러 번들에도 들어간다.

import type { DECIDED_BY } from './plan';

// enum 값은 배열 하나에서 파생한다 (plan.ts 의 DECIDED_BY 관습).
export const GATE_DIFFICULTIES = ['쉬움', '보통', '어려움'] as const;
export type GateDifficulty = (typeof GATE_DIFFICULTIES)[number];

/** 생성 세션의 effort. SDK 는 xhigh·max 도 받지만 생성은 느려지기만 한다 (TESTING 실측) — 셋만 연다. */
export const GENERATION_EFFORTS = ['low', 'medium', 'high'] as const;
export type GenerationEffort = (typeof GENERATION_EFFORTS)[number];

/** Static — ships in the app bundle. */
export interface GateDefinition {
  readonly gateId: string;
  readonly order: number;
  readonly titleKo: string;
  readonly subtitleKo: string;
  readonly questionKo: string;
  readonly dependsOnGates: readonly string[];
  readonly blocksCodeWrites: boolean;
  readonly minOptions: number;
  readonly maxOptions: number;
  readonly allowFreeform: boolean;
  readonly requiresRecommendation: boolean;
  readonly optionGeneration: {
    readonly promptTemplateId: string;
    readonly model: string;
    readonly maxTurns: number;
    /** 필수다. 빠지면 SDK 기본값(high)으로 돌아 대기가 다시 길어진다. */
    readonly effort: GenerationEffort;
    readonly inputs: readonly string[];
  };
  readonly consumers: readonly string[];
}

/** Runtime — what the agent returns. Must satisfy GATE_OPTIONS_JSON_SCHEMA. */
export interface GeneratedGateOption {
  readonly id: string;
  readonly labelKo: string;
  readonly rationaleKo: string;
  readonly prosKo: readonly string[];
  readonly consKo: readonly string[];
  readonly difficulty: GateDifficulty;
  readonly packages: readonly string[];
  readonly learningResourceKo: string;
}

export interface GeneratedGateOptions {
  readonly options: readonly GeneratedGateOption[];
  readonly recommendedOptionId: string;
  readonly recommendationReasonKo: string;
}

/** The user's answer to one gate, as stored in .harness/gates.json. */
export interface GateAnswer {
  readonly chosenOptionId: string;
  readonly userNote: string;
  readonly decidedAt: string;
  readonly decidedBy: (typeof DECIDED_BY)[number];
  readonly sessionId: string;
}

/** 사용자가 적은 프로젝트 아이디어. 선택지·계획 생성의 입력이다 (ADR-020). */
export const PROJECT_TYPES = ['desktop-app', 'web', 'cli'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
/** `ideaKo` 의 최대 길이. 스키마(코드 포인트)와 입력 화면(`maxLength`)이 같은 값을 쓴다. */
export const IDEA_KO_MAX_LENGTH = 2000;

export interface ProjectIdea {
  readonly projectType: ProjectType;
  /** 사용자가 쓴 문장 그대로. 줄이거나 고치지 않는다. */
  readonly ideaKo: string;
}

/** 관문 답의 `userNote` 최대 길이. 스키마와 관문 화면의 이유 입력(`maxLength`)이 같은 값을 쓴다. */
export const GATE_USER_NOTE_MAX_LENGTH = 1000;

/** Persisted in .harness/gates.json */
export interface GatesFile {
  readonly schemaVersion: 1;
  /** 선택 필드다. 없는 파일이 invalid 가 되면 안 된다 (ADR-020). */
  readonly idea?: ProjectIdea;
  readonly gates: readonly {
    readonly gateId: string;
    readonly generated: GeneratedGateOptions;
    readonly generatedAt: string;
    /** null until the user answers. */
    readonly answer: GateAnswer | null;
  }[];
}

/**
 * 관문 하나의 상태 (4.2절). **판별 유니온이다** — `generated: … | null` 하나로 두면 "아직 안 만들었다"·
 * "만드는 중"·"실패했다"·"파일이 깨졌다" 가 전부 null 이 되어 화면이 구분하지 못한다.
 * 진행·실패는 관문마다가 아니라 `GenerationState` 하나에 있다.
 */
export type GateView =
  | { readonly status: 'locked'; readonly definition: GateDefinition }
  | { readonly status: 'pending'; readonly definition: GateDefinition }
  | { readonly status: 'ready'; readonly definition: GateDefinition; readonly generated: GeneratedGateOptions }
  | {
      readonly status: 'answered';
      readonly definition: GateDefinition;
      readonly generated: GeneratedGateOptions;
      readonly answer: GateAnswer;
    };

/** 생성은 한 번에 하나다 — 관문별이 아니라 프로젝트별 상태다 (4.2절). */
export type GenerationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly target: 'options' | 'plan'; readonly gateId: string | null }
  | { readonly kind: 'failed'; readonly target: 'options' | 'plan'; readonly gateId: string | null };

/** 화면용 생성 단계 이름. 문구는 렌더러가 고른다 (ADR-015). 도구 이름을 그대로 올리지 않는다. */
export type GenerationStage = 'reading' | 'thinking' | 'validating';

/** `gate:list` 가 돌려주는 것 (4.2절). */
export interface GateListResult {
  readonly views: readonly GateView[];
  readonly generation: GenerationState;
  /** 아직 아이디어를 적지 않았으면 null — 화면이 입력을 먼저 띄운다. */
  readonly idea: ProjectIdea | null;
  readonly gatesEnabled: boolean;
  /** gates.json 이 깨졌다. 관문을 그리지 않고 고치는 법을 안내한다. */
  readonly fileInvalid: boolean;
}

/**
 * `gate:answer` 가 받는 것 (4.2절). **`decidedBy` 는 여기 없다** — 렌더러는 추천 버튼을 눌렀다는 사실(`acceptRecommended`)만
 * 보내고, 메인이 `chosenOptionId` 와 `decidedBy` 를 유도한다 ("누가 정하는가").
 */
export type GateAnswerPayload = {
  readonly gateId: string;
  /** 사용자가 적은 이유. 빈 문자열을 허용한다. */
  readonly userNote: string;
} & (
  | { readonly acceptRecommended: false; readonly chosenOptionId: string }
  | { readonly acceptRecommended: true }
);

/**
 * 조율기가 답을 거부한 이유. 뒤 여섯은 gates.json 저장소의 쓰기 거부 사유다 — src/shared/ 는 main 을 import 하지 못해
 * 값을 적어 둔다. 어긋나면 조율기의 `return { ok: false, reason: written.reason }` 가 타입 오류로 잡힌다.
 */
export type GateAnswerRejection =
  | 'no_project'
  | 'gates_disabled'
  | 'unknown_gate'
  | 'not_open'
  | 'missing'
  | 'disk_invalid'
  | 'result_invalid'
  | 'gate_not_found'
  | 'option_not_found'
  | 'conflict';

/** `gate:answer` 의 결과. 던지지 않는다 — 렌더러가 사유로 분기한다 (2.3절). */
export type GateAnswerResult = { readonly ok: true } | { readonly ok: false; readonly reason: GateAnswerRejection };

/**
 * 아이디어 기록을 거부한 이유. `conflict` 는 답변이 이미 있을 때다 (2.2 "아이디어").
 * 조율기의 `setIdea` 가 생기는 phase 07 step 4 에서 확정한다.
 */
export type GateIdeaRejection = 'no_project' | 'gates_disabled' | 'disk_invalid' | 'result_invalid' | 'conflict';

/** `gate:setIdea` 의 결과. 던지지 않는다 (2.3절). */
export type GateIdeaResult = { readonly ok: true } | { readonly ok: false; readonly reason: GateIdeaRejection };

/** `gate:progress` 의 페이로드 — 일시적 신호라 상태를 싣는다 (2.3절). 계획 생성이면 `gateId` 가 null. */
export interface GateProgressEvent {
  readonly gateId: string | null;
  readonly stage: GenerationStage;
}
