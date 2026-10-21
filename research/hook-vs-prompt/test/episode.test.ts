import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { extractEpisode, parseJsonl } from '../analysis/extract';
import { createMockBackend, type MockBehavior, type MockOptions } from '../src/backends/mock';
import { H_REASONS, type ConditionId } from '../src/conditions';
import { runEpisode, type EpisodeEnv } from '../src/episode';
import { systemProcessControl } from '../src/procs';
import { loadTaskSet } from '../src/tasks';

const ROOT = path.resolve(__dirname, '..');
const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hvp-test-ep-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const { set } = loadTaskSet(path.join(ROOT, 'tasks/tasks.json'));
const task = (id: string) => {
  const t = set.tasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(id);
  return t;
};

const envFor = (mock: Partial<MockOptions> & { behavior: MockBehavior }, overrides: Partial<EpisodeEnv> = {}): EpisodeEnv => ({
  backend: createMockBackend({ seed: 7, ...mock }),
  tasks: set,
  fixturesDir: path.join(ROOT, 'fixtures'),
  tmpRoot: path.join(work, 'tmp'),
  logDir: path.join(work, 'logs'),
  model: 'claude-haiku-4-5-20251001',
  maxBudgetUsd: 1.5,
  timeoutMs: 5_000,
  initTimeoutMs: 1_000,
  envSource: { PATH: '/usr/bin:/bin', HOME: '/Users/tester', SECRET: 'zzz-should-not-appear' },
  home: '/Users/tester',
  user: 'tester',
  proc: systemProcessControl,
  now: () => Date.now(),
  meta: { seed: 1 },
  ...overrides,
});

const events = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

const writeIndex: MockBehavior = async (api, ctx) => {
  const r = await api.tool('Write', { file_path: `page${ctx.turn}.html`, content: '<h1/>' });
  if (!r.ok) {
    await api.tool('Bash', { command: `cat > page${ctx.turn}.html <<'EOF'\n<h1/>\nEOF` });
  }
  api.say('done');
};

const plan = (cond: ConditionId, id = `t-${cond}-${Math.random().toString(36).slice(2, 7)}`) => ({
  runId: id,
  block: 0,
  task: task('T01'),
  cond,
  rep: 1,
  rerunOf: null,
});

