import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { leakContextFromEnv, scanDir, scanText } from '../src/leakcheck';

// 커밋한 dry-run 산출물을 검사한다 (`npm run dryrun` 으로 다시 만든다).
const DIR = path.resolve(__dirname, '../results/dryrun');

describe('dry-run 산출물 (results/dryrun)', () => {
  it('12 에피소드 로그와 지표·분석·관문 산출물이 있다', () => {
    expect(readdirSync(path.join(DIR, 'logs')).filter((f) => f.endsWith('.jsonl'))).toHaveLength(12);
    for (const f of ['episodes.csv', 'analysis.json', 'summary.md', 'pilot_gate.md', 'MANIFEST.json', 'run_state.json']) {
      expect(existsSync(path.join(DIR, f)), f).toBe(true);
    }
    expect(readFileSync(path.join(DIR, 'episodes.csv'), 'utf8').trim().split('\n')).toHaveLength(13);
  });

  it('mock 백엔드로 만들었다 — 실제 호출 0회', () => {
    const state = JSON.parse(readFileSync(path.join(DIR, 'run_state.json'), 'utf8')) as { backend: string; episodes: unknown[] };
    expect(state.backend).toBe('mock');
    for (const f of readdirSync(path.join(DIR, 'logs'))) {
      expect(readFileSync(path.join(DIR, 'logs', f), 'utf8')).toContain('"backend":"mock"');
    }
  });

  it('유출 검사 0건: 홈·/Users/·이메일·키 형태·이 셸의 비밀 환경변수 값 (M2)', () => {
    expect(scanDir(DIR, leakContextFromEnv(process.env, os.homedir(), os.userInfo().username))).toEqual([]);
  });

  it('run_meta.options 에 env 값이 없고 init 은 hooks_applied 만', () => {
    const lines = readdirSync(path.join(DIR, 'logs')).flatMap((f) =>
      readFileSync(path.join(DIR, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>),
    );
    for (const meta of lines.filter((e) => e.type === 'run_meta')) {
      expect(Array.isArray((meta.options as { env: unknown }).env)).toBe(true); // 키 이름 목록만
    }
    for (const init of lines.filter((e) => e.type === 'init_result')) {
      expect(Object.keys(init).sort()).toEqual(['hooks_applied', 't', 'type']);
    }
  });

  it('관문 자동 판정 줄에 ❌ 가 없다', () => {
    expect(readFileSync(path.join(DIR, 'pilot_gate.md'), 'utf8')).not.toContain('❌');
  });
});

describe('유출 검사기 자체', () => {
  it('값을 싣지 않고 종류만 낸다', () => {
    const ctx = { home: '/Users/tester', user: 'tester', secretValues: [{ name: 'MY_TOKEN', value: 'abcdefghijklmnop' }] };
    expect(scanText('x /Users/tester/a abcdefghijklmnop a@b.io', ctx).map((f) => f.kind)).toEqual([
      'home_path',
      'users_path',
      'email',
      'env_value:MY_TOKEN',
    ]);
    expect(scanText('/Users/<USER>/x <HOME>', ctx)).toEqual([]);
  });

  it('results.tex 의 숫자 매크로 이름(\\csname R@a.b\\endcsname)은 이메일이 아니다 — 같은 줄의 진짜 이메일은 잡는다', () => {
    const ctx = { home: '/Users/tester', user: 'tester', secretValues: [] };
    expect(scanText('\\expandafter\\def\\csname R@cost.totalUsd\\endcsname{11.85}', ctx)).toEqual([]);
    expect(scanText('\\expandafter\\def\\csname R@coding.score.precision.pfmt\\endcsname{0.932}', ctx)).toEqual([]);
    expect(scanText('\\csname R@x.yz\\endcsname a@b.io', ctx).map((f) => f.kind)).toEqual(['email']);
  });
});
