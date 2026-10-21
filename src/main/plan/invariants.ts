// 계획의 교차 필드 불변식. 명세는 docs/DATA_SCHEMA.md 1.4c절의 표다 — 규칙을 더하거나 빼지 않는다.
// 규칙 하나가 늘면 기존 계획 파일이 읽기 실패할 수 있다.
//
// **순수 함수다.** ajv·fs·electron 을 쓰지 않는다. JSON Schema 가 표현할 수 없는 것만 여기서 보고,
// 둘의 조합은 validate.ts 가 한다.

import { phaseStatus } from '../../shared/plan/progress';
import type { HarnessPlan, PlanPhase, PlanTask } from '../../shared/types/plan';

export interface InvariantReport {
  /** 하나라도 있으면 읽기·쓰기가 실패한다. */
  readonly errors: readonly string[];
  /** 파생 캐시가 어긋난 것. 실패시키지 않고 메모리에서 복구한다. */
  readonly warnings: readonly string[];
}

const checkOrderContiguous = (phases: readonly PlanPhase[]): string[] => {
  const sorted = phases.slice().sort((a, b) => a.order - b.order);
  // 첫 어긋남만 보고한다. 빈틈 하나가 뒤의 모든 phase 를 밀어내므로 나머지는 같은 문제다.
  const index = sorted.findIndex((p, i) => p.order !== i + 1);
  const broken = sorted[index];
  return broken === undefined
    ? []
    : [`phase ${broken.id}: order ${broken.order} breaks the 1..n sequence (expected ${index + 1})`];
};

const checkOrderAscending = (phases: readonly PlanPhase[]): string[] =>
  phases.flatMap((p, i) => {
    const prev = phases[i - 1];
    return prev !== undefined && p.order < prev.order
      ? [`phase ${p.id}: order ${p.order} comes after phase ${prev.id} (order ${prev.order}) in the array`]
      : [];
  });

const duplicates = (ids: readonly string[]): string[] =>
  [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

const checkTaskPrefix = (phases: readonly PlanPhase[]): string[] =>
  phases.flatMap((p) =>
    p.tasks
      .filter((t) => !t.id.startsWith(`${p.id}-`))
      .map((t) => `task ${t.id}: id does not start with its phase id "${p.id}-"`),
  );

/**
 * "앞" 은 **배열 위치**다 — `order` 로 정렬한 순서가 아니다. 둘이 같다는 것은
 * checkOrderAscending 이 보장한다. 그 규칙이 깨진 계획은 어차피 오류로 거부된다.
 */
const checkDependsOn = (tasks: readonly PlanTask[]): string[] => {
  const position = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (!position.has(t.id)) position.set(t.id, i);
  });
  return tasks.flatMap((t, i) =>
    t.dependsOn.flatMap((dep) => {
      const depIndex = position.get(dep);
      if (depIndex === undefined) return [`task ${t.id}: dependsOn ${dep} does not exist`];
      return depIndex >= i ? [`task ${t.id}: dependsOn ${dep} is not earlier in the plan`] : [];
    }),
  );
};

const checkCompletedAt = (tasks: readonly PlanTask[]): string[] =>
  tasks.flatMap((t) => {
    if (t.status === 'done' && t.completedAt === null) {
      return [`task ${t.id}: status is done but completedAt is null`];
    }
    if (t.status !== 'done' && t.completedAt !== null) {
      return [`task ${t.id}: status is ${t.status} but completedAt is set`];
    }
    return [];
  });

export function checkPlanInvariants(plan: HarnessPlan): InvariantReport {
  const { phases } = plan;
  const tasks = phases.flatMap((p) => p.tasks);

  const errors = [
    ...checkOrderContiguous(phases),
    ...checkOrderAscending(phases),
    ...duplicates(phases.map((p) => p.id)).map((id) => `phase ${id}: duplicate phase id`),
    ...duplicates(tasks.map((t) => t.id)).map((id) => `task ${id}: duplicate task id`),
    ...checkTaskPrefix(phases),
    ...checkDependsOn(tasks),
    ...checkCompletedAt(tasks),
  ];

  const warnings = phases
    .filter((p) => p.status !== phaseStatus(p))
    .map((p) => `phase ${p.id}: cached status ${p.status} differs from derived ${phaseStatus(p)}`);

  return { errors, warnings };
}

/** 캐시된 phase.status 를 다시 계산한 **새** 계획. 바뀐 것이 없으면 입력을 그대로 돌려준다. */
export function withDerivedStatus(plan: HarnessPlan): HarnessPlan {
  let changed = false;
  const phases = plan.phases.map((p) => {
    const status = phaseStatus(p);
    if (status === p.status) return p;
    changed = true;
    return { ...p, status };
  });
  return changed ? { ...plan, phases } : plan;
}
