// 에피소드 하나 (DESIGN v2 §9.2): 폴더 준비 → query(스트리밍 입력) → 두 턴 → 스냅샷 → 정리 → 기록.
// query 는 Backend 로 주입한다 — 이 파일은 실제 SDK 를 import 하지 않는다.
//
// 리뷰 반영:
// - M7: `finally` 에서 t_end 스냅샷을 **항상** 찍고, 프로세스 그룹·잔존 프로세스를 정리해 기록한다.
//        시한 초과는 abort + 반복자 대기를 시한과 경주시켜 반복자가 멈춰도 빠져나온다.
//        1턴이 오류로 끝나면 2턴을 보내지 않고 `turn2_skipped` 를 남긴다.
// - M5: 종료를 ok·behavior_end·infra·not_armed·timeout 으로 기록한다. 판정은 is_error 로만 (subtype 아님).
// - M2: init 은 hooks_applied 만, env 는 키만, SDK 메시지는 축약형만 남긴다.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { createInputChannel } from '../../../src/main/agent/inputChannel';
import { isSupportedProjectRoot } from '../../../src/main/session/options';
import { assembleOptions } from './assemble';
import type { Backend } from './backends/backend';
import { CONDITIONS, type ConditionId } from './conditions';
import { scrubEnv } from './env';
import { createJsonlRecorder, reduceSdkMessage, type Recorder } from './log';
import { classifyTurn, isAuthFailure, isUsageLimit, summarizeCost, type ResultLike, type TurnClass } from './outcome';
import { cleanupProcesses, type ProcessControl } from './procs';
import { changedPaths, diffSnapshots, NPM_CACHE_DIR, takeSnapshot, type Snapshot } from './snapshot';
import { copyFixture, runTaskCheck, type TaskSet, type TaskSpec } from './tasks';

export type EpisodeOutcome = 'ok' | 'behavior_end' | 'infra' | 'not_armed' | 'timeout';

export interface EpisodePlan {
  readonly runId: string;
  readonly block: number;
  readonly task: TaskSpec;
  readonly cond: ConditionId;
  readonly rep: number;
  readonly rerunOf: string | null;
}

export interface EpisodeEnv {
  readonly backend: Backend;
  readonly tasks: TaskSet;
  readonly fixturesDir: string;
  /** 실행 폴더를 만들 곳 — OS 임시 폴더 또는 이 worktree 안만 */
  readonly tmpRoot: string;
  readonly logDir: string;
  /** 있으면 실행 후 폴더를 압축 보관한다 (node_modules 제외 — 리뷰 S11) */
  readonly archiveDir?: string;
  readonly model: string;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  /** 초기화 응답 대기 상한 */
  readonly initTimeoutMs: number;
  readonly envSource: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly user: string;
  readonly proc: ProcessControl;
  /** CLI 를 프로세스 그룹으로 띄우는 spawner 를 에피소드마다 만든다 (live). mock 은 없음. */
  readonly makeSpawner?: () => { spawn: NonNullable<Parameters<typeof assembleOptions>[0]['spawnClaudeCodeProcess']>; readonly groups: number[] };
  readonly now: () => number;
  /** run_meta 에 그대로 붙일 값 (seed, gitHead, sdkVersion, node, os, sourcesSha256 …). 비밀 값 금지. */
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface EpisodeSummary {
  readonly runId: string;
  readonly block: number;
  readonly task: string;
  readonly cond: ConditionId;
  readonly rep: number;
  readonly rerunOf: string | null;
  readonly outcome: EpisodeOutcome;
  readonly reason: string;
  readonly costUsd: number;
  readonly usageLimit: boolean;
  readonly authFailure: boolean;
  readonly residualProcs: number;
  readonly logFile: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 실행 폴더 안 작은 파일만 읽는다 — safety hook 의 스크립트 검사용. */
const SCRIPT_READ_MAX_BYTES = 1_000_000;
const makeReadFileText =
  (runDir: string) =>
  (absolutePath: string): string | undefined => {
    try {
      const rel = path.relative(runDir, absolutePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
      if (statSync(absolutePath).size > SCRIPT_READ_MAX_BYTES) return undefined;
      return readFileSync(absolutePath, 'utf8');
    } catch {
      return undefined;
    }
  };

const snapshotEvent = (at: string, s: Snapshot): Record<string, unknown> => ({ type: 'snapshot', at, files: s.files, dirs: s.dirs, flags: s.flags });

/** 반복자의 다음 값을 abort 와 경주시킨다. abort 되면 `done` 처럼 끝낸다. */
async function* raceWithAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([it.next(), aborted]);
      if (next === 'aborted' || next.done === true) return;
      yield next.value;
    }
  } finally {
    // 반복자를 닫으려 하되 기다리지 않는다 — 멈춘 반복자가 return 에서도 멈출 수 있다
    void it.return?.(undefined)?.catch?.(() => undefined);
  }
}

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)))]);
  } finally {
    clearTimeout(timer);
  }
};

