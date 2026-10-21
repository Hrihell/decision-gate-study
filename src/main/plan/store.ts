// 계획 파일 저장소. 명세는 docs/DATA_SCHEMA.md 1.5절, 충돌 규칙의 근거는 ADR-018 이다.
//
// 앱이 계획 파일의 유일한 기록자다 (ADR-009). electron 을 import 하지 않는다 — 경로와 시각을
// 인자로 받는 순수 코어다 (ADR-017). 프로젝트 루트의 허용 여부 검증은 IPC 핸들러의 몫이다.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { PLAN_RELATIVE_PATH } from '../../shared/constants';
import { TASK_PATCH_FIELDS } from '../../shared/types/plan';
import type { HarnessPlan, PlanLoadResult, PlanTask, PlanWriteResult, TaskPatch } from '../../shared/types/plan';
import { validatePlan } from './validate';

export interface PlanStoreOptions {
  /** ISO 8601 UTC. 테스트가 시각을 고정한다 (ADR-017). */
  readonly now?: () => string;
}

export interface PlanStore {
  read(projectRoot: string): Promise<PlanLoadResult>;
  /** 전체 교체. expectedRevision === null 은 "파일이 없어야 한다" 는 뜻이다. */
  writePlan(projectRoot: string, plan: HarnessPlan, expectedRevision: number | null): Promise<PlanWriteResult>;
  updateTask(projectRoot: string, patch: TaskPatch): Promise<PlanWriteResult>;
}

type PatchField = (typeof TASK_PATCH_FIELDS)[number];

const planPathOf = (projectRoot: string): string => resolve(projectRoot, PLAN_RELATIVE_PATH);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isErrnoCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

/** ENOENT 만 "없음" 이다. 그 외(EISDIR·EACCES 등)는 던진다 — 없음으로 읽으면 호출자가 덮어쓰려 한다. */
async function readPlanFile(path: string): Promise<PlanLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return { kind: 'missing' };
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    // 병합 충돌 마커(<<<<<<<)가 들어간 파일이 여기로 온다
    return { kind: 'invalid', errors: [`JSON 파싱 실패: ${errorMessage(error)}`] };
  }

  const validation = validatePlan(data);
  return validation.ok ? { kind: 'ok', plan: validation.value } : { kind: 'invalid', errors: validation.errors };
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // pid 만으로는 같은 프로세스의 두 쓰기가 같은 임시 파일을 공유한다.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    // 정리 실패는 원래 오류를 가리지 않게 버린다. 호출자에게 필요한 것은 쓰기가 실패한 이유다.
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * TASK_PATCH_FIELDS 의 키만 골라 적용한다. 패치를 펼치지 않는다 — 패치는 신뢰 경계 밖(렌더러)에서 온다.
 * 실제로 바뀌는 값이 없으면 undefined.
 */
function applyTaskPatch(task: PlanTask, patch: TaskPatch, now: string): PlanTask | undefined {
  const changedFields = TASK_PATCH_FIELDS.filter(
    (field) => Object.hasOwn(patch, field) && patch[field] !== undefined && patch[field] !== task[field],
  );
  if (changedFields.length === 0) return undefined;

  const picked = Object.fromEntries(changedFields.map((field) => [field, patch[field]])) as Partial<
    Pick<PlanTask, PatchField>
  >;
  const next = { ...task, ...picked };
  const wasDone = task.status === 'done';
  const isDone = next.status === 'done';

  return {
    ...next,
    updatedAt: now,
    completedAt: wasDone === isDone ? task.completedAt : isDone ? now : null,
  };
}

type PatchOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly plan: HarnessPlan };

