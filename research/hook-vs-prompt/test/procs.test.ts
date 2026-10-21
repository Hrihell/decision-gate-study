import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { cleanupProcesses, parseLsofCwd, parsePs, systemProcessControl, type ProcessControl } from '../src/procs';

const RUN = '/private/var/folders/x/T/hvp-run-1';

describe('잔존 프로세스 찾기 (리뷰 M7)', () => {
  it('ps 출력에서 실행 폴더(또는 /var 별칭)를 언급하는 줄만, 자기 자신은 빼고', () => {
    const out = [
      '  100 /usr/bin/node /var/folders/x/T/hvp-run-1/server.js',
      '  101 python3 -m http.server --directory /private/var/folders/x/T/hvp-run-1',
      '  102 /usr/bin/node unrelated.js',
      '  555 node /private/var/folders/x/T/hvp-run-1/self.js',
      '  103 node /private/var/folders/x/T/hvp-run-10/other.js',
    ].join('\n');
    expect(parsePs(out, RUN, 555).map((p) => p.pid)).toEqual([100, 101, 103]);
  });

  it('lsof cwd 출력에서 실행 폴더 안을 cwd 로 둔 pid', () => {
    const out = ['p200', 'fcwd', `n${RUN}`, 'p201', 'fcwd', '/somewhere', `n/tmp`, 'p202', 'fcwd', `n${RUN}/sub`].join('\n');
    expect(parseLsofCwd(out, RUN, 1)).toEqual([200, 202]);
  });

  it('그룹을 먼저 TERM→KILL 하고, 남은 것을 찾아 죽이고 기록한다', async () => {
    const calls: string[] = [];
    let alive = [{ pid: 300, command: 'node server.js' }];
    const ctl: ProcessControl = {
      list: () => alive,
      kill: (pid, sig) => {
        calls.push(`${pid}:${sig}`);
        if (pid === 300 && sig === 'SIGKILL') alive = [];
      },
      sleep: async () => undefined,
    };
    const report = await cleanupProcesses(RUN, [42], ctl);
    expect(calls).toEqual(['-42:SIGTERM', '-42:SIGKILL', '300:SIGTERM', '300:SIGKILL']);
    expect(report).toEqual({ groupsKilled: 1, residual: [{ pid: 300, command: 'node server.js' }], stillAlive: [] });
  });

  it('실제 프로세스: 실행 폴더를 argv 에 가진 detached sleep 이 정리 뒤 사라진다', async () => {
    const runDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hvp-test-proc-')));
    try {
      const child = spawn('/bin/sh', ['-c', `exec sleep 30 # ${runDir}`], { detached: true, stdio: 'ignore', cwd: runDir });
      child.unref();
      await new Promise((r) => setTimeout(r, 200));
      expect(systemProcessControl.list(runDir).map((p) => p.pid)).toContain(child.pid);
      const report = await cleanupProcesses(runDir, [], systemProcessControl);
      expect(report.residual.map((p) => p.pid)).toContain(child.pid);
      expect(report.stillAlive).toEqual([]);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 15_000);
});
