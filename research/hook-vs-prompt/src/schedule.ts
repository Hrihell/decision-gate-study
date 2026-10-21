// 실행 블록 계획 (DESIGN v2 §6.1·§6.3). 블록 = (과제, 반복). 블록 안의 조건은 연달아 돌린다 — 시간대 변화가 조건과 겹치지 않게.
// 블록 순서와 블록 안 조건 순서를 시드 고정 난수로 섞는다. SDK 에는 시드가 없다 — 반복만이 복제 수단이다.

import { randomBytes } from 'node:crypto';

import type { ConditionId } from './conditions';

export const BLOCKS = {
  pilot: { tasks: ['T01', 'T06', 'T09'], conds: ['A', 'B', 'C', 'Cp'], reps: 1, model: 'haiku' },
  main: { tasks: 'all', conds: ['A', 'B', 'C'], reps: 5, model: 'haiku' },
  sens: { tasks: 'all', conds: ['Cp'], reps: 3, model: 'haiku' },
  /** KSC 2026 마감(10/12)에 맞춘 축소 본 실행 — main+sens 대신 네 조건을 한 블록에 (DESIGN 변경 이력 N5) */
  ksc: { tasks: 'all', conds: ['A', 'B', 'C', 'Cp'], reps: 3, model: 'haiku' },
  sonnet: { tasks: 'all', conds: ['A', 'B', 'C'], reps: 2, model: 'sonnet' },
  d: { tasks: 'all', conds: ['D'], reps: 3, model: 'haiku' },
  /** 선택 실험 (DESIGN 변경 이력 N8): Sonnet 네 조건 각 15회 — 과제마다 1회 + 시드로 고른 과제 5개에 2회째 */
  sonnet15: { tasks: 'all', conds: ['A', 'B', 'C', 'Cp'], reps: 1, extraTasks: 5, model: 'sonnet' },
  /** 선택 실험 (DESIGN N9): E 선행 검증 — C′ 에서 누출이 잦던 과제 2개 */
  e_probe: { tasks: ['T03', 'T05'], conds: ['E'], reps: 1, model: 'haiku' },
  /** 선택 실험 (DESIGN N9): E 본 실행 */
  e: { tasks: 'all', conds: ['E'], reps: 3, model: 'haiku' },
  /** 후속 (DESIGN N10 c-3): F = E + 멈추고 보고하라 지시 */
  f: { tasks: 'all', conds: ['F'], reps: 3, model: 'haiku' },
  /** 모의 리뷰 뒤 (DESIGN N11): H = C + 거부 사유가 대화로 답하기를 가리킴 */
  h: { tasks: 'all', conds: ['H'], reps: 3, model: 'haiku' },
} as const satisfies Record<string, { tasks: readonly string[] | 'all'; conds: readonly ConditionId[]; reps: number; extraTasks?: number; model: 'haiku' | 'sonnet' }>;
export type BlockName = keyof typeof BLOCKS;

export interface ScheduledEpisode {
  readonly blockName: BlockName;
  readonly block: number;
  readonly task: string;
  readonly cond: ConditionId;
  readonly rep: number;
  readonly runId: string;
}

const rngFrom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = <T>(xs: readonly T[], rand: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

/** runId 는 고유해야 한다 — 이름 충돌로 로그가 덮인 선례가 있다 (TESTING L396). 끝 6자리는 무작위. */
export const makeRunId = (blockName: string, block: number, task: string, cond: string, rep: number, suffix = randomBytes(3).toString('hex')): string =>
  `${blockName}-${block}-${task}-${cond}-${rep}-${suffix}`;

/** 블록 목록 (블록마다 조건 순서가 섞인 에피소드들). */
export function buildSchedule(name: BlockName, allTasks: readonly string[], seed: number): ScheduledEpisode[][] {
  const spec = BLOCKS[name];
  const tasks = spec.tasks === 'all' ? allTasks : spec.tasks;
  const rand = rngFrom(seed);
  const base = tasks.flatMap((task) => Array.from({ length: spec.reps }, (_, i) => ({ task, rep: i + 1 })));
  // 반복 수가 과제 수로 나눠떨어지지 않을 때: 시드로 고른 과제에만 한 번 더 (같은 시드면 같은 과제)
  const extra = 'extraTasks' in spec ? shuffled(tasks, rand).slice(0, spec.extraTasks).map((task) => ({ task, rep: spec.reps + 1 })) : [];
  const blocks = [...base, ...extra];
  return shuffled(blocks, rand).map((b, index) =>
    shuffled(spec.conds, rand).map((cond) => ({
      blockName: name,
      block: index + 1,
      task: b.task,
      cond,
      rep: b.rep,
      runId: makeRunId(name, index + 1, b.task, cond, b.rep),
    })),
  );
}

// ---------------------------------------------------------------- 재개 (DESIGN 변경 이력 N8)
// 실행이 중간에 멈췄을 때 같은 시드의 계획에서 끝난 에피소드만 빼고 이어 돌린다. 키 = runId 에서 끝 6자리 무작위를 뺀 것.

export const episodeKey = (ep: Pick<ScheduledEpisode, 'blockName' | 'block' | 'task' | 'cond' | 'rep'>): string =>
  `${ep.blockName}-${ep.block}-${ep.task}-${ep.cond}-${ep.rep}`;

/** `sonnet15-5-T06-Cp-1-988c95.jsonl` → `sonnet15-5-T06-Cp-1`. 모양이 다르면 null */
export const keyOfLogFile = (file: string): string | null => /^(.+-\d+-T\d+-[A-Za-z]+-\d+)-[0-9a-f]{6}\.jsonl$/.exec(file)?.[1] ?? null;

/** 끝난 키를 뺀 계획. 순서는 그대로, 비어 버린 블록은 없앤다 */
export const remainingBlocks = (blocks: readonly (readonly ScheduledEpisode[])[], done: ReadonlySet<string>): ScheduledEpisode[][] =>
  blocks.map((b) => b.filter((ep) => !done.has(episodeKey(ep)))).filter((b) => b.length > 0);