/** 대상 task 가 든 phase 만 새 객체다. 나머지는 참조를 유지한다. */
function patchPlan(plan: HarnessPlan, patch: TaskPatch, now: string): PatchOutcome {
  const target = plan.phases.flatMap((phase) => phase.tasks).find((task) => task.id === patch.id);
  if (target === undefined) return { kind: 'not_found' };

  const updated = applyTaskPatch(target, patch, now);
  if (updated === undefined) return { kind: 'unchanged' };

  return {
    kind: 'changed',
    plan: {
      ...plan,
      phases: plan.phases.map((phase) =>
        phase.tasks.includes(target)
          ? { ...phase, tasks: phase.tasks.map((task) => (task === target ? updated : task)) }
          : phase,
      ),
    },
  };
}

export function createPlanStore(options: PlanStoreOptions = {}): PlanStore {
  const now = options.now ?? (() => new Date().toISOString());

  // 계획 파일 경로별 쓰기 꼬리. 저장해 두는 것은 settle 된 뒤 resolve 하는 프라미스라서
  // 앞의 쓰기가 reject 되어도 뒤의 쓰기가 진행된다.
  const tails = new Map<string, Promise<void>>();

  const serialize = <T>(path: string, job: () => Promise<T>): Promise<T> => {
    const previous = tails.get(path) ?? Promise.resolve();
    const current = previous.then(job);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    tails.set(path, tail);
    void tail.then(() => {
      if (tails.get(path) === tail) tails.delete(path);
    });
    return current;
  };

  /** revision·updatedAt 을 앱이 채우고, 검증을 통과할 때만 쓴다. 인자로 온 revision 은 무시한다. */
  const commit = async (
    path: string,
    disk: HarnessPlan | null,
    candidate: HarnessPlan,
    at: string,
  ): Promise<PlanWriteResult> => {
    const next: HarnessPlan = { ...candidate, revision: (disk?.revision ?? 0) + 1, updatedAt: at };
    // validatePlan 의 value 는 withDerivedStatus 를 거친 계획이다 — 캐시된 phase.status 가 교정되어 기록된다.
    const validation = validatePlan(next);
    if (!validation.ok) return { ok: false, reason: 'result_invalid', errors: validation.errors };

    await writeAtomic(path, `${JSON.stringify(validation.value, null, 2)}\n`);
    return { ok: true, plan: validation.value };
  };

  return {
    // 읽기는 쓰지 않으므로 줄 세우지 않는다. 교정한 phase.status 를 디스크에 되쓰지 않는다.
    read: (projectRoot) => readPlanFile(planPathOf(projectRoot)),

    writePlan: (projectRoot, plan, expectedRevision) => {
      const path = planPathOf(projectRoot);
      return serialize(path, async (): Promise<PlanWriteResult> => {
        const disk = await readPlanFile(path);
        if (disk.kind === 'invalid') return { ok: false, reason: 'disk_invalid', errors: disk.errors };
        if (disk.kind === 'missing') {
          return expectedRevision === null ? commit(path, null, plan, now()) : { ok: false, reason: 'missing' };
        }
        // `>` 가 아니다. git checkout 으로 옛 커밋에 가면 디스크 revision 이 작아진다 (ADR-018 이유 2).
        if (disk.plan.revision !== expectedRevision) return { ok: false, reason: 'conflict', plan: disk.plan };
        return commit(path, disk.plan, plan, now());
      });
    },

    updateTask: (projectRoot, patch) => {
      const path = planPathOf(projectRoot);
      return serialize(path, async (): Promise<PlanWriteResult> => {
        // 최신 디스크 계획 위에 패치를 얹는다 — 외부 변경(git pull·손편집)을 지우지 않는다.
        const disk = await readPlanFile(path);
        if (disk.kind === 'invalid') return { ok: false, reason: 'disk_invalid', errors: disk.errors };
        if (disk.kind === 'missing') return { ok: false, reason: 'missing' };

        // 바뀐 task 와 계획의 updatedAt 이 같은 시각이어야 한다
        const at = now();
        const outcome = patchPlan(disk.plan, patch, at);
        if (outcome.kind === 'not_found') return { ok: false, reason: 'task_not_found', plan: disk.plan };
        if (outcome.kind === 'unchanged') return { ok: true, plan: disk.plan };
        return commit(path, disk.plan, outcome.plan, at);
      });
    },
  };
}
