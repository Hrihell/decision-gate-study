// JSON Schema 세 개. 원문은 docs/DATA_SCHEMA.md 1.4a·1.4b·2.2절이다 — 문서와 어긋나게 고치지 않는다.
//
// src/shared/ 에 두지 않는다. 검증은 신뢰 경계인 메인에 붙고, ajv 가 렌더러 번들·CSP 와 충돌한다 (1.4).
// `JSONSchemaType<T>` 를 붙이지 않는다 — readonly 튜플과 union `type` 배열을 거부한다.
// 타입과의 드리프트는 validate.test.ts 가 막는다.

import { LOCALES, THEMES } from '../../shared/types/appState';
import { GATE_USER_NOTE_MAX_LENGTH } from '../../shared/types/gates';
import { DECIDED_BY, PHASE_STATUSES, TASK_STATUSES } from '../../shared/types/plan';

// ── 1.4a 생성 스키마 — SDK `outputFormat.schema` 에 넘긴다 ───────────────────────────
// 키워드를 보수적으로 제한한다. `$ref`·`anyOf`·`enum`·`const` 등을 넣지 않는다 — SDK 의
// JSON Schema 방언이 선언되어 있지 않다. 허용 목록은 schemas.test.ts 가 강제한다.

export const PLAN_GENERATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projectName', 'oneLiner', 'phases'],
  properties: {
    projectName: { type: 'string', minLength: 1, maxLength: 80 },
    oneLiner: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: '무엇을 만드는지 한 문장으로. 한국어.',
    },
    phases: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'order', 'title', 'goal', 'tasks'],
        properties: {
          id: { type: 'string', pattern: '^p[0-9]+$' },
          order: { type: 'integer', minimum: 1, maximum: 6 },
          title: { type: 'string', minLength: 1, maxLength: 60 },
          goal: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description: '이 단계가 끝나면 무엇이 완성되는지. 한국어.',
          },
          tasks: {
            type: 'array',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'description', 'estimateHours', 'dependsOn'],
              properties: {
                id: { type: 'string', pattern: '^p[0-9]+-t[0-9]+$' },
                title: { type: 'string', minLength: 1, maxLength: 80 },
                description: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 400,
                  description: '초보자가 무엇을 해야 하는지. 전문용어를 쓰면 괄호로 풀어쓴다.',
                },
                estimateHours: { type: 'number', minimum: 0.5, maximum: 16 },
                dependsOn: {
                  type: 'array',
                  maxItems: 4,
                  items: { type: 'string', pattern: '^p[0-9]+-t[0-9]+$' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

// ── 1.4b 영속 파일 스키마 — ajv 에만 넘긴다 ─────────────────────────────────────────
// 여기서는 `const`·`anyOf`·union `type` 배열이 안전하다. 방언 주의는 생성 스키마에만 적용된다.

// src/main/decisionGates/schemas.ts 도 쓴다 — 날짜 정규식을 두 벌로 두지 않는다.
export const ISO_DATE = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
} as const;

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'title', 'description', 'status', 'assignee', 'memo',
    'estimateHours', 'dependsOn', 'isToday', 'createdAt', 'updatedAt', 'completedAt',
  ],
  properties: {
    id: { type: 'string', pattern: '^p[0-9]+-t[0-9]+$' },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 400 },
    status: { type: 'string', enum: TASK_STATUSES },
    assignee: { type: ['string', 'null'], maxLength: 60 },
    memo: { type: 'string', maxLength: 2000 },
    estimateHours: { type: ['number', 'null'], minimum: 0, maximum: 40 },
    dependsOn: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^p[0-9]+-t[0-9]+$' } },
    isToday: { type: 'boolean' },
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    completedAt: { anyOf: [ISO_DATE, { type: 'null' }] },
  },
} as const;

const PHASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'order', 'title', 'goal', 'status', 'tasks'],
  properties: {
    id: { type: 'string', pattern: '^p[0-9]+$' },
    order: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 60 },
    goal: { type: 'string', maxLength: 300 },
    status: { type: 'string', enum: PHASE_STATUSES },
    tasks: { type: 'array', minItems: 1, items: TASK_SCHEMA },
  },
} as const;

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'gateId', 'questionKo', 'optionsOffered', 'chosenOptionId',
    'chosenLabel', 'userNote', 'decidedAt', 'decidedBy', 'sessionId',
  ],
  properties: {
    gateId: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' },
    questionKo: { type: 'string', minLength: 1, maxLength: 300 },
    optionsOffered: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'labelKo', 'rationaleKo'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' },
          labelKo: { type: 'string', minLength: 1, maxLength: 60 },
          rationaleKo: { type: 'string', maxLength: 300 },
        },
      },
    },
    chosenOptionId: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' },
    chosenLabel: { type: 'string', minLength: 1, maxLength: 60 },
    userNote: { type: 'string', maxLength: GATE_USER_NOTE_MAX_LENGTH },
    decidedAt: ISO_DATE,
    decidedBy: { type: 'string', enum: DECIDED_BY },
    sessionId: { type: 'string', minLength: 1 },
  },
} as const;

export const HARNESS_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'revision', 'projectName', 'oneLiner',
    'createdAt', 'updatedAt', 'decisions', 'phases',
  ],
  properties: {
    // MVP 에는 마이그레이션이 없다. 1 이 아니면 거부한다.
    schemaVersion: { const: 1 },
    revision: { type: 'integer', minimum: 1 },
    projectName: { type: 'string', minLength: 1, maxLength: 80 },
    oneLiner: { type: 'string', maxLength: 200 },
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    decisions: { type: 'array', items: DECISION_SCHEMA },
    phases: { type: 'array', minItems: 1, items: PHASE_SCHEMA },
  },
} as const satisfies Record<string, unknown>;

// ── 2.2 앱 상태 스키마 — 검증기가 한 곳에서 compile 하도록 같은 파일에 둔다 ───────────
// `pattern`·`minLength` 는 문자열에만 적용되므로 `type: ['string', 'null']` 과 함께 써도 null 을 막지 않는다.

const ISO_DATE_OR_NULL = {
  type: ['string', 'null'],
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$',
} as const;

const PROJECT_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'displayName', 'rootPath', 'createdAt', 'lastOpenedAt', 'lastSessionId',
    'planPresent', 'gatesCompleted', 'lastAuditAt', 'lastAuditSummary',
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    displayName: { type: 'string', minLength: 1, maxLength: 80 },
    rootPath: { type: 'string', minLength: 1 },
    createdAt: ISO_DATE,
    lastOpenedAt: ISO_DATE,
    lastSessionId: { type: ['string', 'null'], minLength: 1 },
    planPresent: { type: 'boolean' },
    gatesCompleted: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' } },
    lastAuditAt: ISO_DATE_OR_NULL,
    lastAuditSummary: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['error', 'warning', 'review'],
          properties: {
            error: { type: 'integer', minimum: 0 },
            warning: { type: 'integer', minimum: 0 },
            review: { type: 'integer', minimum: 0 },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const;

const PROJECT_PREFS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'gatesEnabled', 'mutedGateIds', 'bashWriteGateEnabled', 'auditsEnabled', 'fileCheckpointingEnabled',
  ],
  properties: {
    gatesEnabled: { type: 'boolean' },
    mutedGateIds: { type: 'array', items: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' } },
    bashWriteGateEnabled: { type: 'boolean' },
    auditsEnabled: { type: 'boolean' },
    fileCheckpointingEnabled: { type: 'boolean' },
  },
} as const;

export const APP_STATE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'projects', 'lastOpenedProjectId', 'projectPrefs', 'ui', 'telemetryOptIn'],
  properties: {
    schemaVersion: { const: 1 },
    projects: { type: 'array', items: PROJECT_ENTRY_SCHEMA },
    // projects 에 실제로 있는지는 검사하지 않는다 — 없으면 "마지막 프로젝트 없음" 으로 읽는다.
    lastOpenedProjectId: { type: ['string', 'null'], minLength: 1 },
    projectPrefs: { type: 'object', additionalProperties: PROJECT_PREFS_SCHEMA },
    ui: {
      type: 'object',
      additionalProperties: false,
      // introSeen 은 required 에 넣지 않는다 — 넣으면 예전 파일이 버려져 프로젝트 목록을 잃는다 (DATA_SCHEMA 2.2)
      required: ['theme', 'locale'],
      properties: {
        theme: { type: 'string', enum: THEMES },
        locale: { type: 'string', enum: LOCALES },
        introSeen: { type: 'boolean' },
      },
    },
    telemetryOptIn: { type: 'boolean' },
  },
} as const satisfies Record<string, unknown>;
