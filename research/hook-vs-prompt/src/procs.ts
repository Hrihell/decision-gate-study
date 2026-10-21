// 자식 프로세스 정리 (리뷰 M7). 에이전트가 띄운 `npm run dev`·`python -m http.server` 가 남으면 포트를 잡고,
// 스냅샷 뒤에도 폴더에 쓰고, 동시 실행 중인 다른 에피소드와 부딪친다.
// 1) CLI 를 새 프로세스 그룹으로 띄우고 끝에 그룹 전체를 죽인다. 2) 명령줄이나 cwd 에 실행 폴더가 있는 잔존 프로세스를 찾아 죽이고 기록한다.

import { execFileSync, spawn } from 'node:child_process';

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export interface ProcInfo {
  readonly pid: number;
  readonly command: string;
}

export interface ProcessControl {
  /** 실행 폴더와 관련된 프로세스 (명령줄 또는 cwd 가 그 안). 자기 자신은 뺀다. */
  list(runDir: string): ProcInfo[];
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

const aliases = (runDir: string): string[] => (runDir.startsWith('/private/') ? [runDir, runDir.slice('/private'.length)] : [runDir]);

/** `ps -axo pid=,command=` 출력에서 실행 폴더를 언급하는 줄. */
export function parsePs(output: string, runDir: string, selfPid: number): ProcInfo[] {
  const needles = aliases(runDir);
  return output
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .flatMap((m) => (m === null ? [] : [{ pid: Number(m[1]), command: m[2] ?? '' }]))
    .filter((p) => p.pid !== selfPid && needles.some((n) => p.command.includes(n)));
}

/** `lsof -d cwd -Fpn` 출력에서 cwd 가 실행 폴더 안인 pid. */
export function parseLsofCwd(output: string, runDir: string, selfPid: number): number[] {
  const needles = aliases(runDir);
  const pids: number[] = [];
  let current: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1));
    else if (line.startsWith('n') && current !== undefined && current !== selfPid) {
      const dir = line.slice(1);
      if (needles.some((n) => dir === n || dir.startsWith(`${n}/`))) pids.push(current);
    }
  }
  return pids;
}

const run = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    // lsof 는 일부 pid 를 못 읽으면 0 이 아닌 코드로 끝나도 stdout 을 준다
    const out = (error as { stdout?: unknown }).stdout;
    return typeof out === 'string' ? out : '';
  }
};

export const systemProcessControl: ProcessControl = {
  list(runDir) {
    const byCmd = parsePs(run('ps', ['-axo', 'pid=,command=']), runDir, process.pid);
    const cwdPids = parseLsofCwd(run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-u', String(process.getuid?.() ?? '')]), runDir, process.pid);
    const known = new Set(byCmd.map((p) => p.pid));
    return [...byCmd, ...cwdPids.filter((pid) => !known.has(pid)).map((pid) => ({ pid, command: '(cwd in run dir)' }))];
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // 이미 끝났다
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface CleanupReport {
  readonly groupsKilled: number;
  /** 그룹을 죽인 뒤에도 남아 있던 것 — 기록 대상 */
  readonly residual: readonly ProcInfo[];
  readonly stillAlive: readonly ProcInfo[];
}

const GRACE_MS = 500;

export async function cleanupProcesses(runDir: string, groupPids: readonly number[], ctl: ProcessControl): Promise<CleanupReport> {
  for (const pgid of groupPids) ctl.kill(-pgid, 'SIGTERM');
  if (groupPids.length > 0) await ctl.sleep(GRACE_MS);
  for (const pgid of groupPids) ctl.kill(-pgid, 'SIGKILL');
  const residual = ctl.list(runDir);
  for (const p of residual) ctl.kill(p.pid, 'SIGTERM');
  if (residual.length > 0) await ctl.sleep(GRACE_MS);
  for (const p of residual) ctl.kill(p.pid, 'SIGKILL');
  const stillAlive = residual.length > 0 ? ctl.list(runDir) : [];
  return { groupsKilled: groupPids.length, residual, stillAlive };
}

/** CLI 를 새 프로세스 그룹(detached)으로 띄우는 spawner. 띄운 그룹 id 를 모은다. */
export function createGroupSpawner(): { spawn: (o: SpawnOptions) => SpawnedProcess; readonly groups: number[] } {
  const groups: number[] = [];
  return {
    groups,
    spawn(o) {
      const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid !== undefined) groups.push(child.pid);
      o.signal?.addEventListener('abort', () => {
        if (child.pid !== undefined) systemProcessControl.kill(-child.pid, 'SIGTERM');
      });
      return child as unknown as SpawnedProcess;
    },
  };
}
