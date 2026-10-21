// 진척 계산. 정의 원문은 docs/DATA_SCHEMA.md 1.3절이다 — 가중치와 blocked 처리는 제품 판단이므로
// 문서와 어긋나게 고치지 않는다. 렌더러 번들에도 들어가므로 순수 함수만 둔다.

import type { HarnessPlan, PlanPhase, PlanTask, PhaseStatus, TaskStatus } from '../types/plan';

const WEIGHT: Record<TaskStatus, number> = {
  todo: 0,
  blocked: 0,
  in_progress: 0.5,
  done: 1,
};

export const taskProgress = (tasks: readonly PlanTask[]): number =>
  tasks.length === 0
    ? 0
    : tasks.reduce((sum, t) => sum + WEIGHT[t.status], 0) / tasks.length;

export const phaseStatus = (phase: PlanPhase): PhaseStatus =>
  phase.tasks.length === 0
    ? 'not_started'
    : phase.tasks.every((t) => t.status === 'done')
      ? 'done'
      : phase.tasks.some((t) => t.status !== 'todo')
        ? 'in_progress'
        : 'not_started';

/**
 * Task-count weighted, NOT phase-count weighted. A 2-task phase must not
 * count the same as an 8-task phase, or the progress bar lies to the user.
 */
export const overallProgress = (plan: HarnessPlan): number =>
  taskProgress(plan.phases.flatMap((p) => p.tasks));

export const todaysTodos = (plan: HarnessPlan): readonly PlanTask[] =>
  plan.phases
    .flatMap((p) => p.tasks)
    .filter((t) => t.isToday && t.status !== 'done');

/** The single task the user should work on next. Feature (b) headline. */
export const nextTask = (plan: HarnessPlan): PlanTask | undefined => {
  const all = plan.phases
    .slice()
    .sort((a, b) => a.order - b.order)
    .flatMap((p) => p.tasks);
  const doneIds = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
  return (
    all.find((t) => t.status === 'in_progress') ??
    all.find((t) => t.status === 'todo' && t.dependsOn.every((d) => doneIds.has(d)))
  );
};
