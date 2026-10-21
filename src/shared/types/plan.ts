// 계획 데이터 타입. 정의 원문은 docs/DATA_SCHEMA.md 1.2절이다 — 문서와 어긋나게 고치지 않는다.

// enum 값은 배열 하나에서 파생한다. JSON Schema 의 `enum` 도 같은 배열을 쓴다 —
// 타입과 스키마의 값 목록이 어긋나는 것을 구조로 막는다 (1.4b).
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PHASE_STATUSES = ['not_started', 'in_progress', 'done'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const DECIDED_BY = ['user', 'default'] as const;

export interface PlanTask {
  /** Stable id, "p1-t3". Never reused, never renumbered. */
  readonly id: string;
  /** Korean, imperative, one line. */
  readonly title: string;
  /** 1–3 sentences a non-CS-major can act on. */
  readonly description: string;
  readonly status: TaskStatus;
  /** 담당자. null = unassigned. Always null in MVP; post-MVP team use. */
  readonly assignee: string | null;
  /** 메모. Freeform user notes. '' when empty, never null. */
  readonly memo: string;
  readonly estimateHours: number | null;
  /** Task ids in the same or an earlier phase. */
  readonly dependsOn: readonly string[];
  /** Feature (b) "오늘의 할 일". */
  readonly isToday: boolean;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface PlanPhase {
  /** "p1" */
  readonly id: string;
  /** 1-based, unique, contiguous. */
  readonly order: number;
  readonly title: string;
  /** "이 단계가 끝나면 무엇이 되는가" */
  readonly goal: string;
  /** DERIVED from tasks — a cache. Recompute on read; see §1.4c. */
  readonly status: PhaseStatus;
  readonly tasks: readonly PlanTask[];
}

export interface DecisionGateOption {
  readonly id: string;
  /** 2026-09-16 정정: 이름이 `labelKo` 로 바뀌었다 (GeneratedGateOption 과 맞춘다). GATES.md 4.1 참조. */
  readonly labelKo: string;
  readonly rationaleKo: string;
}

export interface DecisionGateRecord {
  /** Matches a static gate definition's gateId, e.g. "stack-selection". */
  readonly gateId: string;
  /** What was asked, verbatim, in Korean. */
  readonly questionKo: string;
  /** Every option that was on the table — needed to audit the decision later. */
  readonly optionsOffered: readonly DecisionGateOption[];
  readonly chosenOptionId: string;
  /** Denormalised so the dashboard needs no join. */
  readonly chosenLabel: string;
  /** Why the user chose it. '' allowed. */
  readonly userNote: string;
  readonly decidedAt: string;
  readonly decidedBy: (typeof DECIDED_BY)[number];
  /** SDKSystemMessage.session_id (V sdk.d.ts:5497) — traceability. */
  readonly sessionId: string;
}

export interface HarnessPlan {
  readonly schemaVersion: 1;
  /** Incremented on every app write. Detects lost updates. */
  readonly revision: number;
  readonly projectName: string;
  /** "무엇을 만드는가" in one Korean sentence. */
  readonly oneLiner: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decisions: readonly DecisionGateRecord[];
  readonly phases: readonly PlanPhase[];
}

/**
 * What the AGENT generates (§1.4a). Excludes every app-owned field: status,
 * assignee, memo, timestamps, revision, decisions. Asking a model for
 * `createdAt` invites a hallucinated clock.
 */
export interface GeneratedPlan {
  readonly projectName: string;
  readonly oneLiner: string;
  readonly phases: readonly {
    readonly id: string;
    readonly order: number;
    readonly title: string;
    readonly goal: string;
    readonly tasks: readonly {
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly estimateHours: number;
      readonly dependsOn: readonly string[];
    }[];
  }[];
}

/** The fields a caller may change on one task. See §1.5 and §4. */
export const TASK_PATCH_FIELDS = ['status', 'memo', 'isToday', 'assignee'] as const;

export type TaskPatch = { readonly id: string } & Partial<
  Pick<PlanTask, (typeof TASK_PATCH_FIELDS)[number]>
>;

/** Reading `.harness/plan.json`. See §1.5. */
export type PlanLoadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly plan: HarnessPlan }
  | { readonly kind: 'invalid'; readonly errors: readonly string[] };

/** Writing `.harness/plan.json`. See §1.5 and ADR-018. */
export type PlanWriteResult =
  | { readonly ok: true; readonly plan: HarnessPlan }
  | { readonly ok: false; readonly reason: 'missing' }
  | { readonly ok: false; readonly reason: 'disk_invalid'; readonly errors: readonly string[] }
  | { readonly ok: false; readonly reason: 'result_invalid'; readonly errors: readonly string[] }
  | { readonly ok: false; readonly reason: 'task_not_found'; readonly plan: HarnessPlan }
  | { readonly ok: false; readonly reason: 'conflict'; readonly plan: HarnessPlan };
