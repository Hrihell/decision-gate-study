// 앱 상태 타입. 정의 원문은 docs/DATA_SCHEMA.md 2.2절이다 — 문서와 어긋나게 고치지 않는다.
// 기기별 설정이라 저장소에 커밋하지 않는다 (docs/ADR.md ADR-013).

export const THEMES = ['light', 'dark', 'system'] as const;
export const LOCALES = ['ko', 'en'] as const;

export interface ProjectEntry {
  /** crypto.randomUUID() */
  readonly id: string;
  readonly displayName: string;
  /** absolute path */
  readonly rootPath: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
  /** SDKSystemMessage.session_id. 세션이 시작될 때 기록자가 쓰고, `Options.resume` 과 `session:history` 가 읽는다 (SESSION 10절). */
  readonly lastSessionId: string | null;
  /** cache of existsSync('<root>/.harness/plan.json') */
  readonly planPresent: boolean;
  readonly gatesCompleted: readonly string[];
  readonly lastAuditAt: string | null;
  readonly lastAuditSummary: {
    readonly error: number;
    readonly warning: number;
    readonly review: number;
  } | null;
}

/** Per-machine, per-project harness preferences. NEVER committed. See ADR-013. */
export interface ProjectPrefs {
  /** The gate on/off toggle. */
  readonly gatesEnabled: boolean;
  /** Individually muted gates, by gateId. **의도적으로 비어 있다** — 화면이 없다 (DATA_SCHEMA 2.2). */
  readonly mutedGateIds: readonly string[];
  readonly bashWriteGateEnabled: boolean;
  readonly auditsEnabled: boolean;
  readonly fileCheckpointingEnabled: boolean;
}

export interface AppState {
  readonly schemaVersion: 1;
  readonly projects: readonly ProjectEntry[];
  readonly lastOpenedProjectId: string | null;
  /** Keyed by ProjectEntry.id. */
  readonly projectPrefs: Readonly<Record<string, ProjectPrefs>>;
  readonly ui: {
    readonly theme: (typeof THEMES)[number];
    readonly locale: (typeof LOCALES)[number];
    /** 첫 실행 소개를 "시작하기" 로 넘겼다 (ADR-024). **선택 필드** — 없으면 아직 안 본 것이다. */
    readonly introSeen?: boolean;
  };
  readonly telemetryOptIn: boolean;
}

export const DEFAULT_PROJECT_PREFS: ProjectPrefs = {
  gatesEnabled: true,
  mutedGateIds: [],
  bashWriteGateEnabled: true,
  auditsEnabled: true,
  fileCheckpointingEnabled: true,
};

export const DEFAULT_APP_STATE: AppState = {
  schemaVersion: 1,
  projects: [],
  lastOpenedProjectId: null,
  projectPrefs: {},
  ui: { theme: 'system', locale: 'ko' },
  telemetryOptIn: false,
};