const worst = (classes: readonly TurnClass[]): TurnClass =>
  classes.includes('infra') ? 'infra' : classes.includes('behavior_end') ? 'behavior_end' : 'ok';

/** 실행 폴더를 지운다. tmpRoot 아래의 `hvp-` 폴더가 아니면 지우지 않는다. */
const removeRunDir = (runDir: string, tmpRoot: string): void => {
  const rel = path.relative(tmpRoot, runDir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(runDir).startsWith('hvp-')) return;
  rmSync(runDir, { recursive: true, force: true });
};

export async function runEpisode(plan: EpisodePlan, env: EpisodeEnv): Promise<EpisodeSummary> {
  const t0 = env.now();
  const condition = CONDITIONS[plan.cond];
  mkdirSync(env.tmpRoot, { recursive: true });
  const runDir = realpathSync(mkdtempSync(path.join(env.tmpRoot, `hvp-${plan.runId}-`)));
  if (!isSupportedProjectRoot(runDir)) throw new Error('지원하지 않는 실행 폴더 경로다');
  copyFixture(env.fixturesDir, plan.task.fixture, runDir);

  const logFile = path.join(env.logDir, `${plan.runId}.jsonl`);
  const recorder: Recorder = createJsonlRecorder(logFile, { runDir, home: env.home, user: env.user }, env.now, t0);
  let turn = 0;
  const { env: childEnv, authKeys } = scrubEnv(env.envSource, { npm_config_cache: path.join(runDir, NPM_CACHE_DIR) });
  const abortController = new AbortController();
  const spawner = env.makeSpawner?.();
  const assembled = assembleOptions({
    condition,
    runDir,
    recorder,
    turn: () => turn,
    readFileText: makeReadFileText(runDir),
    model: env.model,
    maxBudgetUsd: env.maxBudgetUsd,
    env: childEnv,
    authKeys,
    abortController,
    ...(spawner === undefined ? {} : { spawnClaudeCodeProcess: spawner.spawn }),
  });

  recorder.write({
    type: 'run_meta',
    v: 2,
    runId: plan.runId,
    block: plan.block,
    task: plan.task.id,
    stratum: plan.task.stratum,
    cond: plan.cond,
    rep: plan.rep,
    rerunOf: plan.rerunOf,
    backend: env.backend.name,
    model: env.model,
    maxBudgetUsd: env.maxBudgetUsd,
    timeoutMs: env.timeoutMs,
    optionsHash: assembled.optionsHash,
    options: assembled.description,
    envKeys: Object.keys(childEnv).sort(),
    ...env.meta,
    tStartWall: new Date(t0).toISOString(),
  });

  const t0Snap = takeSnapshot(runDir);
  recorder.write(snapshotEvent('t0', t0Snap));

  const results: ResultLike[] = [];
  const classes: TurnClass[] = [];
  let outcome: EpisodeOutcome = 'ok';
  let reason = 'ok';
  let timedOut = false;
  const channel = createInputChannel();
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, env.timeoutMs);

  try {
    const handle = env.backend.start({ prompt: channel.stream, options: assembled.options });
    const init = await withTimeout(Promise.resolve(handle.initializationResult()).catch(() => undefined), env.initTimeoutMs);
    const hooksApplied = isRecord(init) && init.hooks_applied === true;
    // 응답 전체를 남기지 않는다 — account(이메일)가 들어 있다 (리뷰 M2)
    recorder.write({ type: 'init_result', hooks_applied: hooksApplied });
    if (!hooksApplied) {
      outcome = 'not_armed';
      reason = init === 'timeout' ? 'init_timeout' : 'hooks_not_applied';
      abortController.abort();
    } else {
      turn = 1;
      channel.push(plan.task.promptKo);
      for await (const message of raceWithAbort(handle, abortController.signal)) {
        recorder.write({ type: 'sdk_message', turn, message: reduceSdkMessage(message, runDir, recorder.redact) });
        if (!isRecord(message) || message.type !== 'result') continue;
        const result = message as ResultLike;
        results.push(result);
        const { cls, reason: why } = classifyTurn(result);
        classes.push(cls);
        recorder.write(snapshotEvent(`t${turn}`, takeSnapshot(runDir)));
        if (turn === 1 && cls === 'ok') {
          turn = 2;
          channel.push(env.tasks.pressureKo);
          continue;
        }
        if (turn === 1) recorder.write({ type: 'turn2_skipped', reason: why });
        break;
      }
      if (timedOut) {
        outcome = 'timeout';
        reason = `timeout_turn${turn}`;
      } else if (results.length === 0) {
        outcome = 'infra';
        reason = 'stream_ended_without_result';
      } else {
        const w = worst(classes);
        outcome = w;
        reason = w === 'ok' ? 'ok' : classifyTurn(results.find((r) => classifyTurn(r).cls === w) ?? {}).reason;
      }
    }
  } catch (error) {
    outcome = timedOut ? 'timeout' : 'infra';
    reason = timedOut ? `timeout_turn${turn}` : `stream_failed: ${recorder.redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`;
  } finally {
    clearTimeout(timer);
    channel.close();
    if (!abortController.signal.aborted) abortController.abort();
  }

  // ---- 여기부터는 어떤 경로로 끝났든 항상 돈다 (M7)
  const endSnap = takeSnapshot(runDir);
  recorder.write(snapshotEvent('t_end', endSnap));
  const changed = changedPaths(diffSnapshots(t0Snap, endSnap));
  recorder.write({ type: 'task_check', passed: runTaskCheck(plan.task.check, runDir, changed), changedCount: changed.length });

  const cleanup = await cleanupProcesses(runDir, spawner?.groups ?? [], env.proc);
  recorder.write({
    type: 'proc_cleanup',
    groupsKilled: cleanup.groupsKilled,
    residual: cleanup.residual.map((p) => ({ pid: p.pid, command: recorder.redact(p.command).slice(0, 200) })),
    stillAlive: cleanup.stillAlive.length,
  });

  if (env.archiveDir !== undefined) {
    try {
      mkdirSync(env.archiveDir, { recursive: true });
      const archive = path.join(env.archiveDir, `${plan.runId}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '--exclude', 'node_modules', '--exclude', NPM_CACHE_DIR, '-C', runDir, '.']);
      recorder.write({ type: 'archive', file: path.basename(archive), sha256: sha256File(archive) });
    } catch (error) {
      recorder.write({ type: 'archive_error', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }

  const last = results.at(-1);
  const cost = summarizeCost(results);
  recorder.write({ type: 'run_end', outcome, reason, costUsd: cost.costUsd, rerunOf: plan.rerunOf });
  if (existsSync(runDir)) removeRunDir(runDir, env.tmpRoot);

  return {
    runId: plan.runId,
    block: plan.block,
    task: plan.task.id,
    cond: plan.cond,
    rep: plan.rep,
    rerunOf: plan.rerunOf,
    outcome,
    reason,
    costUsd: cost.costUsd,
    usageLimit: results.some(isUsageLimit),
    authFailure: last !== undefined && isAuthFailure(last),
    residualProcs: cleanup.residual.length,
    logFile,
  };
}
