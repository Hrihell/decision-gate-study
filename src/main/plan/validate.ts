// ajv 검증기. 명세는 docs/DATA_SCHEMA.md 1.4b·1.4c절이다. ajv compile 은 여기서만 한다.
//
// 파일 입출력을 하지 않는다 — 읽기·쓰기는 저장소(store.ts)의 몫이다. 여기는 `unknown` 을 받아 판정만 한다.

import Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

import type { AppState } from '../../shared/types/appState';
import type { GeneratedPlan, HarnessPlan } from '../../shared/types/plan';
import { checkPlanInvariants, withDerivedStatus } from './invariants';
import { APP_STATE_JSON_SCHEMA, HARNESS_PLAN_JSON_SCHEMA, PLAN_GENERATION_JSON_SCHEMA } from './schemas';

export type Validation<T> =
  | { readonly ok: true; readonly value: T; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

// strict 를 끄지 않는다 — 키워드 오타가 조용히 무시되면 스키마가 아무것도 검증하지 않는다.
// compile 이 strict 예외를 내면 옵션이 아니라 스키마를 고친다.
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });

const planValidator = ajv.compile<HarnessPlan>(HARNESS_PLAN_JSON_SCHEMA);
const generatedPlanValidator = ajv.compile<GeneratedPlan>(PLAN_GENERATION_JSON_SCHEMA);
const appStateValidator = ajv.compile<AppState>(APP_STATE_JSON_SCHEMA);

// 루트 오류는 instancePath 가 '' 라서 경로 자리를 '/' 로 채운다.
const formatErrors = (errors: readonly ErrorObject[] | null | undefined): readonly string[] =>
  (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);

const schemaOnly = <T>(validator: ValidateFunction<T>, data: unknown): Validation<T> =>
  validator(data)
    ? { ok: true, value: data, warnings: [] }
    : { ok: false, errors: formatErrors(validator.errors) };

/** ajv 와 교차 필드 불변식을 함께 돌린다. `value` 는 캐시된 phase.status 를 교정한 계획이다. */
export function validatePlan(data: unknown): Validation<HarnessPlan> {
  if (!planValidator(data)) return { ok: false, errors: formatErrors(planValidator.errors) };

  const { errors, warnings } = checkPlanInvariants(data);
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, value: withDerivedStatus(data), warnings };
}

/** 에이전트가 생성한 계획. ajv 만 돌린다 — 불변식은 앱 소유 필드가 채워진 뒤의 일이다. */
export function validateGeneratedPlan(data: unknown): Validation<GeneratedPlan> {
  return schemaOnly(generatedPlanValidator, data);
}

export function validateAppState(data: unknown): Validation<AppState> {
  return schemaOnly(appStateValidator, data);
}