describe('에피소드 — 실제 hook·정책 경로', () => {
  it('A: 쓰기가 허용되어 디스크에 남고, 두 턴·스냅샷 4개·run_end 가 기록된다', async () => {
    const s = await runEpisode(plan('A'), envFor({ behavior: writeIndex }));
    expect(s.outcome).toBe('ok');
    const ev = events(s.logFile);
    expect(ev[0]).toMatchObject({ type: 'run_meta', cond: 'A', task: 'T01' });
    expect(ev.filter((e) => e.type === 'snapshot').map((e) => e.at)).toEqual(['t0', 't1', 't2', 't_end']);
    expect(ev.find((e) => e.type === 'task_check')).toMatchObject({ passed: true });
    expect(ev.at(-1)).toMatchObject({ type: 'run_end', outcome: 'ok' });
  });

  it('C: Write 는 앱 관문이 plan_missing 으로 막고, 셸 쓰기는 G 줄에서 자동 거부된다', async () => {
    const s = await runEpisode(plan('C'), envFor({ behavior: writeIndex }));
    const ev = events(s.logFile);
    expect(ev.some((e) => e.type === 'gate_verdict' && e.kind === 'deny' && e.rule === 'plan_missing')).toBe(true);
    expect(ev.some((e) => e.type === 'gate_verdict' && e.kind === 'ask' && e.rule === 'bash_write_without_plan')).toBe(true);
    expect(ev.some((e) => e.type === 'policy_decision' && e.line === 'G' && e.behavior === 'deny')).toBe(true);
    const end = ev.find((e) => e.type === 'snapshot' && e.at === 't_end') as { files: unknown[] };
    expect(end.files).toEqual([]);
  });

  it('H (N11): 모델은 바뀐 거부 사유를 받고, 기록은 원래 규칙(plan_missing)으로 남는다', async () => {
    const seen: string[] = [];
    const probe: MockBehavior = async (api) => {
      const r = await api.tool('Write', { file_path: 'index.html', content: '<p>x</p>' });
      seen.push(r.text);
      api.say('x');
    };
    const s = await runEpisode(plan('H'), envFor({ behavior: probe }));
    const ev = events(s.logFile);
    expect(seen[0]).toBe(H_REASONS.plan_missing);
    expect(ev.some((e) => e.type === 'gate_verdict' && e.kind === 'deny' && e.rule === 'plan_missing')).toBe(true);
    expect(ev.some((e) => e.type === 'gate_verdict' && e.rule === 'unknown')).toBe(false);
  });

  it('H (N11): 셸 쓰기 ask 는 C 처럼 G 줄에서 자동 거부되고, 파일 거부는 분석에서 거부로 잡힌다 (문구 교체가 정책·기록을 깨지 않는다)', async () => {
    const s = await runEpisode(plan('H'), envFor({ behavior: writeIndex }));
    const ev = events(s.logFile);
    expect(ev.some((e) => e.type === 'gate_verdict' && e.kind === 'ask' && e.rule === 'bash_write_without_plan')).toBe(true);
    expect(ev.some((e) => e.type === 'policy_decision' && e.line === 'G' && e.behavior === 'deny')).toBe(true);
    expect(ev.some((e) => e.type === 'policy_decision' && e.line === 'G' && e.behavior === 'allow')).toBe(false);
    const row = extractEpisode(parseJsonl(readFileSync(s.logFile, 'utf8')));
    expect(row.FT_denied).toBe(true);
    expect(row.FT_denied_by).toBe('gate_plan_missing');
    const end = ev.find((e) => e.type === 'snapshot' && e.at === 't_end') as { files: unknown[] };
    expect(end.files).toEqual([]);
  });

  it("C′: 같은 셸 쓰기가 G 줄에서 허용되어 디스크에 남는다", async () => {
    const s = await runEpisode(plan('Cp'), envFor({ behavior: writeIndex }));
    const ev = events(s.logFile);
    expect(ev.some((e) => e.type === 'policy_decision' && e.line === 'G' && e.behavior === 'allow')).toBe(true);
    const end = ev.find((e) => e.type === 'snapshot' && e.at === 't_end') as { files: { path: string }[] };
    expect(end.files.map((f) => f.path)).toEqual(['page1.html', 'page2.html']);
  });

  it('safety hook 이 홈 접근을 막고 기록한다 — 모든 조건 공통', async () => {
    const probe: MockBehavior = async (api) => {
      await api.tool('Read', { file_path: '/Users/tester/.zshrc' });
      api.say('x');
    };
    const s = await runEpisode(plan('A'), envFor({ behavior: probe }));
    expect(events(s.logFile).some((e) => e.type === 'safety_verdict' && e.rule === 'path_outside')).toBe(true);
  });

  it('로그에 env 값·홈·실행 폴더 경로가 없다 (M2)', async () => {
    const s = await runEpisode(plan('C'), envFor({ behavior: writeIndex }));
    const text = readFileSync(s.logFile, 'utf8');
    expect(text).not.toContain('zzz-should-not-appear');
    expect(text).not.toContain('/Users/tester');
    expect(text).not.toContain(work);
    expect(events(s.logFile).find((e) => e.type === 'init_result')).toEqual(expect.objectContaining({ hooks_applied: true }));
  });

  it('실행 폴더는 끝나면 지운다', async () => {
    const tmpRoot = path.join(work, 'tmp-clean');
    await runEpisode(plan('A'), envFor({ behavior: writeIndex }, { tmpRoot }));
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

describe('에피소드 — 실패 경로 (M5·M7)', () => {
  it('시한 초과: abort 하고 t_end 스냅샷을 찍고, 실행 폴더를 쓰는 자식 프로세스를 정리한다', async () => {
    let child: ReturnType<typeof spawn> | undefined;
    const s = await runEpisode(
      plan('A'),
      envFor(
        {
          behavior: writeIndex,
          hangOnTurn: 1,
          onHang: (cwd) => {
            child = spawn('/bin/sh', ['-c', 'exec sleep 30'], { detached: true, stdio: 'ignore', cwd });
            child.unref();
          },
        },
        { timeoutMs: 600 },
      ),
    );
    expect(s.outcome).toBe('timeout');
    const ev = events(s.logFile);
    expect(ev.filter((e) => e.type === 'snapshot').map((e) => e.at)).toEqual(['t0', 't_end']);
    const cleanup = ev.find((e) => e.type === 'proc_cleanup') as { residual: { pid: number }[]; stillAlive: number };
    expect(cleanup.residual.map((p) => p.pid)).toContain(child?.pid);
    expect(cleanup.stillAlive).toBe(0);
    expect(s.residualProcs).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('1턴 인프라 오류: 2턴을 보내지 않고 infra 로 분류한다', async () => {
    const s = await runEpisode(plan('A'), envFor({ behavior: writeIndex, infraOnTurn: 1 }));
    expect(s.outcome).toBe('infra');
    expect(s.reason).toBe('api_529');
    expect(events(s.logFile).some((e) => e.type === 'turn2_skipped')).toBe(true);
  });

  it('hook 이 무장되지 않으면 not_armed — 프롬프트를 보내지 않는다', async () => {
    const backend = createMockBackend({ seed: 1, behavior: writeIndex });
    const unarmed = { ...backend, start: (i: Parameters<typeof backend.start>[0]) => ({ ...backend.start(i), initializationResult: async () => ({ hooks_applied: false }) }) };
    const s = await runEpisode(plan('A'), { ...envFor({ behavior: writeIndex }), backend: unarmed });
    expect(s.outcome).toBe('not_armed');
    expect(events(s.logFile).some((e) => e.type === 'sdk_message')).toBe(false);
  });
});
